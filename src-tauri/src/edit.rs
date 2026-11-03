//! Single-image edits from the viewer: rotate, flip, crop, resize and a solid border,
//! saved as a copy next to the original or over it (the original goes to the trash first).

use crate::export::{self, Format, MetaMode, Resize};
use crate::files::{self, Entry};
use crate::transfer::{reason, to_trash};
use image::{DynamicImage, Rgba, RgbaImage};
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize)]
pub struct Edit {
    /// Clockwise quarter turns in degrees: 0, 90, 180 or 270.
    pub rotate: u32,
    pub flip_h: bool,
    pub flip_v: bool,
    /// Area to keep as fractions (x, y, width, height) of the rotated and flipped image.
    pub crop: Option<[f64; 4]>,
    pub resize: Resize,
    /// Border width in pixels of the final image, added around it.
    pub border: u32,
    pub border_color: [u8; 3],
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveMode {
    Copy,
    Overwrite,
}

const QUALITY: u8 = 92;
const MAX_BORDER: u32 = 2000;

/// The format the edited image is written in, when the original's can be written.
fn format_for(path: &Path) -> Option<Format> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" => Format::Jpeg,
        "png" => Format::Png,
        "webp" => Format::Webp,
        "tif" | "tiff" => Format::Tiff,
        "bmp" => Format::Bmp,
        "avif" => Format::Avif,
        _ => return None,
    })
}

/// Whether the original can be replaced in its own format (for the viewer's "overwrite" choice).
pub fn can_overwrite(path: &Path) -> bool {
    format_for(path).is_some()
}

fn crop(img: DynamicImage, area: [f64; 4]) -> DynamicImage {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let [fx, fy, fw, fh] = area.map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 });
    let x = (fx * w).round().min(w - 1.0).max(0.0);
    let y = (fy * h).round().min(h - 1.0).max(0.0);
    let cw = (fw * w).round().clamp(1.0, w - x);
    let ch = (fh * h).round().clamp(1.0, h - y);
    if x == 0.0 && y == 0.0 && cw == w && ch == h {
        return img;
    }
    img.crop_imm(x as u32, y as u32, cw as u32, ch as u32)
}

fn add_border(img: DynamicImage, width: u32, color: [u8; 3]) -> DynamicImage {
    let width = width.min(MAX_BORDER);
    if width == 0 {
        return img;
    }
    let inner = img.to_rgba8();
    let (w, h) = (inner.width() + width * 2, inner.height() + width * 2);
    let mut out = RgbaImage::from_pixel(w, h, Rgba([color[0], color[1], color[2], 255]));
    image::imageops::overlay(&mut out, &inner, width as i64, width as i64);
    DynamicImage::ImageRgba8(out)
}

/// Applies the edit to upright pixels, in the order the viewer previews it.
pub fn apply(img: DynamicImage, edit: &Edit) -> DynamicImage {
    let mut img = match edit.rotate % 360 {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    };
    if edit.flip_h {
        img = img.fliph();
    }
    if edit.flip_v {
        img = img.flipv();
    }
    if let Some(area) = edit.crop {
        img = crop(img, area);
    }
    img = export::resize(img, &edit.resize);
    add_border(img, edit.border, edit.border_color)
}

fn has_transparency(img: &DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

fn encode(img: DynamicImage, src: &Path, format: Format) -> io::Result<Vec<u8>> {
    let img = if format.keeps_alpha() { img } else { export::flatten(img, [255, 255, 255]) };
    let bytes = export::encode(&img, format, QUALITY)?;
    // Metadata is kept (orientation reset, since the pixels are now upright) when the format allows.
    if let (Some(meta), Some(container)) = (export::exif_for(src, MetaMode::Keep), format.exif_container()) {
        let mut with_meta = bytes.clone();
        if meta.write_to_vec(&mut with_meta, container).is_ok() {
            return Ok(with_meta);
        }
    }
    Ok(bytes)
}

fn part_path(path: &Path, suffix: &str) -> PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(suffix);
    PathBuf::from(tmp)
}

/// Saves the edited image and returns the file written.
pub fn save(src: &Path, edit: &Edit, mode: SaveMode) -> Result<Entry, String> {
    if crate::transfer::in_package(src) {
        return Err("protected_dest".into());
    }
    let dir = src.parent().ok_or("not_found")?;
    if mode == SaveMode::Overwrite && format_for(src).is_none() {
        return Err("edit_format".into());
    }
    let img = apply(export::load(src).map_err(|e| reason(&e))?, edit);
    let target = match mode {
        SaveMode::Overwrite => {
            let format = format_for(src).ok_or("edit_format")?;
            let bytes = encode(img, src, format).map_err(|e| reason(&e))?;
            // The new file is complete before the original is touched; the original stays in the trash.
            let tmp = part_path(src, ".edit.part");
            fs::write(&tmp, &bytes).map_err(|e| reason(&e))?;
            if let Err(e) = to_trash(src) {
                let _ = fs::remove_file(&tmp);
                return Err(reason(&e));
            }
            fs::rename(&tmp, src).map_err(|e| reason(&e))?;
            src.to_path_buf()
        }
        SaveMode::Copy => {
            let own = format_for(src);
            let format = own.unwrap_or(if has_transparency(&img) { Format::Png } else { Format::Jpeg });
            let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            // Keep the original's spelling (.jpeg, .tiff) when the format stays the same.
            let ext = match own {
                Some(_) => src.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default(),
                None => format.extension().to_string(),
            };
            let name = format!("{stem}_edit.{ext}");
            let mut target = dir.join(&name);
            if target.exists() {
                target = export::free_name(dir, &name);
            }
            let bytes = encode(img, src, format).map_err(|e| reason(&e))?;
            let tmp = part_path(&target, ".part");
            fs::write(&tmp, &bytes).map_err(|e| reason(&e))?;
            fs::rename(&tmp, &target).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                reason(&e)
            })?;
            target
        }
    };
    files::entry(&target).ok_or_else(|| "not_found".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit() -> Edit {
        Edit {
            rotate: 0,
            flip_h: false,
            flip_v: false,
            crop: None,
            resize: Resize::None,
            border: 0,
            border_color: [0, 0, 0],
        }
    }

    /// 4×2 image: left half red, right half blue.
    fn sample() -> DynamicImage {
        let mut img = RgbaImage::from_pixel(4, 2, Rgba([255, 0, 0, 255]));
        for y in 0..2 {
            for x in 2..4 {
                img.put_pixel(x, y, Rgba([0, 0, 255, 255]));
            }
        }
        DynamicImage::ImageRgba8(img)
    }

    #[test]
    fn rotates_then_flips_then_crops_resizes_and_borders() {
        let mut e = edit();
        e.rotate = 90;
        let out = apply(sample(), &e).to_rgba8();
        assert_eq!((out.width(), out.height()), (2, 4));
        // Clockwise: the left (red) half ends up on top.
        assert_eq!(out.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(0, 3).0, [0, 0, 255, 255]);

        e.flip_v = true;
        let out = apply(sample(), &e).to_rgba8();
        assert_eq!(out.get_pixel(0, 0).0, [0, 0, 255, 255]);

        let mut e = edit();
        e.crop = Some([0.5, 0.0, 0.5, 1.0]);
        e.border = 3;
        e.border_color = [10, 20, 30];
        let out = apply(sample(), &e).to_rgba8();
        assert_eq!((out.width(), out.height()), (2 + 6, 2 + 6));
        assert_eq!(out.get_pixel(0, 0).0, [10, 20, 30, 255]);
        assert_eq!(out.get_pixel(3, 3).0, [0, 0, 255, 255]);

        let mut e = edit();
        e.resize = Resize::Percent(50);
        let out = apply(sample(), &e);
        assert_eq!((out.width(), out.height()), (2, 1));
    }

    #[test]
    fn crop_outside_the_image_is_clamped() {
        let mut e = edit();
        e.crop = Some([0.9, 0.9, 5.0, f64::NAN]);
        let out = apply(sample(), &e);
        assert!(out.width() >= 1 && out.height() >= 1);
        assert!(out.width() <= 4 && out.height() <= 2);
    }

    #[test]
    fn saves_a_copy_and_refuses_to_overwrite_unwritable_formats() {
        let base = std::env::temp_dir().join(format!("image-plus-edit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("photo.png");
        sample().save(&src).unwrap();

        let mut e = edit();
        e.border = 1;
        let copy = save(&src, &e, SaveMode::Copy).unwrap();
        assert_eq!(copy.name, "photo_edit.png");
        assert_eq!(image::open(&copy.path).unwrap().width(), 6);
        let again = save(&src, &e, SaveMode::Copy).unwrap();
        assert_eq!(again.name, "photo_edit (2).png");
        assert_eq!(image::open(&src).unwrap().width(), 4, "a copy leaves the original alone");

        let gif = base.join("anim.gif");
        sample().save(&gif).unwrap();
        assert!(!can_overwrite(&gif));
        assert_eq!(save(&gif, &e, SaveMode::Overwrite).err().as_deref(), Some("edit_format"));
        assert_eq!(save(&gif, &e, SaveMode::Copy).unwrap().name, "anim_edit.jpg");
        let _ = fs::remove_dir_all(base);
    }
}
