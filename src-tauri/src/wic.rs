//! Decoding through Windows Imaging Component, which uses the codecs installed
//! on the system (for example the HEIF and HEVC extensions).
use std::path::Path;
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::VT_UI2;

pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

fn orientation(frame: &IWICBitmapFrameDecode) -> u16 {
    unsafe {
        let Ok(reader) = frame.GetMetadataQueryReader() else { return 1 };
        let name = HSTRING::from("System.Photo.Orientation");
        let mut value = PROPVARIANT::default();
        if reader.GetMetadataByName(PCWSTR(name.as_ptr()), &mut value).is_err() {
            return 1;
        }
        let inner = &value.Anonymous.Anonymous;
        if inner.vt == VT_UI2 {
            inner.Anonymous.uiVal
        } else {
            1
        }
    }
}

fn transform(o: u16) -> WICBitmapTransformOptions {
    match o {
        2 => WICBitmapTransformFlipHorizontal,
        3 => WICBitmapTransformRotate180,
        4 => WICBitmapTransformFlipVertical,
        5 => WICBitmapTransformOptions(WICBitmapTransformRotate90.0 | WICBitmapTransformFlipHorizontal.0),
        6 => WICBitmapTransformRotate90,
        7 => WICBitmapTransformOptions(WICBitmapTransformRotate270.0 | WICBitmapTransformFlipHorizontal.0),
        8 => WICBitmapTransformRotate270,
        _ => WICBitmapTransformRotate0,
    }
}

/// The first frame of the file, as stored.
fn frame(path: &Path) -> Option<(IWICImagingFactory, IWICBitmapFrameDecode)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let wide = HSTRING::from(path.as_os_str());
        let decoder = factory
            .CreateDecoderFromFilename(PCWSTR(wide.as_ptr()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)
            .ok()?;
        let frame = decoder.GetFrame(0).ok()?;
        Some((factory, frame))
    }
}

/// `source` turned upright by the orientation tag of `frame`.
fn upright(factory: &IWICImagingFactory, frame: &IWICBitmapFrameDecode, source: IWICBitmapSource) -> Option<IWICBitmapSource> {
    let options = transform(orientation(frame));
    if options == WICBitmapTransformRotate0 {
        return Some(source);
    }
    unsafe {
        let rotator = factory.CreateBitmapFlipRotator().ok()?;
        rotator.Initialize(&source, options).ok()?;
        Some(rotator.into())
    }
}

/// The first frame of the file, upright according to its orientation tag.
fn open(path: &Path) -> Option<(IWICImagingFactory, IWICBitmapSource)> {
    let (factory, frame) = frame(path)?;
    let source = upright(&factory, &frame, frame.clone().into())?;
    Some((factory, source))
}

/// The frame decoded at the smallest scale the codec produces natively (JPEG: 1/2, 1/4, 1/8)
/// whose longer side still covers `max`, so a thumbnail never decodes the full image.
fn reduced(factory: &IWICImagingFactory, frame: &IWICBitmapFrameDecode, max: u32) -> Option<IWICBitmapSource> {
    unsafe {
        let native: IWICBitmapSourceTransform = frame.cast().ok()?;
        let (mut w, mut h) = (0u32, 0u32);
        frame.GetSize(&mut w, &mut h).ok()?;
        let (mut tw, mut th) = (w, h);
        loop {
            let (mut cw, mut ch) = (tw / 2, th / 2);
            if cw.max(ch) < max || native.GetClosestSize(&mut cw, &mut ch).is_err() {
                break;
            }
            if cw.max(ch) < max || cw.max(ch) >= tw.max(th) || cw == 0 || ch == 0 {
                break;
            }
            (tw, th) = (cw, ch);
        }
        if (tw, th) == (w, h) {
            return None;
        }
        let mut format = frame.GetPixelFormat().ok()?;
        native.GetClosestPixelFormat(&mut format).ok()?;
        let info: IWICPixelFormatInfo = factory.CreateComponentInfo(&format).ok()?.cast().ok()?;
        let bits = info.GetBitsPerPixel().ok()?;
        let stride = (tw.checked_mul(bits)?.div_ceil(8) + 3) & !3;
        let mut buffer = vec![0u8; (stride as usize).checked_mul(th as usize)?];
        native.CopyPixels(std::ptr::null(), tw, th, &format, WICBitmapTransformRotate0, stride, &mut buffer).ok()?;
        let bitmap = factory.CreateBitmapFromMemory(tw, th, &format, stride, &buffer).ok()?;
        Some(bitmap.into())
    }
}

fn pixels(factory: &IWICImagingFactory, source: &IWICBitmapSource) -> Option<Pixels> {
    unsafe {
        let converter = factory.CreateFormatConverter().ok()?;
        converter
            .Initialize(source, &GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
            .ok()?;
        let (mut width, mut height) = (0, 0);
        converter.GetSize(&mut width, &mut height).ok()?;
        let stride = width.checked_mul(4)?;
        let mut rgba = vec![0u8; (stride as usize).checked_mul(height as usize)?];
        converter.CopyPixels(std::ptr::null(), stride, &mut rgba).ok()?;
        Some(Pixels { width, height, rgba })
    }
}

pub fn decode(path: &Path) -> Option<Pixels> {
    let (factory, source) = open(path)?;
    pixels(&factory, &source)
}

/// Scaled so the longer side is at most `max` pixels. Scales before rotating: a rotator pulls
/// its source strip by strip, so rotating a large image first decodes it again for every strip
/// (minutes for a 48 MP portrait photo).
pub fn thumbnail(path: &Path, max: u32) -> Option<Pixels> {
    let (factory, frame) = frame(path)?;
    let source = reduced(&factory, &frame, max).unwrap_or_else(|| frame.clone().into());
    let small: IWICBitmapSource = unsafe { factory.CreateBitmapFromSource(&scaled(&factory, source, max)?, WICBitmapCacheOnLoad) }.ok()?.into();
    let source = upright(&factory, &frame, small)?;
    pixels(&factory, &source)
}

fn fit(factory: &IWICImagingFactory, source: &IWICBitmapSource, max: u32) -> Option<Pixels> {
    pixels(factory, &scaled(factory, source.clone(), max)?)
}

/// `source` behind a scaler when its longer side exceeds `max`.
fn scaled(factory: &IWICImagingFactory, source: IWICBitmapSource, max: u32) -> Option<IWICBitmapSource> {
    unsafe {
        let (mut w, mut h) = (0u32, 0u32);
        source.GetSize(&mut w, &mut h).ok()?;
        if w == 0 || h == 0 {
            return None;
        }
        if w <= max && h <= max {
            return Some(source);
        }
        let ratio = max as f64 / w.max(h) as f64;
        let tw = ((w as f64 * ratio).round() as u32).max(1);
        let th = ((h as f64 * ratio).round() as u32).max(1);
        let scaler = factory.CreateBitmapScaler().ok()?;
        scaler.Initialize(&source, tw, th, WICBitmapInterpolationModeFant).ok()?;
        Some(scaler.into())
    }
}

/// The thumbnail File Explorer shows, which covers videos for every installed codec.
pub fn shell_thumbnail(path: &Path, max: u32) -> Option<Pixels> {
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HPALETTE};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let wide = HSTRING::from(path.as_os_str());
        let item: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
        let size = SIZE { cx: max as i32, cy: max as i32 };
        let bitmap = item.GetImage(size, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK).ok()?;
        let result = CoCreateInstance::<_, IWICImagingFactory>(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
            .ok()
            .and_then(|factory| {
                let source = factory.CreateBitmapFromHBITMAP(bitmap, HPALETTE::default(), WICBitmapIgnoreAlpha).ok()?;
                fit(&factory, &source.into(), max)
            });
        let _ = DeleteObject(bitmap.into());
        result
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn thumbnail_of_large_jpeg_uses_reduced_decode_and_keeps_shape() {
        let path = std::env::temp_dir().join(format!("wic-thumb-{}.jpg", std::process::id()));
        image::RgbImage::from_pixel(2400, 1200, image::Rgb([200, 30, 30])).save(&path).unwrap();
        let (factory, frame) = super::frame(&path).unwrap();
        let reduced = super::reduced(&factory, &frame, 320).expect("JPEG decodes at a native reduced scale");
        let (mut w, mut h) = (0, 0);
        unsafe { reduced.GetSize(&mut w, &mut h).unwrap() };
        assert_eq!((w, h), (600, 300), "smallest native scale that still covers 320 px");
        let thumb = super::thumbnail(&path, 320).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!((thumb.width, thumb.height), (320, 160));
        assert!(thumb.rgba[0] > 150 && thumb.rgba[1] < 80, "colour survives the reduced decode");
    }
}
