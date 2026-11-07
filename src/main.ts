import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { $, Entry, isVideo, parentOf, samePath, setVideoExtensions, setWindowTitle, showToast, within } from "./common";
import { AboutDialog } from "./about";
import { Compare } from "./compare";
import { Editor } from "./editor";
import { Exporter } from "./exporter";
import { Gallery } from "./gallery";
import { errorText, Language, t } from "./i18n";
import { Library } from "./library";
import { menuOpen } from "./menu";
import { modalOpen } from "./modal";
import { Transfer, type TransferMode } from "./transfer";
import { loadSettings, saveSettings, settings, SettingsDialog, syncLanguage } from "./settings";
import { Slideshow, SlideshowDialog } from "./slideshow";
import { FolderTree } from "./tree";
import { Viewer } from "./viewer";

interface Listing {
  entries: Entry[];
  index: number;
  folder: string | null;
}

const APP_NAME = "Chojema Image+";
let extensions: string[] = [];
type Mode = "browser" | "viewer" | "compare" | "slideshow";
let mode: Mode = "browser";

const library = new Library($("side-library"), $("panel"), {
  open: (path) => void navigate(path),
  toast: showToast,
});
const tree = new FolderTree($("tree"), (path) => void navigate(path));
const panes: Gallery[] = [];
let activeIndex = 0;
const active = (): Gallery => panes[activeIndex];

function makePane(): Gallery {
  const pane: Gallery = new Gallery($("galleries"), {
    navigate: (path, back) => void navigate(path, undefined, pane, back),
    open: (entries, index) => openViewer(entries, index, pane.folder),
    compare: (entries) => openCompare(entries),
    transfer: (paths, dest, transferMode) => void startTransfer(paths, dest, pane, transferMode),
    dragOut: (paths) => dragOut(paths),
    trash: (paths) => void transfer.trash(paths),
    createFolder: () => void createFolder(pane),
    rename: (path, folder) => void renameEntry(pane, path, folder),
    clipboard: (paths, cut) => void transfer.copyToClipboard(paths, cut),
    paste: (forceMove) => { if (pane.folder) void transfer.paste(pane.folder, forceMove); },
    slideshow: () => void startSlideshow(pane.folder),
    export: (paths) => void startExport(paths, pane.folder, pane),
    reveal: (path) => void invoke("reveal", { path }),
    favorite: () => toggleFavorite(),
    chooseFolder: () => void chooseFolder(),
    chooseFile: () => void chooseFile(),
    toast: showToast,
    activate: (g) => activate(panes.indexOf(g)),
    sizeChanged: (size) => panes.forEach((p) => p !== pane && p.setSize(size)),
    dual: () => void toggleDual(),
    dualLayout: () => toggleDualLayout(),
    sortChanged: () => panes.forEach((p) => p.applySort()),
  });
  pane.applySettings();
  panes.push(pane);
  return pane;
}

/** Keeps the backend watching exactly the folders shown in the panes. */
function watchPanes(): void {
  const folders = panes.map((p) => p.folder).filter((f): f is string => !!f);
  void invoke("watch_folders", { folders });
}

function activate(i: number): void {
  if (i < 0 || i >= panes.length) return;
  const changed = i !== activeIndex;
  activeIndex = i;
  panes.forEach((p, j) => p.setActive(j === i && panes.length > 1));
  if (!changed) return;
  const folder = active().folder;
  library.setActive(folder);
  if (folder) void tree.reveal(folder);
  setTitle(folder ? `${folderName(folder)} - ${APP_NAME}` : APP_NAME);
  updateFavorite();
}

/** Remember the folder in its own pane, independently of the shared recent list. */
async function loadPane(pane: Gallery, path: string, focusPath?: string, back = false): Promise<boolean> {
  const ok = await pane.load(path, focusPath, back);
  if (ok) saveSettings(pane === panes[0] ? { mainFolder: path } : { dualFolder: path });
  return ok;
}

async function toggleDual(start: string | null = settings.dualFolder || panes[0].folder): Promise<void> {
  if (panes.length > 1) {
    const second = panes.pop()!;
    second.dispose();
    document.body.classList.remove("dual");
    saveSettings({ dual: false });
    watchPanes();
    activeIndex = -1;
    activate(0);
    return;
  }
  document.body.classList.add("dual");
  saveSettings({ dual: true });
  const pane = makePane();
  if (start) await loadPane(pane, start);
  if (!pane.folder) pane.showEmpty();
  watchPanes();
  activate(1);
}

function toggleDualLayout(): void {
  saveSettings({ dualVertical: !settings.dualVertical });
  document.body.classList.toggle("dual-vertical", settings.dualVertical);
}
const viewer = new Viewer({
  back: () => back(),
  favorite: () => toggleFavorite(),
  folders: () => library.toggleOpen(),
  trash: (path) => void trashFromViewer(path),
  reveal: (path) => void invoke("reveal", { path }),
  export: (path) => void startExport([path], parentOf(path), null),
  edit: (entry) => void editor.open(entry),
});
const editor = new Editor((entry, replaced) => {
  viewer.showEdited(entry, replaced);
  panes.forEach((p) => void p.refreshQuiet());
});

async function trashFromViewer(path: string): Promise<void> {
  const done = await transfer.trash([path]);
  if (done.includes(path) && !viewer.remove(path)) back();
}
const transfer = new Transfer((relocated = [], foldersChanged = false) => {
  compare.relocate(relocated);
  for (const p of panes) {
    p.relocate(relocated);
    void p.refreshQuiet();
  }
  if (relocated.length) {
    for (const key of ["mainFolder", "dualFolder"] as const) {
      const folder = settings[key];
      if (!folder) continue;
      const moved = relocated.find((d) => within(d.from, folder));
      if (moved) saveSettings({ [key]: moved.to + folder.normalize("NFC").slice(moved.from.normalize("NFC").length) });
    }
    library.setActive(active().folder);
    void library.load();
    watchPanes();
    setTitle(active().folder ? `${folderName(active().folder!)} - ${APP_NAME}` : APP_NAME);
    if (foldersChanged) {
      tree.relocate(relocated);
      void tree.refresh(relocated.flatMap((d) => [parentOf(d.from), parentOf(d.to)]).filter((p): p is string => !!p));
    }
  }
});

async function createFolder(pane: Gallery): Promise<void> {
  const parent = pane.folder;
  if (!parent) return;
  const path = await transfer.createFolder(parent, pane.newFolderName);
  if (!path) return;
  await Promise.all(panes.filter((p) => samePath(p.folder, parent)).map((p) => p.refreshQuiet()));
  if (samePath(pane.folder, parent)) pane.revealFolder(path);
  await tree.refresh([parent]);
}

async function renameEntry(pane: Gallery, path: string, folder: boolean): Promise<void> {
  const done = await transfer.rename(path, folder);
  if (!done.length) return;
  await Promise.all(panes.map((p) => p.refreshQuiet()));
  const renamed = done.find((d) => samePath(d.from, path));
  if (renamed) {
    if (folder && samePath(pane.folder, parentOf(renamed.to))) pane.revealFolder(renamed.to);
    else if (!folder) { pane.clearSearch(); pane.reveal(renamed.to); pane.focusGrid(); }
  }
}
const compare = new Compare({ back: () => backFromCompare(), transfer: transferComparedImage });

async function transferComparedImage(entry: Entry, transferMode: TransferMode): Promise<void> {
  const dest = await open({ multiple: false, directory: true, defaultPath: parentOf(entry.path) ?? undefined });
  if (typeof dest === "string") await transfer.start([entry.path], dest, transferMode);
}
const aboutDialog = new AboutDialog();
const settingsDialog = new SettingsDialog((choice) => applyLanguage(choice));
const RESTORE_KEY = "chojema-image-plus.restore";

/** Redraws the interface in the new language, reopening the same folders afterwards. */
function applyLanguage(choice: Language): void {
  if (!syncLanguage(choice)) return;
  try {
    sessionStorage.setItem(RESTORE_KEY, JSON.stringify({
      folder: panes[0]?.folder ?? null,
      secondFolder: panes[1]?.folder ?? null,
      active: activeIndex,
    }));
  } catch {
    // Without session storage the start-up setting decides what opens.
  }
  location.reload();
}

function takeRestore(): { folder: string | null; secondFolder: string | null; active: number } | null {
  try {
    const raw = sessionStorage.getItem(RESTORE_KEY);
    sessionStorage.removeItem(RESTORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const exporter = new Exporter(
  (failed) => transfer.reportFailures(failed),
  () => panes.forEach((p) => void p.refreshQuiet()),
);

function startExport(all: string[], folder: string | null, from: Gallery | null): void {
  const paths = all.filter((p) => !isVideo(p));
  if (paths.length < all.length) showToast(t.videoNoExport, 2400);
  if (!paths.length) return;
  const source = folder ?? (paths[0] ? parentOf(paths[0]) : null);
  if (!source) return;
  const other = panes.length > 1 ? (panes.find((p) => p !== (from ?? active()))?.folder ?? null) : null;
  void exporter.start(paths, source, other);
}
const slideshowDialog = new SlideshowDialog();
let modeBeforeSlideshow: Mode = "browser";
const slideshow = new Slideshow((last, openFolder) => {
  const folder = last && parentOf(last.path);
  if (openFolder && last && folder) {
    void navigate(folder, last.path);
    return;
  }
  setMode(modeBeforeSlideshow === "viewer" ? "browser" : modeBeforeSlideshow);
  if (last && samePath(parentOf(last.path), active().folder)) active().reveal(last.path);
});


async function startSlideshow(folder: string | null): Promise<void> {
  const options = await slideshowDialog.ask(folder ?? active().folder);
  if (!options) return;
  modeBeforeSlideshow = mode === "compare" ? "browser" : mode;
  setMode("slideshow");
  const ok = await slideshow.start(options, (list) => active().sorted(list));
  if (!ok) setMode(modeBeforeSlideshow === "viewer" ? "browser" : modeBeforeSlideshow);
}

const setTitle = setWindowTitle;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function setMode(next: Mode): void {
  const previous = mode;
  if (previous === "browser" && next !== "browser") panes.forEach((p) => p.suspend());
  mode = next;
  for (const m of ["browser", "viewer", "compare", "slideshow"]) document.body.classList.toggle(`mode-${m}`, m === next);
  if (next !== "viewer") {
    editor.close();
    viewer.close();
  }
  if (next !== "compare") compare.close();
  if (next === "browser") {
    if (previous !== "browser") panes.forEach((p) => p.resume());
    library.close();
    const folder = active().folder;
    setTitle(folder ? `${folderName(folder)} - ${APP_NAME}` : APP_NAME);
    active().focusGrid();
  }
  updateFavorite();
}

function currentFolder(): string | null {
  return mode === "viewer" ? viewer.folder : active().folder;
}

function updateFavorite(): void {
  const folder = currentFolder();
  const on = library.isFavorite(folder);
  for (const p of panes) p.setFavorite(library.isFavorite(p.folder));
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

async function navigate(path: string, focusPath?: string, pane: Gallery = active(), back = false): Promise<void> {
  if (mode !== "browser") setMode("browser");
  activate(panes.indexOf(pane));
  const ok = await loadPane(pane, path, focusPath, back);
  if (!ok) return;
  watchPanes();
  library.setActive(path);
  setTitle(`${folderName(path)} - ${APP_NAME}`);
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

let leavingViewer = false;
async function back(): Promise<void> {
  if (leavingViewer) return;
  leavingViewer = true;
  try {
    if (viewer.isFullscreen) await viewer.toggleFullscreen(false);
    if (mode !== "viewer") return;
    const entry = viewer.current;
    const folder = viewer.folder;
    if (folder && !samePath(folder, active().folder)) {
      await navigate(folder, entry?.path);
      return;
    }
    setMode("browser");
    if (entry) active().reveal(entry.path);
  } catch (err) { showToast(errorText(err)); }
  finally { leavingViewer = false; }
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
    const pane = active();
    const ok = await loadPane(pane, listing.folder, file);
    if (ok) {
      watchPanes();
      library.setActive(listing.folder);
      void tree.reveal(listing.folder);
      void library.load();
      const i = pane.entries.findIndex((e) => samePath(e.path, file));
      openViewer(pane.entries, Math.max(0, i), listing.folder);
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

/** Without a destination: the other pane's folder in dual mode, otherwise a folder picker. */
async function startTransfer(paths: string[], dest: string | null, from: Gallery, transferMode?: TransferMode): Promise<void> {
  let target: string | null = dest;
  if (!target && panes.length > 1) {
    target = panes.find((p) => p !== from)?.folder ?? null;
    if (!target) {
      showToast(t.dualNoTarget);
      return;
    }
  }
  if (!target) {
    const picked = await open({ multiple: false, directory: true, defaultPath: from.folder ?? undefined });
    if (typeof picked !== "string") return;
    target = picked;
  }
  await transfer.start(paths, target, transferMode);
}

function toggleSidebar(): void {
  document.body.classList.toggle("sidebar-hidden");
}

window.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (modalOpen() || menuOpen() || slideshowDialog.isOpen || exporter.isOpen || aboutDialog.isOpen) return;
  if (editor.isOpen) {
    editor.handleKey(e);
    return;
  }
  if (mode === "slideshow") {
    slideshow.handleKey(e);
    return;
  }
  if (settingsDialog.isOpen) {
    if (e.key === "Escape") settingsDialog.close();
    return;
  }
  const target = e.target as HTMLElement;
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyF" && mode === "browser") {
    e.preventDefault(); active().focusSearch(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyN" && mode === "browser") {
    e.preventDefault(); active().command("new-folder"); return;
  }
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
      : e.code === "KeyZ" && (mode === "browser" || mode === "compare") ? () => void transfer.undo()
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
    if (e.code === "KeyS" && !mod) {
      e.preventDefault();
      void startSlideshow(viewer.folder);
      return;
    }
    viewer.handleKey(e);
  } else {
    if (e.code === "F6" && !mod) {
      e.preventDefault();
      void toggleDual();
      return;
    }
    if (e.code === "Tab" && !mod && panes.length > 1) {
      e.preventDefault();
      activate(1 - activeIndex);
      active().focusGrid();
      return;
    }
    active().handleKey(e);
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
$("about-button").title = t.about;
$("about-button").setAttribute("aria-label", t.about);
$("about-button").addEventListener("click", () => aboutDialog.open());
$("tree-title").textContent = t.locations;

library.onChange = () => updateFavorite();

/**
 * Files dragged out of the list. Dropping them back on the window is not an open request: the
 * drop can arrive just after the drag has ended, so the same files are ignored for a moment longer.
 */
let draggingOut: { paths: Set<string>; ended: number } | null = null;
function dragOut(paths: string[]): void {
  draggingOut = { paths: new Set(paths), ended: 0 };
  invoke("drag_out", { paths }).catch(() => (draggingOut = null));
}
function isOwnDrop(paths: string[]): boolean {
  if (!draggingOut) return false;
  if (draggingOut.ended && performance.now() - draggingOut.ended > 1500) {
    draggingOut = null;
    return false;
  }
  return !draggingOut.ended || paths.every((p) => draggingOut!.paths.has(p));
}
void listen<boolean>("drag-out-ended", (event) => {
  if (draggingOut) draggingOut.ended = performance.now();
  document.body.classList.remove("drop-target");
  // A move to another app removes files from the list; the folder watcher also reports it.
  if (event.payload) panes.forEach((p) => void p.refreshQuiet());
});

void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (isOwnDrop(p.type === "drop" ? p.paths : [])) {
    document.body.classList.remove("drop-target");
    return;
  }
  if (p.type === "enter" || p.type === "over") document.body.classList.add("drop-target");
  else document.body.classList.remove("drop-target");
  if (p.type === "drop") void openPaths(p.paths);
});

void listen<string[]>("open-paths", (event) => void openPaths(event.payload));
void listen<string>("folder-changed", (event) => {
  for (const p of panes) if (samePath(p.folder, event.payload)) void p.refreshQuiet();
});

window.addEventListener("contextmenu", (e) => e.preventDefault());

async function init(): Promise<void> {
  await loadSettings();
  // The mirror can be missing (first start after an update, cleared storage): redraw once.
  if (syncLanguage(settings.language)) {
    location.reload();
    return;
  }
  const restore = takeRestore();
  document.documentElement.style.setProperty("--sidebar", `${settings.sidebarWidth}px`);
  makePane();
  document.body.classList.toggle("dual-vertical", settings.dualVertical);
  setMode("browser");
  let videos: string[];
  [extensions, videos] = await Promise.all([invoke<string[]>("image_extensions"), invoke<string[]>("video_extensions"), library.load(), tree.load()]);
  setVideoExtensions(videos);

  const launch = await invoke<string[]>("take_launch_paths");
  if (launch.length) await openPaths(launch);
  else {
    const last = library.recentFirst;
    const folder = restore ? restore.folder : settings.startup === "last"
      ? settings.mainFolder ?? (last?.exists ? last.path : null)
      : null;
    if (folder) await navigate(folder);
    if (!panes[0].folder) panes[0].showEmpty();
  }
  // Complete migration even with an empty pane so later right-pane visits cannot seed the left.
  if (settings.mainFolder === null) saveSettings({ mainFolder: "" });
  if (settings.dual && mode === "browser") {
    const folder = restore ? restore.secondFolder : settings.startup === "last" ? settings.dualFolder : null;
    await toggleDual(folder || null);
    activate(restore?.active === 1 ? 1 : 0);
  }
}

void init();
