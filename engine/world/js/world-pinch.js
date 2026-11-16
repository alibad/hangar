// Desktop trackpad pinches are not touch events. Chromium sends ctrl+wheel;
// Safari also has cumulative GestureEvent.scale. Claim only the world surface,
// before browser page zoom, including the HTML labels above the WebGL canvas.
// https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html
/** @typedef {{deltaY?: number, scaleRatio?: number, clientX?: number, clientY?: number}} WorldPinch */
/**
 * @param {EventTarget} surface
 * @param {(pinch: WorldPinch) => void} onPinch
 * @param {(event: Event) => boolean} [accept]
 */
export function bindWorldPinch(surface, onPinch, accept = () => true) {
  let nativePinch = false, lastScale = 1;
  const claim = event => { event.preventDefault(); event.stopPropagation(); };
  const wheel = event => {
    if (!event.ctrlKey || !accept(event)) return;
    claim(event);
    if (nativePinch || !Number.isFinite(event.deltaY)) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    // Match the vendored controls' existing trackpad sensitivity, without letting
    // the same ctrl+wheel event reach them again and zoom twice.
    onPinch({ deltaY: pixels * 10, clientX: event.clientX, clientY: event.clientY });
  };
  const start = event => {
    if (!accept(event)) return;
    claim(event); nativePinch = true; lastScale = 1;
  };
  const change = event => {
    if (!nativePinch) return;
    claim(event);
    if (!(Number.isFinite(event.scale) && event.scale > 0)) return;
    onPinch({ scaleRatio: event.scale / lastScale, clientX: event.clientX, clientY: event.clientY });
    lastScale = event.scale;
  };
  const end = event => {
    if (!nativePinch) return;
    claim(event); nativePinch = false; lastScale = 1;
  };
  const handlers = { wheel, gesturestart: start, gesturechange: change, gestureend: end };
  for (const [type, listener] of Object.entries(handlers)) surface.addEventListener(type, listener, { capture: true, passive: false });
  return () => {
    for (const [type, listener] of Object.entries(handlers)) surface.removeEventListener(type, listener, { capture: true });
    nativePinch = false;
  };
}
