// Notification bell in the top bar: unread count (refreshed every 60 seconds
// and on each navigation), a panel listing notifications, "Mark all as read".

import { api } from "./api.js";
import { clear, h, icon, loading } from "./lib/dom.js";
import { relativeTime } from "./lib/format.js";

function describe(n) {
  const who = n.actor || "Someone";
  switch (n.type) {
    case "review_requested":
      return `${who} asked you to review “${n.title}”.`;
    case "draft_approved":
      return `${who} approved and published your changes to “${n.title}”.`;
    case "draft_rejected":
      return `${who} asked for changes to “${n.title}”${n.comment ? `: ${n.comment}` : "."}`;
    case "mandatory_assigned":
      return `“${n.title}” is now required reading for you.`;
    case "major_revision":
      return `“${n.title}” changed a lot. Please read it again.`;
    case "department_added":
      return `${who} added you to ${n.department}.`;
    case "made_leader":
      return `${who} made you a team leader of ${n.department}.`;
    default:
      return "You have a new notification.";
  }
}

export function createBell() {
  const count = h("span", { class: "count-badge", hidden: true, "aria-hidden": "true" });
  const button = h("button", { class: "icon-button", type: "button", "aria-label": "Notifications", "aria-haspopup": "true", "aria-expanded": "false" }, icon("bell"), count);
  const panel = h("div", { class: "menu notifications-panel", hidden: true, role: "dialog", "aria-label": "Notifications" });
  const el = h("div", { class: "menu-wrap" }, button, panel);
  let unread = 0;

  function setCount(n) {
    unread = n;
    count.hidden = !n;
    count.textContent = n > 99 ? "99+" : String(n);
    button.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
  }

  async function refresh() {
    try {
      setCount((await api("GET", "/notifications?count=1")).unread_count);
    } catch {
      // A failed refresh is retried on the next navigation or minute.
    }
  }

  function close() {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  async function openPanel() {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    clear(panel, loading());
    let data;
    try {
      data = await api("GET", "/notifications");
    } catch (e) {
      clear(panel, h("div", { class: "alert alert--error" }, e.message));
      return;
    }
    setCount(data.unread_count);
    const markAll = h(
      "button",
      {
        class: "link-button small",
        type: "button",
        disabled: !data.unread_count,
        onclick: async () => {
          await api("POST", "/notifications/read", { all: true });
          await openPanel();
        },
      },
      "Mark all as read",
    );
    clear(
      panel,
      h("div", { class: "notifications-panel__header" }, h("strong", {}, "Notifications"), markAll),
      data.items.length
        ? h(
            "ul",
            { class: "notifications-list" },
            data.items.map((n) =>
              h(
                "li",
                {},
                h(
                  "button",
                  {
                    class: `notification${n.read ? "" : " notification--unread"}`,
                    type: "button",
                    onclick: async () => {
                      close();
                      if (!n.read) {
                        api("POST", "/notifications/read", { ids: [n.id] }).then(refresh).catch(() => {});
                      }
                      if (n.link) location.hash = n.link;
                    },
                  },
                  h("span", { class: "notification__text" }, describe(n)),
                  h("span", { class: "notification__time" }, relativeTime(n.created_at), n.read ? null : h("span", { class: "visually-hidden" }, ", unread")),
                ),
              ),
            ),
          )
        : h("p", { class: "muted small", style: "padding:8px 12px;margin:0" }, "Nothing new. You'll be told here about reviews, required reading and changes to your departments."),
    );
    panel.querySelector("button.notification, button.link-button")?.focus();
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.hidden) openPanel();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !el.contains(e.target)) close();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      button.focus();
    }
  });

  const timer = setInterval(refresh, 60_000);
  refresh();
  return { el, refresh, close, destroy: () => clearInterval(timer), get unread() { return unread; } };
}
