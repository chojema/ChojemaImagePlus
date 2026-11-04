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
}

const CONCURRENT = 8;
const TIMEOUT = 12_000;
const RETRY_DELAYS = [300, 900];

/** A bounded queue belonging to one gallery. Removed cells release their requests immediately. */
export class ThumbnailLoader {
  private readonly items = new Map<HTMLImageElement, Pending>();

  constructor(private readonly source: (entry: Entry, attempt: number) => string) {}

  set(items: Item[]): void {
    const wanted = new Set(items.map(({ img }) => img));
    for (const [img, item] of this.items) {
      if (!wanted.has(img)) this.remove(item);
    }
    for (const item of items) {
      const existing = this.items.get(item.img);
      if (existing) existing.priority = item.priority;
      else this.items.set(item.img, { ...item, status: "queued", attempt: 0, timer: 0 });
    }
    this.pump();
  }

  clear(): void {
    for (const item of this.items.values()) this.remove(item);
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
    for (const item of this.items.values()) {
      if (!item.img.isConnected) this.remove(item);
    }
    const items = [...this.items.values()];
    let room = CONCURRENT - items.filter((item) => item.status === "loading").length;
    const queued = items.filter((item) => item.status === "queued").sort((a, b) => a.priority - b.priority);
    for (const item of queued) {
      if (room-- <= 0) break;
      item.status = "loading";
      item.img.onload = () => this.finish(item, true);
      item.img.onerror = () => this.finish(item, false);
      item.timer = window.setTimeout(() => this.finish(item, false), TIMEOUT);
      item.img.src = this.source(item.entry, item.attempt);
    }
  }

  private finish(item: Pending, ok: boolean): void {
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
