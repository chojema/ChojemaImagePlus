import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export interface FolderItem {
  path: string;
  name: string;
  exists: boolean;
}

export interface Snapshot {
  favorites: FolderItem[];
  recent: FolderItem[];
}

interface Hooks {
  open: (path: string) => void;
  toast: (text: string) => void;
}

const ICONS = {
  rename: '<path d="M4 20h4L19 9l-4-4L4 16z" />',
  up: '<path d="M6 15l6-6 6 6" />',
  down: '<path d="M6 9l6 6 6-6" />',
  remove: '<path d="M6 6l12 12M18 6L6 18" />',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z" />',
};

const isWindows = navigator.userAgent.includes("Windows");

function samePath(a: string, b: string): boolean {
  if (!isWindows) return a === b;
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function iconButton(icon: keyof typeof ICONS, title: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "icon");
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon]}</svg>`;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

/** Favorite and recent folders, shown in the bottom-bar panel and on the empty screen. */
export class Library {
  private data: Snapshot = { favorites: [], recent: [] };
  private editing: string | null = null;
  private readonly containers: HTMLElement[];

  constructor(
    private readonly panel: HTMLElement,
    emptyLists: HTMLElement,
    private readonly hooks: Hooks,
  ) {
    this.containers = [panel, emptyLists];
    document.addEventListener("pointerdown", (e) => {
      if (this.panel.hidden) return;
      const target = e.target as Node;
      if (!this.panel.contains(target) && !(target as Element).closest?.("#folders-button")) this.close();
    });
  }

  async load(): Promise<void> {
    this.set(await invoke<Snapshot>("library_get"));
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  isFavorite(path: string | null): boolean {
    return !!path && this.data.favorites.some((f) => samePath(f.path, path));
  }

  async toggle(path: string): Promise<void> {
    const was = this.isFavorite(path);
    this.set(await invoke<Snapshot>("favorite_toggle", { path }));
    this.hooks.toast(was ? t.favoriteRemoved : t.favoriteAdded);
  }

  /** Opens the favorite at a 1-based position. */
  openFavorite(position: number): void {
    const item = this.data.favorites[position - 1];
    if (item) this.activate(item);
  }

  toggleOpen(): void {
    if (this.isOpen) this.close();
    else {
      this.panel.hidden = false;
      void this.load();
    }
  }

  close(): void {
    this.panel.hidden = true;
    this.editing = null;
    this.render();
  }

  onChange: () => void = () => {};

  private set(data: Snapshot): void {
    this.data = data;
    this.render();
    this.onChange();
  }

  private activate(item: FolderItem): void {
    if (!item.exists) {
      this.hooks.toast(t.notFound);
      return;
    }
    this.close();
    this.hooks.open(item.path);
  }

  private async call(command: string, args: Record<string, unknown>): Promise<void> {
    this.set(await invoke<Snapshot>(command, args));
  }

  private render(): void {
    for (const container of this.containers) {
      container.replaceChildren(...this.sections(container === this.panel));
    }
  }

  private sections(inPanel: boolean): HTMLElement[] {
    const favorites = el("section");
    const head = el("h3", "", t.favorites);
    favorites.append(head);
    if (!this.data.favorites.length) {
      if (!inPanel) return this.data.recent.length ? [this.recentSection(inPanel)] : [];
      favorites.append(el("p", "hint", t.noFavorites));
    } else {
      const list = el("ul");
      this.data.favorites.forEach((item, i) => list.append(this.favoriteRow(item, i, inPanel)));
      favorites.append(list);
    }
    const result = [favorites];
    if (this.data.recent.length || inPanel) result.push(this.recentSection(inPanel));
    return result;
  }

  private favoriteRow(item: FolderItem, index: number, inPanel: boolean): HTMLLIElement {
    const row = el("li", item.exists ? "" : "missing");
    row.title = item.path;
    const key = el("span", "key", index < 9 ? String(index + 1) : "");
    const text = el("span", "text");

    if (inPanel && this.editing === item.path) {
      const input = el("input");
      input.value = item.name;
      input.spellcheck = false;
      const finish = (save: boolean) => {
        if (this.editing !== item.path) return;
        this.editing = null;
        if (save) void this.call("favorite_rename", { path: item.path, name: input.value });
        else this.render();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      text.append(input);
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    } else {
      text.append(el("span", "name", item.name), el("span", "path", item.exists ? item.path : `${t.missing} · ${item.path}`));
    }
    row.append(key, text);

    if (inPanel && this.editing !== item.path) {
      const last = this.data.favorites.length - 1;
      const actions = el("span", "actions");
      actions.append(
        iconButton("rename", t.rename, () => {
          this.editing = item.path;
          this.render();
        }),
      );
      if (index > 0) actions.append(iconButton("up", t.moveUp, () => void this.call("favorite_move", { path: item.path, to: index - 1 })));
      if (index < last) actions.append(iconButton("down", t.moveDown, () => void this.call("favorite_move", { path: item.path, to: index + 1 })));
      actions.append(iconButton("remove", t.remove, () => void this.call("favorite_remove", { path: item.path })));
      row.append(actions);
    }
    row.addEventListener("click", () => {
      if (this.editing !== item.path) this.activate(item);
    });
    return row;
  }

  private recentSection(inPanel: boolean): HTMLElement {
    const section = el("section");
    const head = el("h3", "", t.recent);
    if (inPanel && this.data.recent.length) {
      const clear = el("button", "link", t.clear);
      clear.type = "button";
      clear.addEventListener("click", () => void this.call("recent_clear", {}));
      head.append(clear);
    }
    section.append(head);
    if (!this.data.recent.length) {
      section.append(el("p", "hint", t.noRecent));
      return section;
    }
    const list = el("ul");
    for (const item of this.data.recent) {
      const row = el("li", item.exists ? "" : "missing");
      row.title = item.path;
      const text = el("span", "text");
      text.append(el("span", "name", item.name), el("span", "path", item.exists ? item.path : `${t.missing} · ${item.path}`));
      row.append(el("span", "key"), text);
      if (inPanel && !this.isFavorite(item.path)) {
        const actions = el("span", "actions");
        actions.append(iconButton("star", t.addFavorite, () => void this.toggle(item.path)));
        row.append(actions);
      }
      row.addEventListener("click", () => this.activate(item));
      list.append(row);
    }
    section.append(list);
    return section;
  }
}
