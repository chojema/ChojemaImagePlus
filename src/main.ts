import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { $, Entry, samePath, showToast } from "./common";
import { Compare } from "./compare";
import { Gallery } from "./gallery";
import { errorText, t } from "./i18n";
import { Library } from "./library";
import { loadSettings, saveSettings, settings, SettingsDialog } from "./settings";
import { FolderTree } from "./tree";
import { Viewer } from "./viewer";

interface Listing {
  entries: Entry[];
  index: number;
  folder: string | null;
}

const APP_NAME = "Chojema Image+";
const appWindow = getCurrentWindow();
let extensions: string[] = [];
type Mode = "browser" | "viewer" | "compare";
let mode: Mode = "browser";

const library = new Library($("side-library"), $("panel"), {
  open: (path) => void navigate(path),
  toast: showToast,
});
const tree = new FolderTree($("tree"), (path) => void navigate(path));
const gallery = new Gallery({
  navigate: (path) => void navigate(path),
  open: (entries, index) => openViewer(entries, index, gallery.folder),
  compare: (entries) => openCompare(entries),
  favorite: () => toggleFavorite(),
  chooseFolder: () => void chooseFolder(),
  chooseFile: () => void chooseFile(),
  toast: showToast,
});
const viewer = new Viewer({
  back: () => back(),
  favorite: () => toggleFavorite(),
  folders: () => library.toggleOpen(),
});
const compare = new Compare({ back: () => backFromCompare() });
const settingsDialog = new SettingsDialog();

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function setMode(next: Mode): void {
  mode = next;
  for (const m of ["browser", "viewer", "compare"]) document.body.classList.toggle(`mode-${m}`, m === next);
  if (next !== "viewer") viewer.close();
  if (next !== "compare") compare.close();
  if (next === "browser") {
    library.close();
    void appWindow.setTitle(gallery.folder ? `${folderName(gallery.folder)} - ${APP_NAME}` : APP_NAME);
    $("grid").focus();
  }
  updateFavorite();
}

function currentFolder(): string | null {
  return mode === "viewer" ? viewer.folder : gallery.folder;
}

function updateFavorite(): void {
  const folder = currentFolder();
  const on = library.isFavorite(folder);
  gallery.setFavorite(library.isFavorite(gallery.folder));
  const button = $<HTMLButtonElement>("favorite-button");
  button.classList.toggle("on", on);
  button.disabled = !folder;
}

function toggleFavorite(): void {
  const folder = currentFolder();
  if (!folder) {
    if (mode === "viewer") showToast(t.noFolder);
    return;
  }
  void library.toggle(folder);
}

async function navigate(path: string, focusPath?: string): Promise<void> {
  if (mode !== "browser") setMode("browser");
  const ok = await gallery.load(path, focusPath);
  if (!ok) return;
  library.setActive(path);
  void appWindow.setTitle(`${folderName(path)} - ${APP_NAME}`);
  updateFavorite();
  void library.load();
  void tree.reveal(path);
}

function openViewer(entries: Entry[], index: number, folder: string | null): void {
  if (!entries.length) return;
  setMode("viewer");
  viewer.open(entries, index, folder);
}

function openCompare(entries: Entry[]): void {
  setMode("compare");
  compare.open(entries);
}

function backFromCompare(): void {
  if (compare.isFullscreen) void compare.actions.fullscreen();
  setMode("browser");
}

function back(): void {
  const entry = viewer.current;
  const folder = viewer.folder;
  if (viewer.isFullscreen) void viewer.toggleFullscreen(false);
  if (folder && !samePath(folder, gallery.folder)) {
    void navigate(folder, entry?.path);
    return;
  }
  setMode("browser");
  if (entry) gallery.reveal(entry.path);
}

/** Folders open in the list; files open in the viewer, with their folder listed behind it. */
async function openPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  let listing: Listing;
  try {
    listing = await invoke<Listing>("open_paths", { paths });
  } catch (err) {
    if (paths.length === 1 && err === "no_images") return navigate(paths[0]);
    showToast(errorText(err));
    return;
  }
  if (paths.length === 1 && samePath(listing.folder, paths[0])) return navigate(paths[0]);

  if (paths.length === 1 && listing.folder) {
    const file = listing.entries[listing.index].path;
    const ok = await gallery.load(listing.folder, file);
    if (ok) {
      library.setActive(listing.folder);
      void tree.reveal(listing.folder);
      void library.load();
      const i = gallery.entries.findIndex((e) => samePath(e.path, file));
      openViewer(gallery.entries, Math.max(0, i), listing.folder);
      return;
    }
  }
  void library.load();
  openViewer(listing.entries, listing.index, listing.folder);
}

async function chooseFile(): Promise<void> {
  const picked = await open({ multiple: false, directory: false, filters: [{ name: t.images, extensions }] });
  if (typeof picked === "string") await openPaths([picked]);
}

async function chooseFolder(): Promise<void> {
  const picked = await open({ multiple: false, directory: true });
  if (typeof picked === "string") await navigate(picked);
}

function toggleSidebar(): void {
  document.body.classList.toggle("sidebar-hidden");
}

window.addEventListener("keydown", (e) => {
  if (settingsDialog.isOpen) {
    if (e.key === "Escape") settingsDialog.close();
    return;
  }
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    if (e.key === "Escape") target.blur();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    const digit = /^Digit([1-9])$/.exec(e.code);
    const command =
      e.code === "KeyO" ? () => void (e.shiftKey ? chooseFolder() : chooseFile())
      : e.code === "KeyD" ? toggleFavorite
      : e.code === "KeyB" ? () => (mode === "viewer" ? library.toggleOpen() : toggleSidebar())
      : e.code === "Comma" ? () => settingsDialog.open()
      : digit ? () => library.openFavorite(Number(digit[1]))
      : null;
    if (command) {
      e.preventDefault();
      command();
      return;
    }
  }
  if (e.key === "Escape" && library.isOpen) {
    library.close();
    return;
  }
  if (mode === "compare") {
    if (e.key === "Escape") {
      if (compare.isFullscreen) compare.actions.fullscreen();
      else backFromCompare();
      return;
    }
    compare.handleKey(e);
    return;
  }
  if (mode === "viewer") {
    if (e.key === "Escape") {
      if (viewer.isFullscreen) void viewer.toggleFullscreen(false);
      else back();
      return;
    }
    viewer.handleKey(e);
  } else {
    gallery.handleKey(e);
  }
});

// Dragging the splitter resizes the sidebar.
const splitter = $("splitter");
splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  const move = (ev: PointerEvent) => {
    const width = Math.min(520, Math.max(180, ev.clientX));
    document.documentElement.style.setProperty("--sidebar", `${width}px`);
  };
  const up = (ev: PointerEvent) => {
    splitter.releasePointerCapture(ev.pointerId);
    splitter.removeEventListener("pointermove", move);
    splitter.removeEventListener("pointerup", up);
    document.body.classList.remove("resizing");
    const width = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar"), 10);
    if (width) saveSettings({ sidebarWidth: width });
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
});

$("settings-label").textContent = t.settings;
$("settings-button").title = `${t.settings} (Ctrl/⌘ + ,)`;
$("settings-button").addEventListener("click", () => settingsDialog.open());
$("tree-title").textContent = t.locations;

library.onChange = () => updateFavorite();

void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "enter" || p.type === "over") document.body.classList.add("drop-target");
  else document.body.classList.remove("drop-target");
  if (p.type === "drop") void openPaths(p.paths);
});

void listen<string[]>("open-paths", (event) => void openPaths(event.payload));

window.addEventListener("contextmenu", (e) => e.preventDefault());

async function init(): Promise<void> {
  await loadSettings();
  document.documentElement.style.setProperty("--sidebar", `${settings.sidebarWidth}px`);
  gallery.applySettings();
  setMode("browser");
  [extensions] = await Promise.all([invoke<string[]>("image_extensions"), library.load(), tree.load()]);

  const launch = await invoke<string[]>("take_launch_paths");
  if (launch.length) return openPaths(launch);
  const last = library.recentFirst;
  if (settings.startup === "last" && last?.exists) return navigate(last.path);
  gallery.showEmpty();
}

void init();
