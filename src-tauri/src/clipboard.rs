use serde::Serialize;

#[derive(Serialize)]
pub struct Files {
    pub paths: Vec<String>,
    pub cut: bool,
    pub token: String,
}

pub fn write(paths: &[String], cut: bool, owner: usize) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 100_000 || paths.iter().any(|p| p.contains('\0') || !std::path::Path::new(p).is_absolute()) {
        return Err("clipboard_empty".into());
    }
    platform::write(paths, cut, owner)
}

pub fn read() -> Result<Files, String> {
    let mut files = platform::read()?;
    // File URLs may decompose Unicode or use an alias such as /tmp. Recover the actual
    // filesystem spelling before pair-file discovery and destination naming.
    for path in &mut files.paths {
        if let Ok(real) = std::fs::canonicalize(&path) { *path = real.to_string_lossy().into_owned(); }
    }
    Ok(files)
}

fn path_key(path: &str) -> String {
    let path = std::path::Path::new(path);
    let resolved = path.parent().and_then(|p| std::fs::canonicalize(p).ok())
        .and_then(|p| path.file_name().map(|name| p.join(name)))
        .unwrap_or_else(|| path.to_path_buf()).to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    { objc2_foundation::NSString::from_str(&resolved).precomposedStringWithCanonicalMapping().to_string() }
    #[cfg(windows)]
    { resolved.replace('/', "\\").to_lowercase() }
    #[cfg(not(any(target_os = "macos", windows)))]
    { resolved }
}

/// Only consume paths actually moved. Do not touch a clipboard replaced during a long transfer.
pub fn consume(token: &str, moved: &[String], owner: usize) -> Result<(), String> {
    let current = read()?;
    if !current.cut || current.token != token { return Ok(()); }
    let moved: std::collections::HashSet<_> = moved.iter().map(|p| path_key(p)).collect();
    let remaining: Vec<_> = current.paths.into_iter().filter(|p| !moved.contains(&path_key(p))).collect();
    if remaining.is_empty() { platform::clear() } else { write(&remaining, true, owner) }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Files;
    use objc2::{rc::autoreleasepool, runtime::ProtocolObject};
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn write(paths: &[String], cut: bool, _owner: usize) -> Result<(), String> {
        autoreleasepool(|_| {
            let urls: Vec<_> = paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(p))).collect();
            let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = urls.iter().map(|u| ProtocolObject::from_ref(&**u)).collect();
            let board = NSPasteboard::generalPasteboard();
            board.clearContents();
            if !board.writeObjects(&NSArray::from_slice(&objects)) { return Err("clipboard_failed".into()); }
            if cut && !board.setString_forType(&NSString::from_str("1"), &NSString::from_str("com.chojema.imageplus.cut")) {
                return Err("clipboard_failed".into());
            }
            Ok(())
        })
    }
    pub fn read() -> Result<Files, String> {
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            let token = board.changeCount().to_string();
            let mut paths = Vec::new();
            if let Some(items) = board.pasteboardItems() {
                for item in items.iter().take(100_000) {
                    if let Some(raw) = item.stringForType(&NSString::from_str("public.file-url")) {
                        if let Some(url) = NSURL::URLWithString(&raw) {
                            if url.isFileURL() {
                                if let Some(path) = url.path() { paths.push(path.to_string()); }
                            }
                        }
                    }
                }
            }
            let cut = board.stringForType(&NSString::from_str("com.chojema.imageplus.cut")).is_some_and(|s| s.to_string() == "1");
            Ok(Files { paths, cut, token })
        })
    }
    pub fn clear() -> Result<(), String> { NSPasteboard::generalPasteboard().clearContents(); Ok(()) }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::NSArray;

    /// Preserve every data type in memory; the user's clipboard is restored even after a panic.
    struct Restore(Vec<Retained<NSPasteboardItem>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let board = NSPasteboard::generalPasteboard();
            board.clearContents();
            if !self.0.is_empty() {
                let refs: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = self.0.iter().map(|i| ProtocolObject::from_ref(&**i)).collect();
                board.writeObjects(&NSArray::from_slice(&refs));
            }
        }
    }
    #[test]
    #[ignore = "uses system clipboard, preserving and restoring all current data"]
    fn native_file_clipboard_roundtrip_partial_and_stale_consume() {
        let board = NSPasteboard::generalPasteboard();
        let mut saved = Vec::new();
        if let Some(items) = board.pasteboardItems() {
            for item in items.iter() {
                let backup = NSPasteboardItem::new();
                for ty in item.types().iter() {
                    if let Some(data) = item.dataForType(&ty) { assert!(backup.setData_forType(&data, &ty)); }
                }
                saved.push(backup);
            }
        }
        let _restore = Restore(saved);
        let paths: Vec<_> = ["/private/tmp/사진 one.jpg", "/private/tmp/두 번째.png"].iter().map(|p| {
            // NSURL uses the filesystem's decomposed Unicode representation on macOS.
            objc2_foundation::NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(p)).path().unwrap().to_string()
        }).collect();
        write(&paths, false, 0).unwrap();
        let files = read().unwrap();
        assert_eq!(files.paths, paths);
        assert!(!files.cut);
        write(&paths, true, 0).unwrap();
        let cut = read().unwrap();
        assert!(cut.cut);
        assert_eq!(cut.paths, paths);
        consume(&cut.token, &[paths[0].clone()], 0).unwrap();
        let rest = read().unwrap();
        assert_eq!(rest.paths, paths[1..]);
        assert!(rest.cut);
        consume(&cut.token, &[paths[1].clone()], 0).unwrap();
        assert_eq!(read().unwrap().paths, paths[1..]);
        consume(&rest.token, &[paths[1].clone()], 0).unwrap();
        assert!(read().unwrap().paths.is_empty());
    }
}

#[cfg(windows)]
mod platform {
    use super::Files;
    use std::{ffi::c_void, ptr};
    type Handle = *mut c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(owner: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn GetClipboardData(format: u32) -> Handle;
        fn SetClipboardData(format: u32, data: Handle) -> Handle;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn GetClipboardSequenceNumber() -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(data: Handle) -> Handle;
        fn GlobalUnlock(data: Handle) -> i32;
        fn GlobalFree(data: Handle) -> Handle;
        fn GlobalSize(data: Handle) -> usize;
    }
    #[link(name = "shell32")]
    unsafe extern "system" { fn DragQueryFileW(drop: Handle, index: u32, out: *mut u16, count: u32) -> u32; }
    struct Open;
    impl Drop for Open { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
    fn open(owner: usize) -> Result<Open, String> {
        if unsafe { OpenClipboard(owner as Handle) } == 0 { Err("clipboard_failed".into()) } else { Ok(Open) }
    }
    fn effect_format() -> u32 {
        let name: Vec<_> = "Preferred DropEffect".encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }
    struct Block(Handle);
    impl Drop for Block { fn drop(&mut self) { if !self.0.is_null() { unsafe { GlobalFree(self.0); } } } }
    impl Block {
        fn new(bytes: &[u8]) -> Result<Self, String> {
            let block = Self(unsafe { GlobalAlloc(0x42, bytes.len()) }); // GMEM_MOVEABLE | GMEM_ZEROINIT
            if block.0.is_null() { return Err("clipboard_failed".into()); }
            let locked = unsafe { GlobalLock(block.0) };
            if locked.is_null() { return Err("clipboard_failed".into()); }
            unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), locked.cast(), bytes.len()); GlobalUnlock(block.0); }
            Ok(block)
        }
        fn publish(mut self, format: u32) -> Result<(), String> {
            if format == 0 || unsafe { SetClipboardData(format, self.0) }.is_null() { return Err("clipboard_failed".into()); }
            self.0 = ptr::null_mut(); // The OS owns successful publications.
            Ok(())
        }
    }
    pub fn write(paths: &[String], cut: bool, owner: usize) -> Result<(), String> {
        // DROPFILES header: pFiles, POINT, fNC, fWide, followed by a double-NUL UTF-16 list.
        let mut bytes = vec![0u8; 20];
        bytes[0..4].copy_from_slice(&20u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        for p in paths { for c in p.encode_utf16().chain(Some(0)) { bytes.extend_from_slice(&c.to_le_bytes()); } }
        bytes.extend_from_slice(&0u16.to_le_bytes());
        let files = Block::new(&bytes)?;
        let effect = Block::new(&(if cut { 2u32 } else { 1u32 }).to_le_bytes())?;
        let format = effect_format();
        if format == 0 { return Err("clipboard_failed".into()); }
        let _open = open(owner)?;
        if unsafe { EmptyClipboard() } == 0 { return Err("clipboard_failed".into()); }
        files.publish(15)?; // CF_HDROP
        effect.publish(format)
    }
    pub fn read() -> Result<Files, String> {
        let _open = open(0)?;
        let token = unsafe { GetClipboardSequenceNumber() }.to_string();
        let drop = unsafe { GetClipboardData(15) };
        let mut paths = Vec::new();
        if !drop.is_null() {
            let count = unsafe { DragQueryFileW(drop, u32::MAX, ptr::null_mut(), 0) }.min(100_000);
            for i in 0..count {
                let len = unsafe { DragQueryFileW(drop, i, ptr::null_mut(), 0) };
                if len == 0 || len > 32768 { continue; }
                let mut text = vec![0u16; len as usize + 1];
                let read = unsafe { DragQueryFileW(drop, i, text.as_mut_ptr(), len + 1) };
                if read > 0 { paths.push(String::from_utf16_lossy(&text[..read as usize])); }
            }
        }
        let effect = unsafe { GetClipboardData(effect_format()) };
        let cut = if !effect.is_null() && unsafe { GlobalSize(effect) } >= 4 {
            let data = unsafe { GlobalLock(effect) };
            if data.is_null() { false } else {
                let value = unsafe { ptr::read_unaligned(data.cast::<u32>()) };
                unsafe { GlobalUnlock(effect); }
                value & 2 != 0
            }
        } else { false };
        Ok(Files { paths, cut, token })
    }
    pub fn clear() -> Result<(), String> {
        let _open = open(0)?;
        if unsafe { EmptyClipboard() } == 0 { Err("clipboard_failed".into()) } else { Ok(()) }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::Files;
    pub fn write(_: &[String], _: bool, _: usize) -> Result<(), String> { Err("clipboard_failed".into()) }
    pub fn read() -> Result<Files, String> { Err("clipboard_failed".into()) }
    pub fn clear() -> Result<(), String> { Err("clipboard_failed".into()) }
}
