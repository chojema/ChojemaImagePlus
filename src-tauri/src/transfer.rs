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

pub fn plan(sources: &[String], dest: &Path, include_pairs: bool) -> Result<Plan, String> {
    if !dest.is_dir() {
        return Err("not_found".into());
    }
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
    Ok(Plan { files, pairs, same_folder })
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

fn is_cross_device(err: &io::Error) -> bool {
    // EXDEV on Unix, ERROR_NOT_SAME_DEVICE on Windows.
    err.kind() == io::ErrorKind::CrossesDevices || matches!(err.raw_os_error(), Some(18) if cfg!(unix)) || matches!(err.raw_os_error(), Some(17) if cfg!(windows))
}

fn copy_preserving_time(from: &Path, to: &Path) -> io::Result<()> {
    fs::copy(from, to)?;
    if let Ok(meta) = fs::metadata(from) {
        let mtime = filetime::FileTime::from_last_modification_time(&meta);
        let _ = filetime::set_file_mtime(to, mtime);
    }
    Ok(())
}

/// Renames when possible; across drives copies first and removes the original only after the copy is complete.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            copy_preserving_time(from, to)?;
            let ok = fs::metadata(to).map(|m| m.len()).ok() == fs::metadata(from).map(|m| m.len()).ok();
            if !ok {
                let _ = fs::remove_file(to);
                return Err(io::Error::other("copy incomplete"));
            }
            fs::remove_file(from)
        }
        Err(e) => Err(e),
    }
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
                if let Err(e) = trash::delete(&target) {
                    outcome.failed.push(Failure { src: job.src.clone(), error: e.to_string() });
                    continue;
                }
                outcome.overwritten += 1;
            }
            let result = match mode {
                Mode::Move => move_file(&src, &target),
                Mode::Copy => copy_preserving_time(&src, &target),
            };
            match result {
                Ok(()) => outcome.done.push(Done { from: job.src.clone(), to: target.to_string_lossy().into_owned() }),
                Err(e) => outcome.failed.push(Failure { src: job.src.clone(), error: e.to_string() }),
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
            Mode::Copy => trash::delete(from).map_err(|e| io::Error::other(e.to_string())),
        };
        match result {
            Ok(()) => outcome.done.push(Done { from: item.to.clone(), to: item.from.clone() }),
            Err(e) => outcome.failed.push(Failure { src: item.to.clone(), error: e.to_string() }),
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

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
