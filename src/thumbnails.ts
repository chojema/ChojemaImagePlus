import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "./common";

interface Item {
  img: HTMLImageElement;
  entry: Entry;
  /** Visible cells come before the margin outside the viewport. */
  priority: number;
}

interface Pending extends Item {
  status: "queued" | "loading" | "retry" | "done" | "failed";
  attempt: number;
  timer: number;
  repair: boolean;
}

const TIMEOUT = 12_000;
const RETRY_DELAYS = [300, 900];
// A reload starts a new owner namespace while the native process may still hold old views.
let nextOwner = Date.now() * 1024;

/** Only viewport cells are admitted; the backend bounds actual decoding, not cache hits. */
export class ThumbnailLoader {
  private readonly items = new Map<HTMLImageElement, Pending>();
  private readonly owner = ++nextOwner;
  private revision = 0;
  private ready = 0;
  private scoped = false;
  private viewKey = "";

  constructor(private readonly source: (entry: Entry, attempt: number, repair: boolean) => string) {}

  set(items: Item[]): void {
    const wanted = new Set(items.map(({ img }) => img));
    for (const [img, item] of this.items) {
      if (!wanted.has(img)) this.remove(item);
    }
    for (const item of items) {
      const existing = this.items.get(item.img);
      if (existing) existing.priority = item.priority;
      else this.items.set(item.img, { ...item, status: "queued", attempt: 0, timer: 0, repair: false });
    }
    const ordered = [...items].sort((a, b) => a.priority - b.priority);
    const paths = ordered.map(({ entry }) => entry.path);
    const visible = ordered.filter(({ priority }) => priority < 1e9).length;
    const key = JSON.stringify([paths, visible]);
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.register(paths, visible);
    } else this.pump();
  }

  clear(): void {
    for (const item of this.items.values()) this.remove(item);
    if (this.viewKey) {
      this.viewKey = "";
      this.register([], 0);
    }
  }

  private register(paths: string[], visible: number): void {
    const revision = ++this.revision;
    // Register before assigning src, so delayed requests from an old viewport can be rejected.
    void invoke("thumbs_viewport", { owner: this.owner, revision, paths, visible }).then(
      () => this.registered(revision, true),
      () => this.registered(revision, false),
    );
  }

  private registered(revision: number, scoped: boolean): void {
    if (revision !== this.revision) return;
    this.ready = revision;
    this.scoped = scoped;
    this.pump();
  }

  private stop(item: Pending): void {
    clearTimeout(item.timer);
    item.img.onload = null;
    item.img.onerror = null;
  }

  private remove(item: Pending): void {
    this.stop(item);
    this.items.delete(item.img);
    if (item.status === "loading") item.img.removeAttribute("src");
  }

  private pump(): void {
    if (this.ready !== this.revision) return;
    for (const item of this.items.values()) {
      if (!item.img.isConnected) this.remove(item);
    }
    const items = [...this.items.values()];
    const visible = items.filter((item) => item.priority < 1e9);
    const waiting = visible.filter((item) => item.status !== "done" && item.status !== "failed").length;
    // Do not spend first-screen I/O on the margin until at least 90% of visible cells finish.
    const margin = waiting <= Math.floor(visible.length / 10);
    const queued = items.filter((item) => item.status === "queued").sort((a, b) => a.priority - b.priority);
    for (const item of queued) {
      if (item.priority >= 1e9 && !margin) continue;
      item.status = "loading";
      item.img.onload = () => this.finish(item, true, false);
      item.img.onerror = () => this.finish(item, false, true);
      item.timer = window.setTimeout(() => this.finish(item, false, false), TIMEOUT);
      const scope = this.scoped ? `&owner=${this.owner}&view=${this.revision}` : "";
      item.img.src = this.source(item.entry, item.attempt, item.repair) + scope;
    }
  }

  private finish(item: Pending, ok: boolean, repair: boolean): void {
    if (this.items.get(item.img) !== item || item.status !== "loading") return;
    this.stop(item);
    if (ok) {
      item.status = "done";
      item.img.parentElement?.classList.remove("broken");
    } else {
      item.img.removeAttribute("src");
      const delay = RETRY_DELAYS[item.attempt];
      if (delay !== undefined) {
        item.status = "retry";
        item.attempt++;
        item.repair = repair;
        item.timer = window.setTimeout(() => {
          if (this.items.get(item.img) !== item) return;
          item.status = "queued";
          this.pump();
        }, delay);
      } else {
        item.status = "failed";
        item.img.parentElement?.classList.add("broken");
      }
    }
    this.pump();
  }
}
