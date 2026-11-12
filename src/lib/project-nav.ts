import { SELECT_TAB_EVENT } from "./library-nav";

// Open one project's pane in Hangar's Projects view from another page (Products, ...). The target waits in
// sessionStorage so it still opens when the Projects view has to mount first; the event wakes it when it is already up.
export const OPEN_PROJECT_KEY = "hangar-open-project";
export const OPEN_PROJECT_EVENT = "hangar:open-project";

export function openProject(repo: string, machine = "local") {
  try { sessionStorage.setItem(OPEN_PROJECT_KEY, JSON.stringify({ machine, repo })); } catch { /* opens the view only */ }
  window.dispatchEvent(new CustomEvent(SELECT_TAB_EVENT, { detail: "projects" }));
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_EVENT));
}
