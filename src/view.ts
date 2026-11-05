const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

/** Zoom relative to "fit" and the image point under the stage centre (0..1), comparable across image sizes. */
export interface ViewState {
  fitted: boolean;
  factor: number;
  u: number;
  v: number;
}

/** Position, zoom, and rotation of the image inside the stage. */
export class View {
  width = 0;
  height = 0;
  scale = 1;
  rotation = 0;
  fitted = true;
  private tx = 0;
  private ty = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly img: HTMLImageElement,
  ) {}

  reset(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.rotation = 0;
    this.fit();
  }

  get loaded(): boolean {
    return this.width > 0 && this.height > 0;
  }

  private get turned(): boolean {
    return this.rotation % 180 !== 0;
  }

  private get box(): { w: number; h: number } {
    return this.turned ? { w: this.height, h: this.width } : { w: this.width, h: this.height };
  }

  private get stageSize(): { w: number; h: number } {
    return { w: this.stage.clientWidth, h: this.stage.clientHeight };
  }

  fitScale(): number {
    const { w, h } = this.box;
    const s = this.stageSize;
    if (!w || !h || !s.w || !s.h) return 1;
    return Math.min(s.w / w, s.h / h, 1);
  }

  /** True when the image is larger than the stage and can be panned. */
  get pannable(): boolean {
    const { w, h } = this.box;
    const s = this.stageSize;
    return w * this.scale > s.w + 0.5 || h * this.scale > s.h + 0.5;
  }

  fit(): void {
    this.fitted = true;
    this.scale = this.fitScale();
    this.tx = 0;
    this.ty = 0;
    this.apply();
  }

  /** Re-fit after a window resize when the image was fitted. */
  relayout(): void {
    if (this.fitted) this.fit();
    else this.apply();
  }

  zoomTo(scale: number, cx?: number, cy?: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const s = this.stageSize;
    const px = (cx ?? s.w / 2) - s.w / 2;
    const py = (cy ?? s.h / 2) - s.h / 2;
    const ratio = next / this.scale;
    this.tx = px - (px - this.tx) * ratio;
    this.ty = py - (py - this.ty) * ratio;
    this.scale = next;
    this.fitted = false;
    this.apply();
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    this.zoomTo(this.scale * factor, cx, cy);
  }

  /** Shows the image at `scale` with the pointer's place in the stage choosing the matching part of the image. */
  zoomHold(scale: number, cx: number, cy: number): void {
    const { w, h } = this.box;
    const s = this.stageSize;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    this.fitted = false;
    const px = s.w ? Math.min(1, Math.max(0, cx / s.w)) : 0.5;
    const py = s.h ? Math.min(1, Math.max(0, cy / s.h)) : 0.5;
    this.tx = Math.max(0, (w * this.scale - s.w) / 2) * (1 - 2 * px);
    this.ty = Math.max(0, (h * this.scale - s.h) / 2) * (1 - 2 * py);
    this.apply();
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  rotate(delta: number): void {
    this.rotation = (((this.rotation + delta) % 360) + 360) % 360;
    if (this.fitted) this.fit();
    else this.apply();
  }

  getState(): ViewState {
    const { w, h } = this.box;
    const s = this.scale || 1;
    return {
      fitted: this.fitted,
      factor: s / this.fitScale(),
      u: 0.5 - this.tx / (s * (w || 1)),
      v: 0.5 - this.ty / (s * (h || 1)),
    };
  }

  setState(state: ViewState): void {
    if (!this.loaded) return;
    if (state.fitted) {
      this.fit();
      return;
    }
    const { w, h } = this.box;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.factor * this.fitScale()));
    this.tx = -(state.u - 0.5) * w * this.scale;
    this.ty = -(state.v - 0.5) * h * this.scale;
    this.fitted = false;
    this.apply();
  }

  private clamp(): void {
    const { w, h } = this.box;
    const s = this.stageSize;
    const mx = Math.max(0, (w * this.scale - s.w) / 2);
    const my = Math.max(0, (h * this.scale - s.h) / 2);
    this.tx = Math.min(mx, Math.max(-mx, this.tx));
    this.ty = Math.min(my, Math.max(-my, this.ty));
  }

  private apply(): void {
    this.clamp();
    const s = this.stageSize;
    const x = s.w / 2 + this.tx - this.width / 2;
    const y = s.h / 2 + this.ty - this.height / 2;
    this.img.style.width = `${this.width}px`;
    this.img.style.height = `${this.height}px`;
    this.img.style.transform = `translate(${x}px, ${y}px) rotate(${this.rotation}deg) scale(${this.scale})`;
    this.img.classList.toggle("pixelated", this.scale >= 3);
    this.stage.classList.toggle("pannable", this.pannable);
  }
}
