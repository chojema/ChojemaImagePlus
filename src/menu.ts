export type MenuItem = { label: string; run: () => void; disabled?: boolean; danger?: boolean } | "separator";

let current: HTMLElement | null = null;

export function closeMenu(): void {
  current?.remove();
  current = null;
}

export function menuOpen(): boolean {
  return current !== null;
}

/** A right-click menu at the pointer position. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item === "separator") {
      menu.append(document.createElement("hr"));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.disabled = !!item.disabled;
    button.setAttribute("role", "menuitem");
    if (item.danger) button.classList.add("danger");
    button.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menu.append(button);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
  current = menu;
}

document.addEventListener(
  "pointerdown",
  (e) => {
    if (current && !current.contains(e.target as Node)) closeMenu();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (current && e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
    }
  },
  true,
);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
