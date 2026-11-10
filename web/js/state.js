// Shared state for the logged-in session.

export const DEFAULT_LOGO = "assets/logo.svg";

export const session = {
  me: null, // response of GET /api/me
};

export function isAdmin() {
  return Boolean(session.me && session.me.user.is_admin);
}

export function isLeader() {
  return Boolean(session.me && session.me.leads.length);
}

export function workspaceLogo(workspace) {
  return (workspace && workspace.logo_url) || DEFAULT_LOGO;
}

// Edit mode is remembered per browser. Changing it fires "handbook:edit-mode".
const EDIT_KEY = "handbook.editMode";

export function isEditMode() {
  if (!session.me || !session.me.can_edit) return false;
  try {
    return localStorage.getItem(EDIT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setEditMode(on) {
  try {
    localStorage.setItem(EDIT_KEY, on ? "1" : "0");
  } catch {
    // Not remembered without storage.
  }
  window.dispatchEvent(new CustomEvent("handbook:edit-mode", { detail: on }));
}

// Ask the sidebar (and anything else listening) to reload the content tree.
export function contentChanged() {
  window.dispatchEvent(new CustomEvent("handbook:content-changed"));
}
