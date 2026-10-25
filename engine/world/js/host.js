// Same-origin embedding in Hangar. No arbitrary API URL and no cross-origin control.
export const embedded = new URLSearchParams(location.search).get("embed") === "hangar";
const mount = location.pathname.match(/^(\/api\/world\/[^/]+)\/view\//)?.[1];
export const api = (path) => mount ? `${mount}/proxy${path.replace(/^\/api/, "")}` : path;
let lastStatus = null;
export function tellHost(type, payload = {}) {
  if (["ready", "pane-ready", "error"].includes(type)) lastStatus = { type, payload };
  if (embedded && window.parent !== window) window.parent.postMessage({ source: "atlas", type, ...payload }, location.origin);
}

// Readiness is a handshake, not a one-shot event. Reconfirm after host reloads
// or missed messages without restarting the renderer or changing the camera.
listenHost(message => {
  if (message.type === "status" && lastStatus) tellHost(lastStatus.type, lastStatus.payload);
});
/** Hangar's theme colours as --h-* variables: plain colour values only, never url(). */
export function applyPalette(palette) {
  if (!palette || typeof palette !== "object") return {};
  for (const [name, value] of Object.entries(palette)) {
    if (/^[a-z-]{2,20}$/.test(name) && typeof value === "string" && value.length < 200 && /^[\w\s#().,%+*/-]*$/.test(value) && !/url/i.test(value)) {
      document.body.style.setProperty(`--h-${name}`, value);
    }
  }
  return palette;
}

export function listenHost(onMessage) {
  if (!embedded) return;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.source !== "hangar") return;
    onMessage(event.data);
  });
}
