import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, Entry, formatSize, isFullscreen, showToast, toggleFullscreen } from "./common";
import { t } from "./i18n";
import { View } from "./view";
import { imageSrc } from "./viewer";

const ZOOM_STEP = 1.25;
export const MAX_COMPARE = 4;

interface Pane {
  entry: Entry;
  root: HTMLElement;
  stage: HTMLElement;
  img: HTMLImageElement;
  detail: HTMLElement;
  view: View;
}

/** Two to four images side by side, with zoom and pan optionally kept in step. */
export class Compare {
  private panes: Pane[] = [];
  private active = 0;
  private sync = true;
  private stacked = false;
  private drag: { pane: Pane; id: number; x: number; y: number } | null = null;

  private readonly container = $<HTMLElement>("panes");
  private readonly bar = $<HTMLElement>("compare-bar");
  private readonly title = $<HTMLElement>("compare-title");
  private readonly zoomLabel = $<HTMLButtonElement>("compare-zoom");
  readonly actions: Record<string, () => void>;

  constructor(hooks: { back: () => void }) {
    this.actions = {
      back: hooks.back,
      layout: () => this.toggleLayout(),
      sync: () => this.toggleSync(),
      "zoom-in": () => this.zoomActive(ZOOM_STEP),
      "zoom-out": () => this.zoomActive(1 / ZOOM_STEP),
      actual: () => this.each((p) => p.view.zoomTo(1)),
      fit: () => this.each((p) => p.view.fit()),
      "rotate-left": () => this.rotateActive(-90),
      "rotate-right": () => this.rotateActive(90),
      "close-pane": () => this.closeActive(),
      fullscreen: () => void toggleFullscreen(),
      next: () => this.setActive((this.active + 1) % this.panes.length),
    };
    const titles: Record<string, string> = {
      back: t.back,
      layout: t.compareLayout,
      sync: t.compareSync,
      "zoom-in": t.zoomIn,
      "zoom-out": t.zoomOut,
      actual: t.compareActual,
      fit: t.fit,
      "rotate-left": t.rotateLeft,
      "rotate-right": t.rotateRight,
      "close-pane": t.compareClose,
      fullscreen: t.fullscreen,
    };
    for (const button of this.bar.querySelectorAll<HTMLButtonElement>("[data-cmp]")) {
      const action = button.dataset.cmp!;
      button.title = titles[action] ?? "";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.actions[action]?.());
    }
    new ResizeObserver(() => this.relayout()).observe(this.container);
    window.addEventListener("mousemove", (e) => {
      this.bar.classList.toggle("peek", window.innerHeight - e.clientY < 90);
    });
  }

  open(entries: Entry[]): void {
    this.close();
    this.active = 0;
    this.panes = entries.slice(0, MAX_COMPARE).map((entry) => this.createPane(entry));
    this.container.replaceChildren(...this.panes.map((p) => p.root));
    this.applyLayout();
    this.paint();
    this.updateTitle();
  }

  private updateTitle(): void {
    void getCurrentWindow().setTitle(`${this.panes.map((p) => p.entry.name).join(" · ")} - Chojema Image+`);
  }

  close(): void {
    for (const p of this.panes) p.img.removeAttribute("src");
    this.panes = [];
    this.container.replaceChildren();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const map: Record<string, string> = {
      Equal: "zoom-in",
      NumpadAdd: "zoom-in",
      Minus: "zoom-out",
      NumpadSubtract: "zoom-out",
      Digit0: "fit",
      Numpad0: "fit",
      Digit1: "actual",
      Numpad1: "actual",
      KeyR: e.shiftKey ? "rotate-left" : "rotate-right",
      KeyL: "rotate-left",
      KeyS: "sync",
      KeyV: "layout",
      KeyF: "fullscreen",
      F11: "fullscreen",
      Tab: "next",
      Delete: "close-pane",
      KeyX: "close-pane",
    };
    const action = map[e.code];
    if (!action) return false;
    e.preventDefault();
    this.actions[action]();
    return true;
  }

  get isFullscreen(): boolean {
    return isFullscreen();
  }

  private createPane(entry: Entry): Pane {
    const root = document.createElement("div");
    root.className = "pane";
    const stage = document.createElement("div");
    stage.className = "pane-stage";
    const img = document.createElement("img");
    img.className = "view-img";
    img.alt = "";
    img.draggable = false;
    stage.append(img);
    const label = document.createElement("div");
    label.className = "pane-label";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    const detail = document.createElement("span");
    detail.className = "detail";
    label.append(name, detail);
    root.append(stage, label);

    const pane: Pane = { entry, root, stage, img, detail, view: new View(stage, img) };
    img.onload = () => {
      pane.view.reset(img.naturalWidth, img.naturalHeight);
      img.classList.add("visible");
      const lead = this.panes[this.active];
      if (this.sync && lead && lead !== pane && lead.view.loaded) pane.view.setState(lead.view.getState());
      this.paint();
    };
    img.onerror = () => {
      detail.textContent = t.loadFailed;
    };
    img.src = imageSrc(entry);
    this.bindPane(pane);
    return pane;
  }

  private bindPane(pane: Pane): void {
    const { stage, view } = pane;
    stage.addEventListener("pointerdown", (e) => {
      this.setActive(this.panes.indexOf(pane));
      if (e.button !== 0 || !view.loaded || !view.pannable) return;
      this.drag = { pane, id: e.pointerId, x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
    });
    stage.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.pane !== pane || d.id !== e.pointerId) return;
      view.panBy(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX;
      d.y = e.clientY;
      this.follow(pane);
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener(
      "wheel",
      (e) => {
        if (!view.loaded) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
        // Ctrl/Cmd + wheel and pinch zoom; plain scrolling pans a zoomed image and zooms otherwise.
        if (e.ctrlKey || e.metaKey || !view.pannable) {
          view.zoomBy(Math.exp(-dy * 0.01), e.clientX - rect.left, e.clientY - rect.top);
        } else {
          view.panBy(e.shiftKey ? -dy : -dx, e.shiftKey ? 0 : -dy);
        }
        this.setActive(this.panes.indexOf(pane));
        this.follow(pane);
      },
      { passive: false },
    );
    stage.addEventListener("dblclick", (e) => {
      if (!view.loaded) return;
      const rect = stage.getBoundingClientRect();
      if (view.fitted && Math.abs(view.scale - 1) > 0.001) view.zoomTo(1, e.clientX - rect.left, e.clientY - rect.top);
      else view.fit();
      this.follow(pane);
    });
  }

  /** Copies the lead pane's zoom and position to the others when syncing. */
  private follow(lead: Pane): void {
    if (this.sync && lead.view.loaded) {
      const state = lead.view.getState();
      for (const p of this.panes) if (p !== lead) p.view.setState(state);
    }
    this.paint();
  }

  private each(fn: (p: Pane) => void): void {
    for (const p of this.panes) if (p.view.loaded) fn(p);
    this.paint();
  }

  private zoomActive(factor: number): void {
    const lead = this.panes[this.active];
    if (!lead?.view.loaded) return;
    lead.view.zoomBy(factor);
    this.follow(lead);
  }

  private rotateActive(delta: number): void {
    const p = this.panes[this.active];
    if (!p?.view.loaded) return;
    p.view.rotate(delta);
    this.paint();
  }

  private closeActive(): void {
    if (this.panes.length <= 2) {
      showToast(t.compareMin);
      return;
    }
    const [removed] = this.panes.splice(this.active, 1);
    removed.img.removeAttribute("src");
    removed.root.remove();
    this.active = Math.min(this.active, this.panes.length - 1);
    this.applyLayout();
    this.paint();
    this.updateTitle();
  }

  private setActive(i: number): void {
    if (i < 0 || i === this.active) return;
    this.active = i;
    this.paint();
  }

  private toggleSync(): void {
    this.sync = !this.sync;
    showToast(this.sync ? t.compareSyncOn : t.compareSyncOff);
    const lead = this.panes[this.active];
    if (this.sync && lead) this.follow(lead);
    else this.paint();
  }

  private toggleLayout(): void {
    if (this.panes.length !== 2) return;
    this.stacked = !this.stacked;
    this.applyLayout();
  }

  private applyLayout(): void {
    const n = this.panes.length;
    this.container.dataset.count = String(n);
    this.container.classList.toggle("stacked", n === 2 && this.stacked);
    requestAnimationFrame(() => this.relayout());
  }

  private relayout(): void {
    for (const p of this.panes) if (p.view.loaded) p.view.relayout();
    const lead = this.panes[this.active];
    if (lead) this.follow(lead);
  }

  private paint(): void {
    this.panes.forEach((p, i) => {
      p.root.classList.toggle("active", i === this.active && this.panes.length > 1);
      const v = p.view;
      if (v.loaded) {
        p.detail.textContent = `${v.width} × ${v.height} · ${formatSize(p.entry.size)} · ${Math.round(v.scale * 100)}%`;
      }
    });
    const lead = this.panes[this.active];
    this.zoomLabel.textContent = lead?.view.loaded ? `${Math.round(lead.view.scale * 100)}%` : "";
    this.title.textContent = t.compareTitle(this.panes.length);
    this.bar.querySelector('[data-cmp="sync"]')?.classList.toggle("on", this.sync);
    const layout = this.bar.querySelector<HTMLButtonElement>('[data-cmp="layout"]');
    if (layout) {
      layout.disabled = this.panes.length !== 2;
      layout.classList.toggle("stacked", this.stacked);
    }
    const closeButton = this.bar.querySelector<HTMLButtonElement>('[data-cmp="close-pane"]');
    if (closeButton) closeButton.disabled = this.panes.length <= 2;
  }
}
