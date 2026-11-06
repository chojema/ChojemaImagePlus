//! Thumbnails through macOS ImageIO, which decodes JPEGs at reduced size, reads HEIC,
//! AVIF and camera RAW files, and applies the photo's orientation. Video frames come from
//! AVFoundation.
#![allow(deprecated)]
use objc2_av_foundation::{AVAsset, AVAssetImageGenerator};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFMutableData, CFNumber, CFString, CFType, CGSize, CFURL};
use objc2_core_media::CMTime;
use objc2_foundation::NSURL;
use objc2_core_graphics::{CGImage, CGImageAlphaInfo};
use objc2_image_io::{
    kCGImageDestinationLossyCompressionQuality, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCache, kCGImageSourceThumbnailMaxPixelSize,
    CGImageDestination, CGImageSource,
};
use std::path::Path;

/// Encoded thumbnail bytes with their file extension and media type.
pub fn thumbnail(path: &Path, max: u32) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let url = CFURL::from_file_path(path)?;
    let source = unsafe { CGImageSource::with_url(&url, None) }?;

    let yes: &CFType = CFBoolean::new(true).as_ref();
    let no: &CFType = CFBoolean::new(false).as_ref();
    let size = CFNumber::new_i32(max as i32);
    // Reuse an embedded preview only when it can supply the full requested resolution.
    // With creation disabled, an absent thumbnail does not decode the original twice.
    let embedded_options = unsafe {
        CFDictionary::<CFString, CFType>::from_slices(
            &[
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceThumbnailMaxPixelSize,
                kCGImageSourceShouldCache,
            ],
            &[no, yes, size.as_ref(), no],
        )
    };
    let embedded = unsafe { source.thumbnail_at_index(0, Some(embedded_options.as_opaque())) }
        .filter(|image| CGImage::width(Some(image)).max(CGImage::height(Some(image))) >= max as usize);
    if let Some(image) = embedded { return encode(&image); }
    let options = unsafe {
        CFDictionary::<CFString, CFType>::from_slices(
            &[
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceThumbnailMaxPixelSize,
                kCGImageSourceShouldCache,
            ],
            &[yes, yes, size.as_ref(), no],
        )
    };
    let image = unsafe { source.thumbnail_at_index(0, Some(options.as_opaque())) }?;
    encode(&image)
}

/// A frame shortly after the start of a video, upright and scaled to fit `max`.
pub fn video_thumbnail(path: &Path, max: u32) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let url = NSURL::from_file_path(path)?;
    let image = unsafe {
        let asset = AVAsset::assetWithURL(&url);
        let generator = AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset);
        generator.setAppliesPreferredTrackTransform(true);
        generator.setMaximumSize(CGSize::new(max as f64, max as f64));
        let tolerance = CMTime::with_seconds(2.0, 600);
        generator.setRequestedTimeToleranceBefore(tolerance);
        generator.setRequestedTimeToleranceAfter(tolerance);
        let duration = asset.duration().seconds();
        let at = if duration.is_finite() && duration > 0.0 { (duration * 0.1).min(1.0) } else { 0.0 };
        generator
            .copyCGImageAtTime_actualTime_error(CMTime::with_seconds(at, 600), std::ptr::null_mut())
            .or_else(|_| generator.copyCGImageAtTime_actualTime_error(CMTime::with_seconds(0.0, 600), std::ptr::null_mut()))
            .ok()?
    };
    encode(&image)
}

fn encode(image: &CGImage) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let alpha = !matches!(
        CGImage::alpha_info(Some(image)),
        CGImageAlphaInfo::None | CGImageAlphaInfo::NoneSkipFirst | CGImageAlphaInfo::NoneSkipLast
    );
    let (uti, ext, mime) = if alpha {
        ("public.png", "png", "image/png")
    } else {
        ("public.jpeg", "jpg", "image/jpeg")
    };
    let data = CFMutableData::new(None, 0)?;
    let destination = unsafe { CGImageDestination::with_data(&data, &CFString::from_static_str(uti), 1, None) }?;
    let quality = CFNumber::new_f64(0.82);
    let props = unsafe {
        CFDictionary::<CFString, CFType>::from_slices(&[kCGImageDestinationLossyCompressionQuality], &[quality.as_ref()])
    };
    unsafe { destination.add_image(image, Some(props.as_opaque())) };
    if !unsafe { destination.finalize() } {
        return None;
    }
    Some((data.to_vec(), ext, mime))
}

#[cfg(test)]
mod tests {
    use image::{ImageEncoder, GenericImageView};

    fn jpeg(w: u32, h: u32, color: [u8; 3]) -> Vec<u8> {
        let mut data = Vec::new();
        let img = image::RgbImage::from_pixel(w, h, image::Rgb(color));
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut data, 90)
            .write_image(&img, w, h, image::ExtendedColorType::Rgb8).unwrap();
        data
    }

    // An independent TIFF IFD1 fixture: main pixels are red, embedded JPEG is blue.
    fn with_thumbnail(main: &[u8], thumbnail: &[u8]) -> Vec<u8> {
        let mut tiff = b"II\x2a\0\x08\0\0\0".to_vec();
        tiff.extend(1u16.to_le_bytes());
        tiff.extend(0x0112u16.to_le_bytes()); // IFD0 orientation: rotate 90 degrees.
        tiff.extend(3u16.to_le_bytes());
        tiff.extend(1u32.to_le_bytes());
        tiff.extend(6u32.to_le_bytes());
        tiff.extend(26u32.to_le_bytes()); // Next IFD.
        tiff.extend(3u16.to_le_bytes());
        for (tag, ty, value) in [(0x0103u16, 3u16, 6u32), (0x0201, 4, 68), (0x0202, 4, thumbnail.len() as u32)] {
            tiff.extend(tag.to_le_bytes());
            tiff.extend(ty.to_le_bytes());
            tiff.extend(1u32.to_le_bytes());
            tiff.extend(value.to_le_bytes());
        }
        tiff.extend(0u32.to_le_bytes());
        assert_eq!(tiff.len(), 68);
        tiff.extend(thumbnail);
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend(tiff);
        let mut data = main[..2].to_vec();
        data.extend([0xff, 0xe1]);
        data.extend(((exif.len() + 2) as u16).to_be_bytes());
        data.extend(exif);
        data.extend(&main[2..]);
        data
    }

    #[test]
    fn large_embedded_preview_is_reused_and_upright() {
        let path = std::env::temp_dir().join(format!("image-plus-embedded-large-{}.jpg", std::process::id()));
        std::fs::write(&path, with_thumbnail(&jpeg(800, 300, [240, 0, 0]), &jpeg(400, 150, [0, 0, 240]))).unwrap();
        let (bytes, _, _) = super::thumbnail(&path, 320).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!(image.dimensions(), (120, 320));
        let pixel = image.get_pixel(60, 160);
        assert!(pixel[2] > 200 && pixel[0] < 20, "expected the embedded blue pixels");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn undersized_embedded_preview_keeps_full_thumbnail_quality() {
        let path = std::env::temp_dir().join(format!("image-plus-embedded-small-{}.jpg", std::process::id()));
        std::fs::write(&path, with_thumbnail(&jpeg(800, 300, [240, 0, 0]), &jpeg(80, 30, [0, 0, 240]))).unwrap();
        let (bytes, _, _) = super::thumbnail(&path, 320).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!(image.dimensions(), (120, 320));
        let pixel = image.get_pixel(60, 160);
        assert!(pixel[0] > 200 && pixel[2] < 20, "a small embedded image must not replace the full thumbnail");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn no_embedded_preview_falls_back_and_preserves_transparency() {
        let path = std::env::temp_dir().join(format!("image-plus-alpha-{}.png", std::process::id()));
        image::RgbaImage::from_pixel(640, 320, image::Rgba([0, 200, 0, 100])).save(&path).unwrap();
        let (bytes, _, mime) = super::thumbnail(&path, 320).unwrap();
        assert_eq!(mime, "image/png");
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!(image.dimensions(), (320, 160));
        assert!((90..=110).contains(&image.get_pixel(100, 80)[3]));
        let _ = std::fs::remove_file(path);
    }
}
