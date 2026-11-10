// Organization (admins and team leaders): members and departments.
//   #/organization                    members list
//   #/organization/members/:id        member page
//   #/organization/departments        departments list
//   #/organization/departments/:id    department page

import { h, icon } from "../lib/dom.js";
import { renderMemberPage, renderMembersList } from "./members.js";
import { renderDepartmentPage, renderDepartmentsList } from "./departments.js";

export async function render(main, { path }) {
  const parts = path.split("/").filter(Boolean);
  const section = parts[1] === "departments" ? "departments" : "members";
  const id = Number(parts[2]) || null;

  const content = h("div", { class: "section-content" });
  const link = (key, label, iconName, href) =>
    h("a", { class: "nav-link", href, "aria-current": section === key ? "page" : null }, icon(iconName), h("span", {}, label));
  main.append(
    h(
      "div",
      { class: "section-layout" },
      h(
        "nav",
        { class: "subnav", "aria-label": "Organization" },
        link("members", "Members", "user", "#/organization"),
        link("departments", "Departments", "organization", "#/organization/departments"),
      ),
      content,
    ),
  );

  if (section === "members" && id) return renderMemberPage(content, id);
  if (section === "members") return renderMembersList(content);
  if (id) return renderDepartmentPage(content, id);
  return renderDepartmentsList(content);
}
