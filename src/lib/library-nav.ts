"use client";

// Opening the Library from anywhere in the console (a studio's History, a
// World project, a Storage folder) already filtered to what you came from.
//
// The Library's tab may not be built yet when this is called, so the filter
// waits here until the Library takes it on mount, and an event tells a
// Library that is already built.

export type LibraryNav = {
  shelf?: string; project?: string; group?: string; studio?: string; kind?: string; faction?: string; status?: string; q?: string;
  /** A folder: only what is inside it. */
  dir?: string;
};

const EVENT = "hangar:library-nav";
/** Asks the console to show a tab; page.tsx listens. */
export const SELECT_TAB_EVENT = "hangar:select-tab";
// On window, not in this module: the page loads the Library in its own chunk,
// and a studio that imports it statically may hold a second copy of this file.
const box = () => window as typeof window & { __hangarLibraryNav?: LibraryNav | null };

export function openLibrary(nav: LibraryNav = {}) {
  box().__hangarLibraryNav = nav;
  window.dispatchEvent(new CustomEvent<LibraryNav>(EVENT, { detail: nav }));
  // page.tsx switches tabs on this event. A synthetic popstate would not do:
  // Next's router answers a history entry it didn't make with a full reload.
  window.dispatchEvent(new CustomEvent(SELECT_TAB_EVENT, { detail: "library" }));
}

/** The filter a caller left for a Library that wasn't built yet. */
export function takeLibraryNav(): LibraryNav | null {
  const nav = box().__hangarLibraryNav ?? null;
  box().__hangarLibraryNav = null;
  return nav;
}

export function onLibraryNav(fn: (nav: LibraryNav) => void): () => void {
  const listener = (e: Event) => {
    box().__hangarLibraryNav = null;
    fn((e as CustomEvent<LibraryNav>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
