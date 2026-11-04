import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { $, Entry, formatSize, parentOf, samePath } from "./common";
import { errorText, t } from "./i18n";
import { MAX_COMPARE } from "./compare";
import { showMenu } from "./menu";
import { saveSettings, settings, SortKey } from "./settings";
import { ThumbnailLoader } from "./thumbnails";
import type { TransferMode } from "./transfer";

interface Hooks {
  navigate: (path: string, back?: boolean) => void;
  open: (entries: Entry[], index: number) => void;
  compare: (entries: Entry[]) => void;
  /** `dest` null asks for the destination folder. */
  transfer: (paths: string[], dest: string | null, mode?: TransferMode) => void;
  trash: (paths: string[]) => void;
  slideshow: () => void;
  export: (paths: string[]) => void;
  reveal: (path: string) => void;
  favorite: () => void;
  chooseFolder: () => void;
  chooseFile: () => void;
  toast: (text: string) => void;
  activate: (gallery: Gallery) => void;
  sizeChanged: (size: number) => void;
  dual: () => void;
  dualLayout: () => void;
  sortChanged: () => void;
  /** Asks the backend to render the thumbnails of every open pane in the background. */
  prefetch: () => void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A subfolder, shown before the images; clicking it opens it. */
interface Sub {
  path: string;
  name: string;
}

interface Contents {
  folders: Sub[];
  images: Entry[];
}

interface FolderVisit {
  folder: string;
  top: number;
  selected: string[];
  focus?: string;
  anchor?: string;
}

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>';

/** Thumbnail grid of the images in one folder, with multi-selection. */
export class Gallery {
  folder: string | null = null;
  entries: Entry[] = [];
  /** Subfolders, laid out before the images. Cells are keyed by slot: folders first, then image i at slot folders.length + i. */
  folders: Sub[] = [];
  private selected = new Set<number>();
  private focus = -1;
  private anchor = -1;
  private loadToken = 0;
  private suppressClick = false;
  private readonly canvas = document.createElement("div");
  private readonly cells = new Map<number, HTMLElement>();
  private metrics = { cols: 1, cellW: 0, cellH: 0, rowH: 0, pad: 10, gap: 6 };
  private frame = 0;
  private readonly thumbnails = new ThumbnailLoader((entry, attempt) => this.thumbSrc(entry, attempt));
  private readonly resizeObserver = new ResizeObserver(() => this.relayout());
  private disposed = false;
  private retrySequence = 0;
  private readonly history: FolderVisit[] = [];

  readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly emptyText: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly count: HTMLElement;
  private readonly sort: HTMLSelectElement;
  private readonly size: HTMLInputElement;
  private readonly favoriteButton: HTMLButtonElement;

  constructor(
    container: HTMLElement,
    private readonly hooks: Hooks,
  ) {
    const template = $<HTMLTemplateElement>("gallery-template");
    this.root = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    container.append(this.root);
    const q = <T extends HTMLElement>(cls: string) => this.root.querySelector(`.${cls}`) as T;
    this.grid = q("grid");
    this.empty = q("gallery-empty");
    this.emptyText = q("gallery-empty-text");
    this.crumbs = q("crumbs");
    this.count = q("gallery-count");
    this.sort = q<HTMLSelectElement>("sort");
    this.size = q<HTMLInputElement>("thumb-size");
    this.favoriteButton = q<HTMLButtonElement>("browse-favorite");
    this.root.addEventListener("pointerdown", () => hooks.activate(this), true);
    this.root.addEventListener("focusin", () => hooks.activate(this));

    const options: [SortKey, string][] = [
      ["name", t.sortName],
      ["date", t.sortDate],
      ["size", t.sortSize],
    ];
    for (const [value, label] of options) this.sort.append(new Option(label, value));
    this.sort.title = this.sort.getAttribute("aria-label") ?? "";
    this.sort.addEventListener("change", () => {
      saveSettings({ sort: this.sort.value as SortKey });
      this.hooks.sortChanged();
    });
    this.size.title = t.thumbSize;
    this.size.addEventListener("input", () => {
      this.applySize();
      hooks.sizeChanged(Number(this.size.value));
    });
    this.size.addEventListener("change", () => saveSettings({ thumbSize: Number(this.size.value) }));

    const titles: Record<string, string> = {
      back: t.folderBack,
      up: t.up,
      "sort-dir": t.sortDir,
      transfer: t.transfer,
      move: t.moveToOtherPane,
      copy: t.copyToOtherPane,
      trash: t.trash,
      slideshow: t.slideshow,
      compare: t.compare,
      favorite: t.favoriteToggle,
      refresh: t.refresh,
      open: t.openTitle,
      dual: t.dualToggle,
      "dual-layout": t.dualLayout,
    };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-browse]")) {
      const action = button.dataset.browse!;
      button.title = titles[action] ?? "";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.command(action));
    }

    this.emptyText.textContent = t.emptyText;
    q("empty-open-file").textContent = t.openFile;
    q("empty-open-folder").textContent = t.openFolder;
    q("empty-open-file").addEventListener("click", () => hooks.chooseFile());
    q("empty-open-folder").addEventListener("click", () => hooks.chooseFolder());

    this.canvas.className = "grid-canvas";
    this.grid.append(this.canvas);
    this.grid.addEventListener(
      "scroll",
      () => {
        this.schedule();
      },
      { passive: true },
    );
    this.resizeObserver.observe(this.grid);
    this.bindDrag();
    this.grid.addEventListener("click", (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
      if (!cell) {
        this.select(new Set());
        return;
      }
      if (cell.dataset.folder) {
        this.hooks.navigate(cell.dataset.folder);
        return;
      }
      this.clickCell(Number(cell.dataset.index), e);
    });
    this.grid.addEventListener("contextmenu", (e) => {
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
      if (!cell) return;
      e.preventDefault();
      const sub = cell.dataset.folder;
      if (sub) {
        showMenu(e.clientX, e.clientY, [
          { label: t.menuOpen, run: () => this.hooks.navigate(sub) },
          { label: t.menuReveal, run: () => this.hooks.reveal(sub) },
        ]);
        return;
      }
      const i = Number(cell.dataset.index);
      if (!this.selected.has(i)) {
        this.focus = i;
        this.anchor = i;
        this.select(new Set([i]));
      }
      const paths = this.selectedPaths();
      const n = paths.length;
      showMenu(e.clientX, e.clientY, [
        { label: t.menuOpen, run: () => this.openAt(i) },
        { label: t.menuCompare, run: () => this.compareSelection(), disabled: n < 2 || n > MAX_COMPARE },
        { label: t.menuTransfer, run: () => this.hooks.transfer(paths, null) },
        { label: t.menuExport, run: () => this.hooks.export(paths) },
        { label: t.menuReveal, run: () => this.hooks.reveal(this.entries[i].path) },
        "separator",
        { label: t.menuTrash, run: () => this.hooks.trash(paths), danger: true },
      ]);
    });
    this.grid.addEventListener("dblclick", (e) => {
      const cell = (e.target as Element).closest<HTMLElement>(".cell[data-index]");
      if (cell) this.openAt(Number(cell.dataset.index));
    });
  }

  applySettings(): void {
    this.sort.value = settings.sort;
    this.size.value = String(settings.thumbSize);
    this.applySize();
    this.updateSortDir();
  }

  /** Re-applies shared sort settings after they change in either pane. */
  applySort(): void {
    this.sort.value = settings.sort;
    this.updateSortDir();
    this.resort();
  }

  setSize(size: number): void {
    this.size.value = String(size);
    this.applySize();
  }

  setActive(on: boolean): void {
    this.root.classList.toggle("active", on);
  }

  focusGrid(): void {
    this.grid.focus({ preventScroll: true });
  }

  dispose(): void {
    this.disposed = true;
    this.loadToken++;
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
    this.thumbnails.clear();
    this.root.remove();
  }

  private applySize(): void {
    this.grid.style.setProperty("--thumb", `${this.size.value}px`);
    this.relayout();
  }

  private updateSortDir(): void {
    this.root.querySelector(".sort-dir")!.classList.toggle("desc", settings.sortDesc);
  }

  command(action: string): void {
    switch (action) {
      case "back": {
        const previous = this.history.at(-1);
        if (previous) this.hooks.navigate(previous.folder, true);
        break;
      }
      case "up": {
        const parent = this.folder && parentOf(this.folder);
        if (parent) this.hooks.navigate(parent);
        break;
      }
      case "sort-dir":
        saveSettings({ sortDesc: !settings.sortDesc });
        this.hooks.sortChanged();
        break;
      case "favorite":
        this.hooks.favorite();
        break;
      case "compare":
        this.compareSelection();
        break;
      case "slideshow":
        this.hooks.slideshow();
        break;
      case "trash": {
        const paths = this.selectedPaths();
        if (paths.length) this.hooks.trash(paths);
        break;
      }
      case "transfer":
      case "move":
      case "copy": {
        const paths = this.selectedPaths();
        if (!paths.length) this.hooks.toast(t.transferNeed);
        else this.hooks.transfer(paths, null, action === "transfer" ? undefined : action);
        break;
      }
      case "refresh":
        void this.refreshQuiet(true);
        break;
      case "open":
        this.hooks.chooseFolder();
        break;
      case "dual":
        this.hooks.dual();
        break;
      case "dual-layout":
        this.hooks.dualLayout();
        break;
    }
  }

  selectedPaths(): string[] {
    return [...this.selected].sort((a, b) => a - b).map((i) => this.entries[i].path);
  }

  private compareSelection(): void {
    const n = this.selected.size;
    if (n < 2) return this.hooks.toast(t.compareNeed);
    if (n > MAX_COMPARE) return this.hooks.toast(t.compareTooMany);
    this.hooks.compare([...this.selected].sort((a, b) => a - b).map((i) => this.entries[i]));
  }

  setFavorite(on: boolean): void {
    this.favoriteButton.classList.toggle("on", on);
    this.favoriteButton.disabled = !this.folder;
  }

  get current(): Entry | undefined {
    return this.entries[this.focus];
  }

  showEmpty(): void {
    this.history.length = 0;
    this.folder = null;
    this.entries = [];
    this.folders = [];
    this.render();
  }

  /** Lists `dir`; `focusPath` keeps or moves the selection to that file. */
  async load(dir: string, focusPath?: string, back = false): Promise<boolean> {
    const restore = back ? this.history.at(-1) : undefined;
    if (back && (!restore || !samePath(restore.folder, dir))) return false;
    const token = ++this.loadToken;
    try {
      const contents = await invoke<Contents>("browse", { dir });
      if (token !== this.loadToken) return false;
      if (restore) this.history.pop();
      else if (this.folder && !samePath(this.folder, dir)) {
        this.history.push({
          folder: this.folder,
          top: this.grid.scrollTop,
          selected: this.selectedPaths(),
          focus: this.current?.path,
          anchor: this.entries[this.anchor]?.path,
        });
        if (this.history.length > 100) this.history.shift();
      }
      this.folder = dir;
      this.folders = this.sortedFolders(contents.folders);
      this.entries = this.sorted(contents.images);
      const focus = focusPath ?? restore?.focus;
      const i = focus ? this.entries.findIndex((e) => samePath(e.path, focus)) : -1;
      const chosen = new Set(restore?.selected ?? []);
      this.focus = i;
      this.anchor = restore?.anchor ? this.entries.findIndex((e) => samePath(e.path, restore.anchor)) : i;
      this.selected = restore
        ? new Set(this.entries.flatMap((e, j) => chosen.has(e.path) ? [j] : []))
        : i >= 0 ? new Set([i]) : new Set();
      this.grid.scrollTop = 0;
      this.render();
      if (restore) {
        this.grid.scrollTop = restore.top;
        this.renderVisible();
      } else if (i >= 0) this.scrollTo(i);
      this.hooks.prefetch();
      return true;
    } catch (err) {
      this.hooks.toast(errorText(err));
      return false;
    }
  }

  /**
   * Re-reads the folder after a change (a move, a copy, another program), keeping selection, focus
   * and scroll position. Cells whose file did not change keep their thumbnail; `force` (F5) makes
   * every cell ask for its thumbnail again.
   */
  async refreshQuiet(force = false): Promise<void> {
    if (!this.folder) return;
    const dir = this.folder;
    const token = ++this.loadToken;
    let contents: Contents;
    try {
      contents = await invoke<Contents>("browse", { dir });
    } catch {
      return;
    }
    if (token !== this.loadToken || dir !== this.folder) return;
    const next = this.sorted(contents.images);
    const nextFolders = this.sortedFolders(contents.folders);
    const same = (a: Entry | undefined, b: Entry | undefined) =>
      !!a && !!b && a.path === b.path && a.modified === b.modified && a.size === b.size;
    // Image cells sit at slots after the folders, so a different folder list moves every one of them.
    const foldersSame =
      nextFolders.length === this.folders.length && nextFolders.every((f, i) => f.path === this.folders[i].path);
    const imagesSame = next.length === this.entries.length && next.every((e, i) => same(e, this.entries[i]));
    if (!force && foldersSame && imagesSame) return;

    const chosen = new Set([...this.selected].map((i) => this.entries[i]?.path));
    const focusPath = this.entries[this.focus]?.path;
    const anchorPath = this.entries[this.anchor]?.path;
    const top = this.grid.scrollTop;
    const old = this.entries;
    const nf = this.folders.length;
    this.entries = next;
    this.folders = nextFolders;
    this.selected = new Set(next.flatMap((e, i) => (chosen.has(e.path) ? [i] : [])));
    this.focus = focusPath ? next.findIndex((e) => e.path === focusPath) : -1;
    this.anchor = anchorPath ? next.findIndex((e) => e.path === anchorPath) : -1;
    for (const [slot, cell] of this.cells) {
      const keep = !force && foldersSame && (slot < nf || same(old[slot - nf], next[slot - nf]));
      if (keep) continue;
      cell.remove();
      this.cells.delete(slot);
    }
    this.updateEmpty();
    this.relayout();
    this.grid.scrollTop = top;
    this.renderVisible();
    this.paintSelection();
    this.hooks.prefetch();
  }

  /** The paths whose thumbnails the backend may render ahead of time. */
  prefetchPaths(): string[] {
    return this.entries.map((e) => e.path);
  }

  /** Moves the selection to `path`, typically after returning from the viewer. */
  reveal(path: string): void {
    const i = this.entries.findIndex((e) => samePath(e.path, path));
    if (i < 0) return;
    this.focus = i;
    this.anchor = i;
    this.select(new Set([i]));
    this.scrollTo(i);
  }

  sorted(list: Entry[]): Entry[] {
    const dir = settings.sortDesc ? -1 : 1;
    const byName = (a: Entry, b: Entry) => collator.compare(a.name, b.name);
    const compare: Record<SortKey, (a: Entry, b: Entry) => number> = {
      name: byName,
      date: (a, b) => a.modified - b.modified || byName(a, b),
      size: (a, b) => a.size - b.size || byName(a, b),
    };
    return [...list].sort((a, b) => dir * compare[settings.sort](a, b));
  }

  /** Folders by name, following the list's direction when it is sorted by name. */
  private sortedFolders(list: Sub[]): Sub[] {
    const dir = settings.sort === "name" && settings.sortDesc ? -1 : 1;
    return [...list].sort((a, b) => dir * collator.compare(a.name, b.name));
  }

  private resort(): void {
    const keep = this.current?.path;
    this.folders = this.sortedFolders(this.folders);
    const chosen = new Set([...this.selected].map((i) => this.entries[i]?.path));
    this.entries = this.sorted(this.entries);
    this.selected = new Set(this.entries.flatMap((e, i) => (chosen.has(e.path) ? [i] : [])));
    this.focus = keep ? this.entries.findIndex((e) => e.path === keep) : -1;
    this.anchor = this.focus;
    this.render();
    if (this.focus >= 0) this.scrollTo(this.focus);
  }

  private thumbSrc(entry: Entry, attempt = 0): string {
    const retry = attempt ? `&retry=${Date.now()}-${++this.retrySequence}` : "";
    return `${convertFileSrc(entry.path, "thumb")}?v=${entry.modified}&s=${entry.size}${retry}`;
  }

  private render(): void {
    this.renderCrumbs();
    this.updateEmpty();
    for (const cell of this.cells.values()) cell.remove();
    this.cells.clear();
    this.thumbnails.clear();
    this.relayout();
    this.paintSelection();
  }

  private updateEmpty(): void {
    const hasFolder = this.folder !== null;
    this.empty.hidden = hasFolder && this.slots > 0;
    this.emptyText.textContent = hasFolder ? t.folderEmpty : t.emptyText;
    this.empty.querySelector<HTMLElement>(".empty-actions")!.hidden = hasFolder;
    this.root.classList.toggle("no-folder", !hasFolder);
    if (this.folder) this.root.dataset.drop = this.folder;
    else delete this.root.dataset.drop;
    const previous = this.history.at(-1);
    const back = this.root.querySelector<HTMLButtonElement>('[data-browse="back"]')!;
    back.disabled = !previous;
    back.title = previous ? `${t.folderBack}\n${previous.folder}` : t.folderBack;
    this.root.querySelector<HTMLButtonElement>('[data-browse="up"]')!.disabled = !this.folder || !parentOf(this.folder);
  }

  /** Start visible thumbnails immediately, including during continuous scrolling. */
  private loadThumbs(): void {
    const m = this.metrics;
    const top = this.grid.scrollTop;
    const bottom = top + this.grid.clientHeight;
    const items = [];
    for (const [slot, cell] of this.cells) {
      const img = cell.querySelector("img");
      if (!img) continue;
      const y = m.pad + Math.floor(slot / m.cols) * m.rowH;
      const visible = y < bottom && y + m.cellH > top;
      const distance = Math.max(top - y - m.cellH, y - bottom, 0);
      items.push({ img, entry: this.entries[slot - this.folders.length], priority: visible ? y - top : 1e9 + distance });
    }
    this.thumbnails.set(items);
  }

  // Virtual scrolling: only the rows in view (plus a margin) exist as elements, so a folder
  // of any size opens at once and thumbnails are requested for what is on screen first.

  private computeMetrics(): void {
    const pad = 10;
    const gap = 6;
    const width = Math.max(0, this.grid.clientWidth - pad * 2);
    const thumb = Number(this.size.value) || 160;
    const cols = Math.max(1, Math.floor((width + gap) / (thumb + gap)));
    const cellW = cols > 0 ? (width - gap * (cols - 1)) / cols : thumb;
    const cellH = cellW + 20;
    this.metrics = { cols, cellW, cellH, rowH: cellH + gap, pad, gap };
  }

  private relayout(): void {
    const before = this.metrics;
    this.computeMetrics();
    const m = this.metrics;
    const rows = Math.ceil(this.slots / m.cols);
    this.canvas.style.height = `${rows ? rows * m.rowH - m.gap + m.pad * 2 : 0}px`;
    if (before.cols !== m.cols || before.cellW !== m.cellW) {
      for (const [i, cell] of this.cells) this.place(cell, i);
    }
    this.renderVisible();
  }

  /** Cells in the grid: folders, then images. */
  private get slots(): number {
    return this.folders.length + this.entries.length;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderVisible();
    });
  }

  private place(cell: HTMLElement, i: number): void {
    const m = this.metrics;
    const row = Math.floor(i / m.cols);
    const col = i % m.cols;
    cell.style.transform = `translate(${m.pad + col * (m.cellW + m.gap)}px, ${m.pad + row * m.rowH}px)`;
    cell.style.width = `${m.cellW}px`;
    cell.style.height = `${m.cellH}px`;
  }

  private renderVisible(): void {
    if (this.disposed) return;
    if (!this.grid.clientWidth || !this.grid.clientHeight) {
      this.thumbnails.clear();
      return;
    }
    const m = this.metrics;
    if (!this.slots || !m.rowH) {
      for (const cell of this.cells.values()) cell.remove();
      this.cells.clear();
      this.thumbnails.clear();
      return;
    }
    const overscan = 2;
    const top = this.grid.scrollTop - m.pad;
    const firstRow = Math.max(0, Math.floor(top / m.rowH) - overscan);
    const lastRow = Math.floor((top + this.grid.clientHeight) / m.rowH) + overscan;
    const first = firstRow * m.cols;
    const last = Math.min(this.slots - 1, (lastRow + 1) * m.cols - 1);
    for (const [i, cell] of this.cells) {
      if (i < first || i > last) {
        cell.remove();
        this.cells.delete(i);
      }
    }
    const fragment = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      if (this.cells.has(i)) continue;
      const cell = this.makeCell(i);
      this.place(cell, i);
      this.cells.set(i, cell);
      fragment.append(cell);
    }
    this.canvas.append(fragment);
    this.loadThumbs();
  }

  private makeCell(slot: number): HTMLElement {
    const nf = this.folders.length;
    if (slot < nf) return this.makeFolderCell(this.folders[slot]);
    const i = slot - nf;
    const entry = this.entries[i];
    const cell = document.createElement("div");
    cell.className = "cell";
    if (this.selected.has(i)) cell.classList.add("selected");
    if (i === this.focus) cell.classList.add("focus");
    cell.dataset.index = String(i);
    cell.title = `${entry.name}\n${formatSize(entry.size)} · ${new Date(entry.modified).toLocaleString()}`;
    const frame = document.createElement("div");
    frame.className = "frame";
    const img = document.createElement("img");
    img.decoding = "async";
    img.draggable = false;
    img.alt = "";
    frame.append(img);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    cell.append(frame, name);
    return cell;
  }

  private makeFolderCell(sub: Sub): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "cell folder-cell";
    cell.dataset.folder = sub.path;
    // Images dragged onto a subfolder are moved or copied into it.
    cell.dataset.drop = sub.path;
    cell.title = sub.path;
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.innerHTML = FOLDER_ICON;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = sub.name;
    cell.append(frame, name);
    return cell;
  }

  private renderCrumbs(): void {
    this.crumbs.replaceChildren();
    if (!this.folder) return;
    const chain: string[] = [];
    for (let p: string | null = this.folder; p; p = parentOf(p)) {
      chain.unshift(p);
      if (chain.length > 64) break;
    }
    chain.forEach((path, i) => {
      const button = document.createElement("button");
      button.type = "button";
      const label = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
      button.textContent = label;
      button.title = path;
      button.dataset.drop = path;
      if (i === chain.length - 1) button.classList.add("current");
      button.addEventListener("click", () => this.hooks.navigate(path));
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "›";
        this.crumbs.append(sep);
      }
      this.crumbs.append(button);
    });
    requestAnimationFrame(() => (this.crumbs.scrollLeft = this.crumbs.scrollWidth));
  }

  private paintSelection(): void {
    const nf = this.folders.length;
    for (const [slot, cell] of this.cells) {
      if (slot < nf) continue;
      cell.classList.toggle("selected", this.selected.has(slot - nf));
      cell.classList.toggle("focus", slot - nf === this.focus);
    }
    this.count.textContent = this.folder ? t.count(this.entries.length, this.selected.size) : "";
    const n = this.selected.size;
    this.root.querySelector(".compare-button")!.classList.toggle("ready", n >= 2 && n <= MAX_COMPARE);
  }

  private select(next: Set<number>): void {
    this.selected = next;
    this.paintSelection();
  }

  private range(a: number, b: number): Set<number> {
    const set = new Set<number>();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    return set;
  }

  private clickCell(i: number, e: MouseEvent): void {
    const toggle = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this.anchor >= 0) {
      const base = toggle ? new Set(this.selected) : new Set<number>();
      for (const j of this.range(this.anchor, i)) base.add(j);
      this.focus = i;
      this.select(base);
      return;
    }
    if (toggle) {
      const next = new Set(this.selected);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      this.focus = i;
      this.anchor = i;
      this.select(next);
      return;
    }
    this.focus = i;
    this.anchor = i;
    this.select(new Set([i]));
  }

  /** Scrolls image `i` (not counting the folder cells before it) into view. */
  private scrollTo(i: number): void {
    const m = this.metrics;
    if (!m.rowH) return;
    const top = m.pad + Math.floor((this.folders.length + i) / m.cols) * m.rowH;
    const bottom = top + m.cellH;
    const view = this.grid.clientHeight;
    if (top < this.grid.scrollTop) this.grid.scrollTop = top - m.pad;
    else if (bottom > this.grid.scrollTop + view) this.grid.scrollTop = bottom - view + m.pad;
    this.renderVisible();
  }

  private columns(): number {
    return this.metrics.cols;
  }

  /** Opens the viewer: on the selection when several images are selected, otherwise on the whole folder. */
  openAt(i: number): void {
    if (this.selected.size > 1 && this.selected.has(i)) {
      const order = [...this.selected].sort((a, b) => a - b);
      this.hooks.open(
        order.map((j) => this.entries[j]),
        order.indexOf(i),
      );
    } else {
      this.hooks.open(this.entries, i);
    }
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.target instanceof HTMLButtonElement && ["Space", "Enter", "NumpadEnter"].includes(e.code)) return false;
    const mod = e.ctrlKey || e.metaKey;
    if ((e.altKey && !mod && e.code === "ArrowLeft") || (e.metaKey && !e.altKey && e.code === "BracketLeft")) {
      e.preventDefault();
      this.command("back");
      return true;
    }
    if (e.code === "Delete" || (e.metaKey && e.code === "Backspace")) {
      e.preventDefault();
      this.command("trash");
      return true;
    }
    if (mod && e.code === "KeyE") {
      e.preventDefault();
      this.hooks.export(this.selectedPaths());
      return true;
    }
    if (mod && e.code === "KeyA") {
      e.preventDefault();
      this.select(this.range(0, this.entries.length - 1));
      return true;
    }
    if (mod || e.altKey) {
      if (e.altKey && e.code === "ArrowUp") {
        e.preventDefault();
        this.command("up");
        return true;
      }
      return false;
    }
    if (e.code === "Backspace") {
      e.preventDefault();
      this.command("up");
      return true;
    }
    if (e.code === "KeyS") {
      e.preventDefault();
      this.command("slideshow");
      return true;
    }
    if (e.code === "KeyM") {
      e.preventDefault();
      this.command("transfer");
      return true;
    }
    if (e.code === "KeyC") {
      e.preventDefault();
      this.command("compare");
      return true;
    }
    if (e.code === "F5") {
      e.preventDefault();
      this.command("refresh");
      return true;
    }
    if (e.code === "Escape" && this.selected.size) {
      this.select(new Set());
      return true;
    }
    if (!this.entries.length) return false;
    if ((e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") && this.focus >= 0) {
      e.preventDefault();
      this.openAt(this.focus);
      return true;
    }
    const cols = this.columns();
    const last = this.entries.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: cols,
      ArrowUp: -cols,
      PageDown: cols * 4,
      PageUp: -cols * 4,
      Home: -Infinity,
      End: Infinity,
    };
    const delta = moves[e.code];
    if (delta === undefined) return false;
    e.preventDefault();
    const from = this.focus < 0 ? (delta > 0 ? -1 : last + 1) : this.focus;
    const to = Math.min(last, Math.max(0, from + delta));
    this.focus = to;
    if (e.shiftKey && this.anchor >= 0) this.select(this.range(this.anchor, to));
    else {
      this.anchor = to;
      this.select(new Set([to]));
    }
    this.scrollTo(to);
    return true;
  }

  /** Dragging selected thumbnails onto a folder (tree, favorites, recent, path bar) moves or copies them. */
  private bindDrag(): void {
    const ghost = $<HTMLElement>("drag-ghost");
    let start: { x: number; y: number; index: number; id: number } | null = null;
    let dragging = false;
    let target: HTMLElement | null = null;

    const setTarget = (el: HTMLElement | null) => {
      if (el === target) return;
      target?.classList.remove("drop-hover");
      target = el;
      target?.classList.add("drop-hover");
    };

    this.grid.addEventListener("pointerdown", (e) => {
      const cell = (e.target as Element).closest<HTMLElement>(".cell[data-index]");
      if (e.button !== 0 || !cell) return;
      start = { x: e.clientX, y: e.clientY, index: Number(cell.dataset.index), id: e.pointerId };
    });
    this.grid.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
        dragging = true;
        this.grid.setPointerCapture(e.pointerId);
        if (!this.selected.has(start.index)) {
          this.focus = start.index;
          this.anchor = start.index;
          this.select(new Set([start.index]));
        }
        const first = this.entries[[...this.selected].sort((a, b) => a - b)[0]];
        ghost.replaceChildren();
        const img = document.createElement("img");
        img.src = this.thumbSrc(first);
        const badge = document.createElement("span");
        badge.textContent = String(this.selected.size);
        ghost.append(img, badge);
        ghost.hidden = false;
        document.body.classList.add("dragging-files");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drop]") ?? null;
      setTarget(hit && !samePath(hit.dataset.drop, this.folder) ? hit : null);
    });
    const end = (e: PointerEvent, drop: boolean) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      if (!dragging) return;
      dragging = false;
      this.suppressClick = true;
      ghost.hidden = true;
      document.body.classList.remove("dragging-files");
      const dest = target?.dataset.drop;
      setTarget(null);
      if (drop && dest) this.hooks.transfer(this.selectedPaths(), dest);
    };
    this.grid.addEventListener("pointerup", (e) => end(e, true));
    this.grid.addEventListener("pointercancel", (e) => end(e, false));
  }
}
