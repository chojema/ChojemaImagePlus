mod edit;
mod clipboard;
mod file_actions;
mod export;
mod files;
mod folders;
#[cfg(target_os = "macos")]
mod imageio;
mod library;
mod photo_info;
mod protocol;
mod settings;
mod thumbs;
mod transfer;
mod watch;
#[cfg(windows)]
mod wic;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use library::{Library, Snapshot};
use serde_json::{Map, Value};
use settings::Settings;
use thumbs::Thumbs;
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
async fn open_paths(
    paths: Vec<String>,
    library: tauri::State<'_, Library>,
) -> Result<files::Listing, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let listing = tauri::async_runtime::spawn_blocking(move || files::open(&paths))
        .await
        .map_err(|_| "failed".to_string())??;
    if let Some(folder) = &listing.folder {
        library.touch_recent(folder);
    }
    Ok(listing)
}

/// What the image list shows for a folder: its subfolders first, then its images.
#[derive(serde::Serialize)]
struct Contents {
    folders: Vec<folders::Sub>,
    images: Vec<files::Entry>,
}

#[tauri::command]
async fn browse(dir: String, library: tauri::State<'_, Library>) -> Result<Contents, String> {
    let path = PathBuf::from(&dir);
    let contents = tauri::async_runtime::spawn_blocking(move || {
        files::scan(&path).map(|images| Contents { folders: folders::subfolders(&path), images })
    })
    .await
    .map_err(|_| "failed".to_string())??;
    library.touch_recent(&dir);
    Ok(contents)
}

#[tauri::command]
async fn slideshow_list(dir: String, recursive: bool) -> Result<Vec<files::Entry>, String> {
    const LIMIT: usize = 100_000;
    tauri::async_runtime::spawn_blocking(move || files::scan_tree(Path::new(&dir), recursive, LIMIT))
        .await
        .map_err(|_| "failed".to_string())?
}

#[tauri::command]
async fn photo_info(path: String) -> Result<photo_info::PhotoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || photo_info::read(Path::new(&path)))
        .await
        .map_err(|_| "failed".to_string())?
}

#[tauri::command]
async fn folder_children(path: String) -> Result<Vec<folders::Folder>, String> {
    tauri::async_runtime::spawn_blocking(move || folders::children(Path::new(&path)))
        .await
        .map_err(|_| "failed".to_string())?
}

#[tauri::command]
async fn create_folder(parent: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || file_actions::create_folder(Path::new(&parent), &name))
        .await.map_err(|_| "failed".to_string())?
}

#[tauri::command]
async fn rename_entry(path: String, name: String, include_pairs: bool, library: tauri::State<'_, Library>) -> Result<transfer::Outcome, String> {
    let result = tauri::async_runtime::spawn_blocking(move || file_actions::rename(Path::new(&path), &name, include_pairs))
        .await.map_err(|_| "failed".to_string())??;
    library.relocate(&result.done);
    Ok(result)
}

#[tauri::command]
async fn rename_undo(items: Vec<transfer::Done>, library: tauri::State<'_, Library>) -> Result<transfer::Outcome, String> {
    let result = tauri::async_runtime::spawn_blocking(move || file_actions::undo(&items))
        .await.map_err(|_| "failed".to_string())?;
    library.relocate(&result.done);
    Ok(result)
}

fn clipboard_owner(window: &tauri::Window) -> Result<usize, String> {
    #[cfg(windows)]
    { window.hwnd().map(|h| h.0 as usize).map_err(|_| "clipboard_failed".into()) }
    #[cfg(not(windows))]
    { let _ = window; Ok(0) }
}

#[tauri::command]
fn clipboard_write(window: tauri::Window, paths: Vec<String>, cut: bool) -> Result<(), String> {
    if cut && paths.iter().any(|p| transfer::in_package(Path::new(p))
        || std::fs::canonicalize(p).is_ok_and(|real| transfer::in_package(&real))) {
        return Err("protected".into());
    }
    clipboard::write(&paths, cut, clipboard_owner(&window)?)
}

#[tauri::command]
fn clipboard_read() -> Result<clipboard::Files, String> {
    let mut files = clipboard::read()?;
    files.paths.retain(|p| Path::new(p).is_file() && files::kind(Path::new(p)).is_some());
    Ok(files)
}

#[tauri::command]
fn clipboard_consume(window: tauri::Window, token: String, moved: Vec<String>) -> Result<(), String> {
    clipboard::consume(&token, &moved, clipboard_owner(&window)?)
}

#[tauri::command]
async fn folder_roots(app: AppHandle) -> Result<folders::Roots, String> {
    let p = app.path();
    let places: Vec<(PathBuf, String)> = [
        (p.picture_dir(), "pictures"),
        (p.desktop_dir(), "desktop"),
        (p.download_dir(), "downloads"),
        (p.home_dir(), "home"),
    ]
    .into_iter()
    .filter_map(|(dir, key)| dir.ok().map(|d| (d, key.to_string())))
    .collect();
    tauri::async_runtime::spawn_blocking(move || folders::roots(places))
        .await
        .map_err(|_| "failed".to_string())
}

#[tauri::command]
fn settings_get(settings: tauri::State<Settings>) -> Map<String, Value> {
    settings.all()
}

#[tauri::command]
fn settings_set(values: Map<String, Value>, settings: tauri::State<Settings>) -> Map<String, Value> {
    settings.update(values)
}

#[tauri::command]
fn watch_folders(folders: Vec<String>, watch: tauri::State<watch::FolderWatch>) {
    watch.set(folders);
}

#[tauri::command]
fn thumbs_prefetch(paths: Vec<String>, thumbs: tauri::State<Thumbs>) {
    thumbs.prefetch(paths.into_iter().map(PathBuf::from).collect());
}

#[tauri::command]
async fn thumbs_clear(thumbs: tauri::State<'_, Thumbs>) -> Result<(), String> {
    thumbs.clear();
    Ok(())
}

#[derive(Default)]
struct TransferCancel(Arc<AtomicBool>);

#[tauri::command]
async fn transfer_plan(sources: Vec<String>, dest: String, include_pairs: bool) -> Result<transfer::Plan, String> {
    tauri::async_runtime::spawn_blocking(move || transfer::plan(&sources, Path::new(&dest), include_pairs))
        .await
        .map_err(|_| "failed".to_string())?
}

#[tauri::command]
async fn transfer_run(
    app: AppHandle,
    mode: transfer::Mode,
    dest: String,
    jobs: Vec<transfer::Job>,
    cancel: tauri::State<'_, TransferCancel>,
) -> Result<transfer::Outcome, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        transfer::run(mode, Path::new(&dest), &jobs, &flag, |p| {
            let _ = app.emit("transfer-progress", p);
        })
    })
    .await
    .map_err(|_| "failed".to_string())
}

#[tauri::command]
async fn trash_plan(sources: Vec<String>) -> Result<transfer::TrashPlan, String> {
    tauri::async_runtime::spawn_blocking(move || transfer::trash_plan(&sources))
        .await
        .map_err(|_| "failed".to_string())
}

#[tauri::command]
async fn trash_files(paths: Vec<String>) -> Result<transfer::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || transfer::trash_files(&paths))
        .await
        .map_err(|_| "failed".to_string())
}

/// Shows the file selected in Finder or File Explorer.
#[tauri::command]
fn reveal(path: String) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(&path).spawn();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.replace('/', "\\")))
            .spawn();
    }
}

/// Pages the About window may open in the default browser.
const LINKS: &[&str] = &[
    "https://github.com/chojema/ChojemaImagePlus",
    "https://chojema.github.io/AppPark/",
    "https://github.com/chojema/ChojemaImagePlus/blob/main/THIRD-PARTY-NOTICES.txt",
];

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !LINKS.contains(&url.as_str()) {
        return Err("not_allowed".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open").arg(&url).spawn();
    #[cfg(windows)]
    let result = std::process::Command::new("explorer.exe").arg(&url).spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// The app menu's About item, relabelled when the interface language changes.
#[derive(Default)]
struct AboutItem(Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>);

#[tauri::command]
fn set_about_label(label: String, item: tauri::State<AboutItem>) {
    if let Some(about) = item.0.lock().unwrap().as_ref() {
        let _ = about.set_text(label);
    }
}

/// Opens the system privacy settings where file access for the app is granted.
#[tauri::command]
fn open_privacy_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
        .spawn();
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer.exe").arg("ms-settings:privacy-broadfilesystemaccess").spawn();
}

#[tauri::command]
async fn export_plan(sources: Vec<String>, dest: String, options: export::Options) -> Result<Vec<export::Planned>, String> {
    tauri::async_runtime::spawn_blocking(move || export::plan(&sources, Path::new(&dest), &options))
        .await
        .map_err(|_| "failed".to_string())?
}

#[tauri::command]
async fn export_run(
    app: AppHandle,
    dest: String,
    options: export::Options,
    jobs: Vec<export::Job>,
    cancel: tauri::State<'_, TransferCancel>,
) -> Result<export::Outcome, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        export::run(Path::new(&dest), &options, &jobs, &flag, |p| {
            let _ = app.emit("transfer-progress", p);
        })
    })
    .await
    .map_err(|_| "failed".to_string())
}

#[tauri::command]
async fn edit_save(src: String, edit: edit::Edit, mode: edit::SaveMode) -> Result<files::Entry, String> {
    tauri::async_runtime::spawn_blocking(move || edit::save(Path::new(&src), &edit, mode))
        .await
        .map_err(|_| "failed".to_string())?
}

#[tauri::command]
fn edit_can_overwrite(path: String) -> bool {
    edit::can_overwrite(Path::new(&path))
}

#[tauri::command]
fn transfer_cancel(cancel: tauri::State<TransferCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn transfer_undo(mode: transfer::Mode, items: Vec<transfer::Done>) -> Result<transfer::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || transfer::undo(mode, &items))
        .await
        .map_err(|_| "failed".to_string())
}

#[tauri::command]
fn library_get(library: tauri::State<Library>) -> Snapshot {
    library.snapshot()
}

#[tauri::command]
fn favorite_toggle(path: String, library: tauri::State<Library>) -> Snapshot {
    library.toggle_favorite(&path)
}

#[tauri::command]
fn favorite_remove(path: String, library: tauri::State<Library>) -> Snapshot {
    library.remove_favorite(&path)
}

#[tauri::command]
fn favorite_rename(path: String, name: String, library: tauri::State<Library>) -> Snapshot {
    library.rename_favorite(&path, &name)
}

#[tauri::command]
fn favorite_move(path: String, to: usize, library: tauri::State<Library>) -> Snapshot {
    library.move_favorite(&path, to)
}

#[tauri::command]
fn recent_clear(library: tauri::State<Library>) -> Snapshot {
    library.clear_recent()
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
        .manage(TransferCancel::default())
        .manage(AboutItem::default())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "about" {
                let _ = app.emit("show-about", ());
            }
        })
        .register_asynchronous_uri_scheme_protocol("img", |_ctx, request, responder| {
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::handle(&request));
            });
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // Only the cache lookup runs here; rendering happens on the thumbnail workers, so
            // this blocking thread is free again at once.
            tauri::async_runtime::spawn_blocking(move || {
                protocol::thumbnail(&request, &app.state::<Thumbs>(), responder);
            });
        })
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(Library::load(dir.clone()));
            app.manage(Settings::load(dir));
            let thumbs = Thumbs::new(app.path().app_cache_dir()?.join("thumbnails"));
            app.manage(thumbs);
            app.manage(watch::FolderWatch::new(app.handle().clone()));
            // macOS: the app menu's About opens the app's own window, which has the links.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let handle = app.handle();
                let menu = Menu::default(handle)?;
                if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                    app_menu.remove_at(0)?;
                    let about = MenuItem::with_id(handle, "about", "About Chojema Image+", true, None::<&str>)?;
                    app_menu.prepend(&about)?;
                    *app.state::<AboutItem>().0.lock().unwrap() = Some(about);
                }
                app.set_menu(menu)?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || handle.state::<Thumbs>().trim());
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args().collect();
            deliver(app.handle(), paths_from_args(&args, &cwd));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_launch_paths,
            open_paths,
            image_extensions,
            photo_info,
            library_get,
            favorite_toggle,
            favorite_remove,
            favorite_rename,
            favorite_move,
            recent_clear,
            browse,
            folder_children,
            create_folder,
            rename_entry,
            rename_undo,
            clipboard_write,
            clipboard_read,
            clipboard_consume,
            folder_roots,
            settings_get,
            settings_set,
            thumbs_clear,
            thumbs_prefetch,
            watch_folders,
            transfer_plan,
            transfer_run,
            transfer_cancel,
            transfer_undo,
            open_privacy_settings,
            trash_plan,
            trash_files,
            reveal,
            slideshow_list,
            open_link,
            set_about_label,
            export_plan,
            export_run,
            edit_save,
            edit_can_overwrite
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
