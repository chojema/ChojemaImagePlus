use crate::transfer::{reason, to_trash, Failure, Progress, Resolution};
use image::codecs::avif::AvifEncoder;
use image::codecs::bmp::BmpEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::tiff::TiffEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader, RgbImage, Rgba, RgbaImage};
use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use little_exif::ifd::ExifTagGroup;
use little_exif::metadata::Metadata;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Jpeg,
    Png,
    Webp,
    Tiff,
    Bmp,
    Avif,
    Heic,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Png => "png",
            Format::Webp => "webp",
            Format::Tiff => "tif",
            Format::Bmp => "bmp",
            Format::Avif => "avif",
            Format::Heic => "heic",
        }
    }

    fn keeps_alpha(self) -> bool {
        !matches!(self, Format::Jpeg | Format::Bmp)
    }

    /// Container little_exif can write EXIF into.
    fn exif_container(self) -> Option<FileExtension> {
        match self {
            Format::Jpeg => Some(FileExtension::JPEG),
            Format::Png => Some(FileExtension::PNG { as_zTXt_chunk: false }),
            Format::Webp => Some(FileExtension::WEBP),
            Format::Tiff | Format::Heic => Some(FileExtension::TIFF),
            Format::Avif => Some(FileExtension::HEIF),
            Format::Bmp => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetaMode {
    Keep,
    Strip,
    #[serde(rename = "strip_gps")]
    StripGps,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "mode", content = "value", rename_all = "lowercase")]
pub enum Resize {
    None,
    Long(u32),
    Percent(u32),
}

#[derive(Clone, Deserialize)]
pub struct Options {
    pub format: Format,
    pub quality: u8,
    pub resize: Resize,
    pub metadata: MetaMode,
    pub background: [u8; 3],
    pub suffix: String,
}

#[derive(Serialize)]
pub struct Planned {
    pub src: String,
    pub name: String,
    pub exists: bool,
    /// The export would land on the source file itself.
    pub same: bool,
}

#[derive(Deserialize)]
pub struct Job {
    pub src: String,
    pub resolution: Option<Resolution>,
}

#[derive(Serialize)]
pub struct Outcome {
    pub done: Vec<String>,
    pub skipped: usize,
    pub failed: Vec<Failure>,
    pub cancelled: bool,
}

fn target_name(src: &Path, options: &Options) -> String {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{stem}{}.{}", options.suffix, options.format.extension())
}

pub fn plan(sources: &[String], dest: &Path, options: &Options) -> Result<Vec<Planned>, String> {
    if crate::transfer::in_package(dest) {
        return Err("protected_dest".into());
    }
    if options.format == Format::Heic && !cfg!(target_os = "macos") {
        return Err("heic_unsupported".into());
    }
    Ok(sources
        .iter()
        .map(|s| {
            let name = target_name(Path::new(s), options);
            let target = dest.join(&name);
            let same = target.exists() && fs::canonicalize(&target).ok() == fs::canonicalize(s).ok();
            Planned { exists: target.exists(), src: s.clone(), name, same }
        })
        .collect())
}

/// Decodes the image with its orientation applied so the pixels are upright.
fn load(path: &Path) -> io::Result<DynamicImage> {
    let fail = |e: image::ImageError| io::Error::new(io::ErrorKind::InvalidData, e.to_string());
    let attempt = || -> io::Result<DynamicImage> {
        let mut decoder = ImageReader::open(path)?.with_guessed_format()?.into_decoder().map_err(fail)?;
        let orientation = decoder.orientation().ok();
        let mut img = DynamicImage::from_decoder(decoder).map_err(fail)?;
        if let Some(o) = orientation {
            img.apply_orientation(o);
        }
        Ok(img)
    };
    match attempt() {
        Ok(img) => Ok(img),
        Err(first) => system_decode(path).ok_or(first),
    }
}

#[cfg(windows)]
fn system_decode(path: &Path) -> Option<DynamicImage> {
    let p = crate::wic::decode(path)?;
    RgbaImage::from_raw(p.width, p.height, p.rgba).map(DynamicImage::ImageRgba8)
}

/// HEIC, AVIF and other formats macOS can read are converted with `sips`.
#[cfg(target_os = "macos")]
fn system_decode(path: &Path) -> Option<DynamicImage> {
    let tmp = temp_path("png");
    let ok = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(path)
        .arg("--out")
        .arg(&tmp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let img = if ok { image::open(&tmp).ok() } else { None };
    let _ = fs::remove_file(&tmp);
    img
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system_decode(_path: &Path) -> Option<DynamicImage> {
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn temp_path(ext: &str) -> PathBuf {
    use std::sync::atomic::AtomicUsize;
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("image-plus-export-{}-{n}.{ext}", std::process::id()))
}

fn resize(img: DynamicImage, resize: &Resize) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let (tw, th) = match *resize {
        Resize::None => return img,
        Resize::Long(px) if px > 0 && w.max(h) > px => {
            let r = px as f64 / w.max(h) as f64;
            ((w as f64 * r).round() as u32, (h as f64 * r).round() as u32)
        }
        Resize::Percent(p) if p > 0 && p != 100 => {
            let r = p as f64 / 100.0;
            ((w as f64 * r).round() as u32, (h as f64 * r).round() as u32)
        }
        _ => return img,
    };
    img.resize_exact(tw.max(1), th.max(1), FilterType::Lanczos3)
}

/// Composites transparent pixels onto `bg` for formats without transparency.
fn flatten(img: DynamicImage, bg: [u8; 3]) -> DynamicImage {
    if !img.color().has_alpha() {
        return img;
    }
    let rgba: RgbaImage = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, Rgba([r, g, b, a])) in rgba.enumerate_pixels().map(|(x, y, p)| (x, y, *p)) {
        let a = a as u32;
        let mix = |c: u8, k: u8| ((c as u32 * a + k as u32 * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([mix(r, bg[0]), mix(g, bg[1]), mix(b, bg[2])]));
    }
    DynamicImage::ImageRgb8(out)
}

fn encode(img: &DynamicImage, format: Format, quality: u8) -> io::Result<Vec<u8>> {
    let fail = |e: image::ImageError| io::Error::other(e.to_string());
    let quality = quality.clamp(1, 100);
    let mut out = Vec::new();
    match format {
        Format::Jpeg => {
            let rgb = img.to_rgb8();
            JpegEncoder::new_with_quality(&mut out, quality)
                .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                .map_err(fail)?;
        }
        Format::Png => {
            let rgba = img.to_rgba8();
            PngEncoder::new(&mut out)
                .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                .map_err(fail)?;
        }
        Format::Webp => {
            let rgba = img.to_rgba8();
            let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
            out = encoder.encode(quality as f32).to_vec();
        }
        Format::Tiff | Format::Heic => {
            let rgba = img.to_rgba8();
            TiffEncoder::new(Cursor::new(&mut out))
                .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                .map_err(fail)?;
        }
        Format::Bmp => {
            let rgb = img.to_rgb8();
            BmpEncoder::new(&mut out)
                .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                .map_err(fail)?;
        }
        Format::Avif => {
            let rgba = img.to_rgba8();
            AvifEncoder::new_with_speed_quality(&mut out, 6, quality)
                .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                .map_err(fail)?;
        }
    }
    Ok(out)
}

/// The source's EXIF, adjusted for the exported pixels: upright, optionally without location.
fn exif_for(src: &Path, mode: MetaMode) -> Option<Metadata> {
    if mode == MetaMode::Strip {
        return None;
    }
    let mut meta = Metadata::new_from_path(src).ok()?;
    meta.set_tag(ExifTag::Orientation(vec![1]));
    if mode == MetaMode::StripGps {
        for tag in 0x0000..=0x001f {
            meta.remove_tag_by_hex_group(tag, ExifTagGroup::GPS);
        }
    }
    Some(meta)
}

#[cfg(target_os = "macos")]
fn tiff_to_heic(tiff: &[u8], quality: u8) -> io::Result<Vec<u8>> {
    let (input, output) = (temp_path("tif"), temp_path("heic"));
    fs::write(&input, tiff)?;
    let status = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "heic", "-s", "formatOptions", &quality.clamp(1, 100).to_string()])
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let result = match status {
        Ok(s) if s.success() => fs::read(&output),
        _ => Err(io::Error::other("HEIC conversion failed")),
    };
    let _ = fs::remove_file(&input);
    let _ = fs::remove_file(&output);
    result
}

#[cfg(not(target_os = "macos"))]
fn tiff_to_heic(_tiff: &[u8], _quality: u8) -> io::Result<Vec<u8>> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "HEIC export needs macOS"))
}

/// Produces the exported file's bytes.
pub fn render(src: &Path, options: &Options) -> io::Result<Vec<u8>> {
    let mut img = resize(load(src)?, &options.resize);
    if !options.format.keeps_alpha() {
        img = flatten(img, options.background);
    }
    let mut bytes = encode(&img, options.format, options.quality)?;
    if let (Some(meta), Some(container)) = (exif_for(src, options.metadata), options.format.exif_container()) {
        // Metadata is best effort: an image without it is still a valid export.
        let mut with_meta = bytes.clone();
        if meta.write_to_vec(&mut with_meta, container).is_ok() {
            bytes = with_meta;
        }
    }
    if options.format == Format::Heic {
        bytes = tiff_to_heic(&bytes, options.quality)?;
    }
    Ok(bytes)
}

fn free_name(dir: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).expect("unbounded")
}

pub fn run(dest: &Path, options: &Options, jobs: &[Job], cancel: &AtomicBool, progress: impl Fn(Progress)) -> Outcome {
    let mut outcome = Outcome { done: Vec::new(), skipped: 0, failed: Vec::new(), cancelled: false };
    if let Err(e) = fs::create_dir_all(dest) {
        outcome.failed = jobs.iter().map(|j| Failure { src: j.src.clone(), error: reason(&e) }).collect();
        return outcome;
    }
    let total = jobs.len();
    for (i, job) in jobs.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            outcome.cancelled = true;
            break;
        }
        let src = PathBuf::from(&job.src);
        let name = target_name(&src, options);
        progress(Progress { done: i, total, name: name.clone() });
        let mut target = dest.join(&name);
        if target.exists() {
            match job.resolution {
                None | Some(Resolution::Skip) => {
                    outcome.skipped += 1;
                    continue;
                }
                Some(Resolution::Rename) => target = free_name(dest, &name),
                Some(Resolution::Overwrite) => {
                    if fs::canonicalize(&target).ok() == fs::canonicalize(&src).ok() {
                        outcome.failed.push(Failure { src: job.src.clone(), error: "same_file".into() });
                        continue;
                    }
                    if let Err(e) = to_trash(&target) {
                        outcome.failed.push(Failure { src: job.src.clone(), error: reason(&e) });
                        continue;
                    }
                }
            }
        }
        let result = render(&src, options).and_then(|bytes| {
            let tmp = target.with_extension(format!("{}.part", options.format.extension()));
            fs::write(&tmp, bytes)?;
            fs::rename(&tmp, &target).inspect_err(|_| {
                let _ = fs::remove_file(&tmp);
            })
        });
        match result {
            Ok(()) => outcome.done.push(target.to_string_lossy().into_owned()),
            Err(e) => outcome.failed.push(Failure { src: job.src.clone(), error: reason(&e) }),
        }
    }
    progress(Progress { done: total, total, name: String::new() });
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(format: Format) -> Options {
        Options {
            format,
            quality: 80,
            resize: Resize::Long(100),
            metadata: MetaMode::Keep,
            background: [255, 255, 255],
            suffix: "_out".into(),
        }
    }

    #[test]
    fn exports_every_portable_format_resized_and_flattened() {
        let base = std::env::temp_dir().join(format!("image-plus-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("source.png");
        RgbaImage::from_pixel(400, 200, Rgba([255, 0, 0, 0])).save(&src).unwrap();
        for format in [Format::Jpeg, Format::Png, Format::Webp, Format::Tiff, Format::Bmp, Format::Avif] {
            let bytes = render(&src, &options(format)).unwrap();
            assert!(!bytes.is_empty());
            if format != Format::Avif {
                let img = image::load_from_memory(&bytes).unwrap();
                assert_eq!((img.width(), img.height()), (100, 50), "{:?}", format.extension());
                if format == Format::Jpeg {
                    let p = img.to_rgb8().get_pixel(10, 10).0;
                    assert!(p.iter().all(|&c| c > 240), "transparent pixels become the background");
                }
            }
        }
        let out = run(
            &base.join("out"),
            &options(Format::Jpeg),
            &[Job { src: src.to_string_lossy().into_owned(), resolution: None }],
            &AtomicBool::new(false),
            |_| {},
        );
        assert_eq!(out.done.len(), 1);
        assert!(base.join("out").join("source_out.jpg").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn exif_is_kept_upright_and_location_can_be_removed() {
        use little_exif::rational::uR64;
        let base = std::env::temp_dir().join(format!("image-plus-exif-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("photo.jpg");
        RgbImage::from_pixel(80, 40, image::Rgb([10, 200, 10])).save(&src).unwrap();
        let mut meta = Metadata::new();
        meta.set_tag(ExifTag::Orientation(vec![6]));
        meta.set_tag(ExifTag::Model("TestCam".to_string()));
        meta.set_tag(ExifTag::GPSLatitudeRef("N".to_string()));
        meta.set_tag(ExifTag::GPSLatitude(vec![uR64 { nominator: 37, denominator: 1 }; 3]));
        meta.write_to_file(&src).unwrap();

        let mut opts = options(Format::Jpeg);
        opts.resize = Resize::None;
        let read = |bytes: &Vec<u8>| Metadata::new_from_vec(bytes, FileExtension::JPEG).unwrap();
        let has = |m: &Metadata, hex: u16, group: ExifTagGroup| m.get_tag_by_hex(hex, Some(group)).next().is_some();

        let kept = render(&src, &opts).unwrap();
        let img = image::load_from_memory(&kept).unwrap();
        assert_eq!((img.width(), img.height()), (40, 80), "orientation 6 is applied to the pixels");
        let m = read(&kept);
        assert!(has(&m, 0x0110, ExifTagGroup::GENERIC), "camera model kept");
        assert!(has(&m, 0x0002, ExifTagGroup::GPS), "location kept");
        let orientation = m.get_tag(&ExifTag::Orientation(vec![])).next().map(|t| t.value_as_u8_vec(&little_exif::endian::Endian::Little));
        assert!(orientation.is_some());

        opts.metadata = MetaMode::StripGps;
        let m = read(&render(&src, &opts).unwrap());
        assert!(has(&m, 0x0110, ExifTagGroup::GENERIC));
        assert!(!has(&m, 0x0002, ExifTagGroup::GPS), "location removed");

        opts.metadata = MetaMode::Strip;
        let stripped = render(&src, &opts).unwrap();
        assert!(Metadata::new_from_vec(&stripped, FileExtension::JPEG).map_or(true, |m| !has(&m, 0x0110, ExifTagGroup::GENERIC)));
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn exports_heic_on_macos() {
        let base = std::env::temp_dir().join(format!("image-plus-heic-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("source.png");
        RgbImage::from_pixel(64, 32, image::Rgb([0, 128, 255])).save(&src).unwrap();
        let bytes = render(&src, &options(Format::Heic)).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        let _ = fs::remove_dir_all(base);
    }
}
