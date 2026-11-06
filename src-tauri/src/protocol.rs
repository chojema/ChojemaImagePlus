use crate::files::{self, Kind};
use crate::thumbs::{Context, Thumbs};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use percent_encoding::percent_decode_str;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::UriSchemeResponder;

fn request_path(request: &Request<Vec<u8>>) -> Option<PathBuf> {
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    Some(PathBuf::from(decoded.as_ref()))
}

fn ok(body: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Full image: served as-is when the web view can display it, otherwise decoded to PNG.
pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = request_path(request) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let result = match files::kind(&path) {
        None => return status(StatusCode::FORBIDDEN),
        Some(Kind::Video) => return video(request, &path),
        Some(Kind::Native) => fs::read(&path).map(|b| (b, files::mime(&path))).ok(),
        Some(Kind::Decoded) => decode(&path).map(|b| (b, "image/png")),
    };
    match result {
        Some((body, mime)) => ok(body, mime),
        None => status(StatusCode::NOT_FOUND),
    }
}

/// Longest part of a video sent in one response; players ask for the rest as they go.
const VIDEO_CHUNK: u64 = 4 * 1024 * 1024;

/// The requested byte range `start..=end` of a file of `len` bytes.
fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let last = len.checked_sub(1)?;
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Some((0, last.min(VIDEO_CHUNK - 1)));
    };
    let (from, to) = spec.split(',').next()?.trim().split_once('-')?;
    let (start, end) = if from.is_empty() {
        let n: u64 = to.parse().ok()?;
        (len.saturating_sub(n), last)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() { last } else { to.parse::<u64>().ok()?.min(last) };
        (start, end)
    };
    if start > end {
        return None;
    }
    Some((start, end.min(start + VIDEO_CHUNK - 1)))
}

/// Videos are served in parts, as media players expect.
fn video(request: &Request<Vec<u8>>, path: &Path) -> Response<Vec<u8>> {
    let Ok(mut file) = File::open(path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let Some((start, end)) = byte_range(range, len) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .header(header::CACHE_CONTROL, "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR));
    };
    let mut body = vec![0; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return status(StatusCode::NOT_FOUND);
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, files::mime(path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::CONTENT_LENGTH, body.len())
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Answers from the cache at once, or queues the thumbnail and answers once a worker has it.
pub fn thumbnail(request: &Request<Vec<u8>>, thumbs: &Thumbs, responder: UriSchemeResponder) {
    let Some(path) = request_path(request) else {
        return responder.respond(status(StatusCode::BAD_REQUEST));
    };
    if files::kind(&path).is_none() {
        return responder.respond(status(StatusCode::FORBIDDEN));
    }
    let query: Vec<_> = request.uri().query().unwrap_or_default().split('&').collect();
    let number = |key: &str| query.iter().find_map(|part| part.strip_prefix(key)).and_then(|value| value.parse::<u64>().ok());
    let context = match (number("owner="), number("view=")) {
        (Some(owner), Some(revision)) => Some(Context { owner, revision }),
        (None, None) => None,
        _ => return responder.respond(status(StatusCode::BAD_REQUEST)),
    };
    // A slow request is not evidence of cache corruption. Only a decode error repairs it.
    if query.contains(&"repair=1") {
        thumbs.invalidate(&path);
    }
    thumbs.request_in_view(
        path,
        context,
        Box::new(move |result| {
            responder.respond(match result {
                Some((body, mime)) => ok(body, mime),
                None => status(StatusCode::NOT_FOUND),
            })
        }),
    );
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
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("empty response")
}

#[cfg(test)]
mod tests {
    use super::{byte_range, decode, VIDEO_CHUNK};

    #[test]
    fn video_ranges_are_bounded_parts_of_the_file() {
        assert_eq!(byte_range(None, 10), Some((0, 9)));
        assert_eq!(byte_range(Some("bytes=0-"), 10), Some((0, 9)));
        assert_eq!(byte_range(Some("bytes=0-1"), 10), Some((0, 1)));
        assert_eq!(byte_range(Some("bytes=4-100"), 10), Some((4, 9)));
        assert_eq!(byte_range(Some("bytes=-3"), 10), Some((7, 9)));
        assert_eq!(byte_range(Some("bytes=10-"), 10), None);
        assert_eq!(byte_range(Some("bytes=0-"), 0), None);
        let big = VIDEO_CHUNK * 3;
        assert_eq!(byte_range(Some("bytes=0-"), big), Some((0, VIDEO_CHUNK - 1)));
        assert_eq!(byte_range(Some("bytes=5-"), big), Some((5, VIDEO_CHUNK + 4)));
    }

    #[test]
    fn transient_errors_are_not_cached_by_the_webview() {
        let response = super::status(tauri::http::StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[tauri::http::header::CACHE_CONTROL], "no-store");
    }

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
