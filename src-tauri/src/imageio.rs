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
