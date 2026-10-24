// Reuse Hangar's complete repository UI without starting a second WebGL world.
import { createUI } from "./ui.js";
import { api, tellHost, listenHost } from "./host.js";

export async function startProjectPane(doc, params) {
  document.body.classList.add("atlas-pane");
  document.body.classList.remove("booting");
  document.getElementById("loading").hidden = true;
  const remote = params.get("remote") === "1";
  let ui, selected = params.get("repo"), view = params.get("view") || "changes";
  const islands = () => doc.families.map(family => ({ spot: { id: family.id, family, cells: doc.repos.filter(r => !r.hidden && r.family === family.id).map(repo => ({ repo })) } }));
  const read = async path => {
    const response = await fetch(api(path), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Hangar is unavailable.");
    return data;
  };
  const post = async (path, body) => {
    const response = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1", "X-Hangar": "1" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The action could not be completed.");
    return data;
  };
  const report = action => async (...args) => { try { return await action(...args); } catch (e) { ui.toast(e.message, true); } };
  const show = () => {
    const repo = doc.repos.find(r => r.id === selected);
    document.body.classList.toggle("pane-repo", !!repo);
    if (repo) { ui.toggleList(false); ui.showRepo(repo); }
    else { ui.hideCard(); const kind = ["commit", "push", "pull", "prs"].includes(view) ? view : null; ui.toggleList(true, kind, kind ? null : view); view = null; }
  };
  async function refresh() {
    Object.assign(doc, await read("/api/atlas"));
    app.islands = islands();
    show();
    tellHost("pane-changed");
  }
  async function waitForScan() {
    const status = await read("/api/status");
    if (status.scanning) return setTimeout(() => waitForScan().catch(e => ui.toast(e.message, true)), 1500);
    ui.scanning(false);
    if (status.error) return ui.toast(status.error, true);
    await refresh();
  }
  const app = {
    doc, local: true, canOpen: !remote, canControlApps: !remote, islands: islands(), apps: null,
    sound: { on: false, toggle() {} }, setLens() {}, setTime() {}, toggleNight() {}, focusIsland() {},
    select(repo) { selected = repo.id; show(); tellHost("pane-select", { repo: repo.id }); },
    deselect() { if (params.get("pane") === "tools") { selected = null; show(); } else tellHost("pane-close"); },
    step(direction) {
      const current = doc.repos.find(r => r.id === selected);
      const peers = doc.repos.filter(r => !r.hidden && r.family === current?.family);
      const i = peers.findIndex(r => r.id === selected);
      if (peers.length) app.select(peers[(i + direction + peers.length) % peers.length]);
    },
    open: report(async (repo, site, how, intent) => { await post("/api/open", { repo: repo.id, site, with: how, intent }); ui.toast("Opening on this machine"); }),
    copy: report(async value => { await navigator.clipboard.writeText(value); ui.toast("Copied"); }),
    changes: repo => read(`/api/changes?repo=${encodeURIComponent(repo.id)}`),
    sync: async (action, repos) => { const result = await post("/api/git", { action, repos }); ui.scanning(true, "Updating Git state…"); setTimeout(() => waitForScan().catch(e => ui.toast(e.message, true)), 1500); return result.results; },
    rescan: report(async () => { await post("/api/rescan", { github: true }); ui.scanning(true); ui.toast("Scanning GitHub and this machine…"); await waitForScan(); }),
    setAttention: report(async (repo, state) => {
      await post("/api/notes", { repo: repo.id, fields: { focus: state === "focus", parked: state === "parked", hidden: state === "hidden" } });
      await refresh(); ui.toast(state === "hidden" ? "Removed from the world. Restore from Hidden." : "Project visibility updated");
    }),
    saveNotes: async (repo, fields) => { await post("/api/notes", { repo: repo.id, fields }); await refresh(); ui.toast("Notes saved"); },
    appAction: report(async (action, repo, extra = {}) => { const result = await post("/api/apps", { action, repo: repo.id, ...extra }); await refreshApps(); return result; }),
  };
  ui = createUI(app);
  document.querySelector("#list")?.addEventListener("click", e => {
    if (e.target.closest('[aria-label="Close list"]')) tellHost("pane-close");
  });
  async function refreshApps() {
    try { app.apps = await read("/api/apps"); ui.apps(app.apps); } catch (e) { ui.toast(e.message, true); }
  }
  listenHost(message => {
    if (message.type === "theme") { document.body.classList.toggle("night", !!message.night); ui.showNight(!!message.night); }
    if (message.type === "rescan") void app.rescan();
  });
  window.addEventListener("keydown", e => { if (e.key === "Escape" && !e.target.closest("input,textarea")) { e.preventDefault(); app.deselect(); } });
  show();
  tellHost("pane-ready");
  await refreshApps();
  const timer = setInterval(() => { if (!document.hidden) void refreshApps(); }, 8000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
