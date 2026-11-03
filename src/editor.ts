import { invoke } from "@tauri-apps/api/core";
import { $, Entry, showToast } from "./common";
import { t } from "./i18n";
import { saveSettings, settings, Settings } from "./settings";
import { imageSrc } from "./viewer";

/** A rectangle in pixels of the rotated and flipped image. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Edges = { l: boolean; r: boolean; t: boolean; b: boolean };

interface Drag {
  id: number;
  mode: "move" | "resize" | "new";
  edges: Edges;
  start: Rect;
  px: number;
  py: number;
}

const RATIOS = ["free", "original", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"];
const MARGIN = 28;
const HANDLE = 10;
const MIN_SIZE = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0) as [number, number, number];
}

/**
 * Edits the image shown in the viewer: quarter-turn rotation, flips, crop, resize and a border.
 * The canvas previews exactly what the backend will write, in the same order
 * (rotate → flip → crop → resize → border).
 */
export class Editor {
  private readonly root = $("editor");
  private readonly stage = $("ed-stage");
  private readonly canvas = $<HTMLCanvasElement>("ed-canvas");
  private readonly ctx = this.canvas.getContext("2d")!;
  private readonly ratio = $<HTMLSelectElement>("ed-ratio");
  private readonly result = $("ed-result");
  private readonly saveButton = $<HTMLButtonElement>("ed-save");
  private img = new Image();
  private entry: Entry | null = null;
  private rotate = 0;
  private flipH = false;
  private flipV = false;
  private crop: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** The image's place on the canvas, in CSS pixels, and its display scale. */
  private box = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  /** The rotated and flipped image pre-scaled to the display size, redrawn only when the layout changes. */
  private base: HTMLCanvasElement | null = null;
  private drag: Drag | null = null;
  private busy = false;
  private canOverwrite = true;

  constructor(private readonly saved: (entry: Entry, replaced: boolean) => void) {
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-t]")) {
      el.textContent = String((t as Record<string, unknown>)[el.dataset.t!] ?? "");
    }
    $("ed-title").textContent = t.edTitle;
    $("ed-crop-reset").textContent = t.edCropReset;
    $("ed-reset").textContent = t.edReset;
    $("ed-cancel").textContent = t.cancel;
    this.saveButton.textContent = t.edSaveButton;
    const ratioLabel: Record<string, string> = { free: t.edRatioFree, original: t.edRatioOriginal };
    for (const r of RATIOS) this.ratio.append(new Option(ratioLabel[r] ?? r, r));

    const titles: Record<string, string> = {
      "rotate-left": t.edRotateLeft,
      "rotate-right": t.edRotateRight,
      "flip-h": t.edFlipH,
      "flip-v": t.edFlipV,
    };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-ed]")) {
      const action = button.dataset.ed!;
      button.title = titles[action] ?? "";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.transform(action));
    }
    this.ratio.addEventListener("change", () => {
      saveSettings({ edRatio: this.ratio.value });
      this.fitRatio();
      this.draw();
    });
    $("ed-crop-reset").addEventListener("click", () => {
      this.ratio.value = "free";
      saveSettings({ edRatio: "free" });
      this.crop = this.full();
      this.draw();
    });
    $("ed-reset").addEventListener("click", () => this.reset());
    $("ed-cancel").addEventListener("click", () => this.close());
    this.saveButton.addEventListener("click", () => void this.save());
    for (const el of this.root.querySelectorAll<HTMLInputElement>(".ed-panel input")) {
      el.addEventListener("input", () => this.readOptions());
      el.addEventListener("change", () => this.readOptions());
    }
    new ResizeObserver(() => this.isOpen && this.layout()).observe(this.stage);
    this.bindPointer();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Opens on `entry`; it must already be loaded in the viewer. */
  async open(entry: Entry): Promise<void> {
    this.entry = entry;
    const img = new Image();
    img.decoding = "async";
    img.src = imageSrc(entry);
    try {
      await img.decode();
    } catch {
      showToast(t.edNotReady);
      return;
    }
    if (this.entry !== entry) return;
    this.img = img;
    this.canOverwrite = await invoke<boolean>("edit_can_overwrite", { path: entry.path }).catch(() => false);
    this.applySettings();
    this.root.hidden = false;
    document.body.classList.add("editing");
    this.reset();
    this.saveButton.focus();
  }

  close(): void {
    if (this.busy) return;
    this.root.hidden = true;
    document.body.classList.remove("editing");
    this.entry = null;
    this.base = null;
    this.drag = null;
  }

  handleKey(e: KeyboardEvent): void {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== "radio" && e.target.type !== "color";
    if (e.key === "Escape") {
      e.preventDefault();
      if (typing) (e.target as HTMLElement).blur();
      else this.close();
      return;
    }
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      void this.save();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "KeyR") {
      e.preventDefault();
      this.transform(e.shiftKey ? "rotate-left" : "rotate-right");
    } else if (e.code === "KeyL") {
      e.preventDefault();
      this.transform("rotate-left");
    }
  }

  // --- state ------------------------------------------------------------------------------

  private get turned(): boolean {
    return this.rotate % 180 !== 0;
  }

  /** Size of the image after rotation, in pixels. */
  private get size(): { w: number; h: number } {
    const w = this.img.naturalWidth;
    const h = this.img.naturalHeight;
    return this.turned ? { w: h, h: w } : { w, h };
  }

  private full(): Rect {
    const { w, h } = this.size;
    return { x: 0, y: 0, w, h };
  }

  private reset(): void {
    this.rotate = 0;
    this.flipH = false;
    this.flipV = false;
    this.crop = this.full();
    this.fitRatio();
    this.layout();
  }

  private applySettings(): void {
    this.ratio.value = RATIOS.includes(settings.edRatio) ? settings.edRatio : "free";
    this.pick("ed-resize", settings.edResize);
    $<HTMLInputElement>("ed-long").value = String(settings.edLong);
    $<HTMLInputElement>("ed-percent").value = String(settings.edPercent);
    $<HTMLInputElement>("ed-border").value = String(settings.edBorder);
    $<HTMLInputElement>("ed-border-color").value = settings.edBorderColor;
    const overwrite = $<HTMLInputElement>("ed-save-overwrite-input");
    overwrite.disabled = !this.canOverwrite;
    this.pick("ed-save", this.canOverwrite ? settings.edSave : "copy");
    $("ed-no-overwrite").hidden = this.canOverwrite;
  }

  private radio(name: string): string {
    return this.root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "";
  }

  private pick(name: string, value: string): void {
    for (const r of this.root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) r.checked = r.value === value;
  }

  private readOptions(): void {
    const num = (id: string, lo: number, hi: number, fallback: number) => {
      const v = Math.round(Number($<HTMLInputElement>(id).value));
      return Number.isFinite(v) && v >= lo ? Math.min(v, hi) : fallback;
    };
    const next: Partial<Settings> = {
      edResize: (this.radio("ed-resize") || "none") as Settings["edResize"],
      edLong: num("ed-long", 16, 20000, settings.edLong),
      edPercent: num("ed-percent", 1, 1000, settings.edPercent),
      edBorder: num("ed-border", 0, 2000, 0),
      edBorderColor: $<HTMLInputElement>("ed-border-color").value || "#ffffff",
    };
    if (this.canOverwrite) next.edSave = (this.radio("ed-save") || "copy") as Settings["edSave"];
    saveSettings(next);
    this.draw();
  }

  /** Width ÷ height wanted by the ratio menu, or null when free. */
  private wantedRatio(): number | null {
    const value = this.ratio.value;
    if (value === "free") return null;
    if (value === "original") {
      const { w, h } = this.size;
      return w / h;
    }
    const [a, b] = value.split(":").map(Number);
    return a > 0 && b > 0 ? a / b : null;
  }

  /** The largest area of the wanted ratio, centred on the current one. */
  private fitRatio(): void {
    const r = this.wantedRatio();
    if (!r) return;
    const { w: W, h: H } = this.size;
    let w = W;
    let h = w / r;
    if (h > H) {
      h = H;
      w = h * r;
    }
    const cx = this.crop.x + this.crop.w / 2;
    const cy = this.crop.y + this.crop.h / 2;
    this.crop = { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
  }

  /** Rotates or flips the picture as seen on screen, carrying the crop area along. */
  private transform(action: string): void {
    const { w: W, h: H } = this.size;
    const c = this.crop;
    switch (action) {
      case "rotate-right":
      case "rotate-left": {
        const cw = action === "rotate-right";
        // The backend rotates first and flips after, so with one flip set the stored turn goes the other way.
        const oneFlip = this.flipH !== this.flipV;
        this.rotate = (this.rotate + ((cw !== oneFlip) ? 90 : 270)) % 360;
        this.crop = cw ? { x: H - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: W - c.x - c.w, w: c.h, h: c.w };
        const [a, b] = this.ratio.value.split(":");
        if (b && this.ratio.querySelector(`option[value="${b}:${a}"]`)) {
          this.ratio.value = `${b}:${a}`;
          saveSettings({ edRatio: this.ratio.value });
        }
        break;
      }
      case "flip-h":
        this.flipH = !this.flipH;
        this.crop = { ...c, x: W - c.x - c.w };
        break;
      case "flip-v":
        this.flipV = !this.flipV;
        this.crop = { ...c, y: H - c.y - c.h };
        break;
    }
    this.layout();
  }

  /** Pixel size after crop and resize, before the border. */
  private outputSize(): { w: number; h: number } {
    let w = Math.max(1, Math.round(this.crop.w));
    let h = Math.max(1, Math.round(this.crop.h));
    const long = Math.max(w, h);
    let r = 1;
    if (settings.edResize === "long" && settings.edLong > 0 && long > settings.edLong) r = settings.edLong / long;
    if (settings.edResize === "percent" && settings.edPercent > 0 && settings.edPercent !== 100) r = settings.edPercent / 100;
    if (r !== 1) {
      w = Math.max(1, Math.round(w * r));
      h = Math.max(1, Math.round(h * r));
    }
    return { w, h };
  }

  // --- drawing ----------------------------------------------------------------------------

  /** Fits the picture into the stage and re-renders the scaled copy. */
  private layout(): void {
    if (!this.img.naturalWidth) return;
    const cw = this.stage.clientWidth;
    const ch = this.stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    const { w: W, h: H } = this.size;
    const scale = Math.max(0.001, Math.min((cw - MARGIN * 2) / W, (ch - MARGIN * 2) / H, 4));
    const w = W * scale;
    const h = H * scale;
    this.box = { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale };

    const base = document.createElement("canvas");
    base.width = Math.max(1, Math.round(w * dpr));
    base.height = Math.max(1, Math.round(h * dpr));
    const b = base.getContext("2d")!;
    b.imageSmoothingQuality = "high";
    b.translate(base.width / 2, base.height / 2);
    b.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1);
    b.rotate((this.rotate * Math.PI) / 180);
    const iw = this.img.naturalWidth * scale * dpr;
    const ih = this.img.naturalHeight * scale * dpr;
    b.drawImage(this.img, -iw / 2, -ih / 2, iw, ih);
    this.base = base;
    this.draw();
  }

  /** Crop area in canvas CSS pixels. */
  private screenCrop(): Rect {
    const { x, y, scale } = this.box;
    return { x: x + this.crop.x * scale, y: y + this.crop.y * scale, w: this.crop.w * scale, h: this.crop.h * scale };
  }

  private draw(): void {
    if (!this.base || this.root.hidden) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const { x, y, w, h } = this.box;
    ctx.drawImage(this.base, x, y, w, h);

    const c = this.screenCrop();
    const cropped = this.crop.w < this.size.w - 0.5 || this.crop.h < this.size.h - 0.5;
    if (cropped) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill("evenodd");
    }

    // Border preview at the scale it will have once the crop is resized.
    const out = this.outputSize();
    const border = settings.edBorder;
    if (border > 0) {
      const t = (border * c.w) / out.w;
      ctx.fillStyle = settings.edBorderColor;
      ctx.beginPath();
      ctx.rect(c.x - t, c.y - t, c.w + t * 2, c.h + t * 2);
      ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill("evenodd");
    }

    // Crop frame: outline, rule-of-thirds guides while dragging, handles.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
    if (this.drag) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(c.x + c.w * f, c.y);
        ctx.lineTo(c.x + c.w * f, c.y + c.h);
        ctx.moveTo(c.x, c.y + c.h * f);
        ctx.lineTo(c.x + c.w, c.y + c.h * f);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    const s = 7;
    for (const [hx, hy] of [
      [c.x, c.y],
      [c.x + c.w, c.y],
      [c.x, c.y + c.h],
      [c.x + c.w, c.y + c.h],
      [c.x + c.w / 2, c.y],
      [c.x + c.w / 2, c.y + c.h],
      [c.x, c.y + c.h / 2],
      [c.x + c.w, c.y + c.h / 2],
    ]) {
      ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    }

    this.result.textContent = this.busy ? t.edSaving : t.edResult(out.w + border * 2, out.h + border * 2);
  }

  // --- pointer ----------------------------------------------------------------------------

  private edgesAt(px: number, py: number): Edges | null {
    const c = this.screenCrop();
    const near = (a: number, b: number) => Math.abs(a - b) <= HANDLE;
    const inX = px >= c.x - HANDLE && px <= c.x + c.w + HANDLE;
    const inY = py >= c.y - HANDLE && py <= c.y + c.h + HANDLE;
    const edges = {
      l: inY && near(px, c.x),
      r: inY && near(px, c.x + c.w),
      t: inX && near(py, c.y),
      b: inX && near(py, c.y + c.h),
    };
    if (edges.l && edges.r) edges[px - c.x < c.x + c.w - px ? "r" : "l"] = false;
    if (edges.t && edges.b) edges[py - c.y < c.y + c.h - py ? "b" : "t"] = false;
    return edges.l || edges.r || edges.t || edges.b ? edges : null;
  }

  private cursorFor(px: number, py: number): string {
    const e = this.edgesAt(px, py);
    if (e) {
      if ((e.l && e.t) || (e.r && e.b)) return "nwse-resize";
      if ((e.r && e.t) || (e.l && e.b)) return "nesw-resize";
      return e.l || e.r ? "ew-resize" : "ns-resize";
    }
    const c = this.screenCrop();
    if (px > c.x && px < c.x + c.w && py > c.y && py < c.y + c.h) return "move";
    return "crosshair";
  }

  /** Pointer position in image pixels, kept inside the image. */
  private toImage(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const { w: W, h: H } = this.size;
    return {
      x: clamp((e.clientX - rect.left - this.box.x) / this.box.scale, 0, W),
      y: clamp((e.clientY - rect.top - this.box.y) / this.box.scale, 0, H),
    };
  }

  private bindPointer(): void {
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.base) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const p = this.toImage(e);
      const edges = this.edgesAt(sx, sy);
      const c = this.screenCrop();
      const inside = sx > c.x && sx < c.x + c.w && sy > c.y && sy < c.y + c.h;
      const mode = edges ? "resize" : inside ? "move" : "new";
      this.drag = {
        id: e.pointerId,
        mode,
        edges: edges ?? { l: false, r: true, t: false, b: true },
        start: mode === "new" ? { x: p.x, y: p.y, w: 0, h: 0 } : { ...this.crop },
        px: p.x,
        py: p.y,
      };
      canvas.setPointerCapture(e.pointerId);
      this.draw();
    });
    canvas.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) {
        const rect = canvas.getBoundingClientRect();
        canvas.style.cursor = this.cursorFor(e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      const p = this.toImage(e);
      if (d.mode === "move") this.moveTo(d, p);
      else this.resizeTo(d, p);
      this.draw();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      // A click without dragging outside the area selects everything again.
      if (d.mode === "new" && (this.crop.w < MIN_SIZE / this.box.scale || this.crop.h < MIN_SIZE / this.box.scale)) {
        this.crop = d.start.w ? d.start : this.full();
        if (!d.start.w) this.fitRatio();
      }
      this.draw();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  private moveTo(d: Drag, p: { x: number; y: number }): void {
    const { w: W, h: H } = this.size;
    this.crop = {
      ...d.start,
      x: clamp(d.start.x + p.x - d.px, 0, W - d.start.w),
      y: clamp(d.start.y + p.y - d.py, 0, H - d.start.h),
    };
  }

  /** Resizes from the dragged edges (or draws a new area), keeping the ratio when one is chosen. */
  private resizeTo(d: Drag, p: { x: number; y: number }): void {
    const { w: W, h: H } = this.size;
    const s = d.start;
    const r = this.wantedRatio();
    const min = MIN_SIZE / this.box.scale;
    const horizontal = d.edges.l || d.edges.r;
    const vertical = d.edges.t || d.edges.b;

    if (d.mode === "new" || (horizontal && vertical)) {
      // Corner: the opposite corner stays put.
      const ax = d.mode === "new" ? s.x : d.edges.l ? s.x + s.w : s.x;
      const ay = d.mode === "new" ? s.y : d.edges.t ? s.y + s.h : s.y;
      const dx = p.x >= ax ? 1 : -1;
      const dy = p.y >= ay ? 1 : -1;
      const roomW = dx > 0 ? W - ax : ax;
      const roomH = dy > 0 ? H - ay : ay;
      let w = Math.min(Math.abs(p.x - ax), roomW);
      let h = Math.min(Math.abs(p.y - ay), roomH);
      if (r) {
        if (w / Math.max(h, 1e-6) > r) w = h * r;
        else h = w / r;
        if (w > roomW) {
          w = roomW;
          h = w / r;
        }
        if (h > roomH) {
          h = roomH;
          w = h * r;
        }
      }
      if (d.mode !== "new") {
        w = Math.max(w, Math.min(min, roomW));
        h = Math.max(h, Math.min(min, roomH));
      }
      this.crop = { x: dx > 0 ? ax : ax - w, y: dy > 0 ? ay : ay - h, w, h };
      return;
    }

    if (horizontal) {
      const ax = d.edges.l ? s.x + s.w : s.x;
      const dx = d.edges.l ? -1 : 1;
      let w = clamp(dx > 0 ? p.x - ax : ax - p.x, min, dx > 0 ? W - ax : ax);
      let h = s.h;
      let y = s.y;
      if (r) {
        const cy = s.y + s.h / 2;
        const roomH = 2 * Math.min(cy, H - cy);
        h = w / r;
        if (h > roomH) {
          h = roomH;
          w = h * r;
        }
        y = cy - h / 2;
      }
      this.crop = { x: dx > 0 ? ax : ax - w, y, w, h };
      return;
    }

    const ay = d.edges.t ? s.y + s.h : s.y;
    const dy = d.edges.t ? -1 : 1;
    let h = clamp(dy > 0 ? p.y - ay : ay - p.y, min, dy > 0 ? H - ay : ay);
    let w = s.w;
    let x = s.x;
    if (r) {
      const cx = s.x + s.w / 2;
      const roomW = 2 * Math.min(cx, W - cx);
      w = h * r;
      if (w > roomW) {
        w = roomW;
        h = w / r;
      }
      x = cx - w / 2;
    }
    this.crop = { x, y: dy > 0 ? ay : ay - h, w, h };
  }

  // --- saving -----------------------------------------------------------------------------

  private async save(): Promise<void> {
    const entry = this.entry;
    if (!entry || this.busy) return;
    this.readOptions();
    const { w: W, h: H } = this.size;
    const c = this.crop;
    const whole = c.x <= 0.5 && c.y <= 0.5 && c.w >= W - 0.5 && c.h >= H - 0.5;
    const edit = {
      rotate: this.rotate,
      flip_h: this.flipH,
      flip_v: this.flipV,
      crop: whole ? null : [c.x / W, c.y / H, c.w / W, c.h / H],
      resize:
        settings.edResize === "long"
          ? { mode: "long", value: settings.edLong }
          : settings.edResize === "percent"
            ? { mode: "percent", value: settings.edPercent }
            : { mode: "none" },
      border: settings.edBorder,
      border_color: hexToRgb(settings.edBorderColor),
    };
    const mode = this.canOverwrite && this.radio("ed-save") === "overwrite" ? "overwrite" : "copy";
    this.busy = true;
    this.root.classList.add("busy");
    this.draw();
    try {
      const out = await invoke<Entry>("edit_save", { src: entry.path, edit, mode });
      this.busy = false;
      this.root.classList.remove("busy");
      this.close();
      showToast(t.edSaved(out.name), 3000);
      this.saved(out, mode === "overwrite");
    } catch (err) {
      this.busy = false;
      this.root.classList.remove("busy");
      this.draw();
      const code = String(err);
      const reason =
        code === "edit_format" ? t.edFormat : code.startsWith("other:") ? code.slice(6) : (t.failReason[code] ?? code);
      showToast(t.edFailed(reason), 5000);
    }
  }
}
