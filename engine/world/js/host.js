// Same-origin embedding in Hangar. No arbitrary API URL and no cross-origin control.
export const embedded = new URLSearchParams(location.search).get("embed") === "hangar";
const mount = location.pathname.match(/^(\/api\/world\/[^/]+)\/view\//)?.[1];
export const api = (path) => mount ? `${mount}/proxy${path.replace(/^\/api/, "")}` : path;
export function tellHost(type, payload = {}) {
  if (embedded && window.parent !== window) window.parent.postMessage({ source: "atlas", type, ...payload }, location.origin);
}
export function listenHost(onMessage) {
  if (!embedded) return;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.source !== "hangar") return;
    onMessage(event.data);
  });
}
