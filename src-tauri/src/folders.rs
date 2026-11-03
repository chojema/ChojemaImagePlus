use crate::files::natural_cmp;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub has_children: bool,
}

#[derive(Serialize)]
pub struct Roots {
    pub places: Vec<Folder>,
    pub drives: Vec<Folder>,
}

/// macOS packages appear as single files in Finder; browsing or changing their insides
/// (a Photos library, an app bundle) can damage them.
pub fn is_package(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    const PACKAGES: &[&str] = &[
        "photoslibrary", "photolibrary", "aplibrary", "migratedphotolibrary", "musiclibrary", "tvlibrary",
        "app", "bundle", "framework", "plugin", "kext", "appex", "xpc", "lrlibrary", "lrdata", "fcpbundle",
        "imovielibrary", "theater", "rtfd", "pages", "numbers", "key", "xcodeproj", "xcworkspace",
    ];
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| PACKAGES.contains(&e.to_ascii_lowercase().as_str()))
        && path.is_dir()
}

fn hidden(path: &Path, meta: &fs::Metadata) -> bool {
    if is_package(path) {
        return true;
    }
    let dot = path
        .file_name()
        .and_then(|n| n.to_str())
        .map_or(true, |n| n.starts_with('.') || n.starts_with('$'));
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    dot
}

fn visible_dirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let meta = fs::metadata(&path).ok()?;
            (meta.is_dir() && !hidden(&path, &meta)).then_some(path)
        })
}

fn folder(path: PathBuf, name: Option<String>) -> Folder {
    let has_children = visible_dirs(&path).next().is_some();
    Folder {
        name: name.unwrap_or_else(|| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned())
        }),
        path: path.to_string_lossy().into_owned(),
        has_children,
    }
}

pub fn children(dir: &Path) -> Result<Vec<Folder>, String> {
    if !dir.is_dir() {
        return Err("not_found".into());
    }
    let mut list: Vec<Folder> = visible_dirs(dir).map(|p| folder(p, None)).collect();
    list.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(list)
}

pub fn roots(places: Vec<(PathBuf, String)>) -> Roots {
    let places = places
        .into_iter()
        .filter(|(p, _)| p.is_dir())
        .map(|(p, name)| folder(p, Some(name)))
        .collect();

    #[cfg(windows)]
    let drives = (b'C'..=b'Z')
        .map(|letter| PathBuf::from(format!("{}:\\", letter as char)))
        .filter(|p| p.is_dir())
        .map(|p| {
            let name = p.to_string_lossy().trim_end_matches('\\').to_string();
            folder(p, Some(name))
        })
        .collect();

    #[cfg(not(windows))]
    let drives = {
        let mut list = vec![folder(PathBuf::from("/"), Some("/".into()))];
        #[cfg(target_os = "macos")]
        {
            let mut volumes: Vec<Folder> = fs::read_dir("/Volumes")
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| folder(e.path(), None))
                .collect();
            volumes.sort_by(|a, b| natural_cmp(&a.name, &b.name));
            list.extend(volumes);
        }
        list
    };

    Roots { places, drives }
}
