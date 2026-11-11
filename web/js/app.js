// Boot, session handling, app shell and hash router.

import { api, currentWorkspace, getToken, normalizeWorkspaceUrl, setToken } from "./api.js";
import { avatar, clear, h, icon, loading, setTitle } from "./lib/dom.js";
import { fullName } from "./lib/format.js";
import { isAdmin, isLeader, session, workspaceLogo } from "./state.js";
import { renderLogin } from "./views/login.js";
import { renderForcedPasswordChange } from "./views/password.js";
import { createSidebar } from "./sidebar.js";
import { attachSearchBox } from "./search-box.js";
import { createBell } from "./notifications.js";

const root = document.getElementById("app");

// Routes. Views are loaded on demand and export render(main, params).
const ROUTES = [
  { path: /^\/$/, nav: "knowledge", load: () => import("./views/home.js") },
  { path: /^\/doc\/\d+(?:\/step\/[\w-]+)?$/, nav: "knowledge", load: () => import("./views/document.js") },
  { path: /^\/profile$/, load: () => import("./views/profile.js") },
  { path: /^\/settings$/, nav: "settings", allowed: isAdmin, load: () => import("./views/settings.js") },
  { path: /^\/settings\/import$/, nav: "settings", allowed: isAdmin, load: () => import("./views/import.js") },
  {
    path: /^\/organization(?:\/.*)?$/,
    nav: "organization",
    allowed: () => isAdmin() || isLeader(),
    load: () => import("./views/organization.js"),
  },
  {
    path: /^\/reporting(?:\/.*)?$/,
    nav: "reporting",
    allowed: () => isAdmin() || isLeader(),
    load: () => import("./views/reporting.js"),
  },
  { path: /^\/search$/, nav: "knowledge", load: () => import("./views/search.js") },
];

const NAV_ITEMS = [
  { id: "knowledge", label: "Knowledge", href: "#/", icon: "knowledge", visible: () => true },
  { id: "organization", label: "Organization", href: "#/organization", icon: "organization", visible: () => isAdmin() || isLeader() },
  { id: "reporting", label: "Reporting", href: "#/reporting", icon: "reporting", visible: () => isAdmin() || isLeader() },
  { id: "settings", label: "Settings", href: "#/settings", icon: "settings", visible: isAdmin },
];

let shell = null;

function currentPath() {
  const hash = location.hash.replace(/^#/, "") || "/";
  return hash.split("?")[0] || "/";
}

function navLinks() {
  return NAV_ITEMS.filter((item) => item.visible()).map((item) =>
    h(
      "a",
      { class: "nav-link", href: item.href, title: item.label, dataset: { nav: item.id } },
      icon(item.icon),
      h("span", { class: "nav-link__label" }, item.label),
    ),
  );
}

function buildShell() {
  if (shell) shell.destroy();
  const listeners = new AbortController();
  const me = session.me;
  const main = h("main", { class: "main", id: "main", tabindex: "-1" });
  const menuButton = h("button", { class: "icon-button topbar__menu-button", type: "button", "aria-label": "Open the menu", "aria-controls": "sidebar", "aria-expanded": "false" }, icon("menu"));
  const menuName = h("strong", {}, fullName(me.user));
  const avatarMenu = h(
    "div",
    { class: "menu", id: "avatar-menu", hidden: true },
    h("div", { class: "menu__header" }, h("div", { class: "small" }, menuName), h("div", { class: "small muted" }, me.user.email)),
    h("a", { class: "menu__item", href: "#/profile" }, icon("user"), "My profile"),
    h("button", { class: "menu__item", type: "button", onclick: switchWorkspace }, icon("workspace"), "Switch workspace"),
    h("button", { class: "menu__item", type: "button", onclick: logout }, icon("logout"), "Log out"),
  );
  const avatarButton = h(
    "button",
    { class: "icon-button", type: "button", "aria-label": "Account menu", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "avatar-menu" },
    avatar(me.user),
  );
  const searchInput = h("input", { class: "input", type: "search", name: "q", placeholder: "Search the handbook", "aria-label": "Search the handbook", autocomplete: "off" });
  const searchForm = h("form", { class: "topbar__search search-field", role: "search" }, icon("search"), searchInput);
  attachSearchBox(searchForm, searchInput);
  const bell = createBell();
  const logoImg = h("img", { src: workspaceLogo(me.workspace), alt: "" });
  const logoName = h("span", { class: "topbar__logo-name" }, me.workspace.name);

  const topbar = h(
    "header",
    { class: "topbar" },
    menuButton,
    h("a", { class: "topbar__logo", href: "#/", "aria-label": `${me.workspace.name}, home` }, logoImg, logoName),
    h("nav", { class: "topbar__nav", "aria-label": "Main" }, navLinks()),
    searchForm,
    h(
      "div",
      { class: "topbar__actions" },
      h("a", { class: "icon-button topbar__search-button", href: "#/search", "aria-label": "Search" }, icon("search")),
      bell.el,
      h("div", { class: "menu-wrap" }, avatarButton, avatarMenu),
    ),
  );

  const sidebarToolbar = h("div", { class: "sidebar__toolbar", style: "flex:1" });
  const sidebarBody = h("div", { class: "sidebar__body" });
  const sidebar = h(
    "aside",
    { class: "sidebar", id: "sidebar", "aria-label": "Handbook contents" },
    h("nav", { class: "drawer-nav", "aria-label": "Main" }, navLinks()),
    h(
      "div",
      { class: "sidebar__header" },
      sidebarToolbar,
      h("button", { class: "icon-button sidebar__close", type: "button", "aria-label": "Close the menu", onclick: () => setDrawer(false) }, icon("close")),
    ),
    sidebarBody,
  );
  const tree = createSidebar({ toolbar: sidebarToolbar, body: sidebarBody });
  window.addEventListener("handbook:content-changed", () => tree.refresh(), { signal: listeners.signal });
  window.addEventListener("handbook:edit-mode", () => {
    tree.refresh();
    route();
  }, { signal: listeners.signal });
  window.addEventListener("handbook:active-document", (event) => tree.setActive(event.detail), { signal: listeners.signal });
  const backdrop = h("div", { class: "backdrop", onclick: () => setDrawer(false) });
  const body = h("div", { class: "shell" }, sidebar, backdrop, main);

  function setDrawer(open) {
    body.dataset.drawer = open ? "open" : "closed";
    menuButton.setAttribute("aria-expanded", String(open));
    if (open) sidebar.querySelector("a, button")?.focus();
  }
  menuButton.addEventListener("click", () => setDrawer(body.dataset.drawer !== "open"));

  function setAvatarMenu(open) {
    avatarMenu.hidden = !open;
    avatarButton.setAttribute("aria-expanded", String(open));
    if (open) avatarMenu.querySelector(".menu__item")?.focus();
  }
  avatarButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setAvatarMenu(avatarMenu.hidden);
  });
  document.addEventListener("click", (event) => {
    if (!avatarMenu.hidden && !avatarMenu.contains(event.target)) setAvatarMenu(false);
  }, { signal: listeners.signal });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!avatarMenu.hidden) {
      setAvatarMenu(false);
      avatarButton.focus();
    } else if (body.dataset.drawer === "open") {
      setDrawer(false);
      menuButton.focus();
    }
  }, { signal: listeners.signal });

  const skip = h("a", { class: "skip-link", href: "#main", onclick: (e) => { e.preventDefault(); main.focus(); } }, "Skip to content");
  clear(root, skip, topbar, body);

  return {
    main,
    tree,
    bell,
    destroy() {
      listeners.abort();
      bell.destroy();
    },
    setSection(section) {
      body.dataset.section = section;
      topbar.dataset.section = section;
    },
    setActiveNav(id) {
      for (const link of root.querySelectorAll("[data-nav]")) {
        if (link.dataset.nav === id) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    closeMenus() {
      setDrawer(false);
      setAvatarMenu(false);
    },
    refreshBranding() {
      logoImg.src = workspaceLogo(session.me.workspace);
      logoName.textContent = session.me.workspace.name;
      avatarButton.replaceChildren(avatar(session.me.user));
      menuName.textContent = fullName(session.me.user);
    },
  };
}

function messagePage(title, text) {
  return h("div", { class: "page page--narrow" }, h("h1", { class: "page-title" }, title), h("div", { class: "card" }, h("p", { style: "margin-top:0" }, text), h("a", { class: "button", href: "#/" }, "Back to the home page")));
}

let renderCount = 0;

async function route() {
  if (!shell) return;
  const path = currentPath();
  const match = ROUTES.find((r) => r.path.test(path));
  shell.closeMenus();
  shell.bell.close();
  shell.bell.refresh();
  const main = shell.main;
  const ticket = ++renderCount;

  shell.setSection(match && match.nav === "knowledge" ? "knowledge" : "other");
  if (!match || (match.allowed && !match.allowed())) {
    shell.setActiveNav(null);
    const refused = Boolean(match);
    setTitle(refused ? "No access" : "Not found");
    clear(main, messagePage(refused ? "You don't have access to this page" : "Page not found", refused ? "This page is for admins and team leaders. If you think you should see it, ask an admin." : "This page doesn't exist."));
    return;
  }
  shell.setActiveNav(match.nav || null);
  if (!path.startsWith("/doc/")) shell.tree.setActive(null);
  clear(main, loading());
  try {
    const view = await match.load();
    if (ticket !== renderCount) return; // a newer navigation started
    clear(main);
    await view.render(main, { path, query: new URLSearchParams(location.hash.split("?")[1] || ""), ...(match.params || {}), refreshBranding: () => shell.refreshBranding() });
  } catch (error) {
    if (ticket !== renderCount) return;
    if (error.status === 404) {
      clear(main, messagePage("Not found", error.message));
    } else if (error.status === 403) {
      clear(main, messagePage("You don't have access to this page", error.message));
    } else {
      console.error(error);
      clear(main, h("div", { class: "page" }, h("div", { class: "alert alert--error", role: "alert" }, error.message || "Something went wrong.")));
    }
  }
  if (renderCount > 1) main.focus({ preventScroll: true });
}

async function startSession() {
  if (shell) shell.destroy();
  shell = null;
  clear(root, loading());
  session.me = await api("GET", "/me");
  if (session.me.user.must_change_password) {
    renderForcedPasswordChange(root, { onDone: startSession, onLogout: logout });
    return;
  }
  shell = buildShell();
  renderCount = 0;
  await route();
}

function showLogin(options = {}) {
  if (shell) shell.destroy();
  shell = null;
  session.me = null;
  setTitle("Log in");
  renderLogin(root, { ...options, onLoggedIn: () => startSession().catch(handleBootError) });
}

async function logout() {
  try {
    await api("POST", "/logout");
  } catch {
    // The session is cleared locally either way.
  }
  setToken(currentWorkspace(), null);
  showLogin({ message: "You are logged out." });
}

function switchWorkspace() {
  showLogin({ chooseWorkspace: true });
}

function handleBootError(error) {
  if (error.status === 401) return; // handled by the logged-out event
  showLogin({ message: error.message, chooseWorkspace: true });
}

window.addEventListener("hashchange", () => {
  if (location.hash === "#main") return;
  route();
});
window.addEventListener("handbook:logged-out", (event) => showLogin({ message: event.detail }));
window.addEventListener("handbook:must-change-password", () => startSession().catch(handleBootError));

function boot() {
  // ?workspace=https://... pre-fills the workspace URL (invitation links).
  const params = new URLSearchParams(location.search);
  let invited = null;
  if (params.has("workspace")) {
    try {
      invited = normalizeWorkspaceUrl(params.get("workspace"));
    } catch {
      invited = null;
    }
    history.replaceState(null, "", location.pathname + location.hash);
  }
  const current = currentWorkspace();
  if (current && getToken(current) && (!invited || invited === current)) {
    startSession().catch(handleBootError);
  } else {
    showLogin({ invitedUrl: invited });
  }
}

boot();
