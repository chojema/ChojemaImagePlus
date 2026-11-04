export interface Choice {
  id: string;
  label: string;
  primary?: boolean;
}

export interface Question {
  title: string;
  message?: string;
  choices: Choice[];
  checkbox?: { label: string; checked: boolean };
  input?: { label: string; value: string; selectEnd?: number };
  /** Choice returned by Escape. */
  cancel?: string;
}

export interface Answer {
  choice: string;
  checked: boolean;
  value: string;
}

export function modalOpen(): boolean {
  return !!document.querySelector(".modal");
}

/** Shows a dialog and resolves with the button pressed. */
export function ask(q: Question): Promise<Answer> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    const box = document.createElement("div");
    box.className = "dialog";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.textContent = q.title;
    title.id = "dialog-title";
    box.setAttribute("aria-labelledby", title.id);
    box.append(title);
    if (q.message) {
      const p = document.createElement("p");
      p.className = "dialog-message";
      p.textContent = q.message;
      box.append(p);
    }
    let input: HTMLInputElement | null = null;
    if (q.input) {
      const label = document.createElement("label");
      label.className = "dialog-input";
      label.textContent = q.input.label;
      input = document.createElement("input");
      input.type = "text";
      input.value = q.input.value;
      input.autocomplete = "off";
      input.spellcheck = false;
      label.append(input);
      box.append(label);
    }
    let checkbox: HTMLInputElement | null = null;
    if (q.checkbox) {
      const label = document.createElement("label");
      label.className = "dialog-check";
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = q.checkbox.checked;
      label.append(checkbox, document.createTextNode(` ${q.checkbox.label}`));
      box.append(label);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    let primary: HTMLButtonElement | null = null;
    const previous = document.activeElement as HTMLElement | null;
    const finish = (choice: string) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      previous?.focus({ preventScroll: true });
      resolve({ choice, checked: checkbox?.checked ?? false, value: input?.value ?? "" });
    };
    // Keys are handled at the document level so the dialog works even if focus stayed elsewhere.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (q.cancel) finish(q.cancel);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement && box.contains(focused)) focused.click();
        else primary?.click();
      } else if (e.key === "Tab") {
        const controls = [...box.querySelectorAll<HTMLElement>("input, button")];
        const i = controls.indexOf(document.activeElement as HTMLElement);
        if (i < 0 || (!e.shiftKey && i === controls.length - 1) || (e.shiftKey && i === 0)) {
          e.preventDefault();
          controls[e.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    for (const c of q.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = c.label;
      if (c.primary) {
        button.classList.add("primary");
        primary = button;
      }
      button.addEventListener("click", () => finish(c.id));
      actions.append(button);
    }
    box.append(actions);
    overlay.append(box);
    document.body.append(overlay);
    (input ?? primary ?? actions.querySelector("button"))?.focus();
    if (input) input.setSelectionRange(0, q.input?.selectEnd ?? input.value.length);
  });
}
