use crate::files::{self, Kind};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use percent_encoding::percent_decode_str;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};

pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    let Ok(decoded) = percent_decode_str(raw).decode_utf8() else {
        return status(StatusCode::BAD_REQUEST);
    };
    let path = PathBuf::from(decoded.as_ref());

    let result = match files::kind(&path) {
        None => return status(StatusCode::FORBIDDEN),
        Some(Kind::Native) => fs::read(&path).map(|b| (b, files::mime(&path))).ok(),
        Some(Kind::Decoded) => decode(&path).map(|b| (b, "image/png")),
    };

    match result {
        Some((body, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .body(body)
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
        None => status(StatusCode::NOT_FOUND),
    }
}

fn decode(path: &Path) -> Option<Vec<u8>> {
    #[cfg(windows)]
    if let Some(p) = crate::wic::decode(path) {
        return encode_png(&p.rgba, p.width, p.height, ExtendedColorType::Rgba8);
    }
    let img = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let mut out = Vec::new();
    img.write_with_encoder(encoder(&mut out)).ok()?;
    Some(out)
}

fn encoder(out: &mut Vec<u8>) -> PngEncoder<&mut Vec<u8>> {
    PngEncoder::new_with_quality(out, CompressionType::Fast, FilterType::NoFilter)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode_png(pixels: &[u8], width: u32, height: u32, color: ExtendedColorType) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    encoder(&mut out).write_image(pixels, width, height, color).ok()?;
    Some(out)
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .expect("empty response")
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_tiff_to_png() {
        let path = std::env::temp_dir().join("image-plus-test.tiff");
        image::RgbImage::from_pixel(3, 2, image::Rgb([10, 20, 30]))
            .save(&path)
            .unwrap();
        let png = decode(&path).expect("decoded");
        let back = image::load_from_memory(&png).unwrap();
        assert_eq!((back.width(), back.height()), (3, 2));
        let _ = std::fs::remove_file(path);
    }
}
