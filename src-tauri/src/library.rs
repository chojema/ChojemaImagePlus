use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const RECENT_LIMIT: usize = 12;

#[derive(Clone, Serialize, Deserialize)]
pub struct Favorite {
    pub path: String,
    pub name: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    favorites: Vec<Favorite>,
    #[serde(default)]
    recent: Vec<String>,
}

#[derive(Serialize)]
pub struct FolderItem {
    pub path: String,
    pub name: String,
    pub exists: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub favorites: Vec<FolderItem>,
    pub recent: Vec<FolderItem>,
}

/// Favorite and recent folders, saved as JSON in the app's config folder.
pub struct Library {
    file: PathBuf,
    data: Mutex<Data>,
}

fn same(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.replace('/', "\\").eq_ignore_ascii_case(&b.replace('/', "\\"))
    } else {
        a == b
    }
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn item(path: &str, name: String) -> FolderItem {
    FolderItem {
        path: path.to_string(),
        name,
        exists: Path::new(path).is_dir(),
    }
}

impl Library {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("library.json");
        let data = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Library {
            file,
            data: Mutex::new(data),
        }
    }

    fn save(&self, data: &Data) {
        let Some(dir) = self.file.parent() else { return };
        if fs::create_dir_all(dir).is_err() {
            return;
        }
        let Ok(json) = serde_json::to_vec_pretty(data) else { return };
        let tmp = self.file.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.file);
        }
    }

    fn update(&self, change: impl FnOnce(&mut Data)) -> Snapshot {
        let mut data = self.data.lock().unwrap();
        change(&mut data);
        self.save(&data);
        snapshot(&data)
    }

    pub fn snapshot(&self) -> Snapshot {
        snapshot(&self.data.lock().unwrap())
    }

    pub fn touch_recent(&self, path: &str) {
        self.update(|d| {
            d.recent.retain(|p| !same(p, path));
            d.recent.insert(0, path.to_string());
            d.recent.truncate(RECENT_LIMIT);
        });
    }

    pub fn clear_recent(&self) -> Snapshot {
        self.update(|d| d.recent.clear())
    }

    pub fn relocate(&self, changes: &[crate::transfer::Done]) {
        let folders: Vec<_> = changes.iter().filter(|d| Path::new(&d.to).is_dir()).collect();
        if folders.is_empty() { return; }
        let mapped = |path: &str| {
            for d in &folders {
                if same(path, &d.from) { return d.to.clone(); }
                // Compare one path component at a time, preserving the original suffix.
                for (i, c) in path.char_indices() {
                    if (c == '/' || c == '\\') && same(&path[..i], &d.from) {
                        return format!("{}{}", d.to, &path[i..]);
                    }
                }
            }
            path.to_string()
        };
        self.update(|d| {
            for f in &mut d.favorites {
                let next = mapped(&f.path);
                if next != f.path {
                    if f.name == folder_name(&f.path) { f.name = folder_name(&next); }
                    f.path = next;
                }
            }
            for p in &mut d.recent { *p = mapped(p); }
        });
    }

    /// Adds the folder if it is not a favorite yet, otherwise removes it.
    pub fn toggle_favorite(&self, path: &str) -> Snapshot {
        self.update(|d| {
            let before = d.favorites.len();
            d.favorites.retain(|f| !same(&f.path, path));
            if d.favorites.len() == before {
                d.favorites.push(Favorite {
                    path: path.to_string(),
                    name: folder_name(path),
                });
            }
        })
    }

    pub fn remove_favorite(&self, path: &str) -> Snapshot {
        self.update(|d| d.favorites.retain(|f| !same(&f.path, path)))
    }

    pub fn rename_favorite(&self, path: &str, name: &str) -> Snapshot {
        let name = name.trim();
        self.update(|d| {
            if let Some(f) = d.favorites.iter_mut().find(|f| same(&f.path, path)) {
                f.name = if name.is_empty() {
                    folder_name(path)
                } else {
                    name.to_string()
                };
            }
        })
    }

    pub fn move_favorite(&self, path: &str, to: usize) -> Snapshot {
        self.update(|d| {
            if let Some(from) = d.favorites.iter().position(|f| same(&f.path, path)) {
                let f = d.favorites.remove(from);
                let to = to.min(d.favorites.len());
                d.favorites.insert(to, f);
            }
        })
    }
}

fn snapshot(data: &Data) -> Snapshot {
    Snapshot {
        favorites: data
            .favorites
            .iter()
            .map(|f| item(&f.path, f.name.clone()))
            .collect(),
        recent: data
            .recent
            .iter()
            .map(|p| item(p, folder_name(p)))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::Library;

    fn temp_library() -> (Library, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("image-plus-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Library::load(dir.clone()), dir)
    }

    #[test]
    fn favorites_toggle_rename_move_and_persist() {
        let (lib, dir) = temp_library();
        lib.toggle_favorite("/a/one");
        lib.toggle_favorite("/b/two");
        let s = lib.toggle_favorite("/c/three");
        assert_eq!(s.favorites.len(), 3);
        assert_eq!(s.favorites[1].name, "two");

        let s = lib.toggle_favorite("/b/two");
        assert_eq!(s.favorites.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["one", "three"]);

        lib.rename_favorite("/c/three", "  Photos ");
        let s = lib.move_favorite("/c/three", 0);
        assert_eq!(s.favorites[0].name, "Photos");

        let reloaded = Library::load(dir.clone());
        let s = reloaded.snapshot();
        assert_eq!(s.favorites[0].path, "/c/three");
        assert_eq!(s.favorites[1].path, "/a/one");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn recent_is_deduplicated_and_limited() {
        let dir = std::env::temp_dir().join(format!("image-plus-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lib = Library::load(dir.clone());
        for i in 0..20 {
            lib.touch_recent(&format!("/f/{i}"));
        }
        lib.touch_recent("/f/5");
        let s = lib.snapshot();
        assert_eq!(s.recent.len(), super::RECENT_LIMIT);
        assert_eq!(s.recent[0].path, "/f/5");
        assert_eq!(s.recent.iter().filter(|r| r.path == "/f/5").count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn renamed_folder_tracks_descendants_and_keeps_custom_favorite_names() {
        let dir = std::env::temp_dir().join(format!("image-plus-relocate-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("old/nested")).unwrap();
        let lib = Library::load(dir.join("config"));
        let old = dir.join("old").to_string_lossy().into_owned();
        let nested = dir.join("old/nested").to_string_lossy().into_owned();
        lib.toggle_favorite(&old);
        lib.toggle_favorite(&nested);
        lib.rename_favorite(&nested, "My photos");
        lib.touch_recent(&nested);
        let new = dir.join("new").to_string_lossy().into_owned();
        std::fs::rename(&old, &new).unwrap();
        lib.relocate(&[crate::transfer::Done { from: old, to: new.clone() }]);
        let s = lib.snapshot();
        assert_eq!(s.favorites[0].name, "new");
        assert_eq!(s.favorites[1].name, "My photos");
        assert_eq!(s.favorites[1].path, format!("{new}/nested"));
        assert!(s.favorites.iter().all(|f| f.exists));
        assert_eq!(s.recent[0].path, format!("{new}/nested"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
