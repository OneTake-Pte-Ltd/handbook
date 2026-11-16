// The next mandatory document the member still has to complete, in the order
// of the sidebar, starting after the current one and wrapping around.
// `tree` is the response of GET /api/tree. Returns { id, title } or null.

export function nextRequiredDocument(tree, currentId) {
  if (!tree || !tree.spaces) return null;
  const docs = [];
  for (const space of tree.spaces) for (const category of space.categories || []) for (const doc of category.documents || []) docs.push(doc);
  const start = docs.findIndex((d) => d.id === currentId);
  const ordered = start < 0 ? docs : [...docs.slice(start + 1), ...docs.slice(0, start)];
  const next = ordered.find((d) => d.id !== currentId && d.is_published && d.mandatory && (!d.progress || d.progress.status !== "completed"));
  return next ? { id: next.id, title: next.title } : null;
}
