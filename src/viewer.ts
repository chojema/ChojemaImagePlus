import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, Entry, formatDuration, formatSize, isFullscreen, isVideo, isWindows, setWindowTitle, showToast, toggleFullscreen } from "./common";
import { t } from "./i18n";
import { showMenu } from "./menu";
import { View } from "./view";
import { PhotoDetails } from "./photo-info";

const APP_NAME = "Chojema Image+";
const ZOOM_STEP = 1.25;
const SEEK_STEP = 5;
const HOLD_DELAY = 150;
/** Toolbar actions that only apply to still images. */
const IMAGE_ONLY = ["zoom-out", "toggle-zoom", "zoom-in", "fit", "rotate-left", "rotate-right", "edit"];

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
  KeyE: "edit",
  KeyI: "details",
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
  private readonly video = $<HTMLVideoElement>("video");
  private videoInfo: { width: number; height: number; duration: number } | null = null;
  private readonly message = $<HTMLElement>("message");
  private readonly bar = $<HTMLElement>("bar");
  private readonly infoName = $<HTMLElement>("info-name");
  private readonly infoDetail = $<HTMLElement>("info-detail");
  private readonly zoomLabel = $<HTMLButtonElement>("zoom-label");
  private readonly view = new View(this.stage, this.img);
  private readonly details = new PhotoDetails();
  private readonly appWindow = getCurrentWindow();
  private readonly preloaded = new Map<string, HTMLImageElement>();
  private loadToken = 0;
  private wheelAccum = 0;
  private wheelLock = 0;
  private drag: { id: number; x: number; y: number } | null = null;
  private hold: { id: number; x: number; y: number; scale: number; timer: number; active: boolean } | null = null;

  readonly actions: Record<string, () => void>;

  constructor(hooks: {
    back: () => void;
    favorite: () => void;
    folders: () => void;
    trash: (path: string) => void;
    reveal: (path: string) => void;
    export: (path: string) => void;
    edit: (entry: Entry) => void;
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
      details: () => this.details.toggle(),
      trash: () => {
        if (this.current) hooks.trash(this.current.path);
      },
      export: () => {
        if (this.current) hooks.export(this.current.path);
      },
      edit: () => {
        if (this.showingVideo) showToast(t.videoNoEdit);
        else if (this.current && v.loaded) hooks.edit(this.current);
        else showToast(t.edNotReady);
      },
      "play-pause": () => {
        if (!this.showingVideo) return;
        if (this.video.paused || this.video.ended) void this.video.play().catch(() => {});
        else this.video.pause();
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
      edit: t.edit,
      fullscreen: t.fullscreen,
      back: t.back,
      favorite: t.favoriteToggle,
      folders: t.folders,
      details: t.photoDetails,
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
      const image = !isVideo(entry);
      showMenu(e.clientX, e.clientY, [
        { label: t.menuReveal, run: () => hooks.reveal(entry.path) },
        ...(image
          ? [
              { label: t.menuExport, run: () => hooks.export(entry.path) },
              { label: t.edTitle, run: () => this.actions.edit() },
            ]
          : [{ label: t.playPause, run: () => this.actions["play-pause"]() }]),
        { label: t.photoDetails, run: () => this.actions.details() },
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
      const peek = window.innerHeight - e.clientY < Math.max(90, this.bar.offsetHeight + 12);
      this.bar.classList.toggle("peek", peek);
      // Video controls move above the bar so both stay usable in full screen.
      this.stage.classList.toggle("bar-peek", peek);
      if (peek) this.stage.style.setProperty("--bar-height", `${this.bar.offsetHeight}px`);
    });
    void this.appWindow.onResized(async () => {
      document.body.classList.toggle("fullscreen", await this.appWindow.isFullscreen());
    });
  }

  get current(): Entry | undefined {
    return this.entries[this.index];
  }

  private get showingVideo(): boolean {
    return !this.video.hidden;
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

  /** Shows an edited image: a saved copy is added after the current one, a replaced original reloads. */
  showEdited(entry: Entry, replaced: boolean): void {
    if (replaced) {
      const i = this.entries.findIndex((e) => e.path === entry.path);
      if (i >= 0) this.entries[i] = entry;
      this.preloaded.clear();
      this.show(i >= 0 ? i : this.index);
      return;
    }
    const at = this.index + 1;
    this.entries = [...this.entries.slice(0, at), entry, ...this.entries.slice(at)];
    this.show(at);
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
    this.stopVideo();
    this.img.removeAttribute("src");
    this.img.classList.remove("visible");
    this.preloaded.clear();
    this.details.clear();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.target instanceof HTMLButtonElement && ["Space", "Enter", "NumpadEnter"].includes(e.code)) return false;
    if ((e.target as Element | null)?.closest?.("#photo-details") && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.code)) return false;
    if (e.code === "Delete" || (e.metaKey && e.code === "Backspace")) {
      e.preventDefault();
      this.actions.trash();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyE") {
      e.preventDefault();
      this.actions.export();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (this.showingVideo) {
      if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        this.actions["play-pause"]();
        return true;
      }
      if (e.shiftKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        e.preventDefault();
        this.seek(e.code === "ArrowRight" ? SEEK_STEP : -SEEK_STEP);
        return true;
      }
      if (e.code === "KeyM") {
        e.preventDefault();
        this.video.muted = !this.video.muted;
        return true;
      }
    }
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
    const video = this.showingVideo ? this.videoInfo : null;
    if (v.loaded) parts.push(`${v.width} × ${v.height}`);
    else if (video) {
      if (video.width) parts.push(`${video.width} × ${video.height}`);
      const length = formatDuration(video.duration);
      if (length) parts.push(length);
    }
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
      if (!entry || isVideo(entry)) continue;
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
    this.endHold();
    const entry = this.entries[i];
    const token = ++this.loadToken;
    const v = this.view;
    v.width = 0;
    v.height = 0;
    this.img.classList.remove("visible");
    this.showMessage(null);
    const video = isVideo(entry);
    for (const button of this.bar.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      if (IMAGE_ONLY.includes(button.dataset.action!)) button.disabled = video;
    }
    this.stopVideo();
    this.details.show(entry);
    if (video) {
      this.img.onload = this.img.onerror = null;
      this.img.removeAttribute("src");
      this.playVideo(entry, token);
      this.preloadAround();
      return;
    }
    this.updateInfo();

    this.img.onload = () => {
      if (token !== this.loadToken) return;
      v.reset(this.img.naturalWidth, this.img.naturalHeight);
      this.img.classList.add("visible");
      this.details.dimensions(this.img.naturalWidth, this.img.naturalHeight);
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

  private playVideo(entry: Entry, token: number): void {
    const el = this.video;
    this.videoInfo = { width: 0, height: 0, duration: NaN };
    el.hidden = false;
    el.onloadedmetadata = () => {
      if (token !== this.loadToken) return;
      this.videoInfo = { width: el.videoWidth, height: el.videoHeight, duration: el.duration };
      if (el.videoWidth) this.details.dimensions(el.videoWidth, el.videoHeight);
      this.updateInfo();
    };
    el.onerror = () => {
      if (token !== this.loadToken) return;
      el.hidden = true;
      this.showMessage(t.videoFailed);
      this.updateInfo();
    };
    el.src = imageSrc(entry);
    this.updateInfo();
    void el.play().catch(() => {});
  }

  private stopVideo(): void {
    const el = this.video;
    el.onloadedmetadata = el.onerror = null;
    this.videoInfo = null;
    if (el.hidden && !el.hasAttribute("src")) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.hidden = true;
  }

  private seek(seconds: number): void {
    const el = this.video;
    if (!Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + seconds));
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

  /** Ends a press-and-hold zoom, returning the image to the fitted view. */
  private endHold(): void {
    const p = this.hold;
    if (!p) return;
    clearTimeout(p.timer);
    this.hold = null;
    if (!p.active) return;
    this.stage.classList.remove("holding");
    if (this.view.loaded) this.view.fit();
    this.updateInfo();
  }

  private bindPointer(): void {
    const stage = this.stage;
    const v = this.view;
    stage.addEventListener(
      "wheel",
      (e) => {
        const video = this.showingVideo;
        if (!v.loaded && !video) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;

        // Pinch gestures and Ctrl/Cmd + wheel zoom around the pointer.
        // Videos do not zoom; the wheel moves between files as on an unzoomed image.
        if (!video && (e.ctrlKey || e.metaKey)) {
          v.zoomBy(Math.exp(-dy * 0.01), cx, cy);
          this.updateInfo();
          return;
        }
        if (!video && v.pannable) {
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

    const local = (x: number, y: number) => {
      const rect = stage.getBoundingClientRect();
      return [x - rect.left, y - rect.top] as const;
    };
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !v.loaded || this.showingVideo) return;
      if (v.pannable) {
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        stage.setPointerCapture(e.pointerId);
        stage.classList.add("dragging");
        return;
      }
      if (!v.fitted) return;
      // Holding the button on a fitted image shows it at twice its size until release.
      // The short delay keeps clicks and double-clicks from flashing the zoom.
      const hold = { id: e.pointerId, x: e.clientX, y: e.clientY, scale: v.scale * 2, active: false, timer: 0 };
      hold.timer = window.setTimeout(() => {
        if (this.hold !== hold) return;
        hold.active = true;
        stage.classList.add("holding");
        v.zoomHold(hold.scale, ...local(hold.x, hold.y));
        this.updateInfo();
      }, HOLD_DELAY);
      this.hold = hold;
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      const p = this.hold;
      if (p && p.id === e.pointerId) {
        p.x = e.clientX;
        p.y = e.clientY;
        if (p.active) v.zoomHold(p.scale, ...local(p.x, p.y));
        return;
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      v.panBy(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX;
      d.y = e.clientY;
    });
    const endDrag = (e: PointerEvent) => {
      if (this.hold && this.hold.id === e.pointerId) {
        this.endHold();
        return;
      }
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("lostpointercapture", endDrag);
    stage.addEventListener("dblclick", (e) => {
      const rect = stage.getBoundingClientRect();
      this.toggleZoom(e.clientX - rect.left, e.clientY - rect.top);
    });
  }
}
