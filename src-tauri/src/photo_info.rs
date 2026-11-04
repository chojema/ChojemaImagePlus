use little_exif::endian::Endian;
use little_exif::exif_tag::ExifTag;
use little_exif::exif_tag_format::ExifTagFormat;
use little_exif::ifd::ExifTagGroup::{self, EXIF, GENERIC, GPS};
use little_exif::metadata::Metadata;
use serde::Serialize;
use std::path::Path;

#[derive(Default, Serialize)]
pub struct PhotoInfo {
    camera_make: Option<String>,
    camera_model: Option<String>,
    lens: Option<String>,
    captured_at: Option<String>,
    captured_offset: Option<String>,
    exposure_seconds: Option<f64>,
    aperture: Option<f64>,
    iso: Option<u32>,
    focal_mm: Option<f64>,
    focal_35mm: Option<u32>,
    exposure_bias: Option<f64>,
    flash_fired: Option<bool>,
    white_balance: Option<u32>,
    artist: Option<String>,
    copyright: Option<String>,
    location: Option<Location>,
}

#[derive(Serialize)]
struct Location {
    latitude: f64,
    longitude: f64,
    altitude: Option<f64>,
}

/// Reads metadata only; never decodes image pixels or writes to the source file.
pub fn read(path: &Path) -> Result<PhotoInfo, String> {
    let Some(kind) = crate::files::kind(path) else {
        return Err("unsupported".into());
    };
    let file = std::fs::metadata(path).map_err(|_| "not_found".to_string())?;
    if !file.is_file() {
        return Err("not_found".into());
    }
    if kind == crate::files::Kind::Video {
        return Ok(PhotoInfo::default());
    }
    // A missing EXIF block is normal (screenshots, exports, GIF/SVG, etc.). Malformed EXIF
    // must not prevent the viewer from displaying an otherwise readable image.
    Ok(std::panic::catch_unwind(|| {
        Metadata::new_from_path(path).ok().map(|metadata| extract(&metadata)).unwrap_or_default()
    }).unwrap_or_default())
}

fn tag(metadata: &Metadata, id: u16, group: ExifTagGroup) -> Option<&ExifTag> {
    // Thumbnail IFDs can contain different camera settings. Use the primary image only.
    metadata.get_ifd(group, 0)?.get_tags().iter().find(|tag| tag.as_u16() == id)
}

fn text(metadata: &Metadata, id: u16, group: ExifTagGroup) -> Option<String> {
    let tag = tag(metadata, id, group)?;
    if tag.format() != ExifTagFormat::STRING {
        return None;
    }
    let bytes = tag.value_as_u8_vec(&Endian::Little);
    let value: String = String::from_utf8_lossy(&bytes).chars().filter(|c| !c.is_control()).take(512).collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn numbers(metadata: &Metadata, id: u16, group: ExifTagGroup) -> Option<Vec<f64>> {
    let tag = tag(metadata, id, group)?;
    let bytes = tag.value_as_u8_vec(&Endian::Little);
    use ExifTagFormat::*;
    let (width, signed, rational) = match tag.format() {
        INT8U | UNDEF => (1, false, false),
        INT16U => (2, false, false),
        INT32U => (4, false, false),
        INT32S => (4, true, false),
        RATIONAL64U => (8, false, true),
        RATIONAL64S => (8, true, true),
        _ => return None,
    };
    if bytes.is_empty() || bytes.len() % width != 0 {
        return None;
    }
    bytes.chunks_exact(width).take(4).map(|part| {
        let number = match width {
            1 => part[0] as f64,
            2 => u16::from_le_bytes(part.try_into().ok()?) as f64,
            4 if signed => i32::from_le_bytes(part.try_into().ok()?) as f64,
            4 => u32::from_le_bytes(part.try_into().ok()?) as f64,
            _ if rational => {
                let numerator = if signed {
                    i32::from_le_bytes(part[..4].try_into().ok()?) as f64
                } else {
                    u32::from_le_bytes(part[..4].try_into().ok()?) as f64
                };
                let denominator = if signed {
                    i32::from_le_bytes(part[4..].try_into().ok()?) as f64
                } else {
                    u32::from_le_bytes(part[4..].try_into().ok()?) as f64
                };
                if denominator == 0.0 { return None; }
                numerator / denominator
            }
            _ => return None,
        };
        number.is_finite().then_some(number)
    }).collect()
}

fn number(metadata: &Metadata, id: u16, group: ExifTagGroup) -> Option<f64> {
    numbers(metadata, id, group)?.first().copied()
}

fn positive(metadata: &Metadata, id: u16) -> Option<f64> {
    number(metadata, id, EXIF).filter(|value| *value > 0.0)
}

fn integer(metadata: &Metadata, id: u16) -> Option<u32> {
    positive(metadata, id).filter(|value| value.fract() == 0.0 && *value <= u32::MAX as f64).map(|value| value as u32)
}

fn coordinate(metadata: &Metadata, id: u16, reference: u16, latitude: bool) -> Option<f64> {
    let values = numbers(metadata, id, GPS)?;
    if values.len() != 3 { return None; }
    let (degrees, minutes, seconds) = (values[0], values[1], values[2]);
    if degrees < 0.0 || !(0.0..60.0).contains(&minutes) || !(0.0..60.0).contains(&seconds) { return None; }
    let magnitude = degrees + minutes / 60.0 + seconds / 3600.0;
    if magnitude > if latitude { 90.0 } else { 180.0 } { return None; }
    match (latitude, text(metadata, reference, GPS)?.to_uppercase().as_str()) {
        (true, "N") | (false, "E") => Some(magnitude),
        (true, "S") | (false, "W") => Some(-magnitude),
        _ => None,
    }
}

fn extract(metadata: &Metadata) -> PhotoInfo {
    let base_iso = integer(metadata, 0x8827);
    let iso = match base_iso {
        None | Some(65535) => integer(metadata, 0x8833).or(base_iso),
        _ => base_iso,
    };
    let location = coordinate(metadata, 0x0002, 0x0001, true)
        .zip(coordinate(metadata, 0x0004, 0x0003, false))
        .map(|(latitude, longitude)| {
            let altitude = number(metadata, 0x0006, GPS).filter(|value| *value >= 0.0).and_then(|value| {
                match number(metadata, 0x0005, GPS) {
                    Some(0.0) => Some(value),
                    Some(1.0) => Some(-value),
                    _ => None,
                }
            });
            Location { latitude, longitude, altitude }
        });
    PhotoInfo {
        camera_make: text(metadata, 0x010f, GENERIC),
        camera_model: text(metadata, 0x0110, GENERIC),
        lens: text(metadata, 0xa434, EXIF),
        captured_at: text(metadata, 0x9003, EXIF),
        captured_offset: text(metadata, 0x9011, EXIF),
        exposure_seconds: positive(metadata, 0x829a),
        aperture: positive(metadata, 0x829d),
        iso,
        focal_mm: positive(metadata, 0x920a),
        focal_35mm: integer(metadata, 0xa405),
        exposure_bias: number(metadata, 0x9204, EXIF),
        flash_fired: number(metadata, 0x9209, EXIF).map(|value| value as u32 & 1 != 0),
        white_balance: number(metadata, 0xa403, EXIF).map(|value| value as u32),
        artist: text(metadata, 0x013b, GENERIC),
        copyright: text(metadata, 0x8298, GENERIC),
        location,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use little_exif::rational::{iR64, uR64};

    fn rational(n: u32, d: u32) -> uR64 { uR64 { nominator: n, denominator: d } }

    fn metadata() -> Metadata {
        let mut m = Metadata::new();
        m.set_tag(ExifTag::Model("Test Camera".into()));
        m.set_tag(ExifTag::DateTimeOriginal("2026:11:04 09:00:00".into()));
        m.set_tag(ExifTag::ExposureTime(vec![rational(1, 125)]));
        m.set_tag(ExifTag::FNumber(vec![rational(28, 10)]));
        m.set_tag(ExifTag::ISO(vec![200]));
        m.set_tag(ExifTag::ExposureCompensation(vec![iR64 { nominator: -1, denominator: 3 }]));
        m.set_tag(ExifTag::GPSLatitudeRef("S".into()));
        m.set_tag(ExifTag::GPSLatitude(vec![rational(12, 1), rational(30, 1), rational(0, 1)]));
        m.set_tag(ExifTag::GPSLongitudeRef("W".into()));
        m.set_tag(ExifTag::GPSLongitude(vec![rational(45, 1), rational(15, 1), rational(0, 1)]));
        m.set_tag(ExifTag::GPSAltitudeRef(vec![1]));
        m.set_tag(ExifTag::GPSAltitude(vec![rational(125, 10)]));
        m
    }

    #[test]
    fn extracts_exposure_and_signed_gps_without_changing_source() {
        let dir = std::env::temp_dir().join(format!("image-plus-photo-info-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("photo.jpg");
        image::RgbImage::from_pixel(10, 8, image::Rgb([10, 20, 30])).save(&path).unwrap();
        metadata().write_to_file(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        let info = read(&path).unwrap();
        assert_eq!(info.camera_model.as_deref(), Some("Test Camera"));
        assert_eq!(info.iso, Some(200));
        assert_eq!(info.exposure_seconds, Some(1.0 / 125.0));
        assert_eq!(info.aperture, Some(2.8));
        assert_eq!(info.exposure_bias, Some(-1.0 / 3.0));
        let location = info.location.unwrap();
        assert_eq!((location.latitude, location.longitude, location.altitude), (-12.5, -45.25, Some(-12.5)));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_gps_and_zero_denominators_are_not_invented() {
        let mut m = metadata();
        m.set_tag(ExifTag::ExposureTime(vec![rational(1, 0)]));
        m.set_tag(ExifTag::GPSLatitude(vec![rational(91, 1), rational(0, 1), rational(0, 1)]));
        let info = extract(&m);
        assert!(info.exposure_seconds.is_none());
        assert!(info.location.is_none());
        m.set_tag(ExifTag::GPSLatitude(vec![rational(0, 1); 3]));
        m.set_tag(ExifTag::GPSLongitude(vec![rational(0, 1); 3]));
        assert_eq!(extract(&m).location.unwrap().latitude, 0.0);
        m.remove_tag_by_hex_group(0x0003, GPS);
        assert!(extract(&m).location.is_none());
    }

    #[test]
    fn extended_iso_is_used_and_digitization_is_not_reported_as_capture_time() {
        let mut m = Metadata::new();
        m.set_tag(ExifTag::ISO(vec![65535]));
        m.set_tag(ExifTag::ISOSpeed(vec![100000]));
        m.set_tag(ExifTag::CreateDate("2026:11:04 12:00:00".into()));
        let info = extract(&m);
        assert_eq!(info.iso, Some(100000));
        assert!(info.captured_at.is_none());
    }

    #[test]
    fn ordinary_png_has_no_exif_but_remains_readable() {
        let path = std::env::temp_dir().join(format!("image-plus-no-exif-{}.png", std::process::id()));
        image::RgbImage::from_pixel(4, 3, image::Rgb([0, 0, 0])).save(&path).unwrap();
        let info = read(&path).unwrap();
        assert!(info.camera_model.is_none() && info.location.is_none());
        let _ = std::fs::remove_file(path);
    }
}
