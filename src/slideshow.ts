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

  constructor(private readonly onExit: (last: Entry | undefined) => void) {
    this.root.addEventListener("click", () => this.togglePause());
    new ResizeObserver(() => this.layout(this.slides[this.front])).observe(this.root);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Lists the images and starts; `sorter` applies the list's current sort order. */
  async start(options: SlideshowOptions, sorter: (list: Entry[]) => Entry[]): Promise<boolean> {
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
    this.paused = false;
    this.running = true;
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
    this.enteredFullscreen = false;
    if (settings.ssFullscreen && !isFullscreen()) {
      this.enteredFullscreen = true;
      await toggleFullscreen(true);
    }
    this.next();
    return true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.clockTimer);
    this.token++;
    for (const s of this.slides) s.removeAttribute("src");
    if (this.enteredFullscreen && isFullscreen()) void toggleFullscreen(false);
    this.onExit(this.entries[this.index]);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
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
        void toggleFullscreen();
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }

  private togglePause(): void {
    this.paused = !this.paused;
    const label = $("ss-paused");
    label.textContent = t.ssPaused;
    label.hidden = !this.paused;
    if (this.paused) clearTimeout(this.timer);
    else this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.paused && this.running) this.timer = window.setTimeout(() => this.next(), settings.ssInterval * 1000);
  }

  private next(): void {
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
    this.show(this.index <= 0 ? this.entries.length - 1 : this.index - 1);
  }

  private show(i: number, skipped = 0): void {
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
