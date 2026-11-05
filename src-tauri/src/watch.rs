use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const QUIET: Duration = Duration::from_millis(400);

/// Real folder paths mapped to the folder paths the list opened them under.
type Aliases = Arc<Mutex<HashMap<PathBuf, Vec<String>>>>;

/// Watches the folders open in the list and reports changes, grouped into short bursts,
/// as `folder-changed` events carrying the folder path as the list knows it.
pub struct FolderWatch {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
    aliases: Aliases,
}

impl FolderWatch {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    if let Some(dir) = path.parent() {
                        let _ = tx.send(dir.to_path_buf());
                    }
                }
            }
        })
        .ok();

        let aliases: Aliases = Arc::default();
        let names = aliases.clone();
        std::thread::spawn(move || {
            let mut pending: HashSet<PathBuf> = HashSet::new();
            let mut last = Instant::now();
            loop {
                match rx.recv_timeout(QUIET) {
                    Ok(dir) => {
                        pending.insert(dir);
                        last = Instant::now();
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
                if !pending.is_empty() && last.elapsed() >= QUIET {
                    let names = names.lock().unwrap();
                    for dir in pending.drain() {
                        for folder in reported(&names, &dir) {
                            let _ = app.emit("folder-changed", folder);
                        }
                    }
                }
            }
        });

        FolderWatch { watcher: Mutex::new(watcher), watched: Mutex::new(HashSet::new()), aliases }
    }

    /// Replaces the set of watched folders (not recursive). Folders reached through a symbolic
    /// link are watched at their real path, which is the path the system reports changes under.
    pub fn set(&self, folders: Vec<String>) {
        let mut names: HashMap<PathBuf, Vec<String>> = HashMap::new();
        for folder in folders {
            let real = real_path(Path::new(&folder));
            if !real.is_dir() {
                continue;
            }
            let list = names.entry(real).or_default();
            if !list.contains(&folder) {
                list.push(folder);
            }
        }
        let wanted: HashSet<PathBuf> = names.keys().cloned().collect();
        *self.aliases.lock().unwrap() = names;

        let mut guard = self.watcher.lock().unwrap();
        let Some(watcher) = guard.as_mut() else { return };
        let mut watched = self.watched.lock().unwrap();
        for old in watched.difference(&wanted) {
            let _ = watcher.unwatch(Path::new(old));
        }
        for new in wanted.difference(&watched) {
            let _ = watcher.watch(Path::new(new), RecursiveMode::NonRecursive);
        }
        *watched = wanted;
    }
}

/// FSEvents reports resolved paths; other platforms report paths under the watched one as given.
#[cfg(target_os = "macos")]
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(not(target_os = "macos"))]
fn real_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// The folder paths to report for a change in `dir`: the paths the list opened it under,
/// or `dir` itself when it is not a watched folder.
fn reported(names: &HashMap<PathBuf, Vec<String>>, dir: &Path) -> Vec<String> {
    match names.get(dir) {
        Some(list) => list.clone(),
        None => vec![dir.to_string_lossy().into_owned()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_link_paths_for_real_folder() {
        let mut names = HashMap::new();
        names.insert(PathBuf::from("/real/photos"), vec!["/link/photos".to_string(), "/real/photos".to_string()]);
        assert_eq!(reported(&names, Path::new("/real/photos")), vec!["/link/photos", "/real/photos"]);
        assert_eq!(reported(&names, Path::new("/other")), vec!["/other"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn set_maps_symlinked_folder_to_real_path() {
        let base = std::env::temp_dir().join(format!("imageplus-watch-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let aliases: Aliases = Arc::default();
        let watch = FolderWatch { watcher: Mutex::new(None), watched: Mutex::new(HashSet::new()), aliases: aliases.clone() };
        let shown = link.to_string_lossy().into_owned();
        watch.set(vec![shown.clone()]);
        let names = aliases.lock().unwrap();
        assert_eq!(reported(&names, &std::fs::canonicalize(&real).unwrap()), vec![shown]);

        drop(names);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn change_through_link_is_reported_under_link() {
        let base = std::env::temp_dir().join(format!("imageplus-watch-e2e-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let shown = link.to_string_lossy().into_owned();
        let mut names = HashMap::new();
        names.insert(real_path(&link), vec![shown.clone()]);

        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
        })
        .unwrap();
        watcher.watch(&real_path(&link), RecursiveMode::NonRecursive).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(link.join("new.jpg"), b"x").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let Ok(path) = rx.recv_timeout(left) else { break };
            if path.file_name().is_some_and(|n| n == "new.jpg") {
                assert_eq!(reported(&names, path.parent().unwrap()), vec![shown.clone()]);
                found = true;
                break;
            }
        }
        drop(watcher);
        let _ = std::fs::remove_dir_all(&base);
        assert!(found, "no event for the new file");
    }
}
