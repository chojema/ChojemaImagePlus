import { invoke } from "@tauri-apps/api/core";
import { $, Entry, formatSize } from "./common";
import { t } from "./i18n";

interface PhotoInfo {
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  captured_at: string | null;
  captured_offset: string | null;
  exposure_seconds: number | null;
  aperture: number | null;
  iso: number | null;
  focal_mm: number | null;
  focal_35mm: number | null;
  exposure_bias: number | null;
  flash_fired: boolean | null;
  white_balance: number | null;
  artist: string | null;
  copyright: string | null;
  location: { latitude: number; longitude: number; altitude: number | null } | null;
}

interface Request {
  entry: Entry;
  key: string;
  token: number;
  session: number;
}

const keyOf = (entry: Entry) => JSON.stringify([entry.path, entry.modified, entry.size]);
const decimal = (value: number, places = 1) => Number(value.toFixed(places)).toLocaleString(undefined, { maximumFractionDigits: places });

function exposure(seconds: number): string {
  const denominator = Math.round(1 / seconds);
  if (seconds < 1 && Math.abs(denominator * seconds - 1) < 0.005) return `1/${denominator} s`;
  return `${decimal(seconds, 4)} s`;
}

/** Local metadata panel with coalesced reads, bounded concurrency and a small session cache. */
export class PhotoDetails {
  private readonly root = $("photo-details");
  private readonly content = $("photo-details-content");
  private readonly button = $("photo-details-button");
  private readonly cache = new Map<string, PhotoInfo>();
  private readonly reading = new Set<string>();
  private entry: Entry | undefined;
  private info: PhotoInfo | undefined;
  private pending: Request | null = null;
  private token = 0;
  private session = 0;
  private timer = 0;
  private visible = true;
  private failed = false;
  private width = 0;
  private height = 0;

  constructor() {
    $("photo-details-title").textContent = t.photoInfoTitle;
    const close = $("photo-details-close");
    close.title = t.photoInfoClose;
    close.setAttribute("aria-label", t.photoInfoClose);
    close.addEventListener("click", () => this.setVisible(false));
    this.button.setAttribute("aria-expanded", "true");
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
    this.button.setAttribute("aria-expanded", String(visible));
    if (visible) {
      this.render();
      if (this.entry && !this.info) this.queue();
    } else {
      clearTimeout(this.timer);
      this.timer = 0;
      this.pending = null;
      if (this.root.contains(document.activeElement)) this.button.focus({ preventScroll: true });
    }
  }

  show(entry: Entry): void {
    this.entry = entry;
    this.token++;
    this.width = this.height = 0;
    this.failed = false;
    this.info = this.cache.get(keyOf(entry));
    this.pending = null;
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.visible) {
      this.render();
      if (!this.info) this.queue();
    }
  }

  dimensions(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const value = this.content.querySelector<HTMLElement>('[data-field="dimensions"]');
    if (value) value.textContent = `${width} × ${height} px`;
  }

  clear(): void {
    this.token++;
    this.session++;
    this.entry = undefined;
    this.info = undefined;
    this.pending = null;
    this.cache.clear();
    this.content.replaceChildren();
    clearTimeout(this.timer);
    this.timer = 0;
  }

  private queue(): void {
    if (!this.entry || !this.visible) return;
    clearTimeout(this.timer);
    this.pending = { entry: this.entry, key: keyOf(this.entry), token: this.token, session: this.session };
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.pump();
    }, 80);
  }

  private pump(): void {
    const request = this.pending;
    if (!request || this.timer || this.reading.size >= 2 || this.reading.has(request.key)) return;
    this.pending = null;
    const cached = this.cache.get(request.key);
    if (cached) {
      this.info = cached;
      this.render();
      return;
    }
    this.reading.add(request.key);
    void invoke<PhotoInfo>("photo_info", { path: request.entry.path }).then((info) => {
      if (request.session !== this.session) return;
      this.cache.set(request.key, info);
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      if (request.token !== this.token || !this.entry) return;
      this.info = info;
      this.failed = false;
      if (this.visible) this.render();
    }).catch(() => {
      if (request.session !== this.session || request.token !== this.token) return;
      this.failed = true;
      if (this.visible) this.render();
    }).finally(() => {
      this.reading.delete(request.key);
      this.pump();
    });
  }

  private section(title: string, rows: [string, string | number | null | undefined, string?][], empty?: string): HTMLElement {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("dl");
    for (const [name, value, field] of rows) {
      if (value === null || value === undefined || value === "") continue;
      const term = document.createElement("dt");
      term.textContent = name;
      const detail = document.createElement("dd");
      detail.textContent = String(value);
      if (field) detail.dataset.field = field;
      list.append(term, detail);
    }
    section.append(heading, list);
    if (!list.children.length && empty) {
      const message = document.createElement("p");
      message.className = "photo-details-empty";
      message.textContent = empty;
      section.append(message);
    }
    return section;
  }

  private render(): void {
    const entry = this.entry;
    this.content.replaceChildren();
    if (!entry) return;
    const l = t.photoLabels;
    this.content.append(this.section(t.photoInfoFile, [
      [l.name, entry.name],
      [l.path, entry.path],
      [l.format, entry.name.split(".").pop()?.toUpperCase()],
      [l.dimensions, this.width && this.height ? `${this.width} × ${this.height} px` : "—", "dimensions"],
      [l.size, formatSize(entry.size)],
      [l.modified, entry.modified ? new Date(entry.modified).toLocaleString() : undefined],
    ]));
    const info = this.info;
    if (!info) {
      const status = document.createElement("p");
      status.className = "photo-details-status";
      status.setAttribute("role", "status");
      status.textContent = this.failed ? t.photoInfoError : t.photoInfoLoading;
      this.content.append(status);
      if (this.failed) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = t.photoInfoRetry;
        retry.addEventListener("click", () => {
          this.failed = false;
          this.render();
          this.queue();
        });
        this.content.append(retry);
      }
      return;
    }
    const make = info.camera_make ?? "";
    const model = info.camera_model ?? "";
    const camera = model.toLocaleLowerCase().startsWith(make.toLocaleLowerCase()) ? model : [make, model].filter(Boolean).join(" ");
    const date = info.captured_at?.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3 ");
    const offset = /^[+-]\d{2}:\d{2}$/.test(info.captured_offset ?? "") ? info.captured_offset : "";
    this.content.append(this.section(t.photoInfoCapture, [
      [l.captured, date ? `${date}${offset ? ` (${offset})` : ""}` : undefined],
      [l.camera, camera],
      [l.lens, info.lens],
      [l.exposure, info.exposure_seconds ? exposure(info.exposure_seconds) : undefined],
      [l.aperture, info.aperture ? `ƒ/${decimal(info.aperture, 2)}` : undefined],
      [l.iso, info.iso],
      [l.focal, info.focal_mm ? `${decimal(info.focal_mm)} mm` : undefined],
      [l.focal35, info.focal_35mm ? `${info.focal_35mm} mm` : undefined],
      [l.bias, info.exposure_bias != null ? `${info.exposure_bias > 0 ? "+" : ""}${decimal(info.exposure_bias, 2)} EV` : undefined],
      [l.flash, info.flash_fired == null ? undefined : info.flash_fired ? t.photoFlashFired : t.photoFlashNotFired],
      [l.whiteBalance, info.white_balance === 0 ? t.photoAuto : info.white_balance === 1 ? t.photoManual : undefined],
      [l.artist, info.artist],
      [l.copyright, info.copyright],
    ], t.photoInfoEmpty));
    const gps = info.location;
    this.content.append(this.section(t.photoInfoLocation, gps ? [
      [l.latitude, `${Math.abs(gps.latitude).toFixed(6)}° ${gps.latitude < 0 ? "S" : "N"}`],
      [l.longitude, `${Math.abs(gps.longitude).toFixed(6)}° ${gps.longitude < 0 ? "W" : "E"}`],
      [l.altitude, gps.altitude != null ? `${decimal(gps.altitude)} m` : undefined],
    ] : [], t.photoLocationEmpty));
  }
}
