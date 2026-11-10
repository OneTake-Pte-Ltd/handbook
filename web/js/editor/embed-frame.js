// HTML embeds run in a sandboxed iframe built from srcdoc, without
// allow-same-origin: the embed gets an opaque origin, so it can't read the
// app's cookies, localStorage or DOM. A tiny script injected into the srcdoc
// reports the content height so the iframe can fit its content.

const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation";
const ALLOW = "fullscreen; autoplay; clipboard-write";

const RESIZE_SCRIPT = `<script>
(function () {
  var id = "__ID__";
  function send() {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    parent.postMessage({ type: "handbook-embed-height", id: id, height: h }, "*");
  }
  window.addEventListener("load", send);
  if (window.ResizeObserver) new ResizeObserver(send).observe(document.documentElement);
  setTimeout(send, 50); setTimeout(send, 500); setTimeout(send, 2000);
})();
</script>`;

const frames = new Map(); // id -> iframe

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "handbook-embed-height" || typeof data.id !== "string") return;
  const frame = frames.get(data.id);
  // Only accept the message from that iframe's own window.
  if (!frame || event.source !== frame.contentWindow) return;
  if (!frame.isConnected) {
    frames.delete(data.id);
    return;
  }
  const height = Math.max(40, Math.min(5000, Number(data.height) || 0));
  frame.style.height = `${height}px`;
});

export function htmlEmbedFrame(html, title = "Embedded content") {
  const id = Math.random().toString(36).slice(2);
  const frame = document.createElement("iframe");
  frame.className = "html-embed__frame";
  frame.setAttribute("sandbox", SANDBOX);
  frame.setAttribute("allow", ALLOW);
  frame.setAttribute("title", title);
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const base = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;font-family:Arial,sans-serif}</style></head><body>';
  frame.srcdoc = `${base}${html || ""}${RESIZE_SCRIPT.replace("__ID__", id)}</body></html>`;
  frames.set(id, frame);
  return frame;
}
