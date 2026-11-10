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
