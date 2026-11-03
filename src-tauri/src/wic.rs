//! Decoding through Windows Imaging Component, which uses the codecs installed
//! on the system (for example the HEIF and HEVC extensions).
use std::path::Path;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_UI2;
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::*;

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

pub fn decode(path: &Path) -> Option<Pixels> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let wide = HSTRING::from(path.as_os_str());
        let decoder = factory
            .CreateDecoderFromFilename(PCWSTR(wide.as_ptr()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)
            .ok()?;
        let frame = decoder.GetFrame(0).ok()?;
        let options = transform(orientation(&frame));
        let source: IWICBitmapSource = if options == WICBitmapTransformRotate0 {
            frame.clone().into()
        } else {
            let rotator = factory.CreateBitmapFlipRotator().ok()?;
            rotator.Initialize(&frame, options).ok()?;
            rotator.into()
        };
        let converter = factory.CreateFormatConverter().ok()?;
        converter
            .Initialize(&source, &GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
            .ok()?;
        let (mut width, mut height) = (0, 0);
        converter.GetSize(&mut width, &mut height).ok()?;
        let stride = width.checked_mul(4)?;
        let mut rgba = vec![0u8; (stride as usize).checked_mul(height as usize)?];
        converter.CopyPixels(std::ptr::null(), stride, &mut rgba).ok()?;
        Some(Pixels { width, height, rgba })
    }
}
