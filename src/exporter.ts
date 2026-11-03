import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { $, isWindows, showToast } from "./common";
import { errorText, t } from "./i18n";
import { ask } from "./modal";
import { saveSettings, settings, Settings } from "./settings";

type Resolution = "skip" | "overwrite" | "rename";

interface Planned {
  src: string;
  name: string;
  exists: boolean;
  same: boolean;
}

interface Outcome {
  done: string[];
  skipped: number;
  failed: { src: string; error: string }[];
  cancelled: boolean;
}

const QUALITY_FORMATS = new Set(["jpeg", "webp", "avif", "heic"]);
const NO_ALPHA = new Set(["jpeg", "bmp"]);

function join(dir: string, name: string): string {
  const sep = isWindows ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

function base(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

const EXT: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", heic: "heic", tiff: "tif", bmp: "bmp" };

/** "Export to another format": options dialog, conflict prompts, progress. */
export class Exporter {
  private readonly root = $("ex-dialog");
  private custom = "";
  private sources: string[] = [];
  private folder = "";
  private otherPane: string | null = null;
  private resolve: ((go: boolean) => void) | null = null;
  private busy = false;

  constructor(
    private readonly report: (failed: { src: string; error: string }[]) => Promise<void>,
    private readonly refresh: () => void,
  ) {
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-t]")) {
      el.textContent = String((t as Record<string, unknown>)[el.dataset.t!] ?? "");
    }
    $("ex-cancel").textContent = t.cancel;
    $("ex-start").textContent = t.exStart;
    if (isWindows) $<HTMLOptionElement>("ex-format").querySelector('option[value="heic"]')?.setAttribute("disabled", "");
    this.root.addEventListener("input", () => this.update());
    this.root.addEventListener("change", () => this.update());
    $("ex-custom").addEventListener("click", async () => {
      const picked = await open({ multiple: false, directory: true, defaultPath: this.custom || this.folder || undefined });
      if (typeof picked === "string") {
        this.custom = picked;
        this.pick("ex-dest", "custom");
        this.update();
      }
    });
    $("ex-cancel").addEventListener("click", () => this.finish(false));
    $("ex-start").addEventListener("click", () => this.finish(true));
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.finish(false);
      if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "radio") this.finish(true);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private radio(name: string): string {
    return this.root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "";
  }

  private pick(name: string, value: string): void {
    for (const r of this.root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) r.checked = r.value === value;
  }

  private destination(): string | null {
    switch (this.radio("ex-dest")) {
      case "same":
        return this.folder;
      case "pane":
        return this.otherPane;
      case "custom":
        return this.custom || null;
      default: {
        const name = $<HTMLInputElement>("ex-subname").value.trim().replace(/[\\/:*?"<>|]/g, "") || "Export";
        return join(this.folder, name);
      }
    }
  }

  private update(): void {
    const format = $<HTMLSelectElement>("ex-format").value;
    const quality = $<HTMLInputElement>("ex-quality");
    $("ex-quality-row").hidden = !QUALITY_FORMATS.has(format);
    $("ex-quality-value").textContent = quality.value;
    $("ex-bg-row").hidden = !NO_ALPHA.has(format);
    const noMeta = format === "bmp";
    for (const r of this.root.querySelectorAll<HTMLInputElement>('input[name="ex-meta"]')) r.disabled = noMeta;
    const note = $("ex-format-note");
    note.textContent = noMeta ? t.exNoMeta : format === "heic" && isWindows ? t.exHeicMac : format === "avif" ? t.exAvifSlow : "";
    note.hidden = !note.textContent;
    $("ex-custom").textContent = this.custom ? base(this.custom) : t.exChoose;
    $("ex-custom").title = this.custom;
    $("ex-dest-pane").hidden = !this.otherPane;
    const dest = this.destination();
    const first = this.sources[0];
    const suffix = $<HTMLInputElement>("ex-suffix").value;
    $("ex-preview").textContent = first && dest ? t.exPreview(`${stem(base(first))}${suffix}.${EXT[format]}`, dest) : "";
    $<HTMLButtonElement>("ex-start").disabled = !dest || (format === "heic" && isWindows);
  }

  /** Opens the dialog for `sources` from `folder`; `otherPane` is the dual-pane destination, if any. */
  async start(sources: string[], folder: string, otherPane: string | null): Promise<void> {
    if (this.busy) return;
    if (!sources.length) {
      showToast(t.exNeed);
      return;
    }
    this.sources = sources;
    this.folder = folder;
    this.otherPane = otherPane;
    this.custom = settings.exCustom;
    $("ex-title").textContent = t.exTitle(sources.length);
    $<HTMLSelectElement>("ex-format").value = isWindows && settings.exFormat === "heic" ? "jpeg" : settings.exFormat;
    $<HTMLInputElement>("ex-quality").value = String(settings.exQuality);
    this.pick("ex-resize", settings.exResize);
    $<HTMLInputElement>("ex-long").value = String(settings.exLong);
    $<HTMLInputElement>("ex-percent").value = String(settings.exPercent);
    this.pick("ex-meta", settings.exMeta);
    $<HTMLInputElement>("ex-background").value = settings.exBackground;
    this.pick("ex-dest", settings.exDest === "pane" && !otherPane ? "sub" : settings.exDest);
    $<HTMLInputElement>("ex-subname").value = settings.exSubName;
    $<HTMLInputElement>("ex-suffix").value = settings.exSuffix;
    this.update();
    this.root.hidden = false;
    $("ex-start").focus();
    const go = await new Promise<boolean>((resolve) => (this.resolve = resolve));
    if (go) await this.run();
  }

  private finish(go: boolean): void {
    if (go && $<HTMLButtonElement>("ex-start").disabled) return;
    this.root.hidden = true;
    this.resolve?.(go);
    this.resolve = null;
  }

  private async run(): Promise<void> {
    const dest = this.destination();
    if (!dest) {
      showToast(t.exNoPane);
      return;
    }
    const num = (id: string, min: number, max: number, fallback: number) =>
      Math.min(max, Math.max(min, Math.round(Number($<HTMLInputElement>(id).value) || fallback)));
    const format = $<HTMLSelectElement>("ex-format").value;
    const resizeMode = (this.radio("ex-resize") || "none") as Settings["exResize"];
    const saved: Partial<Settings> = {
      exFormat: format,
      exQuality: num("ex-quality", 1, 100, 90),
      exResize: resizeMode,
      exLong: num("ex-long", 16, 20000, 1920),
      exPercent: num("ex-percent", 1, 1000, 50),
      exMeta: (this.radio("ex-meta") || "keep") as Settings["exMeta"],
      exBackground: $<HTMLInputElement>("ex-background").value,
      exDest: (this.radio("ex-dest") || "sub") as Settings["exDest"],
      exSubName: $<HTMLInputElement>("ex-subname").value.trim() || "Export",
      exCustom: this.custom,
      exSuffix: $<HTMLInputElement>("ex-suffix").value,
    };
    saveSettings(saved);
    const hex = settings.exBackground.replace("#", "");
    const background = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
    const options = {
      format,
      quality: settings.exQuality,
      resize:
        resizeMode === "long"
          ? { mode: "long", value: settings.exLong }
          : resizeMode === "percent"
            ? { mode: "percent", value: settings.exPercent }
            : { mode: "none" },
      metadata: settings.exMeta,
      background,
      suffix: settings.exSuffix,
    };

    let plan: Planned[];
    try {
      plan = await invoke<Planned[]>("export_plan", { sources: this.sources, dest, options });
    } catch (err) {
      showToast(err === "protected_dest" ? t.protectedDest : err === "heic_unsupported" ? t.exHeicMac : errorText(err));
      return;
    }

    const jobs: { src: string; resolution: Resolution | null }[] = [];
    const conflicts = plan.filter((p) => p.exists && !p.same).length;
    let forAll: Resolution | null = null;
    let seen = 0;
    for (const p of plan) {
      // Never replace the source itself: such exports get a new name.
      if (p.same) {
        jobs.push({ src: p.src, resolution: "rename" });
        continue;
      }
      if (!p.exists) {
        jobs.push({ src: p.src, resolution: null });
        continue;
      }
      seen++;
      let resolution: Resolution | null = forAll;
      if (!resolution) {
        const remaining = conflicts - seen;
        const a = await ask({
          title: t.conflictTitle(p.name),
          message: t.conflictMessage(base(dest)),
          checkbox: remaining > 0 ? { label: t.applyToRest(remaining), checked: false } : undefined,
          choices: [
            { id: "rename", label: t.keepBoth, primary: true },
            { id: "overwrite", label: t.overwrite },
            { id: "skip", label: t.skip },
            { id: "cancel", label: t.cancelAll },
          ],
          cancel: "cancel",
        });
        if (a.choice === "cancel") return;
        resolution = a.choice as Resolution;
        if (a.checked) forAll = resolution;
      }
      jobs.push({ src: p.src, resolution });
    }

    this.busy = true;
    const panel = $("progress");
    const timer = window.setTimeout(() => (panel.hidden = false), 300);
    let outcome: Outcome;
    try {
      outcome = await invoke<Outcome>("export_run", { dest, options, jobs });
    } catch (err) {
      showToast(errorText(err));
      return;
    } finally {
      clearTimeout(timer);
      panel.hidden = true;
      this.busy = false;
    }
    this.refresh();
    const parts = [t.exDone(outcome.done.length)];
    if (outcome.skipped) parts.push(t.skipped(outcome.skipped));
    if (outcome.cancelled) parts.push(t.cancelledRest);
    showToast(parts.join(" · "), 3000);
    if (outcome.failed.length) await this.report(outcome.failed);
  }
}
