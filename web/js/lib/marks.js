// Completion marks: empty circle (not started), partial ring (in progress),
// filled Golden Grass circle with a Bleached Cedar tick (completed). The tick,
// not the color, carries the meaning; each mark also has a text label.

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(children, label) {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 20 20");
  el.setAttribute("class", "mark");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  for (const [tag, attrs] of children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    el.append(node);
  }
  return el;
}

export function statusLabel(progress) {
  if (!progress) return "Not started";
  if (progress.status === "completed") return "Completed";
  if (progress.status === "in_progress") return `In progress (${progress.done} of ${progress.total} steps)`;
  return "Not started";
}

export function completionMark(progress) {
  const label = statusLabel(progress);
  if (progress && progress.status === "completed") {
    return svg(
      [
        ["circle", { cx: "10", cy: "10", r: "9", fill: "var(--golden-grass)" }],
        ["path", { d: "M6 10.5l2.6 2.6L14 7.5", fill: "none", stroke: "var(--bleached-cedar)", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" }],
      ],
      label,
    );
  }
  if (progress && progress.status === "in_progress") {
    // Arc length proportional to progress, on a light ring.
    const fraction = Math.max(0.08, Math.min(0.92, progress.done / Math.max(1, progress.total)));
    const circumference = 2 * Math.PI * 7;
    return svg(
      [
        ["circle", { cx: "10", cy: "10", r: "7", fill: "none", stroke: "var(--gold-200)", "stroke-width": "3" }],
        [
          "circle",
          {
            cx: "10",
            cy: "10",
            r: "7",
            fill: "none",
            stroke: "var(--bleached-cedar)",
            "stroke-width": "3",
            "stroke-dasharray": `${fraction * circumference} ${circumference}`,
            transform: "rotate(-90 10 10)",
          },
        ],
      ],
      label,
    );
  }
  return svg([["circle", { cx: "10", cy: "10", r: "7.5", fill: "none", stroke: "var(--cedar-300)", "stroke-width": "1.6" }]], label);
}

// A single step's mark: completed or not.
export function stepMark(completed) {
  return completionMark(completed ? { status: "completed" } : { status: "not_started" });
}
