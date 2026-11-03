import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { $, Entry, formatSize, parentOf, samePath } from "./common";
import { errorText, t } from "./i18n";
import { MAX_COMPARE } from "./compare";
import { showMenu } from "./menu";
import { saveSettings, settings, SortKey } from "./settings";

interface Hooks {
  navigate: (path: string) => void;
  open: (entries: Entry[], index: number) => void;
  compare: (entries: Entry[]) => void;
  /** `dest` null asks for the destination folder. */
  transfer: (paths: string[], dest: string | null) => void;
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
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Thumbnail grid of the images in one folder, with multi-selection. */
export class Gallery {
  folder: string | null = null;
  entries: Entry[] = [];
  private selected = new Set<number>();
  private focus = -1;
  private anchor = -1;
  private loadToken = 0;
  private suppressClick = false;
  private readonly canvas = document.createElement("div");
  private readonly cells = new Map<number, HTMLElement>();
  private metrics = { cols: 1, cellW: 0, cellH: 0, rowH: 0, pad: 10, gap: 6 };
  private frame = 0;
  /** Cells made while scrolling fast wait here; their thumbnails are requested once scrolling settles. */
  private readonly unloaded = new Map<HTMLImageElement, Entry>();
  private lastScroll = 0;
  private settleTimer = 0;

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
      up: t.up,
      "sort-dir": t.sortDir,
      transfer: t.transfer,
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
        this.lastScroll = performance.now();
        this.schedule();
      },
      { passive: true },
    );
    new ResizeObserver(() => this.relayout()).observe(this.grid);
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
      this.clickCell(Number(cell.dataset.index), e);
    });
    this.grid.addEventListener("contextmenu", (e) => {
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
      if (!cell) return;
      e.preventDefault();
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
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
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

  private applySize(): void {
    this.grid.style.setProperty("--thumb", `${this.size.value}px`);
    this.relayout();
  }

  private updateSortDir(): void {
    this.root.querySelector(".sort-dir")!.classList.toggle("desc", settings.sortDesc);
  }

  command(action: string): void {
    switch (action) {
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
      case "transfer": {
        const paths = this.selectedPaths();
        if (!paths.length) this.hooks.toast(t.transferNeed);
        else this.hooks.transfer(paths, null);
        break;
      }
      case "refresh":
        if (this.folder) void this.load(this.folder, this.current?.path);
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
    this.folder = null;
    this.entries = [];
    this.render();
  }

  /** Lists `dir`; `focusPath` keeps or moves the selection to that file. */
  async load(dir: string, focusPath?: string): Promise<boolean> {
    const token = ++this.loadToken;
    try {
      const entries = await invoke<Entry[]>("browse", { dir });
      if (token !== this.loadToken) return false;
      this.folder = dir;
      this.entries = this.sorted(entries);
      const i = focusPath ? this.entries.findIndex((e) => samePath(e.path, focusPath)) : -1;
      this.focus = i;
      this.anchor = i;
      this.selected = i >= 0 ? new Set([i]) : new Set();
      this.grid.scrollTop = 0;
      this.render();
      if (i >= 0) this.scrollTo(i);
      this.prefetch();
      return true;
    } catch (err) {
      this.hooks.toast(errorText(err));
      return false;
    }
  }

  /** Re-reads the folder after outside changes, keeping selection, focus and scroll position. */
  async refreshQuiet(): Promise<void> {
    if (!this.folder) return;
    const dir = this.folder;
    const token = ++this.loadToken;
    let entries: Entry[];
    try {
      entries = await invoke<Entry[]>("browse", { dir });
    } catch {
      return;
    }
    if (token !== this.loadToken || dir !== this.folder) return;
    const chosen = new Set([...this.selected].map((i) => this.entries[i]?.path));
    const focusPath = this.entries[this.focus]?.path;
    const anchorPath = this.entries[this.anchor]?.path;
    const top = this.grid.scrollTop;
    this.entries = this.sorted(entries);
    this.selected = new Set(this.entries.flatMap((e, i) => (chosen.has(e.path) ? [i] : [])));
    this.focus = focusPath ? this.entries.findIndex((e) => e.path === focusPath) : -1;
    this.anchor = anchorPath ? this.entries.findIndex((e) => e.path === anchorPath) : -1;
    this.render();
    this.grid.scrollTop = top;
    this.schedule();
    this.prefetch();
  }

  /** Lets the backend render the rest of the folder's thumbnails while the user looks around. */
  private prefetch(): void {
    if (this.entries.length) void invoke("thumbs_prefetch", { paths: this.entries.map((e) => e.path) });
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

  private resort(): void {
    const keep = this.current?.path;
    const chosen = new Set([...this.selected].map((i) => this.entries[i]?.path));
    this.entries = this.sorted(this.entries);
    this.selected = new Set(this.entries.flatMap((e, i) => (chosen.has(e.path) ? [i] : [])));
    this.focus = keep ? this.entries.findIndex((e) => e.path === keep) : -1;
    this.anchor = this.focus;
    this.render();
    if (this.focus >= 0) this.scrollTo(this.focus);
  }

  private thumbSrc(entry: Entry): string {
    return `${convertFileSrc(entry.path, "thumb")}?v=${entry.modified}`;
  }

  private render(): void {
    this.renderCrumbs();
    const hasFolder = this.folder !== null;
    this.empty.hidden = hasFolder && this.entries.length > 0;
    this.emptyText.textContent = hasFolder ? t.folderEmpty : t.emptyText;
    this.empty.querySelector<HTMLElement>(".empty-actions")!.hidden = hasFolder;
    this.root.classList.toggle("no-folder", !hasFolder);
    if (this.folder) this.root.dataset.drop = this.folder;
    else delete this.root.dataset.drop;

    for (const cell of this.cells.values()) cell.remove();
    this.cells.clear();
    this.unloaded.clear();
    this.relayout();
    this.paintSelection();
  }

  /** Requests thumbnails for cells still on the page; while the list is moving, waits until it stops. */
  private loadThumbs(): void {
    if (!this.unloaded.size) return;
    const SETTLE = 120;
    const wait = this.lastScroll + SETTLE - performance.now();
    if (wait > 0) {
      clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.loadThumbs(), wait);
      return;
    }
    for (const [img, entry] of this.unloaded) {
      if (img.isConnected) img.src = this.thumbSrc(entry);
    }
    this.unloaded.clear();
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
    const rows = Math.ceil(this.entries.length / m.cols);
    this.canvas.style.height = `${rows ? rows * m.rowH - m.gap + m.pad * 2 : 0}px`;
    if (before.cols !== m.cols || before.cellW !== m.cellW) {
      for (const [i, cell] of this.cells) this.place(cell, i);
    }
    this.renderVisible();
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
    const m = this.metrics;
    if (!this.entries.length || !m.rowH) {
      for (const cell of this.cells.values()) cell.remove();
      this.cells.clear();
      this.unloaded.clear();
      return;
    }
    const overscan = 2;
    const top = this.grid.scrollTop - m.pad;
    const firstRow = Math.max(0, Math.floor(top / m.rowH) - overscan);
    const lastRow = Math.floor((top + this.grid.clientHeight) / m.rowH) + overscan;
    const first = firstRow * m.cols;
    const last = Math.min(this.entries.length - 1, (lastRow + 1) * m.cols - 1);
    for (const [i, cell] of this.cells) {
      if (i < first || i > last) {
        cell.remove();
        this.cells.delete(i);
        const img = cell.querySelector("img");
        if (img) this.unloaded.delete(img);
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

  private makeCell(i: number): HTMLElement {
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
    this.unloaded.set(img, entry);
    img.addEventListener("error", () => frame.classList.add("broken"), { once: true });
    frame.append(img);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
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
    for (const [i, cell] of this.cells) {
      cell.classList.toggle("selected", this.selected.has(i));
      cell.classList.toggle("focus", i === this.focus);
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

  private scrollTo(i: number): void {
    const m = this.metrics;
    if (!m.rowH) return;
    const top = m.pad + Math.floor(i / m.cols) * m.rowH;
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
    const mod = e.ctrlKey || e.metaKey;
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
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
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
