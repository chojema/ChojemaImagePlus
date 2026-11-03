import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Entry {
  path: string;
  name: string;
  size: number;
  modified: number;
}

export const isWindows = navigator.userAgent.includes("Windows");

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function normalize(p: string): string {
  return isWindows ? p.replace(/\//g, "\\").toLowerCase() : p;
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalize(a) === normalize(b);
}

/** True when `child` is `parent` itself or lies inside it. */
export function within(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  if (c === p) return true;
  if (!c.startsWith(p)) return false;
  return /[\\/]$/.test(p) || /[\\/]/.test(c.charAt(p.length));
}

export function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return null;
  const parent = trimmed.slice(0, i);
  if (parent === "") return "/";
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 || n >= 100 ? 0 : 1)} ${units[u]}`;
}

const toast = () => document.getElementById("toast")!;
let toastTimer = 0;
export function showToast(text: string, ms = 1600): void {
  const el = toast();
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}

export function isFullscreen(): boolean {
  return document.body.classList.contains("fullscreen");
}

export async function toggleFullscreen(force?: boolean): Promise<void> {
  const win = getCurrentWindow();
  const next = force ?? !(await win.isFullscreen());
  await win.setFullscreen(next);
  document.body.classList.toggle("fullscreen", next);
}

// Title updates are chained so quick successive changes cannot arrive out of order.
let titleChain: Promise<void> = Promise.resolve();
export function setWindowTitle(text: string): void {
  titleChain = titleChain.then(() => getCurrentWindow().setTitle(text)).catch(() => {});
}
