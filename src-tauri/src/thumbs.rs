use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::UNIX_EPOCH;

/// Longest side of a stored thumbnail, in pixels.
pub const SIZE: u32 = 320;
const FORMAT_VERSION: u32 = 1;
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;
const CACHE_TARGET: u64 = 768 * 1024 * 1024;

/// Thumbnails rendered on demand and cached on disk, keyed by path, size and modification time.
pub struct Thumbs {
    dir: PathBuf,
    busy: Mutex<usize>,
    freed: Condvar,
    limit: usize,
}

struct Permit<'a>(&'a Thumbs);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap() -= 1;
        self.0.freed.notify_one();
    }
}

impl Thumbs {
    pub fn new(dir: PathBuf) -> Self {
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
        Thumbs {
            dir,
            busy: Mutex::new(0),
            freed: Condvar::new(),
            limit: cores.saturating_sub(1).clamp(2, 8),
        }
    }

    fn permit(&self) -> Permit<'_> {
        let mut busy = self.busy.lock().unwrap();
        while *busy >= self.limit {
            busy = self.freed.wait(busy).unwrap();
        }
        *busy += 1;
        Permit(self)
    }

    fn cache_path(&self, path: &Path) -> Option<PathBuf> {
        let meta = fs::metadata(path).ok()?;
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
        let mut h = DefaultHasher::new();
        (path, meta.len(), modified, SIZE, FORMAT_VERSION).hash(&mut h);
        Some(self.dir.join(format!("{:016x}", h.finish())))
    }

    /// Returns the thumbnail bytes and their media type.
    pub fn get(&self, path: &Path) -> Option<(Vec<u8>, &'static str)> {
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("svg")) {
            return fs::read(path).ok().map(|b| (b, "image/svg+xml"));
        }
        let base = self.cache_path(path)?;
        let cached = |base: &Path| {
            for (ext, mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
                if let Ok(b) = fs::read(base.with_extension(ext)) {
                    return Some((b, mime));
                }
            }
            None
        };
        if let Some(hit) = cached(&base) {
            return Some(hit);
        }
        let _permit = self.permit();
        if let Some(hit) = cached(&base) {
            return Some(hit);
        }
        let img = render(path)?;
        let (bytes, ext, mime) = encode(img)?;
        let _ = fs::create_dir_all(&self.dir);
        let target = base.with_extension(ext);
        let tmp = base.with_extension(format!("{ext}.tmp"));
        if fs::write(&tmp, &bytes).is_ok() {
            let _ = fs::rename(&tmp, &target);
        }
        Some((bytes, mime))
    }

    pub fn clear(&self) {
        let _ = fs::remove_dir_all(&self.dir);
    }

    /// Deletes the oldest cached files once the cache grows past its limit.
    pub fn trim(&self) {
        let Ok(read) = fs::read_dir(&self.dir) else { return };
        let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = read
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), e.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= CACHE_LIMIT {
            return;
        }
        files.sort_by_key(|f| f.0);
        for (_, len, path) in files {
            if total <= CACHE_TARGET {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    }
}

fn render(path: &Path) -> Option<DynamicImage> {
    #[cfg(windows)]
    if let Some(p) = crate::wic::thumbnail(path, SIZE) {
        return image::RgbaImage::from_raw(p.width, p.height, p.rgba).map(DynamicImage::ImageRgba8);
    }
    if let Some(img) = render_with_image(path) {
        return Some(img);
    }
    #[cfg(target_os = "macos")]
    if let Some(img) = render_with_quicklook(path) {
        return Some(img);
    }
    None
}

fn render_with_image(path: &Path) -> Option<DynamicImage> {
    let mut decoder = ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Some(if img.width() > SIZE || img.height() > SIZE {
        img.thumbnail(SIZE, SIZE)
    } else {
        img
    })
}

/// Quick Look covers formats the image crate cannot decode, such as HEIC and AVIF.
#[cfg(target_os = "macos")]
fn render_with_quicklook(path: &Path) -> Option<DynamicImage> {
    let out = std::env::temp_dir().join(format!(
        "image-plus-ql-{}-{:x}",
        std::process::id(),
        {
            let mut h = DefaultHasher::new();
            path.hash(&mut h);
            std::thread::current().id().hash(&mut h);
            h.finish()
        }
    ));
    let _ = fs::create_dir_all(&out);
    let status = std::process::Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", &SIZE.to_string(), "-o"])
        .arg(&out)
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    let produced = fs::read_dir(&out)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "png"));
    let img = if status.success() {
        produced.and_then(|p| image::open(p).ok())
    } else {
        None
    };
    let _ = fs::remove_dir_all(&out);
    img
}

fn encode(img: DynamicImage) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let mut out = Vec::new();
    let has_alpha = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255);
    if has_alpha {
        let rgba = img.to_rgba8();
        PngEncoder::new(&mut out)
            .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
            .ok()?;
        Some((out, "png", "image/png"))
    } else {
        let rgb = img.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 82)
            .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .ok()?;
        Some((out, "jpg", "image/jpeg"))
    }
}

#[cfg(test)]
mod tests {
    use super::Thumbs;

    #[test]
    fn renders_and_caches_scaled_thumbnail() {
        let base = std::env::temp_dir().join(format!("image-plus-thumbs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("big.png");
        image::RgbImage::from_pixel(1000, 500, image::Rgb([200, 10, 10])).save(&src).unwrap();

        let thumbs = Thumbs::new(base.join("cache"));
        let (bytes, mime) = thumbs.get(&src).expect("thumbnail");
        assert_eq!(mime, "image/jpeg");
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (super::SIZE, super::SIZE / 2));
        assert_eq!(std::fs::read_dir(base.join("cache")).unwrap().count(), 1);
        let (again, _) = thumbs.get(&src).unwrap();
        assert_eq!(again, bytes);
        let _ = std::fs::remove_dir_all(base);
    }
}
