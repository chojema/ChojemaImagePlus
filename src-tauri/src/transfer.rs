use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Move,
    Copy,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Serialize)]
pub struct PlannedFile {
    pub src: String,
    pub name: String,
    pub pair: bool,
    pub exists: bool,
    /// Files of one image and its pair files share a group and are resolved together.
    pub group: usize,
}

#[derive(Serialize)]
pub struct Plan {
    pub files: Vec<PlannedFile>,
    pub pairs: usize,
    pub same_folder: bool,
    /// Sources lie inside a photo library package, whose files must not be moved out.
    pub copy_only: bool,
}

#[derive(Deserialize)]
pub struct Job {
    pub src: String,
    pub group: usize,
    pub resolution: Option<Resolution>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Done {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
pub struct Failure {
    pub src: String,
    pub error: String,
}

#[derive(Serialize)]
pub struct Outcome {
    pub done: Vec<Done>,
    pub skipped: usize,
    pub failed: Vec<Failure>,
    pub overwritten: usize,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub name: String,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Files sharing the image's base name: RAW+JPEG pairs, `photo.xmp` or `photo.jpg.xmp`
/// sidecars, Live Photo videos and similar.
fn pairs_of(image: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(stem), Some(full)) = (
        image.parent(),
        image.file_stem().map(|s| s.to_string_lossy().to_lowercase()),
        image.file_name().map(|s| s.to_string_lossy().to_lowercase()),
    ) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let name = file_name(p).to_lowercase();
            if name == full {
                return false;
            }
            let other_stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase());
            other_stem.as_deref() == Some(stem.as_str()) || name.starts_with(&format!("{full}."))
        })
        .collect();
    found.sort();
    found
}

/// Inside a macOS package such as a Photos library, where outside changes corrupt the package.
pub fn in_package(path: &Path) -> bool {
    path.ancestors().any(|p| crate::folders::is_package(p))
}

pub fn plan(sources: &[String], dest: &Path, include_pairs: bool) -> Result<Plan, String> {
    if !dest.is_dir() {
        return Err("not_found".into());
    }
    if in_package(dest) {
        return Err("protected_dest".into());
    }
    let copy_only = sources.iter().any(|s| in_package(Path::new(s)));
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut pairs = 0;
    let mut same_folder = false;
    for (group, src) in sources.iter().enumerate() {
        let path = PathBuf::from(src);
        if path.parent().is_some_and(|p| same_dir(p, dest)) {
            same_folder = true;
        }
        let mut members = vec![(path.clone(), false)];
        if include_pairs {
            members.extend(pairs_of(&path).into_iter().map(|p| (p, true)));
        }
        for (p, pair) in members {
            if !seen.insert(p.clone()) {
                continue;
            }
            // A "pair" that was itself selected counts as a main file.
            let pair = pair && !sources.iter().any(|s| Path::new(s) == p);
            if pair {
                pairs += 1;
            }
            let name = file_name(&p);
            files.push(PlannedFile {
                exists: dest.join(&name).exists(),
                src: p.to_string_lossy().into_owned(),
                name,
                pair,
                group,
            });
        }
    }
    Ok(Plan { files, pairs, same_folder, copy_only })
}

/// Target names for a group with ` (n)` after the main file's stem, e.g. `A (2).jpg`,
/// `A (2).CR3`, `A (2).jpg.xmp`, using the first `n` for which none of them is taken.
fn renamed_group(dir: &Path, names: &[String]) -> Vec<String> {
    let stem = Path::new(&names[0])
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cut = stem.chars().count();
    let rename = |name: &str, n: usize| {
        let rest: String = name.chars().skip(cut).collect();
        format!("{stem} ({n}){rest}")
    };
    (2..)
        .map(|n| names.iter().map(|name| rename(name, n)).collect::<Vec<_>>())
        .find(|candidate| candidate.iter().all(|c| !dir.join(c).exists()))
        .expect("unbounded range")
}

/// A short reason code the interface turns into a localized explanation.
fn reason(err: &io::Error) -> String {
    use io::ErrorKind::*;
    let code = match err.kind() {
        PermissionDenied => "permission",
        NotFound => "not_found",
        AlreadyExists => "exists",
        StorageFull | QuotaExceeded => "no_space",
        ReadOnlyFilesystem => "read_only",
        ResourceBusy => "in_use",
        _ => match err.raw_os_error() {
            Some(1) if cfg!(unix) => "permission",
            Some(32) | Some(33) if cfg!(windows) => "in_use",
            _ => "",
        },
    };
    if code.is_empty() {
        format!("other:{err}")
    } else {
        code.to_string()
    }
}

/// Moves a file to the trash without needing extra permissions (on macOS, no Finder automation).
pub fn to_trash(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let result = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path)
    };
    #[cfg(not(target_os = "macos"))]
    let result = trash::delete(path);
    result.map_err(|e| match e {
        trash::Error::Os { code, .. } => io::Error::from_raw_os_error(code),
        other => io::Error::other(other.to_string()),
    })
}

fn set_mtime_from(from: &Path, to: &Path) {
    if let Ok(meta) = fs::metadata(from) {
        let mtime = filetime::FileTime::from_last_modification_time(&meta);
        let _ = filetime::set_file_mtime(to, mtime);
    }
}

/// Plain byte copy, used when the system copy (cloning, extended attributes) is refused.
fn stream_copy(from: &Path, to: &Path) -> io::Result<()> {
    let mut reader = fs::File::open(from)?;
    let mut writer = fs::File::create_new(to)?;
    let result = io::copy(&mut reader, &mut writer).and_then(|_| writer.sync_all());
    if result.is_err() {
        drop(writer);
        let _ = fs::remove_file(to);
    }
    result
}

fn copy_file(from: &Path, to: &Path) -> io::Result<()> {
    match fs::copy(from, to) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound && !from.exists() => return Err(e),
        Err(first) => {
            if to.exists() && fs::metadata(to).map(|m| m.len()).ok() != fs::metadata(from).map(|m| m.len()).ok() {
                let _ = fs::remove_file(to);
            }
            if let Err(e) = stream_copy(from, to) {
                // Report the original error when the fallback fails for the same reason.
                return Err(if e.kind() == first.kind() { first } else { e });
            }
        }
    }
    set_mtime_from(from, to);
    Ok(())
}

/// Renames when possible. Otherwise (another drive, a cloud folder, …) copies, checks the size,
/// and removes the original; if the original cannot be removed the copy is withdrawn.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    let err = match fs::rename(from, to) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::AlreadyExists) {
        return Err(err);
    }
    copy_file(from, to)?;
    let same_size = fs::metadata(to).map(|m| m.len()).ok() == fs::metadata(from).map(|m| m.len()).ok();
    if !same_size {
        let _ = fs::remove_file(to);
        return Err(io::Error::other("copy incomplete"));
    }
    if let Err(e) = fs::remove_file(from) {
        let _ = fs::remove_file(to);
        return Err(e);
    }
    Ok(())
}

pub fn run(
    mode: Mode,
    dest: &Path,
    jobs: &[Job],
    cancel: &AtomicBool,
    progress: impl Fn(Progress),
) -> Outcome {
    let mut outcome = Outcome { done: Vec::new(), skipped: 0, failed: Vec::new(), overwritten: 0, cancelled: false };
    let total = jobs.len();
    let mut index = 0;
    let mut groups: Vec<Vec<&Job>> = Vec::new();
    for job in jobs {
        match groups.last_mut() {
            Some(g) if g[0].group == job.group => g.push(job),
            _ => groups.push(vec![job]),
        }
    }
    'groups: for group in groups {
        let names: Vec<String> = group.iter().map(|j| file_name(Path::new(&j.src))).collect();
        let conflict = names.iter().any(|n| dest.join(n).exists());
        let resolution = group[0].resolution;
        if conflict && matches!(resolution, None | Some(Resolution::Skip)) {
            outcome.skipped += group.len();
            index += group.len();
            continue;
        }
        let targets: Vec<String> = if conflict && resolution == Some(Resolution::Rename) {
            renamed_group(dest, &names)
        } else {
            names.clone()
        };
        for (job, target_name) in group.iter().zip(targets) {
            if cancel.load(Ordering::Relaxed) {
                outcome.cancelled = true;
                break 'groups;
            }
            progress(Progress { done: index, total, name: target_name.clone() });
            index += 1;
            let src = PathBuf::from(&job.src);
            let target = dest.join(&target_name);
            if target.exists() {
                if same_dir(&src, &target) {
                    outcome.skipped += 1;
                    continue;
                }
                if let Err(e) = to_trash(&target) {
                    outcome.failed.push(Failure { src: job.src.clone(), error: reason(&e) });
                    continue;
                }
                outcome.overwritten += 1;
            }
            let result = match mode {
                Mode::Move => move_file(&src, &target),
                Mode::Copy => copy_file(&src, &target),
            };
            match result {
                Ok(()) => outcome.done.push(Done { from: job.src.clone(), to: target.to_string_lossy().into_owned() }),
                Err(e) => outcome.failed.push(Failure { src: job.src.clone(), error: reason(&e) }),
            }
        }
    }
    progress(Progress { done: total, total, name: String::new() });
    outcome
}

/// Reverses a finished operation: moved files go back, copies go to the trash.
pub fn undo(mode: Mode, items: &[Done]) -> Outcome {
    let mut outcome = Outcome { done: Vec::new(), skipped: 0, failed: Vec::new(), overwritten: 0, cancelled: false };
    for item in items.iter().rev() {
        let (from, to) = (Path::new(&item.to), Path::new(&item.from));
        let result = match mode {
            Mode::Move if to.exists() => Err(io::Error::new(io::ErrorKind::AlreadyExists, "original location is taken")),
            Mode::Move => move_file(from, to),
            Mode::Copy => to_trash(from),
        };
        match result {
            Ok(()) => outcome.done.push(Done { from: item.to.clone(), to: item.from.clone() }),
            Err(e) => outcome.failed.push(Failure { src: item.to.clone(), error: reason(&e) }),
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_are_classified() {
        assert_eq!(reason(&io::Error::from(io::ErrorKind::PermissionDenied)), "permission");
        assert_eq!(reason(&io::Error::from(io::ErrorKind::StorageFull)), "no_space");
        assert!(reason(&io::Error::other("boom")).starts_with("other:"));
    }

    #[test]
    fn photo_library_sources_are_copy_only() {
        let (base, a, b) = setup("package");
        let lib = a.join("Photos Library.photoslibrary").join("originals");
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("p.jpg"), "x").unwrap();
        let p = plan(&[lib.join("p.jpg").to_string_lossy().into_owned()], &b, true).unwrap();
        assert_eq!(p.copy_only, cfg!(target_os = "macos"));
        if cfg!(target_os = "macos") {
            assert!(plan(&[], &lib, true).is_err());
        }
        let _ = fs::remove_dir_all(base);
    }

    fn setup(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("image-plus-transfer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (a, b) = (base.join("a"), base.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        (base, a, b)
    }

    #[test]
    fn plan_finds_pairs_and_conflicts() {
        let (base, a, b) = setup("plan");
        for f in ["IMG_1.JPG", "IMG_1.CR3", "IMG_1.JPG.xmp", "img_1.xmp", "IMG_10.JPG", "other.png"] {
            fs::write(a.join(f), f).unwrap();
        }
        fs::write(b.join("IMG_1.CR3"), "old").unwrap();
        let src = a.join("IMG_1.JPG").to_string_lossy().into_owned();
        let p = plan(&[src.clone()], &b, true).unwrap();
        let mut names: Vec<_> = p.files.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.JPG.xmp", "img_1.xmp"]);
        assert_eq!(p.pairs, 3);
        assert!(p.files.iter().find(|f| f.name == "IMG_1.CR3").unwrap().exists);
        assert!(!p.same_folder);
        assert_eq!(plan(&[src], &b, false).unwrap().files.len(), 1);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn move_copy_rename_skip_and_undo() {
        let (base, a, b) = setup("run");
        fs::write(a.join("x.jpg"), "new-x").unwrap();
        fs::write(a.join("y.jpg"), "new-y").unwrap();
        fs::write(a.join("y.CR3"), "new-y-raw").unwrap();
        fs::write(a.join("z.jpg"), "new-z").unwrap();
        fs::write(b.join("y.jpg"), "old-y").unwrap();
        fs::write(b.join("y (2).CR3"), "taken").unwrap();
        fs::write(b.join("z.jpg"), "old-z").unwrap();
        let job = |n: &str, g, r| Job { src: a.join(n).to_string_lossy().into_owned(), group: g, resolution: r };
        let jobs = [
            job("x.jpg", 0, None),
            job("y.jpg", 1, Some(Resolution::Rename)),
            job("y.CR3", 1, Some(Resolution::Rename)),
            job("z.jpg", 2, Some(Resolution::Skip)),
        ];
        let out = run(Mode::Move, &b, &jobs, &AtomicBool::new(false), |_| {});
        assert_eq!(out.done.len(), 3);
        assert_eq!(out.skipped, 1);
        // The pair keeps matching its image: "y (2)" is skipped because "y (2).CR3" is taken.
        assert_eq!(fs::read_to_string(b.join("y (3).jpg")).unwrap(), "new-y");
        assert_eq!(fs::read_to_string(b.join("y (3).CR3")).unwrap(), "new-y-raw");
        assert_eq!(fs::read_to_string(b.join("z.jpg")).unwrap(), "old-z");
        assert!(!a.join("x.jpg").exists() && a.join("z.jpg").exists());

        let back = undo(Mode::Move, &out.done);
        assert_eq!(back.done.len(), 3);
        assert!(a.join("x.jpg").exists() && a.join("y.jpg").exists() && a.join("y.CR3").exists());
        assert!(!b.join("y (3).jpg").exists());

        let copy = run(Mode::Copy, &b, &[job("x.jpg", 0, None)], &AtomicBool::new(false), |_| {});
        assert_eq!(copy.done.len(), 1);
        assert!(a.join("x.jpg").exists() && b.join("x.jpg").exists());
        let _ = fs::remove_dir_all(base);
    }
}
