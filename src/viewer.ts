import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, Entry, formatSize, isFullscreen, isWindows, setWindowTitle, showToast, toggleFullscreen } from "./common";
import { t } from "./i18n";
import { showMenu } from "./menu";
import { View } from "./view";

const APP_NAME = "Chojema Image+";
const ZOOM_STEP = 1.25;

// Physical key codes keep shortcuts working when a non-Latin input method is active.
const keymap: Record<string, string> = {
  ArrowRight: "next",
  ArrowDown: "next",
  PageDown: "next",
  Space: "next",
  ArrowLeft: "prev",
  ArrowUp: "prev",
  PageUp: "prev",
  Backspace: "prev",
  Home: "first",
  End: "last",
  Equal: "zoom-in",
  NumpadAdd: "zoom-in",
  Minus: "zoom-out",
  NumpadSubtract: "zoom-out",
  Digit0: "fit",
  Numpad0: "fit",
  Digit1: "actual",
  Numpad1: "actual",
  KeyR: "rotate-right",
  KeyL: "rotate-left",
  KeyF: "fullscreen",
  F11: "fullscreen",
  Enter: "fullscreen",
  NumpadEnter: "fullscreen",
};

export function imageSrc(entry: Entry): string {
  return `${convertFileSrc(entry.path, "img")}?v=${entry.modified}`;
}

/** Single-image view with zoom, pan, rotation and full screen. */
export class Viewer {
  entries: Entry[] = [];
  index = -1;
  folder: string | null = null;

  private readonly stage = $<HTMLElement>("stage");
  private readonly img = $<HTMLImageElement>("image");
  private readonly message = $<HTMLElement>("message");
  private readonly bar = $<HTMLElement>("bar");
  private readonly infoName = $<HTMLElement>("info-name");
  private readonly infoDetail = $<HTMLElement>("info-detail");
  private readonly zoomLabel = $<HTMLButtonElement>("zoom-label");
  private readonly view = new View(this.stage, this.img);
  private readonly appWindow = getCurrentWindow();
  private readonly preloaded = new Map<string, HTMLImageElement>();
  private loadToken = 0;
  private wheelAccum = 0;
  private wheelLock = 0;
  private drag: { id: number; x: number; y: number } | null = null;

  readonly actions: Record<string, () => void>;

  constructor(hooks: {
    back: () => void;
    favorite: () => void;
    folders: () => void;
    trash: (path: string) => void;
    reveal: (path: string) => void;
  }) {
    const v = this.view;
    const loaded = (fn: () => void) => () => {
      if (v.loaded) {
        fn();
        this.updateInfo();
      }
    };
    this.actions = {
      prev: () => this.go(-1),
      next: () => this.go(1),
      first: () => this.show(0),
      last: () => this.show(this.entries.length - 1),
      "zoom-in": loaded(() => v.zoomBy(ZOOM_STEP)),
      "zoom-out": loaded(() => v.zoomBy(1 / ZOOM_STEP)),
      "toggle-zoom": () => this.toggleZoom(),
      actual: loaded(() => v.zoomTo(1)),
      fit: loaded(() => v.fit()),
      "rotate-left": loaded(() => v.rotate(-90)),
      "rotate-right": loaded(() => v.rotate(90)),
      fullscreen: () => void this.toggleFullscreen(),
      back: hooks.back,
      favorite: hooks.favorite,
      folders: hooks.folders,
      trash: () => {
        if (this.current) hooks.trash(this.current.path);
      },
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
      back: t.back,
      favorite: t.favoriteToggle,
      folders: t.folders,
    };
    for (const button of this.bar.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      const action = button.dataset.action!;
      button.title = tooltips[action] ?? "";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.actions[action]?.());
    }
    this.bindPointer();
    this.stage.addEventListener("contextmenu", (e) => {
      const entry = this.current;
      if (!entry) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: t.menuReveal, run: () => hooks.reveal(entry.path) },
        "separator",
        { label: t.menuTrash, run: () => hooks.trash(entry.path), danger: true },
      ]);
    });

    new ResizeObserver(() => {
      if (v.loaded) {
        v.relayout();
        this.updateInfo();
      }
    }).observe(this.stage);

    // In full screen the bar slides in when the pointer nears the bottom edge.
    window.addEventListener("mousemove", (e) => {
      this.bar.classList.toggle("peek", window.innerHeight - e.clientY < 90);
    });
    void this.appWindow.onResized(async () => {
      document.body.classList.toggle("fullscreen", await this.appWindow.isFullscreen());
    });
  }

  get current(): Entry | undefined {
    return this.entries[this.index];
  }

  get isFullscreen(): boolean {
    return isFullscreen();
  }

  open(entries: Entry[], index: number, folder: string | null): void {
    this.entries = entries;
    this.folder = folder;
    this.preloaded.clear();
    this.show(index);
  }

  /** Drops a file that no longer exists; returns false when nothing is left to show. */
  remove(path: string): boolean {
    const i = this.entries.findIndex((e) => e.path === path);
    if (i < 0) return this.entries.length > 0;
    this.entries = this.entries.filter((_, j) => j !== i);
    if (!this.entries.length) return false;
    this.show(Math.min(i, this.entries.length - 1));
    return true;
  }

  /** Releases the displayed image when returning to the list. */
  close(): void {
    this.loadToken++;
    this.img.removeAttribute("src");
    this.img.classList.remove("visible");
    this.preloaded.clear();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.code === "Delete" || (e.metaKey && e.code === "Backspace")) {
      e.preventDefault();
      this.actions.trash();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    let action = keymap[e.code];
    if (e.code === "KeyR" && e.shiftKey) action = "rotate-left";
    if (!action) return false;
    e.preventDefault();
    this.actions[action]();
    return true;
  }

  toggleFullscreen(force?: boolean): Promise<void> {
    return toggleFullscreen(force);
  }

  updateInfo(): void {
    const entry = this.current;
    if (!entry) {
      this.infoName.textContent = "";
      this.infoDetail.textContent = "";
      this.zoomLabel.textContent = "";
      return;
    }
    const v = this.view;
    const parts = [`${this.index + 1} / ${this.entries.length}`];
    if (v.loaded) parts.push(`${v.width} × ${v.height}`);
    parts.push(formatSize(entry.size));
    this.infoName.textContent = entry.name;
    this.infoDetail.textContent = parts.join("  ·  ");
    this.zoomLabel.textContent = v.loaded ? `${Math.round(v.scale * 100)}%` : "";
    setWindowTitle(`${entry.name} - ${APP_NAME}`);
  }

  private showMessage(text: string | null): void {
    this.message.hidden = text === null;
    this.message.textContent = text ?? "";
  }

  private preloadAround(): void {
    const wanted = new Set<string>();
    for (const offset of [1, -1, 2]) {
      const entry = this.entries[this.index + offset];
      if (!entry) continue;
      const src = imageSrc(entry);
      wanted.add(src);
      if (!this.preloaded.has(src)) {
        const pre = new Image();
        pre.decoding = "async";
        pre.src = src;
        this.preloaded.set(src, pre);
      }
    }
    for (const key of this.preloaded.keys()) {
      if (!wanted.has(key)) this.preloaded.delete(key);
    }
  }

  show(i: number): void {
    if (i < 0 || i >= this.entries.length) return;
    this.index = i;
    const entry = this.entries[i];
    const token = ++this.loadToken;
    const v = this.view;
    v.width = 0;
    v.height = 0;
    this.img.classList.remove("visible");
    this.showMessage(null);
    this.updateInfo();

    this.img.onload = () => {
      if (token !== this.loadToken) return;
      v.reset(this.img.naturalWidth, this.img.naturalHeight);
      this.img.classList.add("visible");
      this.updateInfo();
    };
    this.img.onerror = () => {
      if (token !== this.loadToken) return;
      this.showMessage(isWindows && /\.hei[cf]$/i.test(entry.name) ? t.heifHint : t.loadFailed);
      this.updateInfo();
    };
    this.img.src = imageSrc(entry);
    this.preloadAround();
  }

  private go(delta: number): void {
    if (!this.entries.length) return;
    const next = this.index + delta;
    if (next < 0) return showToast(t.first);
    if (next >= this.entries.length) return showToast(t.last);
    this.show(next);
  }

  private toggleZoom(cx?: number, cy?: number): void {
    const v = this.view;
    if (!v.loaded) return;
    if (v.fitted && Math.abs(v.scale - 1) > 0.001) v.zoomTo(1, cx, cy);
    else v.fit();
    this.updateInfo();
  }

  private bindPointer(): void {
    const stage = this.stage;
    const v = this.view;
    stage.addEventListener(
      "wheel",
      (e) => {
        if (!v.loaded) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;

        // Pinch gestures and Ctrl/Cmd + wheel zoom around the pointer.
        if (e.ctrlKey || e.metaKey) {
          v.zoomBy(Math.exp(-dy * 0.01), cx, cy);
          this.updateInfo();
          return;
        }
        if (v.pannable) {
          const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
          v.panBy(e.shiftKey ? -dy : -dx, e.shiftKey ? 0 : -dy);
          return;
        }
        const now = performance.now();
        if (now < this.wheelLock) return;
        this.wheelAccum += dy;
        if (Math.abs(this.wheelAccum) >= 40) {
          this.go(this.wheelAccum > 0 ? 1 : -1);
          this.wheelAccum = 0;
          this.wheelLock = now + 180;
        }
      },
      { passive: false },
    );

    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !v.loaded || !v.pannable) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
    });
    stage.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      v.panBy(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX;
      d.y = e.clientY;
    });
    const endDrag = (e: PointerEvent) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("dblclick", (e) => {
      const rect = stage.getBoundingClientRect();
      this.toggleZoom(e.clientX - rect.left, e.clientY - rect.top);
    });
  }
}
