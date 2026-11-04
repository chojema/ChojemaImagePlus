import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { $, isWindows, parentOf, samePath, showToast } from "./common";
import { errorText, t } from "./i18n";
import { ask } from "./modal";
import { saveSettings, settings } from "./settings";

export type TransferMode = "move" | "copy";
type Mode = TransferMode;
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

export interface Done {
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
  private last: { mode: Mode | "rename"; items: Done[] } | null = null;
  private busy = false;
  private readonly panel = $<HTMLElement>("progress");
  private readonly label = $<HTMLElement>("progress-label");
  private readonly fill = $<HTMLElement>("progress-fill");

  constructor(private readonly refresh: (relocated?: Done[]) => void) {
    $("progress-cancel").textContent = t.cancel;
    $("progress-cancel").addEventListener("click", () => void invoke("transfer_cancel"));
    void listen<Progress>("transfer-progress", (e) => {
      const p = e.payload;
      this.fill.style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
      this.label.textContent = p.name ? `${p.done + 1} / ${p.total} · ${p.name}` : "";
    });
  }

  async start(sources: string[], dest: string, requestedMode?: Mode): Promise<Done[]> {
    if (this.busy || !sources.length) return [];
    this.busy = true;
    try {
      return await this.perform(sources, dest, requestedMode);
    } finally {
      this.busy = false;
    }
  }

  async createFolder(parent: string): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      let name = t.newFolder;
      while (true) {
        const a = await ask({ title: t.newFolder, input: { label: t.entryName, value: name },
          choices: [{ id: "create", label: t.create, primary: true }, { id: "cancel", label: t.cancel }], cancel: "cancel" });
        if (a.choice === "cancel") return null;
        name = a.value;
        try {
          const path = await invoke<string>("create_folder", { parent, name });
          this.refresh();
          showToast(t.folderCreated);
          return path;
        } catch (err) { showToast(errorText(err), 4000); }
      }
    } finally { this.busy = false; }
  }

  async rename(path: string, folder: boolean): Promise<Done[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const plan = folder ? { pairs: [] } : await invoke<{ pairs: string[] }>("trash_plan", { sources: [path] });
      let name = baseName(path);
      while (true) {
        const dot = name.lastIndexOf(".");
        const a = await ask({ title: t.entryRename, message: path,
          input: { label: t.entryName, value: name, selectEnd: !folder && dot > 0 ? dot : name.length },
          checkbox: plan.pairs.length ? { label: t.includePairs(plan.pairs.length), checked: settings.includePairs } : undefined,
          choices: [{ id: "rename", label: t.rename, primary: true }, { id: "cancel", label: t.cancel }], cancel: "cancel" });
        if (a.choice === "cancel") return [];
        name = a.value;
        try {
          if (plan.pairs.length && a.checked !== settings.includePairs) saveSettings({ includePairs: a.checked });
          const result = await invoke<Outcome>("rename_entry", { path, name, includePairs: a.checked });
          if (result.done.length) {
            this.last = { mode: "rename", items: result.done };
            this.refresh(result.done);
            showToast(`${t.entryRenamed} · ${t.undoHint}`, 4000);
          }
          if (result.failed.length) await this.reportFailures(result.failed);
          return result.done;
        } catch (err) { showToast(errorText(err), 4000); }
      }
    } catch (err) { showToast(errorText(err)); return []; }
    finally { this.busy = false; }
  }

  async copyToClipboard(paths: string[], cut: boolean): Promise<void> {
    if (this.busy || !paths.length) return;
    try {
      await invoke("clipboard_write", { paths, cut });
      showToast(cut ? t.clipboardCutReady(paths.length) : t.clipboardCopied(paths.length), 3500);
    } catch (err) { showToast(errorText(err)); }
  }

  async paste(dest: string, forceMove = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const files = await invoke<{ paths: string[]; cut: boolean; token: string }>("clipboard_read");
      if (!files.paths.length) { showToast(errorText("clipboard_empty")); return; }
      const move = forceMove || files.cut;
      const done = await this.perform(files.paths, dest, move ? "move" : "copy");
      if (move && done.length) {
        await invoke("clipboard_consume", { token: files.token, moved: done.map((d) => d.from) });
      }
    } catch (err) { showToast(errorText(err)); }
    finally { this.busy = false; }
  }

  private async perform(sources: string[], dest: string, requestedMode?: Mode): Promise<Done[]> {
    let plan: Plan;
    try {
      plan = await invoke<Plan>("transfer_plan", { sources, dest, includePairs: true });
    } catch (err) {
      showToast(err === "protected_dest" ? t.protectedDest : errorText(err));
      return [];
    }
    if (plan.same_folder && requestedMode !== "copy") {
      showToast(t.sameFolder);
      return [];
    }
    if (requestedMode === "move" && plan.copy_only) {
      showToast(t.copyOnly);
      return [];
    }

    const images = plan.files.filter((f) => !f.pair).length;
    const answer = await ask({
      title: t.transferTitle(images, folderName(dest)),
      message: plan.copy_only ? `${dest}\n\n${t.copyOnly}` : dest,
      checkbox: plan.pairs ? { label: t.includePairs(plan.pairs), checked: settings.includePairs } : undefined,
      choices: requestedMode
        ? [
            { id: requestedMode, label: requestedMode === "move" ? t.move : t.copy, primary: true },
            { id: "cancel", label: t.cancel },
          ]
        : plan.copy_only
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
    if (answer.choice === "cancel") return [];
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
              ...(!group.some((f) => samePath(parentOf(f.src), dest)) ? [{ id: "overwrite", label: t.overwrite }] : []),
              { id: "skip", label: t.skip },
              { id: "cancel", label: t.cancelAll },
            ],
            cancel: "cancel",
          });
          if (a.choice === "cancel") return [];
          resolution = a.choice as Resolution;
          if (a.checked) forAll = resolution;
        }
      }
      for (const f of group) jobs.push({ src: f.src, group: f.group, resolution });
    }

    const timer = window.setTimeout(() => (this.panel.hidden = false), 300);
    let outcome: Outcome;
    try {
      outcome = await invoke<Outcome>("transfer_run", { mode, dest, jobs });
    } catch (err) {
      showToast(errorText(err));
      return [];
    } finally {
      clearTimeout(timer);
      this.panel.hidden = true;
    }

    if (outcome.done.length) this.last = { mode, items: outcome.done };
    this.refresh(mode === "move" ? outcome.done : undefined);
    const parts = [mode === "move" ? t.moved(outcome.done.length) : t.copied(outcome.done.length)];
    if (outcome.skipped) parts.push(t.skipped(outcome.skipped));
    if (outcome.overwritten) parts.push(t.overwrittenToTrash(outcome.overwritten));
    if (outcome.cancelled) parts.push(t.cancelledRest);
    if (outcome.done.length) parts.push(t.undoHint);
    showToast(parts.join(" · "), 4000);
    if (outcome.failed.length) await this.reportFailures(outcome.failed);
    return outcome.done;
  }

  /** Sends images (and, if chosen, their pair files) to the trash. Resolves with the images trashed. */
  async trash(paths: string[]): Promise<string[]> {
    if (this.busy || !paths.length) return [];
    const plan = await invoke<{ pairs: string[] }>("trash_plan", { sources: paths });
    const answer = await ask({
      title: t.trashTitle(paths.length),
      message: paths.length === 1 ? `${baseName(paths[0])}\n\n${t.trashMessage}` : t.trashMessage,
      checkbox: plan.pairs.length ? { label: t.includePairs(plan.pairs.length), checked: settings.includePairs } : undefined,
      choices: [
        { id: "trash", label: t.toTrash, primary: true },
        { id: "cancel", label: t.cancel },
      ],
      cancel: "cancel",
    });
    if (answer.choice !== "trash") return [];
    if (plan.pairs.length && answer.checked !== settings.includePairs) saveSettings({ includePairs: answer.checked });
    const targets = plan.pairs.length && answer.checked ? [...paths, ...plan.pairs] : paths;
    this.busy = true;
    let outcome: Outcome;
    try {
      outcome = await invoke<Outcome>("trash_files", { paths: targets });
    } finally {
      this.busy = false;
    }
    const trashed = new Set(outcome.done.map((d) => d.from));
    const images = paths.filter((p) => trashed.has(p));
    if (outcome.done.length) showToast(t.trashed(outcome.done.length));
    this.refresh();
    if (outcome.failed.length) await this.reportFailures(outcome.failed);
    return images;
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
      const outcome = await invoke<Outcome>(last.mode === "rename" ? "rename_undo" : "transfer_undo", { mode: last.mode, items: last.items });
      this.refresh(last.mode !== "copy" ? outcome.done : undefined);
      showToast(t.undone(outcome.done.length));
      if (outcome.failed.length) await this.reportFailures(outcome.failed);
    } catch (err) {
      showToast(errorText(err));
    } finally {
      this.busy = false;
    }
  }

  async reportFailures(failed: { src: string; error: string }[]): Promise<void> {
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
