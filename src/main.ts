import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { $, Entry, parentOf, samePath, setWindowTitle, showToast } from "./common";
import { Compare } from "./compare";
import { Exporter } from "./exporter";
import { Gallery } from "./gallery";
import { errorText, t } from "./i18n";
import { Library } from "./library";
import { menuOpen } from "./menu";
import { modalOpen } from "./modal";
import { Transfer } from "./transfer";
import { loadSettings, saveSettings, settings, SettingsDialog } from "./settings";
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
    navigate: (path) => void navigate(path, undefined, pane),
    open: (entries, index) => openViewer(entries, index, pane.folder),
    compare: (entries) => openCompare(entries),
    transfer: (paths, dest) => void startTransfer(paths, dest, pane),
    trash: (paths) => void transfer.trash(paths),
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

async function toggleDual(): Promise<void> {
  if (panes.length > 1) {
    const second = panes.pop()!;
    second.root.remove();
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
  const start = settings.dualFolder || panes[0].folder;
  if (start && !(await pane.load(start))) {
    if (panes[0].folder) await pane.load(panes[0].folder);
  }
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
});

async function trashFromViewer(path: string): Promise<void> {
  const done = await transfer.trash([path]);
  if (done.includes(path) && !viewer.remove(path)) back();
}
const transfer = new Transfer(() => panes.forEach((p) => p.folder && p.command("refresh")));
const compare = new Compare({ back: () => backFromCompare() });
const settingsDialog = new SettingsDialog();
const exporter = new Exporter(
  (failed) => transfer.reportFailures(failed),
  () => panes.forEach((p) => p.folder && p.command("refresh")),
);

function startExport(paths: string[], folder: string | null, from: Gallery | null): void {
  const source = folder ?? (paths[0] ? parentOf(paths[0]) : null);
  if (!source) return;
  const other = panes.length > 1 ? (panes.find((p) => p !== (from ?? active()))?.folder ?? null) : null;
  void exporter.start(paths, source, other);
}
const slideshowDialog = new SlideshowDialog();
let modeBeforeSlideshow: Mode = "browser";
const slideshow = new Slideshow((last) => {
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
  mode = next;
  for (const m of ["browser", "viewer", "compare", "slideshow"]) document.body.classList.toggle(`mode-${m}`, m === next);
  if (next !== "viewer") viewer.close();
  if (next !== "compare") compare.close();
  if (next === "browser") {
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

async function navigate(path: string, focusPath?: string, pane: Gallery = active()): Promise<void> {
  if (mode !== "browser") setMode("browser");
  activate(panes.indexOf(pane));
  const ok = await pane.load(path, focusPath);
  if (!ok) return;
  watchPanes();
  if (pane === panes[1]) saveSettings({ dualFolder: path });
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

function back(): void {
  const entry = viewer.current;
  const folder = viewer.folder;
  if (viewer.isFullscreen) void viewer.toggleFullscreen(false);
  if (folder && !samePath(folder, active().folder)) {
    void navigate(folder, entry?.path);
    return;
  }
  setMode("browser");
  if (entry) active().reveal(entry.path);
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
    const ok = await pane.load(listing.folder, file);
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
async function startTransfer(paths: string[], dest: string | null, from: Gallery): Promise<void> {
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
  await transfer.start(paths, target);
}

function toggleSidebar(): void {
  document.body.classList.toggle("sidebar-hidden");
}

window.addEventListener("keydown", (e) => {
  if (modalOpen() || menuOpen() || slideshowDialog.isOpen || exporter.isOpen) return;
  if (mode === "slideshow") {
    slideshow.handleKey(e);
    return;
  }
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
      : e.code === "KeyZ" && mode === "browser" ? () => void transfer.undo()
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
$("tree-title").textContent = t.locations;

library.onChange = () => updateFavorite();

void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
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
  document.documentElement.style.setProperty("--sidebar", `${settings.sidebarWidth}px`);
  makePane();
  document.body.classList.toggle("dual-vertical", settings.dualVertical);
  setMode("browser");
  [extensions] = await Promise.all([invoke<string[]>("image_extensions"), library.load(), tree.load()]);

  const launch = await invoke<string[]>("take_launch_paths");
  if (launch.length) await openPaths(launch);
  else {
    const last = library.recentFirst;
    if (settings.startup === "last" && last?.exists) await navigate(last.path);
    else panes[0].showEmpty();
  }
  if (settings.dual && mode === "browser") {
    await toggleDual();
    activate(0);
  }
}

void init();
