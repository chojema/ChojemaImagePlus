mod files;
mod protocol;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct Launch {
    ready: bool,
    pending: Vec<String>,
}

type LaunchState = Mutex<Launch>;

fn paths_from_args(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a).to_string_lossy().into_owned())
        .collect()
}

/// Paths arriving before the window has loaded are held until it asks for them.
fn deliver(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<LaunchState>();
    let mut launch = state.lock().unwrap();
    if launch.ready {
        let _ = app.emit("open-paths", paths);
    } else {
        launch.pending.extend(paths);
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn take_launch_paths(state: tauri::State<LaunchState>) -> Vec<String> {
    let mut launch = state.lock().unwrap();
    launch.ready = true;
    std::mem::take(&mut launch.pending)
}

#[tauri::command]
fn open_paths(paths: Vec<String>) -> Result<files::Listing, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    files::open(&paths)
}

#[tauri::command]
fn image_extensions() -> Vec<&'static str> {
    files::extensions()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            deliver(app, paths_from_args(&args, Path::new(&cwd)));
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchState::default())
        .register_asynchronous_uri_scheme_protocol("img", |_ctx, request, responder| {
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::handle(&request));
            });
        })
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args().collect();
            deliver(app.handle(), paths_from_args(&args, &cwd));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_launch_paths,
            open_paths,
            image_extensions
        ])
        .build(tauri::generate_context!())
        .expect("failed to build application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            deliver(_app, paths);
            focus_main(_app);
        }
    });
}
