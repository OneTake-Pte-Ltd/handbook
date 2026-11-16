// Pasted images are copied into the workspace's storage, so documents never
// depend on images hosted elsewhere (Google Docs, Notion, any website).
//
// After each change, the editor looks for images whose address is not in the
// workspace's storage: images pasted as data (screenshots inside copied
// content) are uploaded; images from other websites are fetched by the edge
// script (POST /api/files/import-url). Each image is then replaced, in every
// step of the draft, by the copy. Saving waits until the copies are done.

import { api, uploadFile } from "../api.js";
import { fitImage } from "../lib/image.js";

const MAX_IMAGE = 10 * 1024 * 1024;

// Addresses of images (figure nodes) in Tiptap JSON that `keep` doesn't accept.
export function imageSources(json, keep = () => false, found = new Set()) {
  if (!json || typeof json !== "object") return found;
  if (json.type === "figure" && json.attrs && json.attrs.src && !keep(json.attrs.src)) found.add(json.attrs.src);
  if (Array.isArray(json.content)) for (const child of json.content) imageSources(child, keep, found);
  return found;
}

// Replaces image addresses in Tiptap JSON (in place). `to` null removes the image.
export function replaceImageSources(json, from, to) {
  if (!json || !Array.isArray(json.content)) return json;
  json.content = json.content.filter((child) => !(to === null && child.type === "figure" && child.attrs && child.attrs.src === from));
  for (const child of json.content) {
    if (child.type === "figure" && child.attrs && child.attrs.src === from) child.attrs = { ...child.attrs, src: to };
    replaceImageSources(child, from, to);
  }
  return json;
}

// Whether an address points to the workspace's own storage.
export function ownFileChecker(filesUrl) {
  const base = (filesUrl || "").replace(/\/+$/, "");
  return (src) => Boolean(base) && src.startsWith(`${base}/`);
}

async function copyImage(src) {
  if (src.startsWith("data:")) {
    let blob = await (await fetch(src)).blob();
    if (!blob.type.startsWith("image/")) throw new Error("This pasted item isn't an image.");
    blob = await fitImage(blob);
    if (blob.size > MAX_IMAGE) throw new Error("Images can be 10 MB at most.");
    const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
    return (await uploadFile(blob, `pasted-image.${ext}`, "image")).url;
  }
  return (await api("POST", "/files/import-url", { url: src })).url;
}

// editor: the Tiptap editor. otherSteps(): Tiptap JSON of the other steps in
// the draft. onChange(): the draft changed. onStatus(text): progress text
// (empty when done). onError(message): shown to the person.
export function createImageImporter({ editor, filesUrl, otherSteps, onChange, onStatus, onError }) {
  const isOwn = ownFileChecker(filesUrl);
  const pending = new Map();
  const failed = new Set();

  function replace(from, to) {
    const { state } = editor;
    const tr = state.tr;
    const positions = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name === "figure" && node.attrs.src === from) positions.push([pos, node]);
    });
    for (const [pos, node] of positions.reverse()) {
      if (to === null) tr.delete(pos, pos + node.nodeSize);
      else tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: to });
    }
    if (positions.length) editor.view.dispatch(tr.setMeta("addToHistory", false));
    for (const json of otherSteps()) replaceImageSources(json, from, to);
    onChange();
  }

  function scan() {
    const sources = new Set();
    editor.state.doc.descendants((node) => {
      const src = node.type.name === "figure" ? node.attrs.src : "";
      if (src && !isOwn(src) && !failed.has(src) && !pending.has(src) && /^(data:image\/|https?:)/i.test(src)) sources.add(src);
    });
    for (const src of sources) {
      const job = copyImage(src)
        .then((url) => replace(src, url))
        .catch((error) => {
          failed.add(src);
          if (src.startsWith("data:")) {
            replace(src, null);
            onError(`A pasted image couldn't be uploaded and was removed: ${error.message}`);
          } else {
            onError(`An image couldn't be copied to the handbook, so it still comes from another website: ${error.message} Download it and add it with the image button instead.`);
          }
        })
        .finally(() => {
          pending.delete(src);
          report();
        });
      pending.set(src, job);
    }
    if (sources.size) report();
  }

  function report() {
    onStatus(pending.size ? `Copying ${pending.size} image${pending.size === 1 ? "" : "s"} to the handbook` : "");
  }

  return {
    scan,
    get busy() {
      return pending.size > 0;
    },
    async settle() {
      while (pending.size) await Promise.allSettled([...pending.values()]);
    },
  };
}

// Image files pasted or dropped on their own (a screenshot from the clipboard).
export async function uploadImageFiles(editor, files, position = null) {
  for (const file of files) {
    let blob = await fitImage(file);
    if (blob.size > MAX_IMAGE) throw new Error("Images can be 10 MB at most.");
    const uploaded = await uploadFile(blob, file.name || "pasted-image.png", "image");
    const content = { type: "figure", attrs: { src: uploaded.url, alt: "", caption: "", width: "full" } };
    if (position === null) editor.chain().focus().insertContent(content).run();
    else editor.chain().focus().insertContentAt(position, content).run();
  }
}
