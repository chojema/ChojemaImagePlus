import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import icon from "../src-tauri/icons/128x128@2x.png";
import { $ } from "./common";
import { t } from "./i18n";

/** The About window: version, copyright, and links to the project pages. */
export class AboutDialog {
  private readonly root = $("about");

  constructor() {
    $<HTMLImageElement>("about-icon").src = icon;
    $("about-description").textContent = t.aboutDescription;
    $("about-license").textContent = t.aboutLicense;
    $("about-close").textContent = t.close;
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-t]")) {
      el.textContent = String((t as Record<string, unknown>)[el.dataset.t!] ?? "");
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-link]")) {
      button.title = button.dataset.link!;
      button.addEventListener("click", () => void invoke("open_link", { url: button.dataset.link }));
    }
    $("about-close").addEventListener("click", () => this.close());
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    void getVersion().then((v) => ($("about-version").textContent = t.aboutVersion(v)));
    void invoke("set_about_label", { label: t.aboutMenu });
    void listen("show-about", () => this.open());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    $("about-close").focus();
  }

  close(): void {
    this.root.hidden = true;
  }
}
