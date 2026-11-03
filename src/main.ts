import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { errorText, t } from "./i18n";
import { View } from "./view";

interface Entry {
  path: string;
  name: string;
  size: number;
  modified: number;
}

interface Listing {
  entries: Entry[];
  index: number;
}

const APP_NAME = "Chojema Image+";
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const ZOOM_STEP = 1.25;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLElement>("stage");
const img = $<HTMLImageElement>("image");
const empty = $<HTMLElement>("empty");
const message = $<HTMLElement>("message");
const bar = $<HTMLElement>("bar");
const infoName = $<HTMLElement>("info-name");
const infoDetail = $<HTMLElement>("info-detail");
const zoomLabel = $<HTMLButtonElement>("zoom-label");
const toast = $<HTMLElement>("toast");

const appWindow = getCurrentWindow();
const view = new View(stage, img);

let entries: Entry[] = [];
let index = -1;
let loadToken = 0;
let extensions: string[] = [];
const preloaded = new Map<string, HTMLImageElement>();

const current = (): Entry | undefined => entries[index];

function srcOf(entry: Entry): string {
  return `${convertFileSrc(entry.path, "img")}?v=${entry.modified}`;
}

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 || n >= 100 ? 0 : 1)} ${units[u]}`;
}

function updateInfo(): void {
  const entry = current();
  if (!entry) {
    infoName.textContent = "";
    infoDetail.textContent = "";
    zoomLabel.textContent = "";
    void appWindow.setTitle(APP_NAME);
    return;
  }
  const parts = [`${index + 1} / ${entries.length}`];
  if (view.loaded) parts.push(`${view.width} × ${view.height}`);
  parts.push(formatSize(entry.size));
  infoName.textContent = entry.name;
  infoDetail.textContent = parts.join("  ·  ");
  zoomLabel.textContent = view.loaded ? `${Math.round(view.scale * 100)}%` : "";
  void appWindow.setTitle(`${entry.name} - ${APP_NAME}`);
}

let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 1600);
}

function showMessage(text: string | null): void {
  message.hidden = text === null;
  message.textContent = text ?? "";
}

function setEmpty(isEmpty: boolean): void {
  empty.hidden = !isEmpty;
  document.body.classList.toggle("has-image", !isEmpty);
}

function preloadAround(): void {
  const wanted = new Set<string>();
  for (const offset of [1, -1, 2]) {
    const entry = entries[index + offset];
    if (!entry) continue;
    const src = srcOf(entry);
    wanted.add(src);
    if (!preloaded.has(src)) {
      const pre = new Image();
      pre.decoding = "async";
      pre.src = src;
      preloaded.set(src, pre);
    }
  }
  for (const key of preloaded.keys()) {
    if (!wanted.has(key)) preloaded.delete(key);
  }
}

function show(i: number): void {
  if (i < 0 || i >= entries.length) return;
  index = i;
  const entry = entries[i];
  const token = ++loadToken;
  view.width = 0;
  view.height = 0;
  img.classList.remove("visible");
  showMessage(null);
  updateInfo();

  img.onload = () => {
    if (token !== loadToken) return;
    view.reset(img.naturalWidth, img.naturalHeight);
    img.classList.add("visible");
    updateInfo();
  };
  img.onerror = () => {
    if (token !== loadToken) return;
    showMessage(IS_WINDOWS && /\.hei[cf]$/i.test(entry.name) ? t.heifHint : t.loadFailed);
    updateInfo();
  };
  img.src = srcOf(entry);
  preloadAround();
}

function go(delta: number): void {
  if (!entries.length) return;
  const next = index + delta;
  if (next < 0) return showToast(t.first);
  if (next >= entries.length) return showToast(t.last);
  show(next);
}

async function openPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    const listing = await invoke<Listing>("open_paths", { paths });
    entries = listing.entries;
    preloaded.clear();
    setEmpty(false);
    show(listing.index);
  } catch (err) {
    if (entries.length) showToast(errorText(err));
    else {
      setEmpty(true);
      showToast(errorText(err));
    }
  }
}

async function chooseFile(): Promise<void> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: t.images, extensions }],
  });
  if (typeof picked === "string") await openPaths([picked]);
}

async function chooseFolder(): Promise<void> {
  const picked = await open({ multiple: false, directory: true });
  if (typeof picked === "string") await openPaths([picked]);
}

async function toggleFullscreen(force?: boolean): Promise<void> {
  const next = force ?? !(await appWindow.isFullscreen());
  await appWindow.setFullscreen(next);
  document.body.classList.toggle("fullscreen", next);
}

function toggleZoom(cx?: number, cy?: number): void {
  if (!view.loaded) return;
  if (view.fitted && Math.abs(view.scale - 1) > 0.001) view.zoomTo(1, cx, cy);
  else view.fit();
  updateInfo();
}

const actions: Record<string, () => void> = {
  prev: () => go(-1),
  next: () => go(1),
  first: () => show(0),
  last: () => show(entries.length - 1),
  "zoom-in": () => view.loaded && (view.zoomBy(ZOOM_STEP), updateInfo()),
  "zoom-out": () => view.loaded && (view.zoomBy(1 / ZOOM_STEP), updateInfo()),
  "toggle-zoom": () => toggleZoom(),
  actual: () => view.loaded && (view.zoomTo(1), updateInfo()),
  fit: () => view.loaded && (view.fit(), updateInfo()),
  "rotate-left": () => view.loaded && (view.rotate(-90), updateInfo()),
  "rotate-right": () => view.loaded && (view.rotate(90), updateInfo()),
  fullscreen: () => void toggleFullscreen(),
  open: () => void chooseFile(),
  "open-folder": () => void chooseFolder(),
};

const tooltips: Record<string, string> = {
  prev: t.prev,
  next: t.next,
  "zoom-out": t.zoomOut,
  "zoom-in": t.zoomIn,
  "toggle-zoom": t.toggleZoom,
  fit: t.fit,
  "rotate-left": t.rotateLeft,
  "rotate-right": t.rotateRight,
  fullscreen: t.fullscreen,
  open: t.open,
};

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
  const action = button.dataset.action!;
  button.title = tooltips[action] ?? "";
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () => actions[action]?.());
}

$("empty-text").textContent = t.emptyText;
$("empty-open-file").textContent = t.openFile;
$("empty-open-folder").textContent = t.openFolder;
$("empty-open-file").addEventListener("click", () => void chooseFile());
$("empty-open-folder").addEventListener("click", () => void chooseFolder());

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    return e.shiftKey ? actions["open-folder"]() : actions.open();
  }
  if (mod || e.altKey) return;

  const keymap: Record<string, string> = {
    ArrowRight: "next",
    ArrowDown: "next",
    PageDown: "next",
    " ": "next",
    ArrowLeft: "prev",
    ArrowUp: "prev",
    PageUp: "prev",
    Backspace: "prev",
    Home: "first",
    End: "last",
    "+": "zoom-in",
    "=": "zoom-in",
    "-": "zoom-out",
    _: "zoom-out",
    "0": "fit",
    "1": "actual",
    r: "rotate-right",
    R: e.shiftKey ? "rotate-left" : "rotate-right",
    l: "rotate-left",
    L: "rotate-left",
    f: "fullscreen",
    F: "fullscreen",
    F11: "fullscreen",
    Enter: "fullscreen",
  };

  if (e.key === "Escape") {
    if (document.body.classList.contains("fullscreen")) void toggleFullscreen(false);
    return;
  }
  const action = keymap[e.key];
  if (action) {
    e.preventDefault();
    actions[action]();
  }
});

let wheelAccum = 0;
let wheelLock = 0;
stage.addEventListener(
  "wheel",
  (e) => {
    if (!view.loaded) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;

    // Pinch gestures and Ctrl/Cmd + wheel zoom around the pointer.
    if (e.ctrlKey || e.metaKey) {
      view.zoomBy(Math.exp(-dy * 0.01), cx, cy);
      updateInfo();
      return;
    }
    if (view.pannable) {
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      view.panBy(e.shiftKey ? -dy : -dx, e.shiftKey ? 0 : -dy);
      return;
    }
    const now = performance.now();
    if (now < wheelLock) return;
    wheelAccum += dy;
    if (Math.abs(wheelAccum) >= 40) {
      go(wheelAccum > 0 ? 1 : -1);
      wheelAccum = 0;
      wheelLock = now + 180;
    }
  },
  { passive: false },
);

let drag: { id: number; x: number; y: number } | null = null;
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !view.loaded || !view.pannable) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("dragging");
});
stage.addEventListener("pointermove", (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  view.panBy(e.clientX - drag.x, e.clientY - drag.y);
  drag.x = e.clientX;
  drag.y = e.clientY;
});
const endDrag = (e: PointerEvent) => {
  if (!drag || drag.id !== e.pointerId) return;
  drag = null;
  stage.classList.remove("dragging");
};
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);

stage.addEventListener("dblclick", (e) => {
  const rect = stage.getBoundingClientRect();
  toggleZoom(e.clientX - rect.left, e.clientY - rect.top);
});

new ResizeObserver(() => {
  if (view.loaded) {
    view.relayout();
    updateInfo();
  }
}).observe(stage);

// In full screen the bar slides in when the pointer nears the bottom edge.
window.addEventListener("mousemove", (e) => {
  bar.classList.toggle("peek", window.innerHeight - e.clientY < 90);
});

void appWindow.onResized(async () => {
  document.body.classList.toggle("fullscreen", await appWindow.isFullscreen());
});

void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "enter" || p.type === "over") document.body.classList.add("drop-target");
  else document.body.classList.remove("drop-target");
  if (p.type === "drop") void openPaths(p.paths);
});

void listen<string[]>("open-paths", (event) => void openPaths(event.payload));

window.addEventListener("contextmenu", (e) => e.preventDefault());

async function init(): Promise<void> {
  setEmpty(true);
  updateInfo();
  extensions = await invoke<string[]>("image_extensions");
  const launch = await invoke<string[]>("take_launch_paths");
  if (launch.length) await openPaths(launch);
}

void init();
