// Drag handles that resize a column (the sidebar, the list of steps).
// The width is a CSS variable on <html>, remembered per browser. The handle is
// a focusable separator: Left and Right arrows resize it, Home resets it.
// Handles are hidden on narrow screens by CSS.

const COLUMNS = {
  sidebar: { variable: "--sidebar-width", key: "handbook.sidebarWidth", min: 220, max: 520, initial: 300, label: "Resize the sidebar" },
  steps: { variable: "--steps-width", key: "handbook.stepsWidth", min: 180, max: 480, initial: 280, label: "Resize the list of steps" },
};

function stored(column) {
  try {
    const value = Number(localStorage.getItem(column.key));
    return value ? clamp(column, value) : null;
  } catch {
    return null;
  }
}

function clamp(column, value) {
  return Math.round(Math.min(column.max, Math.max(column.min, value)));
}

function apply(column, width, remember) {
  if (width === null) document.documentElement.style.removeProperty(column.variable);
  else document.documentElement.style.setProperty(column.variable, `${width}px`);
  if (!remember) return;
  try {
    if (width === null) localStorage.removeItem(column.key);
    else localStorage.setItem(column.key, String(width));
  } catch {
    // Not remembered without storage.
  }
}

// Call once at start-up so remembered widths apply before anything renders.
export function applyStoredWidths() {
  for (const column of Object.values(COLUMNS)) {
    const width = stored(column);
    if (width) apply(column, width, false);
  }
}

// name: "sidebar" or "steps". `measure` returns the column's current width.
export function resizeHandle(name, measure) {
  const column = COLUMNS[name];
  const handle = document.createElement("div");
  handle.className = `resize-handle resize-handle--${name}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", column.label);
  handle.setAttribute("aria-valuemin", String(column.min));
  handle.setAttribute("aria-valuemax", String(column.max));
  handle.tabIndex = 0;
  handle.title = "Drag to resize. Double-click to reset.";

  const current = () => stored(column) || Math.round(measure()) || column.initial;
  const set = (width) => {
    const value = clamp(column, width);
    apply(column, value, true);
    handle.setAttribute("aria-valuenow", String(value));
  };
  handle.setAttribute("aria-valuenow", String(stored(column) || column.initial));

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = Math.round(measure());
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");
    const move = (e) => set(startWidth + e.clientX - startX);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("is-resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") set(current() - step);
    else if (event.key === "ArrowRight") set(current() + step);
    else if (event.key === "Home") reset();
    else return;
    event.preventDefault();
  });
  const reset = () => {
    apply(column, null, true);
    handle.setAttribute("aria-valuenow", String(column.initial));
  };
  handle.addEventListener("dblclick", reset);
  return handle;
}
