use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// User preferences as a flat JSON object; the interface owns the keys and defaults.
pub struct Settings {
    file: PathBuf,
    values: Mutex<Map<String, Value>>,
}

impl Settings {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("settings.json");
        let values = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok())
            .unwrap_or_default();
        Settings {
            file,
            values: Mutex::new(values),
        }
    }

    pub fn all(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    pub fn update(&self, changes: Map<String, Value>) -> Map<String, Value> {
        let mut values = self.values.lock().unwrap();
        values.extend(changes);
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(&*values) {
            let tmp = self.file.with_extension("json.tmp");
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, &self.file);
            }
        }
        values.clone()
    }
}
