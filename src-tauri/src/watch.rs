use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const QUIET: Duration = Duration::from_millis(400);

/// Watches the folders open in the list and reports changes, grouped into short bursts,
/// as `folder-changed` events carrying the folder path.
pub struct FolderWatch {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
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
                    for dir in pending.drain() {
                        let _ = app.emit("folder-changed", dir.to_string_lossy().into_owned());
                    }
                }
            }
        });

        FolderWatch { watcher: Mutex::new(watcher), watched: Mutex::new(HashSet::new()) }
    }

    /// Replaces the set of watched folders (not recursive).
    pub fn set(&self, folders: Vec<String>) {
        let wanted: HashSet<PathBuf> = folders.into_iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
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
