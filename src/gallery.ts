import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { $, Entry, formatSize, parentOf, samePath } from "./common";
import { errorText, t } from "./i18n";
import { MAX_COMPARE } from "./compare";
import { saveSettings, settings, SortKey } from "./settings";

interface Hooks {
  navigate: (path: string) => void;
  open: (entries: Entry[], index: number) => void;
  compare: (entries: Entry[]) => void;
  favorite: () => void;
  chooseFolder: () => void;
  chooseFile: () => void;
  toast: (text: string) => void;
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

  private readonly grid = $<HTMLElement>("grid");
  private readonly empty = $<HTMLElement>("gallery-empty");
  private readonly emptyText = $<HTMLElement>("gallery-empty-text");
  private readonly crumbs = $<HTMLElement>("crumbs");
  private readonly count = $<HTMLElement>("gallery-count");
  private readonly sort = $<HTMLSelectElement>("sort");
  private readonly size = $<HTMLInputElement>("thumb-size");
  private readonly favoriteButton = $<HTMLButtonElement>("browse-favorite");

  constructor(private readonly hooks: Hooks) {
    const options: [SortKey, string][] = [
      ["name", t.sortName],
      ["date", t.sortDate],
      ["size", t.sortSize],
    ];
    for (const [value, label] of options) this.sort.append(new Option(label, value));
    this.sort.title = this.sort.getAttribute("aria-label") ?? "";
    this.sort.addEventListener("change", () => {
      saveSettings({ sort: this.sort.value as SortKey });
      this.resort();
    });
    this.size.title = t.thumbSize;
    this.size.addEventListener("input", () => this.applySize());
    this.size.addEventListener("change", () => saveSettings({ thumbSize: Number(this.size.value) }));

    const titles: Record<string, string> = {
      up: t.up,
      "sort-dir": t.sortDir,
      compare: t.compare,
      favorite: t.favoriteToggle,
      refresh: t.refresh,
      open: t.openTitle,
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-browse]")) {
      const action = button.dataset.browse!;
      button.title = titles[action] ?? "";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.command(action));
    }

    this.emptyText.textContent = t.emptyText;
    $("empty-open-file").textContent = t.openFile;
    $("empty-open-folder").textContent = t.openFolder;
    $("empty-open-file").addEventListener("click", () => hooks.chooseFile());
    $("empty-open-folder").addEventListener("click", () => hooks.chooseFolder());

    this.grid.addEventListener("click", (e) => {
      const cell = (e.target as Element).closest<HTMLElement>(".cell");
      if (!cell) {
        this.select(new Set());
        return;
      }
      this.clickCell(Number(cell.dataset.index), e);
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

  private applySize(): void {
    this.grid.style.setProperty("--thumb", `${this.size.value}px`);
  }

  private updateSortDir(): void {
    $("sort-dir").classList.toggle("desc", settings.sortDesc);
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
        this.updateSortDir();
        this.resort();
        break;
      case "favorite":
        this.hooks.favorite();
        break;
      case "compare":
        this.compareSelection();
        break;
      case "refresh":
        if (this.folder) void this.load(this.folder, this.current?.path);
        break;
      case "open":
        this.hooks.chooseFolder();
        break;
    }
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
      this.render();
      if (i >= 0) this.scrollTo(i);
      else this.grid.scrollTop = 0;
      return true;
    } catch (err) {
      this.hooks.toast(errorText(err));
      return false;
    }
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

  private sorted(list: Entry[]): Entry[] {
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
    document.body.classList.toggle("no-folder", !hasFolder);

    const fragment = document.createDocumentFragment();
    this.entries.forEach((entry, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.index = String(i);
      cell.title = `${entry.name}\n${formatSize(entry.size)} · ${new Date(entry.modified).toLocaleString()}`;
      const frame = document.createElement("div");
      frame.className = "frame";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.alt = "";
      img.src = this.thumbSrc(entry);
      img.addEventListener("error", () => frame.classList.add("broken"), { once: true });
      frame.append(img);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.name;
      cell.append(frame, name);
      fragment.append(cell);
    });
    this.grid.replaceChildren(fragment);
    this.paintSelection();
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
    const cells = this.grid.children;
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle("selected", this.selected.has(i));
      cells[i].classList.toggle("focus", i === this.focus);
    }
    this.count.textContent = this.folder ? t.count(this.entries.length, this.selected.size) : "";
    const n = this.selected.size;
    $<HTMLButtonElement>("compare-button").classList.toggle("ready", n >= 2 && n <= MAX_COMPARE);
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
    (this.grid.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private columns(): number {
    const cells = this.grid.children;
    if (cells.length < 2) return 1;
    const top = (cells[0] as HTMLElement).offsetTop;
    let n = 1;
    while (n < cells.length && (cells[n] as HTMLElement).offsetTop === top) n++;
    return n;
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
}
