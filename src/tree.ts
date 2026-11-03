import { invoke } from "@tauri-apps/api/core";
import { samePath, within } from "./common";
import { t } from "./i18n";

interface Folder {
  path: string;
  name: string;
  has_children: boolean;
}

interface Roots {
  places: Folder[];
  drives: Folder[];
}

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>';

/** Lazily loaded folder tree: places (Pictures, Home, ...) and drives or volumes. */
export class FolderTree {
  private roots: HTMLElement[] = [];
  private active: string | null = null;
  private readonly pending = new Map<HTMLElement, Promise<boolean>>();

  constructor(
    private readonly container: HTMLElement,
    private readonly onSelect: (path: string) => void,
  ) {}

  async load(): Promise<void> {
    const roots = await invoke<Roots>("folder_roots");
    this.container.replaceChildren();
    this.roots = [];
    for (const f of roots.places) {
      const name = t.placeNames[f.name] ?? f.name;
      this.roots.push(this.node({ ...f, name }, 0, "place"));
    }
    if (roots.places.length && roots.drives.length) this.container.append(document.createElement("hr"));
    for (const f of roots.drives) this.roots.push(this.node(f, 0, "drive"));
    if (this.active) this.highlight(this.active);
  }

  private node(folder: Folder, depth: number, kind = ""): HTMLElement {
    const item = document.createElement("div");
    item.className = `node ${kind}`;
    item.dataset.path = folder.path;
    item.setAttribute("role", "treeitem");

    const row = document.createElement("div");
    row.className = "row";
    row.style.paddingLeft = `${6 + depth * 14}px`;
    row.title = folder.path;
    row.dataset.drop = folder.path;

    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "twisty";
    twisty.tabIndex = -1;
    twisty.hidden = !folder.has_children;
    twisty.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggle(item);
    });

    const icon = document.createElement("span");
    icon.className = "folder-icon";
    icon.innerHTML = FOLDER_ICON;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = folder.name;
    row.append(twisty, icon, label);
    row.addEventListener("click", () => this.onSelect(folder.path));
    row.addEventListener("dblclick", () => void this.toggle(item));

    const children = document.createElement("div");
    children.className = "children";
    children.setAttribute("role", "group");
    item.append(row, children);
    item.dataset.depth = String(depth);
    if (depth === 0) this.container.append(item);
    return item;
  }

  private async expand(item: HTMLElement): Promise<void> {
    if (item.classList.contains("open")) return;
    if (!item.dataset.loaded && !(await this.loadChildren(item))) return;
    item.classList.add("open");
  }

  /** Lists a folder's subfolders once; clicks while a slow (network, cloud) folder is still listing share the same request. */
  private loadChildren(item: HTMLElement): Promise<boolean> {
    let pending = this.pending.get(item);
    if (pending) return pending;
    const children = item.querySelector<HTMLElement>(":scope > .children")!;
    const depth = Number(item.dataset.depth) + 1;
    item.classList.add("loading");
    pending = invoke<Folder[]>("folder_children", { path: item.dataset.path })
      .then((list) => {
        children.replaceChildren(...list.map((f) => this.node(f, depth)));
        item.dataset.loaded = "1";
        if (!list.length) item.querySelector<HTMLElement>(":scope > .row .twisty")!.hidden = true;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        item.classList.remove("loading");
        this.pending.delete(item);
      });
    this.pending.set(item, pending);
    return pending;
  }

  private async toggle(item: HTMLElement): Promise<void> {
    if (item.classList.contains("open")) item.classList.remove("open");
    else await this.expand(item);
  }

  /** Expands the tree down to `path` and highlights it. */
  async reveal(path: string): Promise<void> {
    this.active = path;
    const candidates = this.roots.filter((r) => within(r.dataset.path!, path));
    // Prefer the deepest root, e.g. Pictures over Home over the drive.
    candidates.sort((a, b) => b.dataset.path!.length - a.dataset.path!.length);
    let item: HTMLElement | undefined = candidates[0];
    while (item && !samePath(item.dataset.path, path)) {
      await this.expand(item);
      const next: HTMLElement | undefined = [...item.querySelectorAll<HTMLElement>(":scope > .children > .node")].find((c) =>
        within(c.dataset.path!, path),
      );
      if (!next) break;
      item = next;
    }
    this.highlight(path);
  }

  private highlight(path: string): void {
    this.active = path;
    let found: HTMLElement | null = null;
    for (const node of this.container.querySelectorAll<HTMLElement>(".node")) {
      const on = samePath(node.dataset.path, path) && !found;
      node.classList.toggle("active", on);
      if (on) found = node;
    }
    found?.querySelector(".row")?.scrollIntoView({ block: "nearest" });
  }
}
