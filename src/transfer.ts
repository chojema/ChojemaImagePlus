import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { $, isWindows, showToast } from "./common";
import { errorText, t } from "./i18n";
import { ask } from "./modal";
import { saveSettings, settings } from "./settings";

type Mode = "move" | "copy";
type Resolution = "skip" | "overwrite" | "rename";

interface PlannedFile {
  src: string;
  name: string;
  pair: boolean;
  exists: boolean;
  group: number;
}

interface Plan {
  files: PlannedFile[];
  pairs: number;
  same_folder: boolean;
  copy_only: boolean;
}

interface Done {
  from: string;
  to: string;
}

interface Outcome {
  done: Done[];
  skipped: number;
  failed: { src: string; error: string }[];
  overwritten: number;
  cancelled: boolean;
}

interface Progress {
  done: number;
  total: number;
  name: string;
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Moving and copying images (and their pair files) between folders, with conflict prompts and undo. */
export class Transfer {
  private last: { mode: Mode; items: Done[] } | null = null;
  private busy = false;
  private readonly panel = $<HTMLElement>("progress");
  private readonly label = $<HTMLElement>("progress-label");
  private readonly fill = $<HTMLElement>("progress-fill");

  constructor(private readonly refresh: () => void) {
    $("progress-cancel").textContent = t.cancel;
    $("progress-cancel").addEventListener("click", () => void invoke("transfer_cancel"));
    void listen<Progress>("transfer-progress", (e) => {
      const p = e.payload;
      this.fill.style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
      this.label.textContent = p.name ? `${p.done + 1} / ${p.total} · ${p.name}` : "";
    });
  }

  async start(sources: string[], dest: string): Promise<void> {
    if (this.busy || !sources.length) return;
    let plan: Plan;
    try {
      plan = await invoke<Plan>("transfer_plan", { sources, dest, includePairs: true });
    } catch (err) {
      showToast(err === "protected_dest" ? t.protectedDest : errorText(err));
      return;
    }
    if (plan.same_folder) {
      showToast(t.sameFolder);
      return;
    }

    const images = plan.files.filter((f) => !f.pair).length;
    const answer = await ask({
      title: t.transferTitle(images, folderName(dest)),
      message: plan.copy_only ? `${dest}\n\n${t.copyOnly}` : dest,
      checkbox: plan.pairs ? { label: t.includePairs(plan.pairs), checked: settings.includePairs } : undefined,
      choices: plan.copy_only
        ? [
            { id: "copy", label: t.copy, primary: true },
            { id: "cancel", label: t.cancel },
          ]
        : [
            { id: "move", label: t.move, primary: true },
            { id: "copy", label: t.copy },
            { id: "cancel", label: t.cancel },
          ],
      cancel: "cancel",
    });
    if (answer.choice === "cancel") return;
    const mode = answer.choice as Mode;
    if (plan.pairs && answer.checked !== settings.includePairs) saveSettings({ includePairs: answer.checked });
    const files = plan.files.filter((f) => !f.pair || (plan.pairs > 0 && answer.checked));

    // An image and its pair files are resolved together so their names stay matched.
    const groups = new Map<number, PlannedFile[]>();
    for (const f of files) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
    const conflicting = [...groups.values()].filter((g) => g.some((f) => f.exists));
    const jobs: { src: string; group: number; resolution: Resolution | null }[] = [];
    let forAll: Resolution | null = null;
    let seen = 0;
    for (const group of groups.values()) {
      let resolution: Resolution | null = null;
      if (group.some((f) => f.exists)) {
        seen++;
        resolution = forAll;
        if (!resolution) {
          const main = group.find((f) => !f.pair) ?? group[0];
          const name = group.find((f) => f.exists && !f.pair)?.name ?? group.find((f) => f.exists)!.name;
          const remaining = conflicting.length - seen;
          const a = await ask({
            title: t.conflictTitle(name),
            message: t.conflictMessage(folderName(dest)) + (group.length > 1 ? `\n${t.conflictGroup(main.name, group.length - 1)}` : ""),
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
      }
      for (const f of group) jobs.push({ src: f.src, group: f.group, resolution });
    }

    this.busy = true;
    const timer = window.setTimeout(() => (this.panel.hidden = false), 300);
    let outcome: Outcome;
    try {
      outcome = await invoke<Outcome>("transfer_run", { mode, dest, jobs });
    } catch (err) {
      showToast(errorText(err));
      return;
    } finally {
      clearTimeout(timer);
      this.panel.hidden = true;
      this.busy = false;
    }

    if (outcome.done.length) this.last = { mode, items: outcome.done };
    this.refresh();
    const parts = [mode === "move" ? t.moved(outcome.done.length) : t.copied(outcome.done.length)];
    if (outcome.skipped) parts.push(t.skipped(outcome.skipped));
    if (outcome.overwritten) parts.push(t.overwrittenToTrash(outcome.overwritten));
    if (outcome.cancelled) parts.push(t.cancelledRest);
    if (outcome.done.length) parts.push(t.undoHint);
    showToast(parts.join(" · "), 4000);
    if (outcome.failed.length) await this.reportFailures(outcome.failed);
  }

  async undo(): Promise<void> {
    if (this.busy) return;
    const last = this.last;
    if (!last) {
      showToast(t.nothingToUndo);
      return;
    }
    this.last = null;
    this.busy = true;
    try {
      const outcome = await invoke<Outcome>("transfer_undo", { mode: last.mode, items: last.items });
      this.refresh();
      showToast(t.undone(outcome.done.length));
      if (outcome.failed.length) await this.reportFailures(outcome.failed);
    } finally {
      this.busy = false;
    }
  }

  private async reportFailures(failed: { src: string; error: string }[]): Promise<void> {
    const describe = (code: string) => {
      if (code.startsWith("other:")) return code.slice(6);
      return t.failReason[code] ?? code;
    };
    const lines = failed.slice(0, 5).map((f) => `${baseName(f.src)}: ${describe(f.error)}`);
    if (failed.length > 5) lines.push(t.andMore(failed.length - 5));
    const permission = failed.some((f) => f.error === "permission");
    if (permission) lines.push("", isWindows ? t.permissionHintWindows : t.permissionHintMac);
    const a = await ask({
      title: t.failedTitle(failed.length),
      message: lines.join("\n"),
      choices: [
        ...(permission ? [{ id: "settings", label: t.openPrivacy }] : []),
        { id: "ok", label: t.close, primary: true },
      ],
      cancel: "ok",
    });
    if (a.choice === "settings") void invoke("open_privacy_settings");
  }
}
