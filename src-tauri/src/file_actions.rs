use crate::transfer::{self, Done, Failure, Outcome};
use std::{fs, io, path::Path};

/// A single visible name, portable between the two supported systems.
pub fn validate_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty() || name.trim() != name || name.starts_with('.') || name.starts_with('$')
        || name.ends_with('.') || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("invalid_name".into());
    }
    Ok(())
}

fn writable_location(path: &Path) -> Result<(), String> {
    let real = fs::canonicalize(path).map_err(|e| transfer::reason(&e))?;
    if transfer::in_package(path) || transfer::in_package(&real) {
        return Err("protected".into());
    }
    Ok(())
}

pub fn create_folder(parent: &Path, name: &str) -> Result<String, String> {
    validate_name(name)?;
    writable_location(parent)?;
    let target = parent.join(name);
    fs::create_dir(&target).map_err(|e| transfer::reason(&e))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Atomic no-replace rename: an externally created destination must never be overwritten.
pub fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        unsafe extern "C" { fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> i32; }
        let a = CString::new(from.as_os_str().as_bytes())?;
        let b = CString::new(to.as_os_str().as_bytes())?;
        // RENAME_EXCL, from sys/stdio.h.
        if unsafe { renamex_np(a.as_ptr(), b.as_ptr(), 4) } == 0 { Ok(()) }
        else { Err(io::Error::last_os_error()) }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" { fn MoveFileW(from: *const u16, to: *const u16) -> i32; }
        let a: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileW(a.as_ptr(), b.as_ptr()) } != 0 { Ok(()) }
        else { Err(io::Error::last_os_error()) }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    { let _ = (from, to); Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported platform")) }
}

pub fn rename(path: &Path, name: &str, include_pairs: bool) -> Result<Outcome, String> {
    validate_name(name)?;
    writable_location(path)?;
    let parent = path.parent().ok_or("protected")?;
    if path.file_name().is_none() || fs::symlink_metadata(path).map_err(|e| transfer::reason(&e))?.is_symlink() {
        return Err("protected".into());
    }
    let target = parent.join(name);
    let mut items = vec![Done { from: path.to_string_lossy().into_owned(), to: target.to_string_lossy().into_owned() }];
    if path == target { return Ok(empty_outcome()); }
    if include_pairs && path.is_file() {
        let old = path.file_name().unwrap().to_string_lossy();
        let old_stem = path.file_stem().unwrap().to_string_lossy();
        let new_stem = target.file_stem().ok_or("invalid_name")?.to_string_lossy();
        for pair in transfer::pairs_of(path) {
            let full = pair.file_name().unwrap().to_string_lossy();
            let renamed = if full.to_lowercase().starts_with(&format!("{}.", old.to_lowercase())) {
                format!("{name}{}", full.chars().skip(old.chars().count()).collect::<String>())
            } else {
                format!("{new_stem}{}", full.chars().skip(old_stem.chars().count()).collect::<String>())
            };
            validate_name(&renamed)?;
            items.push(Done { from: pair.to_string_lossy().into_owned(), to: parent.join(renamed).to_string_lossy().into_owned() });
        }
    }
    // Preflight the whole group, including dangling symlinks. Each actual rename is exclusive too.
    for item in &items {
        if item.from != item.to && fs::symlink_metadata(&item.to).is_ok()
            && !case_change(Path::new(&item.from), Path::new(&item.to)) { return Err("exists".into()); }
    }
    Ok(apply(&items))
}

fn case_change(from: &Path, to: &Path) -> bool {
    from != to && from.file_name().zip(to.file_name()).is_some_and(|(a, b)| a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase())
        && fs::canonicalize(from).ok().zip(fs::canonicalize(to).ok()).is_some_and(|(a, b)| a == b)
}

fn rename_one(from: &Path, to: &Path) -> io::Result<()> {
    if !case_change(from, to) { return rename_exclusive(from, to); }
    // Case-insensitive volumes require an intermediate name. Every step refuses replacement.
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = from.parent().ok_or_else(|| io::Error::other("missing parent"))?;
    let temp = loop {
        let n = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp = parent.join(format!(".imageplus-rename-{}-{n}", std::process::id()));
        match rename_exclusive(from, &temp) {
            Ok(()) => break temp,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    if let Err(error) = rename_exclusive(&temp, to) {
        if let Err(rollback) = rename_exclusive(&temp, from) {
            return Err(io::Error::other(format!("{error}; restore failed: {rollback}; file retained at {}", temp.display())));
        }
        return Err(error);
    }
    Ok(())
}

fn empty_outcome() -> Outcome {
    Outcome { done: vec![], skipped: 0, failed: vec![], overwritten: 0, cancelled: false }
}

fn apply(items: &[Done]) -> Outcome {
    let mut result = empty_outcome();
    for item in items {
        if item.from == item.to { continue; }
        let from = Path::new(&item.from);
        let to = Path::new(&item.to);
        let changed = writable_location(from).and_then(|_| rename_one(from, to).map_err(|e| transfer::reason(&e)));
        match changed {
            Ok(()) => result.done.push(item.clone()),
            Err(error) => { result.failed.push(Failure { src: item.from.clone(), error }); break; }
        }
    }
    result
}

pub fn undo(items: &[Done]) -> Outcome {
    apply(&items.iter().rev().map(|d| Done { from: d.to.clone(), to: d.from.clone() }).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(label: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("imageplus-actions-{}-{label}", std::process::id()));
        fs::create_dir_all(&p).unwrap(); p
    }
    #[test]
    fn invalid_names_never_escape_or_hide() {
        for n in ["", "..", ".hidden", "$hidden", "../outside", "a/b", "a\\b", "a:", "end.", " a", "a ", "CON.jpg", "LPT1", "x\n"] {
            assert!(validate_name(n).is_err(), "{n:?}");
        }
        assert!(validate_name("여행 사진 01").is_ok());
    }
    #[test]
    fn create_rename_folder_and_preserve_conflicts() {
        let p = fixture("folder");
        let a = create_folder(&p, "새 폴더").unwrap();
        assert_eq!(create_folder(&p, "새 폴더").unwrap_err(), "exists");
        fs::write(Path::new(&a).join("keep.jpg"), b"original").unwrap();
        let done = rename(Path::new(&a), "여행", false).unwrap();
        assert_eq!(done.done.len(), 1);
        assert_eq!(fs::read(p.join("여행/keep.jpg")).unwrap(), b"original");
        assert_eq!(undo(&done.done).done.len(), 1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn rename_pairs_conflict_and_undo_without_overwrite() {
        let p = fixture("pairs");
        for n in ["A.jpg", "A.CR3", "A.jpg.xmp", "B.CR3"] { fs::write(p.join(n), n).unwrap(); }
        assert_eq!(rename(&p.join("A.jpg"), "B.jpg", true).err().unwrap(), "exists");
        assert!(p.join("A.jpg").exists());
        let done = rename(&p.join("A.jpg"), "C.jpg", true).unwrap();
        assert_eq!(done.done.len(), 3);
        assert_eq!(fs::read(p.join("C.jpg.xmp")).unwrap(), b"A.jpg.xmp");
        fs::write(p.join("A.jpg"), b"external").unwrap();
        let undone = undo(&done.done);
        assert_eq!(undone.failed.len(), 1);
        assert_eq!(fs::read(p.join("A.jpg")).unwrap(), b"external");
        assert_eq!(fs::read(p.join("C.jpg")).unwrap(), b"A.jpg");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn rename_letter_case_and_undo() {
        let p = fixture("case");
        fs::write(p.join("Photo.jpg"), b"unchanged").unwrap();
        let result = rename(&p.join("Photo.jpg"), "photo.jpg", false).unwrap();
        assert_eq!(result.done.len(), 1);
        assert_eq!(undo(&result.done).done.len(), 1);
        assert_eq!(fs::read(p.join("Photo.jpg")).unwrap(), b"unchanged");
        fs::remove_dir_all(p).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn packages_and_alias_destinations_are_protected() {
        let p = fixture("package");
        let lib = p.join("Library.photoslibrary"); fs::create_dir(&lib).unwrap();
        let alias = p.join("alias"); std::os::unix::fs::symlink(&lib, &alias).unwrap();
        assert_eq!(create_folder(&alias, "x").unwrap_err(), "protected");
        assert_eq!(rename(&lib, "other", false).err().unwrap(), "protected");
        fs::remove_dir_all(p).unwrap();
    }
}
