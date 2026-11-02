"use client";

// Opening the Library from anywhere in the console (a studio's History, a
// World project, a Storage folder) already filtered to what you came from.
//
// The Library's tab may not be built yet when this is called, so the filter
// waits here until the Library takes it on mount, and an event tells a
// Library that is already built.

export type LibraryNav = {
  shelf?: string; project?: string; group?: string; studio?: string; kind?: string; faction?: string; status?: string; q?: string;
};

const EVENT = "hangar:library-nav";
let pending: LibraryNav | null = null;

export function openLibrary(nav: LibraryNav = {}) {
  pending = nav;
  window.dispatchEvent(new CustomEvent<LibraryNav>(EVENT, { detail: nav }));
  try {
    window.localStorage.setItem("bt-active-tab", "library");
  } catch {
    /* storage can be unavailable */
  }
  // The console switches tabs on popstate (see page.tsx), from the hash.
  window.history.pushState({ tab: "library" }, "", "#library");
  window.dispatchEvent(new PopStateEvent("popstate", { state: { tab: "library" } }));
}

/** The filter a caller left for a Library that wasn't built yet. */
export function takeLibraryNav(): LibraryNav | null {
  const nav = pending;
  pending = null;
  return nav;
}

export function onLibraryNav(fn: (nav: LibraryNav) => void): () => void {
  const listener = (e: Event) => {
    pending = null;
    fn((e as CustomEvent<LibraryNav>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
