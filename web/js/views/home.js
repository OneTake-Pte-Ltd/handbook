// Home page. Milestone 1 shows the greeting; the widgets arrive in milestone 6.

import { h, icon, setTitle } from "../lib/dom.js";
import { greeting } from "../lib/format.js";
import { session } from "../state.js";

export function render(main) {
  const me = session.me;
  setTitle("Home");
  const banner = h(
    "section",
    { class: `banner${me.workspace.banner_url ? " banner--image" : ""}` },
    h("div", { class: "banner__inner" }, h("h1", { class: "banner__title" }, `${greeting()}, ${me.user.first_name}`)),
  );
  if (me.workspace.banner_url) banner.style.backgroundImage = `url(${JSON.stringify(me.workspace.banner_url)})`;

  main.append(
    banner,
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "card empty-state" },
        icon("knowledge"),
        h("h2", { class: "section-title" }, "Your handbook is empty for now"),
        h("p", { class: "small", style: "margin:0" }, "Documents you can read will appear here and in the sidebar."),
      ),
    ),
  );
}
