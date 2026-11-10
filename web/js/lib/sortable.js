// Reordering by dragging, with pointer events so it works with a mouse, a
// pen and a finger. Keyboard users get "Move up" and "Move down" menu items
// instead (see moveItem).
//
// sortable(list, { handle: ".drag-handle", item: "li", onEnd: (orderedIds) => {} })
// Each item needs data-id. onEnd is called only when the order changed.

export function sortable(list, { handle, item, onEnd }) {
  let dragging = null;
  let startOrder = null;

  const items = () => [...list.children].filter((el) => el.matches(item));
  const order = () => items().map((el) => Number(el.dataset.id));

  list.addEventListener("pointerdown", (event) => {
    const grip = event.target.closest(handle);
    if (!grip || !list.contains(grip)) return;
    const el = grip.closest(item);
    if (!el || el.parentElement !== list) return;
    event.preventDefault();
    dragging = el;
    startOrder = order().join(",");
    el.classList.add("is-dragging");
    grip.setPointerCapture(event.pointerId);
  });

  list.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    event.preventDefault();
    const siblings = items().filter((el) => el !== dragging);
    // Insert before the first sibling whose middle is below the pointer.
    const next = siblings.find((el) => {
      const box = el.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    if (next) {
      if (dragging.nextElementSibling !== next) list.insertBefore(dragging, next);
    } else if (siblings.length && list.lastElementChild !== dragging) {
      siblings[siblings.length - 1].after(dragging);
    }
  });

  const finish = () => {
    if (!dragging) return;
    dragging.classList.remove("is-dragging");
    dragging = null;
    const ids = order();
    if (ids.join(",") !== startOrder) onEnd(ids);
  };
  list.addEventListener("pointerup", finish);
  list.addEventListener("pointercancel", finish);
}

// The new order of ids after moving one up (-1) or down (+1). Null if it can't move.
export function moveItem(ids, id, delta) {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return null;
  const copy = [...ids];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}
