import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { $, Entry, formatSize, isVideo, parentOf, samePath, within } from "./common";
import { errorText, t } from "./i18n";
import { MAX_COMPARE } from "./compare";
import { showMenu } from "./menu";
import { saveSettings, settings, SortKey } from "./settings";
import { ThumbnailLoader } from "./thumbnails";
import type { Done, TransferMode } from "./transfer";

interface Hooks {
  navigate: (path: string, back?: boolean) => void;
  open: (entries: Entry[], index: number) => void;
  compare: (entries: Entry[]) => void;
  /** `dest` null asks for the destination folder. */
  transfer: (paths: string[], dest: string | null, mode?: TransferMode) => void;
  /** The pointer left the window while dragging: the system takes over the drag. */
  dragOut: (paths: string[]) => void;
  trash: (paths: string[]) => void;
  createFolder: () => void;
  rename: (path: string, folder: boolean) => void;
  clipboard: (paths: string[], cut: boolean) => void;
  paste: (forceMove?: boolean) => void;
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
  query: string;
  selected: string[];
  focus?: string;
  anchor?: string;
}

interface Viewport {
  top: number;
  path?: string;
  offset: number;
  rowH: number;
}

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>';

const PLAY_BADGE = '<span class="play-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" /></svg></span>';

/** Thumbnail grid of the images in one folder, with multi-selection. */
export class Gallery {
  folder: string | null = null;
  entries: Entry[] = [];
  /** Subfolders, laid out before the images. Cells are keyed by slot: folders first, then image i at slot folders.length + i. */
  folders: Sub[] = [];
  private allEntries: Entry[] = [];
  private allFolders: Sub[] = [];
  private folderSelection: string | null = null;
  private readonly search: HTMLInputElement;
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
  private suspended: Viewport | null = null;

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
    this.search = q<HTMLInputElement>("list-search");
    this.search.placeholder = t.searchPlaceholder;
    this.search.setAttribute("aria-label", t.searchList);
    this.search.title = t.searchList;
    this.search.addEventListener("input", () => this.applySearch());
    this.search.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.clearSearch();
        this.focusGrid();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.focusGrid();
      }
    });
    q("clear-search").title = t.clearSearch;
    q("clear-search").setAttribute("aria-label", t.clearSearch);
    q("clear-search").addEventListener("click", () => { this.clearSearch(); this.search.focus(); });
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
      "new-folder": t.newFolderAction,
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
        this.folderSelection = null;
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
      e.preventDefault();
      this.hooks.activate(this);
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
      const common = [
        { label: t.newFolderAction, run: () => this.hooks.createFolder(), disabled: !this.folder },
        { label: t.clipboardPaste, run: () => this.hooks.paste(), disabled: !this.folder },
      ];
      if (!cell) {
        showMenu(e.clientX, e.clientY, common);
        return;
      }
      const sub = cell.dataset.folder;
      if (sub) {
        this.revealFolder(sub);
        showMenu(e.clientX, e.clientY, [
          { label: t.openFolder, run: () => this.hooks.navigate(sub) },
          { label: t.entryRename, run: () => this.hooks.rename(sub, true) },
          { label: t.menuReveal, run: () => this.hooks.reveal(sub) },
          "separator", ...common,
        ]);
        return;
      }
      this.folderSelection = null;
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
        { label: t.entryRename, run: () => this.hooks.rename(paths[0], false), disabled: n !== 1 },
        { label: t.clipboardCopy, run: () => this.hooks.clipboard(paths, false) },
        { label: t.clipboardCut, run: () => this.hooks.clipboard(paths, true) },
        { label: t.menuTransfer, run: () => this.hooks.transfer(paths, null) },
        { label: t.menuExport, run: () => this.hooks.export(paths) },
        { label: t.menuReveal, run: () => this.hooks.reveal(this.entries[i].path) },
        "separator", ...common, "separator",
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

  /** A highlighted subfolder takes precedence over the folder currently open in this pane. */
  get newFolderName(): string {
    const selected = this.folders.find((f) => samePath(f.path, this.folderSelection));
    const name = selected?.name ?? this.folder?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return name && !/[\\/:]/.test(name) ? name : t.newFolder;
  }

  /** Save the viewport before display:none makes browser scroll/size readings unreliable. */
  suspend(): void {
    if (this.suspended) return;
    const top = this.grid.scrollTop;
    const rowH = Math.max(1, this.metrics.rowH);
    const row = Math.max(0, Math.floor((top - this.metrics.pad) / rowH));
    const slot = row * this.metrics.cols;
    const path = slot < this.folders.length ? this.folders[slot]?.path : this.entries[slot - this.folders.length]?.path;
    this.suspended = { top, path, offset: top - this.metrics.pad - row * rowH, rowH };
    this.thumbnails.clear();
  }

  /** Recalculate visible geometry synchronously, before the caller reveals a viewer image. */
  resume(): void {
    const saved = this.suspended;
    if (!saved || !this.grid.clientWidth || !this.grid.clientHeight) return;
    this.suspended = null;
    this.relayout();
    let slot = saved.path ? this.folders.findIndex((f) => samePath(f.path, saved.path)) : -1;
    if (slot < 0 && saved.path) {
      const image = this.entries.findIndex((e) => samePath(e.path, saved.path));
      if (image >= 0) slot = this.folders.length + image;
    }
    this.grid.scrollTop = slot < 0 ? saved.top :
      this.metrics.pad + Math.floor(slot / this.metrics.cols) * this.metrics.rowH + saved.offset * this.metrics.rowH / saved.rowH;
    this.renderVisible();
    this.paintSelection();
  }

  focusSearch(): void { this.search.focus(); this.search.select(); }

  clearSearch(): void {
    if (!this.search.value) return;
    this.search.value = "";
    this.applySearch();
  }

  private matching<T extends { name: string }>(items: T[]): T[] {
    const query = this.search.value.trim().normalize("NFC").toLocaleLowerCase();
    return query ? items.filter((e) => e.name.normalize("NFC").toLocaleLowerCase().includes(query)) : items;
  }

  private applySearch(): void {
    const chosen = new Set(this.selectedPaths());
    const keep = this.current?.path;
    this.entries = this.sorted(this.matching(this.allEntries));
    this.folders = this.sortedFolders(this.matching(this.allFolders));
    this.folderSelection = null;
    this.selected = new Set(this.entries.flatMap((e, i) => chosen.has(e.path) ? [i] : []));
    this.focus = keep ? this.entries.findIndex((e) => samePath(e.path, keep)) : -1;
    this.anchor = this.focus;
    this.grid.scrollTop = 0;
    this.render();
    this.hooks.prefetch();
  }

  revealFolder(path: string): void {
    this.clearSearch();
    this.folderSelection = path;
    this.selected.clear();
    this.focus = this.anchor = -1;
    this.paintSelection();
    const slot = this.folders.findIndex((f) => samePath(f.path, path));
    if (slot >= 0) {
      this.grid.scrollTop = Math.floor(slot / this.metrics.cols) * this.metrics.rowH;
      this.renderVisible();
      this.paintSelection();
    }
    this.focusGrid();
  }

  /** Track renamed folders in both panes and Back history, including open descendants. */
  relocate(changes: Done[]): void {
    if (!changes.length) return;
    const mapped = (path: string): string => {
      const d = changes.find((d) => within(d.from, path));
      return d ? d.to + path.normalize("NFC").slice(d.from.normalize("NFC").length) : path;
    };
    if (this.folder) this.folder = mapped(this.folder);
    if (this.folderSelection) this.folderSelection = mapped(this.folderSelection);
    if (this.suspended?.path) this.suspended.path = mapped(this.suspended.path);
    for (const visit of this.history) {
      visit.folder = mapped(visit.folder);
      visit.selected = visit.selected.map(mapped);
      if (visit.focus) visit.focus = mapped(visit.focus);
      if (visit.anchor) visit.anchor = mapped(visit.anchor);
    }
    const remap = <T extends Sub>(e: T): T => {
      const path = mapped(e.path);
      return path === e.path ? e : { ...e, path, name: path.split(/[\\/]/).pop() || path };
    };
    this.allEntries = this.allEntries.map(remap);
    this.allFolders = this.allFolders.map(remap);
    this.entries = this.entries.map(remap);
    this.folders = this.folders.map(remap);
    this.render();
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
      case "new-folder":
        if (this.folder) this.hooks.createFolder();
        break;
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
    const entries = [...this.selected].sort((a, b) => a - b).map((i) => this.entries[i]);
    if (entries.some((e) => isVideo(e))) return this.hooks.toast(t.videoNoCompare);
    this.hooks.compare(entries);
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
    this.allEntries = this.entries = [];
    this.allFolders = this.folders = [];
    this.search.value = "";
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
          query: this.search.value,
          selected: this.selectedPaths(),
          focus: this.current?.path,
          anchor: this.entries[this.anchor]?.path,
        });
        if (this.history.length > 100) this.history.shift();
      }
      const sameFolder = samePath(this.folder, dir);
      this.folder = dir;
      this.folderSelection = null;
      this.search.value = focusPath ? "" : restore?.query ?? (sameFolder ? this.search.value : "");
      this.allFolders = contents.folders;
      this.allEntries = contents.images;
      this.folders = this.sortedFolders(this.matching(this.allFolders));
      this.entries = this.sorted(this.matching(this.allEntries));
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
    this.allEntries = contents.images;
    this.allFolders = contents.folders;
    const next = this.sorted(this.matching(this.allEntries));
    const nextFolders = this.sortedFolders(this.matching(this.allFolders));
    const same = (a: Entry | undefined, b: Entry | undefined) =>
      !!a && !!b && a.path === b.path && a.modified === b.modified && a.size === b.size;
    // Image cells sit at slots after the folders, so a different folder list moves every one of them.
    const foldersSame =
      nextFolders.length === this.folders.length && nextFolders.every((f, i) => f.path === this.folders[i].path && f.name === this.folders[i].name);
    const imagesSame = next.length === this.entries.length && next.every((e, i) => same(e, this.entries[i]));
    if (!force && foldersSame && imagesSame) { this.paintSelection(); return; }

    const chosen = new Set([...this.selected].map((i) => this.entries[i]?.path));
    const focusPath = this.entries[this.focus]?.path;
    const anchorPath = this.entries[this.anchor]?.path;
    const top = this.suspended?.top ?? this.grid.scrollTop;
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
    if (!this.suspended) this.grid.scrollTop = top;
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
    this.emptyText.textContent = hasFolder ? (this.search.value.trim() ? t.searchEmpty : t.folderEmpty) : t.emptyText;
    this.empty.querySelector<HTMLElement>(".empty-actions")!.hidden = hasFolder;
    this.root.classList.toggle("no-folder", !hasFolder);
    this.search.disabled = !hasFolder;
    this.root.querySelector<HTMLButtonElement>(".clear-search")!.disabled = !this.search.value;
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
    if (this.suspended || !this.grid.clientWidth || !this.grid.clientHeight) return;
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
    if (this.suspended || !this.grid.clientWidth || !this.grid.clientHeight) {
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
    if (isVideo(entry)) {
      cell.classList.add("video");
      frame.insertAdjacentHTML("beforeend", PLAY_BADGE);
    }
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
      if (slot < nf) {
        cell.classList.toggle("selected", samePath(this.folders[slot]?.path, this.folderSelection));
        continue;
      }
      cell.classList.toggle("selected", this.selected.has(slot - nf));
      cell.classList.toggle("focus", slot - nf === this.focus);
    }
    const shown = this.entries.length + this.folders.length;
    const total = this.allEntries.length + this.allFolders.length;
    this.root.querySelector<HTMLElement>(".search-count")!.textContent = this.search.value.trim() ? t.searchCount(shown, total) : "";
    this.root.querySelector<HTMLButtonElement>(".clear-search")!.disabled = !this.search.value;
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
    if (a < 0 || b < 0) return set;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    return set;
  }

  private clickCell(i: number, e: MouseEvent): void {
    this.folderSelection = null;
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
    if (this.suspended || !this.grid.clientWidth || !this.grid.clientHeight) return;
    this.relayout();
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
    if (e.isComposing) return false;
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
    if (mod && e.shiftKey && e.code === "KeyN") {
      e.preventDefault();
      this.command("new-folder");
      return true;
    }
    if (mod && e.code === "KeyF") {
      e.preventDefault(); this.focusSearch(); return true;
    }
    if (mod && ["KeyC", "KeyX", "KeyV"].includes(e.code)) {
      e.preventDefault();
      if (e.code === "KeyV") { if (this.folder) this.hooks.paste(e.altKey); }
      else this.hooks.clipboard(this.selectedPaths(), e.code === "KeyX");
      return true;
    }
    if (e.code === "F2") {
      e.preventDefault();
      if (this.folderSelection) this.hooks.rename(this.folderSelection, true);
      else if (this.selected.size === 1) this.hooks.rename(this.selectedPaths()[0], false);
      else this.hooks.toast(t.renameNeed);
      return true;
    }
    if (mod && e.code === "KeyE") {
      e.preventDefault();
      this.hooks.export(this.selectedPaths());
      return true;
    }
    if (mod && e.code === "KeyA") {
      e.preventDefault();
      this.folderSelection = null;
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
    if (e.code === "Escape" && this.search.value) {
      e.preventDefault(); this.clearSearch(); return true;
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
    this.folderSelection = null;
    this.focus = to;
    if (e.shiftKey && this.anchor >= 0) this.select(this.range(this.anchor, to));
    else {
      this.anchor = to;
      this.select(new Set([to]));
    }
    this.scrollTo(to);
    return true;
  }

  /**
   * Dragging selected thumbnails onto a folder (tree, favorites, recent, path bar) moves or copies them.
   * Leaving the window hands the files to the system, so they can be dropped in Finder, File Explorer or other apps.
   */
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
      if (e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        const paths = this.selectedPaths();
        if (this.grid.hasPointerCapture(e.pointerId)) this.grid.releasePointerCapture(e.pointerId);
        end(e, false);
        if (paths.length) this.hooks.dragOut(paths);
        return;
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
