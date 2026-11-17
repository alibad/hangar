// A tab left open across a rebuild can still ask for the previous build's
// hashed assets. Remounting a rejected dynamic import cannot update that page.
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message, code } = error as { name?: string; message?: string; code?: string };
  return name === "ChunkLoadError" || code === "CSS_CHUNK_LOAD_FAILED" ||
    (typeof message === "string" && /Loading (?:CSS )?chunk [\s\S]+failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message));
}

export const CHUNK_RELOAD_KEY = "hangar:chunk-reload-at";
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

type Browser = {
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
  location: Pick<Location, "reload">;
  navigator: Pick<Navigator, "onLine">;
};

/** One automatic refresh per minute, across all tabs/tools in this browser tab.
 * If storage is blocked, stay on the fallback: an in-memory guard would be
 * lost on reload and could trap the user in a loop. Manual reload stays usable.
 */
export function reloadAfterChunkError(error: unknown, browser: Browser, now = Date.now()): boolean {
  if (!isChunkLoadError(error)) return false;
  try {
    if (!browser.navigator.onLine) return false;
    const previous = browser.sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (previous !== null && Number.isFinite(Number(previous)) && now - Number(previous) < CHUNK_RELOAD_COOLDOWN_MS) return false;
    browser.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
    // Keep the URL (including the selected tool's hash) intact.
    browser.location.reload();
    return true;
  } catch {
    return false;
  }
}
