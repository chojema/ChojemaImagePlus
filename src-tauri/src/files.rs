use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Formats the system web view can display as-is.
const NATIVE: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "bmp", "ico", "avif", "svg",
];

#[cfg(target_os = "macos")]
const PLATFORM_NATIVE: &[&str] = &["tif", "tiff", "heic", "heif"];
#[cfg(not(target_os = "macos"))]
const PLATFORM_NATIVE: &[&str] = &[];

/// Formats decoded here and handed to the web view as PNG.
#[cfg(target_os = "macos")]
const DECODED: &[&str] = &[];
#[cfg(not(target_os = "macos"))]
const DECODED: &[&str] = &["tif", "tiff", "heic", "heif"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Native,
    Decoded,
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn kind(path: &Path) -> Option<Kind> {
    let ext = extension(path)?;
    let ext = ext.as_str();
    if NATIVE.contains(&ext) || PLATFORM_NATIVE.contains(&ext) {
        Some(Kind::Native)
    } else if DECODED.contains(&ext) {
        Some(Kind::Decoded)
    } else {
        None
    }
}

pub fn extensions() -> Vec<&'static str> {
    NATIVE
        .iter()
        .chain(PLATFORM_NATIVE)
        .chain(DECODED)
        .copied()
        .collect()
}

pub fn mime(path: &Path) -> &'static str {
    match extension(path).as_deref() {
        Some("jpg" | "jpeg" | "jpe" | "jfif") => "image/jpeg",
        Some("png") => "image/png",
        Some("apng") => "image/apng",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("tif" | "tiff") => "image/tiff",
        Some("heic") => "image/heic",
        Some("heif") => "image/heif",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub index: usize,
    /// The folder being browsed, when the list comes from a single folder.
    pub folder: Option<String>,
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map_or(true, |n| n.starts_with('.'))
}

fn entry(path: &Path) -> Option<Entry> {
    if is_hidden(path) || kind(path).is_none() {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(Entry {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        size: meta.len(),
        modified,
    })
}

fn sort(entries: &mut [Entry]) {
    entries.sort_by(|a, b| natural_cmp(&a.name, &b.name).then_with(|| a.name.cmp(&b.name)));
}

pub fn scan(dir: &Path) -> Result<Vec<Entry>, String> {
    let read = fs::read_dir(dir).map_err(|_| "not_found".to_string())?;
    let mut entries: Vec<Entry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| entry(&e.path()))
        .collect();
    sort(&mut entries);
    Ok(entries)
}

/// Images in `dir` and, when `recursive`, in all visible subfolders (packages and symbolic
/// links to folders are skipped), ordered by folder and then by name.
pub fn scan_tree(dir: &Path, recursive: bool, limit: usize) -> Result<Vec<Entry>, String> {
    if !recursive {
        return scan(dir);
    }
    if !dir.is_dir() {
        return Err("not_found".into());
    }
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(folder) = stack.pop() {
        let Ok(read) = fs::read_dir(&folder) else { continue };
        let mut subdirs = Vec::new();
        let mut here = Vec::new();
        for item in read.filter_map(|e| e.ok()) {
            let path = item.path();
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_dir() {
                let hidden = path.file_name().and_then(|n| n.to_str()).map_or(true, |n| n.starts_with('.'));
                if !hidden && !crate::folders::is_package(&path) {
                    subdirs.push(path);
                }
            } else if let Some(e) = entry(&path) {
                here.push(e);
            }
        }
        sort(&mut here);
        out.extend(here);
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
        subdirs.sort_by(|a, b| {
            natural_cmp(&a.to_string_lossy(), &b.to_string_lossy())
        });
        stack.extend(subdirs.into_iter().rev());
    }
    Ok(out)
}

/// One folder or file opens its whole folder; several files open as their own list.
pub fn open(paths: &[PathBuf]) -> Result<Listing, String> {
    match paths {
        [] => Err("no_images".into()),
        [single] => open_one(single),
        many => {
            let mut entries: Vec<Entry> = many.iter().filter_map(|p| entry(p)).collect();
            if entries.is_empty() {
                return Err("unsupported".into());
            }
            sort(&mut entries);
            let parent = |e: &Entry| Path::new(&e.path).parent().map(Path::to_path_buf);
            let first = parent(&entries[0]);
            let folder = if entries.iter().all(|e| parent(e) == first) {
                first.map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            };
            Ok(Listing { entries, index: 0, folder })
        }
    }
}

fn open_one(path: &Path) -> Result<Listing, String> {
    if path.is_dir() {
        let entries = scan(path)?;
        if entries.is_empty() {
            return Err("no_images".into());
        }
        let folder = Some(path.to_string_lossy().into_owned());
        return Ok(Listing { entries, index: 0, folder });
    }
    if !path.is_file() {
        return Err("not_found".into());
    }
    if kind(path).is_none() {
        return Err("unsupported".into());
    }
    let dir = path.parent().ok_or("not_found")?;
    let mut entries = scan(dir)?;
    let target = path.to_string_lossy();
    let index = match entries.iter().position(|e| e.path == target) {
        Some(i) => i,
        None => {
            // Hidden files are skipped by the scan but can still be opened directly.
            let e = entry_unfiltered(path).ok_or("not_found")?;
            entries.insert(0, e);
            0
        }
    };
    let folder = Some(dir.to_string_lossy().into_owned());
    Ok(Listing { entries, index, folder })
}

fn entry_unfiltered(path: &Path) -> Option<Entry> {
    let meta = fs::metadata(path).ok()?;
    Some(Entry {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        size: meta.len(),
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64),
    })
}

/// Case-insensitive comparison that orders digit runs by numeric value.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut a = a.chars().peekable();
    let mut b = b.chars().peekable();
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let na = take_digits(&mut a);
                let nb = take_digits(&mut b);
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let ord = ta
                    .len()
                    .cmp(&tb.len())
                    .then_with(|| ta.cmp(tb))
                    .then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                a.next();
                b.next();
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut s = String::new();
    while let Some(&c) = it.peek() {
        if !c.is_ascii_digit() {
            break;
        }
        s.push(c);
        it.next();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering;

    #[test]
    fn scan_tree_walks_subfolders_in_order() {
        let base = std::env::temp_dir().join(format!("image-plus-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for d in ["", "b", "a", "a/deep", ".hidden"] {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
        for f in ["2.jpg", "10.jpg", "b/x.png", "a/y.png", "a/deep/z.gif", ".hidden/h.jpg", "note.txt"] {
            std::fs::write(base.join(f), "x").unwrap();
        }
        let names = |v: Vec<super::Entry>| v.into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(super::scan_tree(&base, false, 100).unwrap()), ["2.jpg", "10.jpg"]);
        assert_eq!(
            names(super::scan_tree(&base, true, 100).unwrap()),
            ["2.jpg", "10.jpg", "y.png", "z.gif", "x.png"]
        );
        assert_eq!(super::scan_tree(&base, true, 3).unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn numbers_compare_by_value() {
        assert_eq!(natural_cmp("img2.jpg", "img10.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("img010.jpg", "img9.jpg"), Ordering::Greater);
        assert_eq!(natural_cmp("A.jpg", "b.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("x1", "x01"), Ordering::Less);
        assert_eq!(natural_cmp("same", "same"), Ordering::Equal);
    }
}
