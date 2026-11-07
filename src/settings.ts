import { invoke } from "@tauri-apps/api/core";
import { $, showToast } from "./common";
import { currentLanguage, Language, LANGUAGE_KEY, resolveLanguage, t } from "./i18n";

export type SortKey = "name" | "date" | "size";

export interface Settings {
  language: Language;
  startup: "last" | "empty";
  sort: SortKey;
  sortDesc: boolean;
  thumbSize: number;
  sidebarWidth: number;
  includePairs: boolean;
  mainFolder: string | null;
  dual: boolean;
  dualVertical: boolean;
  dualFolder: string;
  ssRecursive: boolean;
  ssOrder: "name" | "random";
  ssSmall: "original" | "enlarge";
  ssLarge: "shrink" | "original";
  ssInterval: number;
  ssClock: boolean;
  ssName: boolean;
  ssIndex: boolean;
  ssLoop: boolean;
  ssFullscreen: boolean;
  exFormat: string;
  exQuality: number;
  exResize: "none" | "long" | "percent";
  exLong: number;
  exPercent: number;
  exMeta: "keep" | "strip_gps" | "strip";
  exBackground: string;
  exDest: "same" | "sub" | "pane" | "custom";
  exSubName: string;
  exCustom: string;
  exSuffix: string;
  edRatio: string;
  edResize: "none" | "long" | "percent";
  edLong: number;
  edPercent: number;
  edBorder: number;
  edBorderColor: string;
  edSave: "copy" | "overwrite";
}

const defaults: Settings = {
  language: "system",
  startup: "last",
  sort: "name",
  sortDesc: false,
  thumbSize: 160,
  sidebarWidth: 260,
  includePairs: true,
  // null identifies preferences from before per-pane folder restoration.
  mainFolder: null,
  dual: false,
  dualVertical: false,
  dualFolder: "",
  ssRecursive: false,
  ssOrder: "name",
  ssSmall: "original",
  ssLarge: "shrink",
  ssInterval: 5,
  ssClock: true,
  ssName: true,
  ssIndex: false,
  ssLoop: true,
  ssFullscreen: true,
  exFormat: "jpeg",
  exQuality: 90,
  exResize: "none",
  exLong: 1920,
  exPercent: 50,
  exMeta: "keep",
  exBackground: "#ffffff",
  exDest: "sub",
  exSubName: "Export",
  exCustom: "",
  exSuffix: "",
  edRatio: "free",
  edResize: "none",
  edLong: 1920,
  edPercent: 50,
  edBorder: 0,
  edBorderColor: "#ffffff",
  edSave: "copy",
};

export const settings: Settings = { ...defaults };

export async function loadSettings(): Promise<void> {
  const stored = await invoke<Partial<Settings>>("settings_get");
  Object.assign(settings, defaults, stored);
}

/** Mirrors the language choice for the next start; true when the interface must be redrawn. */
export function syncLanguage(choice: Language): boolean {
  try {
    if (choice === "system") localStorage.removeItem(LANGUAGE_KEY);
    else localStorage.setItem(LANGUAGE_KEY, choice);
  } catch {
    return false;
  }
  return resolveLanguage(choice) !== currentLanguage;
}

export function saveSettings(changes: Partial<Settings>): void {
  Object.assign(settings, changes);
  void invoke("settings_set", { values: changes });
}

/** The settings dialog. */
export class SettingsDialog {
  private readonly root = $("settings");

  constructor(private readonly onLanguage: (choice: Language) => void) {
    $("settings-title").textContent = t.settings;
    $("language-legend").textContent = t.language;
    $("language-system").textContent = t.languageSystem;
    for (const radio of this.root.querySelectorAll<HTMLInputElement>('input[name="language"]')) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        saveSettings({ language: radio.value as Language });
        this.onLanguage(radio.value as Language);
      });
    }
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
    for (const radio of this.root.querySelectorAll<HTMLInputElement>('input[name="language"]')) {
      radio.checked = radio.value === settings.language;
    }
    this.root.hidden = false;
    $("settings-close").focus();
  }

  close(): void {
    this.root.hidden = true;
  }
}
