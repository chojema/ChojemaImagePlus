import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { $, Entry, isFullscreen, showToast, toggleFullscreen, within } from "./common";
import { errorText, isKorean, t } from "./i18n";
import { saveSettings, settings, Settings } from "./settings";
import { imageSrc } from "./viewer";

export interface SlideshowOptions {
  folder: string;
  recursive: boolean;
  order: Settings["ssOrder"];
}

const radio = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

/** The options dialog shown before a slideshow starts. */
export class SlideshowDialog {
  private readonly root = $("ss-dialog");
  private folder = "";
  private resolve: ((o: SlideshowOptions | null) => void) | null = null;

  constructor() {
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-t]")) {
      el.textContent = String((t as Record<string, unknown>)[el.dataset.t!] ?? "");
    }
    $("ss-title").textContent = t.ssTitle;
    $("ss-folder-change").textContent = t.ssChange;
    $("ss-cancel").textContent = t.cancel;
    $("ss-start").textContent = t.ssStart;
    $("ss-folder-change").addEventListener("click", async () => {
      const picked = await open({ multiple: false, directory: true, defaultPath: this.folder || undefined });
      if (typeof picked === "string") this.setFolder(picked);
    });
    $("ss-cancel").addEventListener("click", () => this.finish(null));
    $("ss-start").addEventListener("click", () => this.start());
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.finish(null);
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) this.start();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private setFolder(path: string): void {
    this.folder = path;
    // Marks keep the path's own direction while the box trims it from the left.
    $("ss-folder-path").textContent = path ? `\u200e${path}\u200e` : t.ssNoFolder;
    $("ss-folder-path").title = path;
    $<HTMLButtonElement>("ss-start").disabled = !path;
  }

  ask(folder: string | null): Promise<SlideshowOptions | null> {
    this.setFolder(folder ?? "");
    const check = (id: string, on: boolean) => ($<HTMLInputElement>(id).checked = on);
    const pick = (name: string, value: string) => {
      for (const r of this.root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) r.checked = r.value === value;
    };
    check("ss-recursive", settings.ssRecursive);
    pick("ss-order", settings.ssOrder);
    pick("ss-small", settings.ssSmall);
    pick("ss-large", settings.ssLarge);
    $<HTMLInputElement>("ss-interval").value = String(settings.ssInterval);
    check("ss-clock-on", settings.ssClock);
    check("ss-name-on", settings.ssName);
    check("ss-index-on", settings.ssIndex);
    check("ss-loop", settings.ssLoop);
    check("ss-fullscreen", settings.ssFullscreen);
    this.root.hidden = false;
    $("ss-start").focus();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private start(): void {
    if (!this.folder) return;
    const checked = (id: string) => $<HTMLInputElement>(id).checked;
    const interval = Math.min(3600, Math.max(1, Math.round(Number($<HTMLInputElement>("ss-interval").value) || 5)));
    saveSettings({
      ssRecursive: checked("ss-recursive"),
      ssOrder: (radio("ss-order") as Settings["ssOrder"]) ?? "name",
      ssSmall: (radio("ss-small") as Settings["ssSmall"]) ?? "original",
      ssLarge: (radio("ss-large") as Settings["ssLarge"]) ?? "shrink",
      ssInterval: interval,
      ssClock: checked("ss-clock-on"),
      ssName: checked("ss-name-on"),
      ssIndex: checked("ss-index-on"),
      ssLoop: checked("ss-loop"),
      ssFullscreen: checked("ss-fullscreen"),
    });
    this.finish({ folder: this.folder, recursive: settings.ssRecursive, order: settings.ssOrder });
  }

  private finish(result: SlideshowOptions | null): void {
    this.root.hidden = true;
    this.resolve?.(result);
    this.resolve = null;
  }
}

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Full-window slideshow with cross-fades, optional clock, caption and position. */
export class Slideshow {
  private entries: Entry[] = [];
  private index = -1;
  private root = $("slideshow");
  private slides = [...this.root.querySelectorAll<HTMLImageElement>(".slide")];
  private front = 0;
  private timer = 0;
  private clockTimer = 0;
  private paused = false;
  private running = false;
  private folder = "";
  private order: Settings["ssOrder"] = "name";
  private enteredFullscreen = false;
  private token = 0;
  private preload = new Image();
  private displayed: Entry | undefined;
  private readonly controls = $("ss-controls");
  private controlsTimer = 0;
  private keyboardControls = false;
  private fullscreenWork: Promise<void> = Promise.resolve();

  constructor(private readonly onExit: (last: Entry | undefined, openFolder: boolean) => void) {
    this.root.setAttribute("aria-label", t.ssTitle);
    this.controls.setAttribute("aria-label", t.ssControls);
    this.root.addEventListener("click", (e) => {
      if (!this.controls.contains(e.target as Node)) this.togglePause();
    });
    this.root.addEventListener("pointermove", () => this.showControls());
    // Older web views allow focus to scroll an overflow-hidden container after resizing.
    this.root.addEventListener("scroll", () => {
      this.root.scrollLeft = 0;
      this.root.scrollTop = 0;
    });
    this.root.addEventListener("pointerdown", (e) => {
      this.keyboardControls = false;
      if (!this.controls.contains(e.target as Node)) this.root.focus({ preventScroll: true });
      this.showControls();
    });
    this.controls.addEventListener("pointerenter", () => this.showControls());
    this.controls.addEventListener("pointerleave", () => this.showControls());
    this.controls.addEventListener("focusin", () => this.showControls());
    this.controls.addEventListener("focusout", () => queueMicrotask(() => this.showControls()));
    this.controls.addEventListener("click", (e) => {
      const action = (e.target as Element).closest<HTMLButtonElement>("[data-ss]")?.dataset.ss;
      if (!action || !this.running) return;
      e.stopPropagation();
      this.showControls();
      switch (action) {
        case "prev": this.prev(); break;
        case "next": this.next(); break;
        case "pause": this.togglePause(); break;
        case "folder": this.stop(true); break;
        case "fullscreen": void this.fullscreen(); break;
        case "stop": this.stop(); break;
      }
    });
    this.updateControls();
    const resize = new ResizeObserver(() => {
      this.layout(this.slides[this.front]);
      this.root.style.setProperty("--ss-controls-height", `${this.controls.offsetHeight}px`);
    });
    resize.observe(this.root);
    resize.observe(this.controls);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Lists the images and starts; `sorter` applies the list's current sort order. */
  async start(options: SlideshowOptions, sorter: (list: Entry[]) => Entry[]): Promise<boolean> {
    this.token++;
    showToast(t.ssLoading);
    let list: Entry[];
    try {
      list = await invoke<Entry[]>("slideshow_list", { dir: options.folder, recursive: options.recursive });
    } catch (err) {
      showToast(errorText(err));
      return false;
    }
    if (!list.length) {
      showToast(t.ssEmpty);
      return false;
    }
    this.folder = options.folder;
    this.order = options.order;
    this.entries = options.order === "random" ? shuffle(list) : options.recursive ? list : sorter(list);
    this.index = -1;
    this.displayed = undefined;
    this.paused = false;
    this.keyboardControls = false;
    this.running = true;
    this.root.classList.remove("paused");
    $("ss-position").textContent = "";
    this.root.focus({ preventScroll: true });
    this.updateControls();
    this.showControls();
    document.getElementById("toast")!.hidden = true;
    for (const s of this.slides) {
      s.classList.remove("visible");
      s.removeAttribute("src");
    }
    $("ss-paused").hidden = true;
    $("ss-clock").hidden = !settings.ssClock;
    $("ss-caption").hidden = !(settings.ssName || settings.ssIndex);
    if (settings.ssClock) {
      this.tickClock();
      this.clockTimer = window.setInterval(() => this.tickClock(), 1000);
    }
    this.enteredFullscreen = !isFullscreen();
    if (settings.ssFullscreen && this.enteredFullscreen) {
      await this.changeFullscreen(true);
    }
    this.updateControls();
    this.next();
    return true;
  }

  stop(openFolder = false): void {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.clockTimer);
    clearTimeout(this.controlsTimer);
    this.root.classList.remove("controls-visible", "paused");
    const stopped = ++this.token;
    const last = this.displayed;
    for (const s of this.slides) {
      s.onload = null;
      s.onerror = null;
      s.removeAttribute("src");
    }
    this.preload.removeAttribute("src");
    const finish = () => {
      if (!this.running && this.token === stopped) this.onExit(last, openFolder);
    };
    if (this.enteredFullscreen) {
      void this.changeFullscreen(false).then(finish, (err) => {
        showToast(errorText(err));
        finish();
      });
    } else finish();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    this.keyboardControls = true;
    this.showControls();
    // Native button activation must not also toggle playback through the global shortcut.
    if (this.controls.contains(e.target as Node) && ["Space", "Enter", "NumpadEnter"].includes(e.code)) return false;
    switch (e.code) {
      case "Escape":
        this.stop();
        break;
      case "Space":
      case "KeyP":
        this.togglePause();
        break;
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
        this.next();
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
        this.prev();
        break;
      case "KeyF":
        void this.fullscreen();
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }

  private togglePause(): void {
    if (!this.running) return;
    this.paused = !this.paused;
    const label = $("ss-paused");
    label.textContent = t.ssPaused;
    label.hidden = !this.paused;
    this.root.classList.toggle("paused", this.paused);
    this.updateControls();
    this.showControls();
    if (this.paused) clearTimeout(this.timer);
    else this.schedule();
  }

  private updateControls(): void {
    const labels: Record<string, string> = {
      prev: t.prev,
      next: t.next,
      pause: this.paused ? t.ssResume : t.ssPause,
      folder: t.ssImageFolder,
      fullscreen: t.fullscreen,
      stop: t.ssStop,
    };
    for (const button of this.controls.querySelectorAll<HTMLButtonElement>("[data-ss]")) {
      const action = button.dataset.ss!;
      const label = labels[action];
      button.title = action === "pause" ? `${label} (Space)` : action === "stop" ? `${label} (Esc)` : label;
      button.setAttribute("aria-label", label);
      const text = button.querySelector("span");
      if (text) text.textContent = label;
      if (action === "folder") button.disabled = !this.displayed;
      if (action === "prev" || action === "next") button.disabled = this.entries.length < 2;
      if (action === "fullscreen") button.setAttribute("aria-pressed", String(isFullscreen()));
    }
  }

  private showControls(): void {
    if (!this.running) return;
    clearTimeout(this.controlsTimer);
    this.root.classList.add("controls-visible");
    if (this.paused || this.controls.matches(":hover") || (this.keyboardControls && this.controls.contains(document.activeElement))) return;
    this.controlsTimer = window.setTimeout(() => this.root.classList.remove("controls-visible"), 2600);
  }

  private async fullscreen(): Promise<void> {
    try {
      await this.changeFullscreen();
      if (!this.running) return;
      this.updateControls();
      this.showControls();
    } catch (err) {
      showToast(errorText(err));
    }
  }

  private changeFullscreen(force?: boolean): Promise<void> {
    // Finishing must restore the window after any pending fullscreen request, even if its
    // reply arrives after the slideshow has stopped.
    this.fullscreenWork = this.fullscreenWork.catch(() => {}).then(() => toggleFullscreen(force));
    return this.fullscreenWork;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.paused && this.running) this.timer = window.setTimeout(() => this.next(), settings.ssInterval * 1000);
  }

  private next(): void {
    if (!this.running) return;
    let i = this.index + 1;
    if (i >= this.entries.length) {
      if (!settings.ssLoop) {
        showToast(t.ssEnded);
        this.stop();
        return;
      }
      if (this.order === "random") this.entries = shuffle(this.entries);
      i = 0;
    }
    this.show(i);
  }

  private prev(): void {
    if (!this.running) return;
    this.show(this.index <= 0 ? this.entries.length - 1 : this.index - 1);
  }

  private show(i: number, skipped = 0): void {
    clearTimeout(this.timer);
    this.index = i;
    const entry = this.entries[i];
    const token = ++this.token;
    const back = this.slides[1 - this.front];
    back.onload = () => {
      if (token !== this.token) return;
      this.layout(back);
      back.classList.add("visible");
      this.slides[this.front].classList.remove("visible");
      this.front = 1 - this.front;
      this.displayed = entry;
      $("ss-position").textContent = `${i + 1} / ${this.entries.length}`;
      $("ss-position").title = entry.path;
      this.updateControls();
      this.caption(entry);
      const upcoming = this.entries[(i + 1) % this.entries.length];
      if (upcoming) this.preload.src = imageSrc(upcoming);
      this.schedule();
    };
    back.onerror = () => {
      if (token !== this.token) return;
      // Skip unreadable files, but stop trying after a full round of failures.
      if (skipped + 1 >= this.entries.length) return this.stop();
      this.show((i + 1) % this.entries.length, skipped + 1);
    };
    back.src = imageSrc(entry);
  }

  /** Sizes an image by the small/large settings, centred in the window. */
  private layout(img: HTMLImageElement | undefined): void {
    if (!img || !img.naturalWidth) return;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const fit = Math.min(W / w, H / h);
    let scale = 1;
    if (fit < 1 && settings.ssLarge === "shrink") scale = fit;
    if (fit > 1 && settings.ssSmall === "enlarge") scale = fit;
    img.style.width = `${w * scale}px`;
    img.style.height = `${h * scale}px`;
  }

  private caption(entry: Entry): void {
    const parts: string[] = [];
    if (settings.ssIndex) parts.push(`${this.index + 1} / ${this.entries.length}`);
    if (settings.ssName) {
      let name = entry.name;
      if (within(this.folder, entry.path)) {
        const rel = entry.path.slice(this.folder.length).replace(/^[\\/]+/, "");
        if (rel !== entry.name) name = rel;
      }
      parts.push(name);
    }
    $("ss-caption").textContent = parts.join("   ");
  }

  private tickClock(): void {
    const now = new Date();
    const locale = isKorean ? "ko-KR" : undefined;
    const date = now.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    const time = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    $("ss-clock").textContent = `${date}  ${time}`;
  }
}
