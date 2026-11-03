import { invoke } from "@tauri-apps/api/core";
import { $, showToast } from "./common";
import { t } from "./i18n";

export type SortKey = "name" | "date" | "size";

export interface Settings {
  startup: "last" | "empty";
  sort: SortKey;
  sortDesc: boolean;
  thumbSize: number;
  sidebarWidth: number;
  includePairs: boolean;
  dual: boolean;
  dualVertical: boolean;
  dualFolder: string;
}

const defaults: Settings = {
  startup: "last",
  sort: "name",
  sortDesc: false,
  thumbSize: 160,
  sidebarWidth: 260,
  includePairs: true,
  dual: false,
  dualVertical: false,
  dualFolder: "",
};

export const settings: Settings = { ...defaults };

export async function loadSettings(): Promise<void> {
  const stored = await invoke<Partial<Settings>>("settings_get");
  Object.assign(settings, defaults, stored);
}

export function saveSettings(changes: Partial<Settings>): void {
  Object.assign(settings, changes);
  void invoke("settings_set", { values: changes });
}

/** The settings dialog. */
export class SettingsDialog {
  private readonly root = $("settings");

  constructor() {
    $("settings-title").textContent = t.settings;
    $("startup-legend").textContent = t.startup;
    $("startup-last").textContent = t.startupLast;
    $("startup-empty").textContent = t.startupEmpty;
    $("cache-legend").textContent = t.cache;
    $("clear-cache").textContent = t.clearCache;
    $("settings-close").textContent = t.close;

    for (const radio of this.root.querySelectorAll<HTMLInputElement>('input[name="startup"]')) {
      radio.addEventListener("change", () => {
        if (radio.checked) saveSettings({ startup: radio.value as Settings["startup"] });
      });
    }
    $("clear-cache").addEventListener("click", async () => {
      await invoke("thumbs_clear");
      showToast(t.cacheCleared);
    });
    $("settings-close").addEventListener("click", () => this.close());
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    for (const radio of this.root.querySelectorAll<HTMLInputElement>('input[name="startup"]')) {
      radio.checked = radio.value === settings.startup;
    }
    this.root.hidden = false;
    $("settings-close").focus();
  }

  close(): void {
    this.root.hidden = true;
  }
}
