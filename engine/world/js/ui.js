// Everything on top of the world: search, stats, the repo card, the district card, the list, lenses and time.
import { icon } from "./icons.js";
import { CHANGE, LENSES, pending, riskLevel } from "./lenses.js";
import { familyColor, shedColor } from "./city.js";
import { ago, el, esc, fmtDate, fmtSize, fuzzy, logoImg } from "./util.js";
import { commitUrl } from "./commit-link.js";

const $ = (s) => document.querySelector(s);
const ROLE_NAMES = { canonical: "Main folder", worktree: "Worktree", copy: "Extra clone", release: "Release folder", derived: "Clone of a clone", submodule: "Submodule", vendor: "Vendor clone", orphan: "Local only", clone: "Clone" };
const KIND_NAMES = { mine: null, fork: "Fork", vendor: "Someone else's code", orphan: "Local only", unlisted: "Unlisted remote" };
const STAGE_NAMES = { lot: "Empty lot", tent: "Tent", house: "House", midrise: "Mid-rise", tower: "Tower", skyscraper: "Skyscraper", warehouse: "Warehouse" };
const RECENCY_NAMES = { live: "Active this month", recent: "Active in 3 months", quiet: "Quiet this year", dormant: "Dormant", unknown: "No activity known" };
const hex = (id) => "#" + familyColor(id).getHexString();
const commitSubject = (repo, commit, className) => {
  const href = commitUrl(repo.url, commit.sha);
  return el(href ? "a" : "span", { class: className, ...(href ? { href, target: "_blank", rel: "noopener noreferrer", title: `Open ${commit.sha} on GitHub (new tab). Unpushed commits may not be available yet.` } : {}) }, commit.subject);
};

/** An extra folder whose commits are on a remote, with nothing uncommitted and nothing ignored beyond build output. */
export const nothingUnique = (s) => !!s.spare && s.spare.commitsElsewhere && !s.spare.ignored.length && !s.spare.ignoredMore && !(s.dirty || 0);

export function createUI(app) {
  const ui = { selected: null };
  const doc = app.doc;

  // ---------- chrome ----------
  $("#btn-list").innerHTML = icon("list");
  $("#btn-scan").innerHTML = icon("refresh");
  $("#btn-help").innerHTML = icon("help");
  const soundBtn = $("#btn-sound");
  const showSound = () => {
    soundBtn.innerHTML = icon(app.sound.on ? "volume" : "mute");
    soundBtn.setAttribute("aria-pressed", String(app.sound.on));
    soundBtn.title = app.sound.on ? "Sounds on (M)" : "Sounds off (M)";
  };
  soundBtn.addEventListener("click", () => { app.sound.toggle(); showSound(); });
  showSound();
  $("#play").innerHTML = icon("play");
  for (const b of document.querySelectorAll(".pad button")) b.innerHTML = icon({ in: "plus", out: "minus", left: "left", right: "right", home: "home" }[b.dataset.pad]);
  if (!app.local) $("#btn-scan").remove();

  // ---------- stats chips ----------
  const s = doc.stats;
  // A shared copy shows only what was published, so its chips describe that, not anyone's machine.
  // On your machine the chips answer "what is waiting on me"; a shared copy shows only what was published.
  const chips = app.local ? [
    { n: s.toCommit, label: "to commit", kind: "commit", color: CHANGE.commit, hint: "Repos with changes not committed yet" },
    { n: s.toPush, label: "to push", kind: "push", color: CHANGE.push, hint: "Commits on no remote branch yet, or a folder with no GitHub repo at all" },
    { n: s.toPull, label: "to pull", kind: "pull", color: CHANGE.pull, hint: "GitHub has newer commits than your folder" },
    { n: s.openPRs, label: "PRs", kind: "prs", color: CHANGE.prs, hint: "Pull requests waiting for you on GitHub" },
  ] : [
    { n: doc.repos.length, label: "repos", lens: "map" },
    { n: s.recency.live, label: "active", lens: "activity" },
    { n: s.live, label: "shipped", lens: "shipped" },
  ];
  const where = (r) => (r.onMachine ? (app.local ? "On this machine" : "Cloned by its owner") : r.kind === "orphan" ? "Only on one disk" : app.local ? "Not on this machine" : "On GitHub");
  const chipBox = $("#chips");
  for (const c of chips) {
    const b = c.kind
      ? el("button", { class: "chip", title: c.hint, onclick: () => { app.setLens("changes"); ui.toggleList(true, c.kind); } },
        el("i", { class: "chip-dot", style: `background:${c.color}` }), el("b", {}, c.n), el("span", {}, c.label))
      : el("button", { class: "chip", "data-lens": c.lens, title: LENSES.find((l) => l.id === c.lens).hint, onclick: () => app.setLens(c.lens) },
        el("b", {}, c.n), el("span", {}, c.label));
    chipBox.append(b);
  }

  // What is running on this machine: one chip, filled in by ui.apps.
  const runChip = app.local ? el("button", { class: "chip run-chip", hidden: true, title: "Apps running on this computer: open, stop, start",
    onclick: () => ui.toggleList(true, null, "apps") }, el("i", { class: "chip-dot" }), el("b", {}, "0"), el("span", {}, "running")) : null;
  if (runChip) chipBox.append(runChip);

  // ---------- lenses ----------
  const lensBox = $("#lenses");
  for (const l of LENSES) {
    lensBox.append(el("button", { class: "lens", "data-lens": l.id, title: `${l.hint} (${l.key})`, html: `${icon(l.icon)}<span>${l.name}</span>`, onclick: () => app.setLens(l.id) }));
  }
  ui.showLens = (id) => {
    for (const b of document.querySelectorAll("[data-lens]")) b.classList.toggle("on", b.dataset.lens === id);
    const lens = LENSES.find((l) => l.id === id);
    const leg = $("#legend");
    leg.innerHTML = "";
    if (lens.id !== "map") {
      leg.append(el("div", { class: "hint-line" }, lens.hint));
      for (const item of lens.legend) leg.append(el("span", {}, el("i", { class: item.swatch || "", style: item.color ? `background:${item.color}` : null }), item.label));
    }
  };

  // ---------- search ----------
  const q = $("#q"), results = $("#results");
  const index = doc.repos.filter((r) => !r.hidden).map((r) => ({ r, text: `${r.name} ${r.fullName || ""} ${r.description || ""}` }));
  const districts = doc.families.map((f) => ({ id: f.id, name: f.name, repos: f.repos, district: true }));
  let hits = [], cursor = 0;
  const render = () => {
    results.innerHTML = "";
    if (!q.value.trim()) return (results.hidden = true);
    results.hidden = false;
    if (!hits.length) return results.append(el("li", { class: "empty" }, "Nothing by that name"));
    hits.forEach((r, i) => {
      results.append(el("li", { role: "option", "aria-selected": String(i === cursor), onmousedown: (e) => { e.preventDefault(); choose(r); } },
        el("span", { class: "dot", style: `background:${hex(r.district ? r.id : r.family)}${r.district ? ";border-radius:50%" : ""}` }),
        el("span", { class: "name" }, r.district ? null : logoImg(r, 16), r.name),
        el("span", { class: "meta" }, r.district ? `district · ${r.repos}` : r.onMachine && app.local ? "here" : r.kind === "orphan" ? "local only" : ago(r.lastActivity))));
    });
  };
  const choose = (r) => {
    q.value = "";
    q.blur();
    render();
    if (r.district) app.focusIsland(r.id);
    else app.select(r, { fly: true });
  };
  // Names match loosely (letters in order); descriptions only as a whole phrase, so long text cannot match everything.
  const score = (v, r) => {
    const low = v.toLowerCase();
    return Math.max(fuzzy(v, r.name) * 2, fuzzy(v, r.fullName || ""), (r.description || "").toLowerCase().includes(low) ? 350 : 0);
  };
  q.addEventListener("input", () => {
    const v = q.value.trim();
    let scored = v ? [
      ...districts.map((d) => ({ r: d, s: fuzzy(v, d.name) * 2.2 })),
      ...index.map((x) => ({ r: x.r, s: score(v, x.r) })),
    ].filter((x) => x.s > 0).sort((a, b) => b.s - a.s) : [];
    if (scored[0]?.s >= 900) scored = scored.filter((x) => x.s >= 300);
    hits = scored.slice(0, 8).map((x) => x.r);
    cursor = 0;
    render();
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { cursor = Math.min(cursor + 1, hits.length - 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cursor = Math.max(cursor - 1, 0); render(); e.preventDefault(); }
    else if (e.key === "Enter" && hits[cursor]) choose(hits[cursor]);
    else if (e.key === "Escape") { q.value = ""; render(); q.blur(); }
  });
  q.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 120));
  q.addEventListener("focus", () => q.value && render());

  // ---------- hover tip ----------
  const tip = $("#tip");
  ui.tip = (repo, x, y) => {
    if (!repo) return (tip.hidden = true);
    const l = riskLevel(repo);
    tip.innerHTML = `<b>${esc(repo.name)}</b><span>${esc(where(repo))} · ${esc(ago(repo.lastActivity))}</span>${l ? `<span class="risk">${esc(repo.risks[0].text)}</span>` : ""}`;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.hidden = false;
  };

  // ---------- agents and editors ----------
  // Starting a session comes first: Claude Code and Codex, then editors and the file manager (what this machine has).
  const apps = app.local ? doc.apps || [] : [];
  const APP_ICON = { claude: "spark", codex: "terminal", code: "code", cursor: "pointer", folder: "folder" };
  const ASKS = { issues: "it reads the open issues and resolves them one by one, without pushing", commit: "it looks at the uncommitted changes and suggests commits", push: "it shows the commits not on GitHub yet",
    pull: "it shows what changed on GitHub and whether a pull is safe", prs: "it goes through the open pull requests" };
  const mainSite = (r) => Math.max(0, r.sites.findIndex((x) => x.role === "canonical"));
  function starters(r, i, { intent, small, agentsOnly } = {}) {
    const agents = apps.filter((a) => a.kind === "agent").map((a, n) => el("button", {
      class: `btn${small ? " small" : ""}${!small && n === 0 ? " primary" : ""} agent`,
      disabled: app.canOpen === false,
      title: app.canOpen === false ? "Use Live work to start a session on this remote machine" : `New ${a.name} session in this folder${intent ? `: ${ASKS[intent]}` : ""}`,
      html: `${icon(APP_ICON[a.id])}${a.name}`, onclick: () => app.open(r, i, a.id, intent) }));
    if (agentsOnly) return agents;
    const tools = apps.filter((a) => a.kind !== "agent").map((a) => el("button", {
      class: `btn${small ? " small" : ""} square quiet`, disabled: app.canOpen === false, title: app.canOpen === false ? "Open this tool on the project's host machine" : `Open in ${a.name}`, "aria-label": `Open in ${a.name}`,
      html: icon(APP_ICON[a.id]), onclick: () => app.open(r, i, a.id) }));
    return [...agents, ...tools];
  }

  // ---------- repo card ----------
  const card = $("#card");
  const closeBtn = () => el("button", { class: "icon-btn close", title: "Close (Esc)", "aria-label": "Close", html: icon("close"), onclick: () => app.deselect() });
  const stepBtns = () => el("div", { class: "steppers" },
    el("button", { class: "icon-btn small", title: "Previous in this district ([)", "aria-label": "Previous repo in this district", html: icon("prev"), onclick: () => app.step(-1) }),
    el("button", { class: "icon-btn small", title: "Next in this district (])", "aria-label": "Next repo in this district", html: icon("next"), onclick: () => app.step(1) }));
  ui.showRepo = (r) => {
    ui.selected = r;
    card.innerHTML = "";
    const fam = doc.families.find((f) => f.id === r.family);
    const kind = KIND_NAMES[r.kind];
    const head = el("div", { class: "head" }, closeBtn(), stepBtns(),
      el("div", { class: "eyebrow" }, el("span", { class: "dot", style: `background:${hex(r.family)}` }), fam?.name || "", r.owner ? ` · ${r.owner}` : ""),
      el("h2", { class: "with-logo" }, logoImg(r, 30), r.name),
      r.meaning.purpose ? el("p", { class: "purpose" }, r.meaning.purpose)
        : el("p", { class: "purpose muted" }, r.url ? "No description on GitHub yet." : "No description yet."),
      el("div", { class: "tags" },
        el("span", { class: `tag ${r.recency}` }, RECENCY_NAMES[r.recency]),
        kind ? el("span", { class: "tag" }, kind) : null,
        r.private === true ? el("span", { class: "tag" }, "Private") : r.private === false ? el("span", { class: "tag" }, "Public") : null,
        r.language ? el("span", { class: "tag" }, r.language) : null,
        r.homepage ? el("span", { class: "tag live", title: "Has a website address on GitHub" }, "Shipped") : null,
        r.archived ? el("span", { class: "tag" }, "Archived") : null),
      app.local && r.sites.length && apps.length ? el("div", { class: "start" }, ...starters(r, mainSite(r))) : null,
      app.local ? attention(r) : null);
    const body = el("div", { class: "body" });

    if (app.local) { const a = appSection(r); if (a) body.append(a); }
    const p = pending(r);
    const shown = app.local && p.any ? new Set(["unpushed", "offmap", "uncommitted", "pull", "prs"]) : new Set();
    if (shown.size) body.append(waiting(r, p));
    const rest = r.risks.filter((k) => !shown.has(k.id));
    if (rest.length) {
      body.append(el("section", {}, el("h3", {}, shown.size ? "Also" : "Needs you"),
        ...rest.map((k) => el("div", { class: `risk-item ${k.level}` }, el("i"), k.text))));
    }
    body.append(el("section", {}, el("div", { class: "facts" },
      fact(ago(r.lastActivity), r.lastActivity ? `Last activity · ${fmtDate(r.lastActivity)}` : "Last activity"),
      fact(STAGE_NAMES[r.stage] || "", [Number.isFinite(r.commitCount) ? `${r.commitCount.toLocaleString()} commits` : "", r.sizeKB ? `${fmtSize(r.sizeKB)} on GitHub` : ""].filter(Boolean).join(" · ") || "Size unknown"),
      fact(r.copies ? `${r.copies} folder${r.copies > 1 ? "s" : ""}` : "None", "On this machine"),
      fact(r.sessions ? `${r.sessions} chat${r.sessions > 1 ? "s" : ""}` : "None", r.lastSession ? `Claude Code · ${ago(r.lastSession)}` : "Claude Code"))));

    if ((r.openPRs && !shown.size) || r.openIssues) {
      body.append(el("section", {}, el("h3", {}, "Waiting on GitHub"),
        el("div", { class: "acts-row" },
          r.openPRs && !shown.size ? el("a", { class: "btn small", href: `${r.url}/pulls`, target: "_blank", rel: "noopener", html: `${icon("pr")}${r.openPRs} pull request${r.openPRs > 1 ? "s" : ""}` }) : null,
          r.openIssues ? el("a", { class: "btn small", href: `${r.url}/issues`, target: "_blank", rel: "noopener", html: `${icon("issue")}${r.openIssues} issue${r.openIssues > 1 ? "s" : ""}` }) : null,
          ...(r.openIssues && app.local && r.sites.length && apps.length ? starters(r, mainSite(r), { intent: "issues", small: true, agentsOnly: true }) : []))));
    }

    const commits = r.sites[0]?.commits || [];
    if (commits.length) {
      body.append(el("section", {}, el("h3", {}, "Recent commits"),
        el("ul", { class: "commits" }, ...commits.map((c) => el("li", { title: `${c.sha} · ${fmtDate(c.at)}` },
          commitSubject(r, c, "subject"), el("span", { class: "when" }, ago(c.at)))))));
    }

    const m = r.meaning;
    if (m.next || m.blockers || m.forWhom || m.why) {
      body.append(el("section", {}, el("h3", {}, "Where you left it"),
        m.forWhom ? el("p", { class: "note" }, el("b", {}, "For: "), m.forWhom) : null,
        m.why ? el("p", { class: "note" }, el("b", {}, "Why: "), m.why) : null,
        m.next ? el("p", { class: "note" }, el("b", {}, "Next: "), m.next) : null,
        m.blockers ? el("p", { class: "note" }, el("b", {}, "Blocked: "), m.blockers) : null));
    }

    if (app.local) body.append(notes(r));

    const run = r.sites[0]?.run || [];
    if (run.length && app.local) {
      body.append(el("section", {}, el("h3", {}, "Run it"), el("ul", { class: "runs" }, ...run.map((h) =>
        el("li", {}, el("span", { class: "rname" }, h.name), el("code", { title: h.cmd }, h.cmd),
          h.port ? app.canOpen === false ? el("span", { title: "Port on the remote machine" }, `:${h.port} remote`) : el("a", { href: `http://localhost:${h.port}/`, target: "_blank", rel: "noopener", title: `Open localhost:${h.port} (if it is running)` }, `:${h.port}`) : null)))));
    }

    if (r.sites.length) {
      body.append(el("section", {}, el("h3", {}, r.sites.length > 1 ? `${r.sites.length} folders here` : "On this machine"), ...r.sites.map((s, i) => site(r, s, i))));
    } else if (r.fullName) {
      body.append(el("section", {}, el("h3", {}, "Not on this machine"),
        el("p", { class: "note" }, "Get a copy with:"),
        el("div", { class: "site" }, el("div", { class: "where" }, `gh repo clone ${r.fullName}`),
          el("div", { class: "acts" }, el("button", { class: "btn small", html: `${icon("copy")}Copy`, onclick: () => app.copy(`gh repo clone ${r.fullName}`) })))));
    }

    const foot = el("div", { class: "foot" },
      r.url ? el("a", { class: "btn primary", href: r.url, target: "_blank", rel: "noopener", html: `${icon("github")}GitHub` }) : null,
      r.homepage ? el("a", { class: "btn", href: r.homepage, target: "_blank", rel: "noopener", html: `${icon("external")}Website` }) : null,
      r.fullName ? el("button", { class: "btn", html: `${icon("copy")}Name`, onclick: () => app.copy(r.fullName) }) : null);
    card.append(head, body, foot);
    card.hidden = false;
    document.body.classList.add("card-open");
  };

  /** Your own words about a repo, kept in Hangar's spine (never written into the repo). */
  function notes(r) {
    const sec = el("section", { class: "notes" });
    const n = r.notes || {};
    const view = () => {
      sec.innerHTML = "";
      const has = n.purpose || n.forWhom || n.next || n.family;
      sec.append(...[el("h3", {}, "Your notes"),
        has ? el("p", { class: "note" }, [n.purpose, n.forWhom && `For ${n.forWhom}`, n.next && `Next: ${n.next}`].filter(Boolean).join(" · ")) : null,
        el("button", { class: "btn small", html: `${icon("edit")}${has ? "Edit notes" : "Write notes"}`, onclick: edit })].filter(Boolean));
    };
    const field = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);
    const edit = () => {
      sec.innerHTML = "";
      const purpose = el("textarea", { rows: 3, maxlength: 400, placeholder: r.description || "What is it, in a sentence?" });
      purpose.value = n.purpose || "";
      const forWhom = el("input", { maxlength: 200, placeholder: "Who it is for" });
      forWhom.value = n.forWhom || "";
      const next = el("input", { maxlength: 200, placeholder: "The next step" });
      next.value = n.next || "";
      const family = el("div", { class: "district-choice", role: "radiogroup", "aria-label": "District" });
      for (const f of [{ id: "", name: "Automatic" }, ...doc.families.filter((f) => !["vendor", "offmap"].includes(f.id))]) {
        const input = el("input", { type: "radio", name: `family-${r.id}`, value: f.id });
        input.checked = f.id === (n.family || "");
        family.append(el("label", {}, input, el("span", {}, f.name)));
      }
      const err = el("p", { class: "field-error", hidden: true });
      const save = el("button", { class: "btn primary small", onclick: async () => {
        save.disabled = true;
        err.hidden = true;
        try {
          await app.saveNotes(r, { purpose: purpose.value, forWhom: forWhom.value, next: next.value, family: family.querySelector("input:checked")?.value || "" });
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          save.disabled = false;
        }
      } }, "Save");
      sec.append(el("h3", {}, "Your notes"),
        field("What it is", purpose), field("For", forWhom), field("Next", next), el("div", { class: "field" }, el("span", {}, "District"), family), err,
        el("div", { class: "acts" }, save, el("button", { class: "btn small", onclick: view }, "Cancel")));
      purpose.focus();
    };
    view();
    return sec;
  }

  function fact(big, small) {
    return el("div", { class: "fact" }, el("b", {}, big), el("span", {}, small));
  }

  function site(r, s, i) {
    const badges = [];
    if (s.branch) badges.push(el("span", { class: "badge" }, s.branch));
    else if (s.head) badges.push(el("span", { class: "badge" }, `detached ${s.head}`));
    if (s.dirty) badges.push(el("span", { class: "badge warn" }, `${s.dirty} uncommitted`));
    const heldOn = s.aheadOnRemote || s.spare?.onRemote;
    if (s.ahead) badges.push(heldOn
      ? el("span", { class: "badge", title: `These commits are already on ${heldOn} (as of the last fetch)` }, `${s.ahead} ahead · on ${heldOn}`)
      : el("span", { class: "badge bad", title: "On no remote branch as of the last fetch" }, `${s.ahead} ahead`));
    if (s.behind) badges.push(el("span", { class: "badge" }, `${s.behind} behind`));
    const v = s.spare;
    if (v) {
      if (nothingUnique(s)) badges.push(el("span", { class: "badge ok", title: "Its commits are on a remote branch (as of its last fetch); nothing uncommitted; git ignores only rebuilt output here" }, "nothing unique"));
      else {
        if (!v.commitsElsewhere) badges.push(el("span", { class: "badge bad", title: "Its current commit is on no remote branch (as of its last fetch)" }, "commits found nowhere else"));
        if (v.ignored.length) badges.push(el("span", { class: "badge warn", title: `Ignored by git, not build output: ${v.ignored.join(", ")}${v.ignoredMore ? ` and ${v.ignoredMore} more` : ""}` }, `keeps ${v.ignored[0]}${v.ignored.length + v.ignoredMore > 1 ? ` +${v.ignored.length + v.ignoredMore - 1}` : ""}`));
      }
    }
    return el("div", { class: "site" },
      el("div", { class: "where" }, el("em", {}, `${s.root}:`), s.rel ? ` ${s.rel}` : " (root)"),
      el("div", { class: "row" },
        el("span", { class: "role" }, el("i", { style: `background:${shedColor(s.role)}` }), ROLE_NAMES[s.role] || s.role),
        ...badges,
        s.lastCommit ? el("span", {}, `commit ${ago(s.lastCommit)}`) : null),
      app.local && apps.length ? el("div", { class: "acts" }, ...starters(r, i, { small: true })) : null);
  }

  // ---------- apps: run, open, stop ----------
  let appState = null;
  const appsOf = (r) => appState?.apps.find((a) => a.repo === r.id);
  ui.apps = (s) => {
    appState = s;
    if (runChip) { runChip.hidden = !s.running; runChip.querySelector("b").textContent = s.running; }
    const sec = card.querySelector(".app-section");
    if (sec && ui.selected && sec.dataset.repo === ui.selected.id) { const fresh = appSection(ui.selected); if (fresh) sec.replaceWith(fresh); }
    if (!list.hidden && filter === "apps") refill?.();
  };
  /** Stop asks once more when Hangar did not start it: it may be another session's server. */
  function stopBtn(r, x) {
    const b = el("button", { class: "btn small", html: `${icon("stop")}Stop`,
      disabled: app.canControlApps === false,
      title: x.by === "atlas" ? "Stop it" : "Started outside Hangar (maybe by an agent session): press again to stop it",
      onclick: () => {
        if (x.by !== "atlas" && !b.dataset.sure) { b.dataset.sure = "1"; b.innerHTML = `${icon("stop")}Stop it?`; return; }
        app.appAction("stop", r, { port: x.port });
      } });
    return b;
  }
  const openBtns = (r, x) => app.canControlApps === false ? [el("span", { class: "note" }, "Manage apps on their host machine")] : [
    el("button", { class: "btn small primary", html: `${icon("window")}Open`, title: "Open in its own window", onclick: () => app.appAction("open", r, { port: x.port, how: "window" }) }),
    el("button", { class: "btn small square quiet", html: icon("external"), title: "Open as a browser tab", "aria-label": "Open as a browser tab", onclick: () => app.appAction("open", r, { port: x.port, how: "tab" }) }),
    stopBtn(r, x)];
  function targetRow(r, x, a, t) {
    const job = x.jobs[`${a.dir}:${t.id}`] || {};
    const live = (job.state === "running" && job.port && x.running.some((p) => p.port === job.port)) || (t.port && x.running.some((p) => p.port === t.port));
    const state = !t.ok ? "no" : live ? "on" : job.state === "starting" ? "busy" : "ok";
    const note = !t.ok ? t.why : job.state === "starting" || job.state === "failed" || job.state === "terminal" ? job.message : live ? "running" : t.port ? `:${t.port}` : "";
    return el("div", { class: `target ${state}` }, el("i", { class: "tdot" }), el("b", {}, t.label),
      el("span", { class: `tnote${job.state === "failed" ? " bad" : ""}`, title: note || "" }, note || ""),
      t.ok && !live && job.state !== "starting" ? el("button", { class: "btn small", disabled: app.canControlApps === false, html: `${icon("play")}Run`,
        title: t.type === "server" ? "Start it and open it in its own window" : "Start it in a terminal window",
        onclick: () => app.appAction("start", r, { target: t.id }) }) : null);
  }
  function appSection(r) {
    const x = appsOf(r);
    const known = r.sites.some((s) => (s.apps || []).length);
    if (!x && !known) return null;
    const sec = el("section", { class: "app-section", "data-repo": r.id }, el("h3", {}, "App"));
    if (!x) return sec.append(el("p", { class: "note" }, "Checking what runs here...")), sec;
    for (const live of x.running) {
      sec.append(el("div", { class: "running-row" }, el("i", { class: "tdot" }),
        el("b", {}, `Running at :${live.port}`), el("span", { class: "tnote" }, live.by === "atlas" ? "started here" : "started outside Hangar"),
        el("div", { class: "acts" }, ...openBtns(r, live))));
    }
    for (const a of x.apps) {
      // Targets that can't run here for the same reason share one line: "Android, Web: Flutter isn't installed".
      const blocked = new Map();
      for (const t of a.targets.filter((y) => !y.ok)) blocked.set(t.why, [...(blocked.get(t.why) || []), t.label]);
      sec.append(el("div", { class: "app-name" }, a.label, a.dir ? el("span", {}, ` · ${a.dir}/`) : null),
        ...a.targets.filter((t) => t.ok).map((t) => targetRow(r, x, a, t)),
        ...[...blocked].map(([why, labels]) => el("div", { class: "target no" }, el("i", { class: "tdot" }), el("b", {}, labels.join(", ")),
          el("span", { class: "tnote", title: why }, why))));
    }
    return sec;
  }
  /** Every app on this machine: what runs now, what can run here, and what needs something else. */
  function appsList(body) {
    if (!appState) return body.append(el("p", { class: "note", style: "padding:14px" }, "Checking what runs..."));
    const visible = new Set(doc.repos.filter((r) => !r.hidden).map((r) => r.id));
    const rows = appState.apps.filter((x) => visible.has(x.repo));
    const byId = new Map(doc.repos.map((r) => [r.id, r]));
    const running = rows.filter((x) => x.running.length);
    const can = rows.filter((x) => !x.running.length && x.apps.some((a) => a.targets.some((t) => t.ok)));
    const cannot = rows.filter((x) => !x.running.length && x.apps.length && !x.apps.some((a) => a.targets.some((t) => t.ok)));
    const m = appState.machine;
    body.append(el("p", { class: "note", style: "padding:10px 12px 0" },
      `This ${m.os === "mac" ? "Mac" : m.os === "windows" ? "Windows PC" : "computer"}: ${[m.node && "web apps", m.flutter && "Flutter", m.androidSdk && "Android", m.xcode && "iPhone"].filter(Boolean).join(", ") || "nothing set up yet"}.`));
    const section = (title, color, list, row) => {
      body.append(el("h4", {}, el("span", { class: "dot", style: `background:${color}` }), `${title} · ${list.length}`));
      if (!list.length) body.append(el("p", { class: "note", style: "padding:2px 12px 8px" }, "None."));
      for (const x of list) { const r = byId.get(x.repo); if (r) body.append(row(r, x)); }
    };
    const name = (r) => el("div", { class: "change-name", onclick: () => app.select(r, { fly: true }) }, logoImg(r, 18), r.name);
    section("Running now", "#2fbf71", running, (r, x) => el("div", { class: "site change-row" }, name(r),
      ...x.running.map((live) => el("div", { class: "row" }, `:${live.port} · ${live.by === "atlas" ? "started here" : "started outside Hangar"}`)),
      el("div", { class: "acts" }, ...openBtns(r, x.running[0]))));
    section("Can run here", "#4aa3ff", can, (r, x) => {
      const a = x.apps.find((y) => y.targets.some((t) => t.ok)), t = a.targets.find((y) => y.ok);
      const job = x.jobs[`${a.dir}:${t.id}`] || {};
      return el("div", { class: "site change-row" }, name(r), el("div", { class: "row" }, `${a.label}${a.dir ? ` · ${a.dir}/` : ""}`),
        job.state === "starting" || job.state === "failed" ? el("div", { class: `row${job.state === "failed" ? " bad" : ""}` }, job.message) : null,
        el("div", { class: "acts" }, job.state === "starting" ? null : el("button", { class: "btn small", disabled: app.canControlApps === false, html: `${icon("play")}Run ${t.label.toLowerCase()}`, onclick: () => app.appAction("start", r, { target: t.id }) })));
    });
    section("Needs something else", "#98a2ad", cannot, (r, x) => el("div", { class: "site change-row" }, name(r),
      el("div", { class: "row" }, `${x.apps[0].label}: ${x.apps[0].targets[0]?.why || "can't run here"}`)));
  }

  // ---------- pull and push ----------
  // The one place Hangar writes to your repos, and only when you press it: fast-forward pulls, plain pushes, never forced.
  const SYNC = { pull: { label: "Pull", icon: "down", verb: "Pulling" }, push: { label: "Push", icon: "up", verb: "Pushing" } };
  const RESULT = { done: "ok", current: "quiet", skipped: "warn", blocked: "warn", diverged: "warn", rejected: "warn", failed: "bad" };
  const resultLine = (x) => el("div", { class: `git-result ${RESULT[x.status] || "warn"}` },
    el("i", { html: icon(x.status === "done" ? "check" : x.status === "current" ? "check" : "alert") }), x.message);
  /** Run a pull or push for some repos; show each result where it belongs (show(result) returns the place). */
  async function sync(action, repos, show, button) {
    if (button) { button.disabled = true; button.innerHTML = `${icon(SYNC[action].icon)}${SYNC[action].verb}...`; }
    try {
      const results = await app.sync(action, repos.map((r) => r.id));
      for (const x of results) {
        const place = show(x);
        place?.append(resultLine(x));
        for (const b of place?.querySelectorAll?.(".sync") || []) b.disabled = true;
      }
      const done = results.filter((x) => x.status === "done").length, need = results.filter((x) => !["done", "current"].includes(x.status)).length;
      ui.toast(`${action === "pull" ? "Pulled" : "Pushed"} ${done} of ${results.length}${need ? ` · ${need} need you` : ""}`, need > 0 && !done);
      if (button) button.innerHTML = `${icon("check")}Done`;
    } catch (e) {
      ui.toast(e.message, true);
      if (button) { button.disabled = false; button.innerHTML = `${icon(SYNC[action].icon)}${SYNC[action].label}`; }
    }
  }
  function syncBtn(action, r, show) {
    const b = el("button", { class: "btn small sync", title: action === "pull" ? "Fast-forward to what GitHub has (never merges, never touches uncommitted files)" : "Push this branch's commits to its remote branch (never forced)",
      html: `${icon(SYNC[action].icon)}${SYNC[action].label}`, onclick: () => sync(action, [r], show, b) });
    return b;
  }
  /** "Pull all" in a list heading, with a one-line confirmation in place. */
  function syncAll(action, repos, rowOf) {
    const box = el("span", { class: "sync-all" });
    const idle = () => box.replaceChildren(el("button", { class: "btn small", html: `${icon(SYNC[action].icon)}${SYNC[action].label} all`, onclick: ask }));
    const ask = () => {
      const go = el("button", { class: "btn small primary", html: `${icon(SYNC[action].icon)}${SYNC[action].label} ${repos.length}`,
        onclick: () => { box.replaceChildren(el("span", { class: "sync-note" }, `${SYNC[action].verb} ${repos.length}...`)); sync(action, repos, (x) => rowOf(x.repo)).then(() => box.replaceChildren(el("span", { class: "sync-note" }, "Done: see each row"))); } });
      box.replaceChildren(go, el("button", { class: "btn small", onclick: idle }, "Cancel"));
    };
    idle();
    return box;
  }

  /** What is waiting on this repo, by kind, then the exact files, commits and pull requests, read live. */
  function waiting(r, p) {
    const groups = [];
    const group = (kind, title, sub) => {
      const list = el("div", { class: "wait-list" }, el("p", { class: "more" }, "Reading..."));
      const g = el("div", { class: "wait", style: `--c:${CHANGE[kind]}` },
        el("div", { class: "wait-head" }, el("i"), el("b", {}, title), sub ? el("span", {}, sub) : null), list,
        r.sites.length && apps.length ? el("div", { class: "acts" },
          kind === "pull" || (kind === "push" && p.push?.id === "unpushed") ? syncBtn(kind, r, () => list) : null,
          ...starters(r, mainSite(r), { intent: kind, small: true, agentsOnly: true }),
          kind === "prs" && r.url ? el("a", { class: "btn small", href: `${r.url}/pulls`, target: "_blank", rel: "noopener", html: `${icon("github")}GitHub` }) : null) : null);
      groups.push([kind, list]);
      return g;
    };
    const sec = el("section", { class: "waiting" }, el("h3", {}, "Waiting on you"),
      p.dirty ? group("commit", `${p.dirty} uncommitted`, "not committed yet") : null,
      p.push ? group("push", p.push.id === "offmap" ? "Not on GitHub at all" : "Not pushed", "commits on no remote branch") : null,
      p.pull ? group("pull", "New on GitHub", "not in your folder yet") : null,
      p.prs ? group("prs", `${p.prs} pull request${p.prs > 1 ? "s" : ""}`, "open on GitHub") : null);
    const rows = (items, more, line) => {
      const ul = el("ul", {}, ...items.slice(0, 6).map(line));
      const extra = items.length - 6 + (more || 0);
      return extra > 0 ? [ul, el("p", { class: "more" }, `and ${extra} more`)] : [ul];
    };
    app.changes(r).then((c) => {
      if (ui.selected !== r) return;
      const fill = (kind, nodes) => { const list = groups.find(([k]) => k === kind)?.[1]; if (list) list.replaceChildren(...nodes); };
      const dirty = c.folders.filter((f) => f.files.total);
      fill("commit", dirty.flatMap((f) => [dirty.length > 1 || f.role !== "canonical" ? el("p", { class: "more" }, f.where) : null,
        ...rows(f.files.items, f.files.more, (x) => el("li", {}, el("span", { class: `k ${x.state}` }, x.state), el("span", { class: "t", title: x.path }, x.path)))].filter(Boolean)));
      const ahead = c.folders.find((f) => f.unpushed.noRemote || f.unpushed.commits.length);
      fill("push", !ahead ? [el("p", { class: "more" }, "Nothing found now: it may have been pushed since the last scan.")]
        : ahead.unpushed.noRemote ? [el("p", { class: "more" }, "This folder has no remote: nothing in it is on GitHub.")]
        : rows(ahead.unpushed.commits, ahead.unpushed.more ? 1 : 0, (x) => el("li", { title: x.sha }, el("span", { class: "t" }, x.subject), el("span", { class: "k" }, ago(x.at)))));
      const inc = c.incoming;
      fill("pull", !inc ? [el("p", { class: "more" }, "Nothing found now: it may have been pulled since the last scan.")]
        : inc.unknown ? [el("p", { class: "more" }, "Could not read GitHub just now.")]
        : rows(inc.commits, inc.more ? 1 : 0, (x) => el("li", { title: `${x.sha} by ${x.author}` }, commitSubject(r, x, "t"), el("span", { class: "k" }, ago(x.at)))));
      fill("prs", !c.prs ? [el("p", { class: "more" }, "Could not read GitHub just now.")]
        : rows(c.prs, 0, (x) => el("li", {}, el("a", { class: "t", href: x.url, target: "_blank", rel: "noopener", title: x.title }, `#${x.number} ${x.title}`),
          el("span", { class: "k" }, x.draft ? "draft" : x.author))));
    }).catch(() => { for (const [, list] of groups) list.replaceChildren(el("p", { class: "more" }, "Could not read the details just now.")); });
    return sec;
  }

  // ---------- district card ----------
  ui.showDistrict = (spot) => {
    ui.selected = null;
    card.innerHTML = "";
    const repos = spot.cells.map((c) => c.repo);
    const here = repos.filter((r) => r.onMachine).length, live = repos.filter((r) => r.homepage).length;
    const risky = repos.filter((r) => riskLevel(r)).length, active = repos.filter((r) => r.recency === "live").length;
    card.append(
      el("div", { class: "head" }, closeBtn(),
        el("div", { class: "eyebrow" }, el("span", { class: "dot", style: `background:${hex(spot.id)}` }), "District"),
        el("h2", {}, spot.family.name),
        el("div", { class: "tags" }, el("span", { class: "tag" }, `${repos.length} repos`), el("span", { class: "tag live" }, `${live} live`), el("span", { class: "tag" }, `${here} here`))),
      el("div", { class: "body" },
        el("section", {}, el("div", { class: "facts" }, fact(active, "Active this month"), fact(risky, "Need you"))),
        el("section", {}, el("ul", { class: "members" }, ...repos.map((r) => memberRow(r))))));
    card.hidden = false;
    document.body.classList.add("card-open");
  };

  function memberRow(r) {
    const p = pending(r);
    const what = [p.dirty && `${p.dirty} uncommitted`, p.push && "push", p.pull && "pull", p.prs && `${p.prs} PR${p.prs > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
    return el("li", { onclick: () => app.select(r, { fly: true }) },
      el("span", { class: "dot", style: `background:${{ live: "#ffad4d", recent: "#f4d35e", quiet: "#78c6a3", dormant: "#8399b3" }[r.recency] || "#a0a4a8"}` }),
      el("span", { class: "n" }, logoImg(r, 16), r.name),
      el("span", { class: `m${what ? " warn" : ""}` }, what || (r.onMachine ? "here" : ago(r.lastActivity))));
  }

  /** Focus, Park or Hide: your say over what the map shows. */
  function attention(r) {
    const state = r.hidden ? "hidden" : r.attention;
    const opt = (id, label, ic, title) => el("button", {
      class: `attn-btn${state === id ? " on" : ""}`, title, "aria-pressed": String(state === id),
      html: `${icon(ic)}<span>${label}</span>`, onclick: () => app.setAttention(r, state === id ? null : id),
    });
    return el("div", { class: "attn" },
      opt("focus", "Focus", "star", "Important now. Keeps its category."),
      opt("parked", "Park", "park", "Relevant, but later. Keeps its category and stays on the map."),
      opt("hidden", "Off the map", "hide", "Not relevant. Hidden from the map; recoverable from Off the map."));
  }

  ui.hideCard = () => {
    ui.selected = null;
    card.hidden = true;
    document.body.classList.remove("card-open");
  };

  // ---------- list ----------
  const list = $("#list");
  let filter = app.local ? "changes" : "all", kind = null;
  const FILTERS = [...(app.local ? [["changes", "Changes"], ["apps", "Apps"]] : []), ["all", "All"], ["focus", "Focus"], ["here", "Here"], ["away", "Not here"],
    ["shipped", "Shipped"], ["parked", "Parked"], ...(app.local ? [["hidden", "Off the map"], ["spare", "Spare folders"]] : [])];
  const keep = { all: () => true, focus: (r) => r.attention === "focus", here: (r) => r.onMachine, away: (r) => !r.onMachine,
    shipped: (r) => !!r.homepage, parked: (r) => r.attention === "parked" };
  let refill = null;
  ui.toggleList = (force, only, view) => {
    const show = force ?? list.hidden;
    if (!show) return (list.hidden = true);
    if (only) { filter = "changes"; kind = only; }
    if (view) { filter = view; kind = null; }
    list.innerHTML = "";
    const body = el("div", { class: "body" });
    const fill = () => {
      body.innerHTML = "";
      if (filter === "apps") return appsList(body);
      if (filter === "spare") return spareFolders(body);
      if (filter === "changes") return changesList(body, kind);
      if (filter === "hidden") return hiddenList(body);
      for (const spot of app.islands.map((i) => i.spot)) {
        const repos = spot.cells.map((c) => c.repo).filter(keep[filter]);
        if (!repos.length) continue;
        body.append(el("h4", {}, el("span", { class: "dot", style: `background:${hex(spot.id)}` }), `${spot.family.name} · ${repos.length}`),
          el("ul", { class: "members" }, ...repos.map(memberRow)));
      }
      if (!body.children.length) body.append(el("p", { class: "note", style: "padding:14px" }, "Nothing matches."));
    };
    const filters = el("div", { class: "filters" }, ...FILTERS.map(([id, name]) =>
      el("button", { class: id === filter ? "on" : "", onclick: (e) => { filter = id; kind = null; for (const b of filters.children) b.classList.toggle("on", b === e.currentTarget); fill(); } }, name)));
    list.append(el("div", { class: "head" }, el("h2", {}, `${doc.repos.filter((r) => !r.hidden).length} repos`), el("button", { class: "icon-btn", "aria-label": "Close list", html: icon("close"), onclick: () => ui.toggleList(false) })), filters, body);
    fill();
    refill = () => { const top = body.scrollTop; fill(); body.scrollTop = top; };
    list.hidden = false;
  };
  /** What is waiting on you, by kind: commit, push, pull, review. The answer to "is anything pending?" */
  function changesList(body, only) {
    const visible = doc.repos.filter((r) => !r.hidden);
    const kinds = [
      ["commit", "To commit", (r) => pending(r).dirty > 0, (r) => r.sites.filter((x) => x.dirty).flatMap((x) => [
        `${x.dirty} uncommitted · ${x.rel ? x.rel : `${x.root} (whole folder)`}${x.role !== "canonical" ? ` · ${ROLE_NAMES[x.role] || x.role}` : ""}`,
        ...(x.dirtyFiles?.length ? [el("span", { class: "files" }, x.dirtyFiles.map((f) => f.path.replace(/\/$/, "").split("/").pop() + (f.path.endsWith("/") ? "/" : "")).join(" · ")
          + (x.dirty > x.dirtyFiles.length ? ` +${x.dirty - x.dirtyFiles.length} more` : ""))] : [])])],
      ["push", "To push", (r) => !!pending(r).push, (r) => [pending(r).push.text]],
      ["pull", "To pull", (r) => !!pending(r).pull, (r) => [pending(r).pull.text]],
      ["prs", "Pull requests waiting", (r) => r.openPRs > 0, (r) => [`${r.openPRs} open on GitHub`]],
      ["issues", "Issues open", (r) => r.openIssues > 0, (r) => [`${r.openIssues} open issue${r.openIssues > 1 ? "s" : ""} on GitHub`]],
    ];
    for (const [id, title, has, lines] of kinds) {
      if (only && id !== only) continue;
      const repos = visible.filter(has);
      const rows = new Map();
      const canSync = (id === "pull" || id === "push") && app.local && apps.length;
      const syncable = canSync ? repos.filter((r) => r.sites.length && (id === "pull" || pending(r).push?.id === "unpushed")) : [];
      body.append(el("h4", {}, el("span", { class: "dot", style: `background:${CHANGE[id]}` }), `${title} · ${repos.length}`,
        syncable.length ? syncAll(id, syncable, (rid) => rows.get(rid)) : null));
      if (!repos.length) {
        body.append(el("p", { class: "note", style: "padding:2px 12px 8px" }, "Nothing here."));
        continue;
      }
      for (const r of repos) {
        const i = Math.max(0, r.sites.findIndex((x) => (id === "commit" ? x.dirty : x.role === "canonical")));
        const local = r.sites.length && apps.length;
        const row = el("div", { class: "site change-row", "data-repo": r.id },
          el("div", { class: "change-name", onclick: () => app.select(r, { fly: true }) }, logoImg(r, 18), r.name),
          ...lines(r).map((t) => el("div", { class: "row" }, t)),
          el("div", { class: "acts" },
            syncable.includes(r) ? syncBtn(id, r, () => row) : null,
            id === "prs" ? el("a", { class: "btn small", href: `${r.url}/pulls`, target: "_blank", rel: "noopener", html: `${icon("pr")}Review` }) : null,
            id === "issues" ? el("a", { class: "btn small", href: `${r.url}/issues`, target: "_blank", rel: "noopener", html: `${icon("issue")}Issues` }) : null,
            ...(local ? starters(r, i, { intent: id, small: true }) : [])));
        rows.set(r.id, row);
        body.append(row);
      }
    }
    if (only) body.append(el("button", { class: "btn small", style: "margin:10px", onclick: () => { kind = null; ui.toggleList(true); } }, "Show every kind"));
  }

  /** Repos you hid, so they can come back. */
  function hiddenList(body) {
    const hidden = doc.repos.filter((r) => r.hidden);
    body.append(el("p", { class: "note", style: "padding:10px 10px 4px" }, hidden.length
      ? `${hidden.length} hidden. They stay off the map and out of every count.`
      : "Nothing hidden. Use Hide on a repo's card to take it off the map."));
    for (const r of hidden) {
      body.append(el("div", { class: "site" }, el("div", { class: "change-name" }, r.name),
        el("div", { class: "row" }, r.meaning.purpose ? r.meaning.purpose.slice(0, 90) : ago(r.lastActivity)),
        el("div", { class: "acts" }, el("button", { class: "btn small", html: `${icon("eye")}Show again`, onclick: () => app.setAttention(r, null) }))));
    }
  }

  /** Every extra folder on this machine that holds nothing unique: a cleanup checklist. Hangar deletes nothing. */
  function spareFolders(body) {
    const rows = [];
    for (const r of doc.repos) r.sites.forEach((s, i) => nothingUnique(s) && rows.push({ r, s, i }));
    body.append(el("p", { class: "note", style: "padding:10px 10px 4px" },
      rows.length ? `${rows.length} extra folders whose commits are on a remote, with nothing uncommitted and nothing ignored beyond build output (as of each folder's last fetch). Hangar deletes nothing; open one to check it yourself.`
        : "No extra folder on this machine is a spare copy."));
    const byRepo = new Map();
    for (const row of rows) byRepo.set(row.r, [...(byRepo.get(row.r) || []), row]);
    for (const [r, list] of byRepo) {
      body.append(el("h4", {}, el("span", { class: "dot", style: `background:${hex(r.family)}` }), `${r.name} · ${list.length}`));
      for (const { s, i } of list) {
        body.append(el("div", { class: "site" },
          el("div", { class: "where" }, el("em", {}, `${s.root}:`), ` ${s.rel}`),
          el("div", { class: "row" }, el("span", { class: "role" }, el("i", { style: `background:${shedColor(s.role)}` }), ROLE_NAMES[s.role] || s.role),
            s.spare?.onRemote ? el("span", { class: "badge" }, `on ${s.spare.onRemote}`) : null,
            s.lastCommit ? el("span", {}, `commit ${ago(s.lastCommit)}`) : null),
          el("div", { class: "acts" }, el("button", { class: "btn small", html: `${icon("folder")}Open`, onclick: () => app.open(r, i, "folder") }))));
      }
    }
  }

  $("#btn-list").addEventListener("click", () => ui.toggleList());

  // ---------- time ----------
  const when = $("#when"), whenLabel = $("#when-label"), play = $("#play");
  const born = doc.repos.map((r) => Date.parse(r.createdAt || r.lastActivity || "")).filter(Number.isFinite);
  const t0 = born.length ? Math.min(...born) : Date.now() - 365 * 864e5, t1 = Date.now();
  const toTime = (v) => t0 + ((t1 - t0) * v) / 1000;
  ui.timeRange = [t0, t1];
  const setWhen = (v, user) => {
    when.value = v;
    const t = toTime(v);
    whenLabel.textContent = v >= 1000 ? "Today" : new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short" });
    app.setTime(v >= 1000 ? null : t, user);
  };
  when.addEventListener("input", () => { stopPlay(); setWhen(+when.value, true); });
  let playing = null;
  const stopPlay = () => { if (playing) { cancelAnimationFrame(playing); playing = null; play.innerHTML = icon("play"); play.setAttribute("aria-label", "Replay project arrivals"); } };
  play.addEventListener("click", () => {
    if (playing) return stopPlay();
    let v = +when.value >= 1000 ? 0 : +when.value, last = performance.now();
    play.innerHTML = icon("pause"); play.setAttribute("aria-label", "Pause project replay");
    const tick = (now) => {
      v = Math.min(1000, v + (now - last) * 0.09);
      last = now;
      setWhen(Math.round(v), false);
      playing = v < 1000 ? requestAnimationFrame(tick) : (stopPlay(), null);
    };
    playing = requestAnimationFrame(tick);
  });

  // ---------- day and night ----------
  ui.showNight = (night) => {
    $("#btn-time").innerHTML = icon(night ? "sun" : "moon");
    $("#btn-time").title = night ? "Daylight (N)" : "Night (N)";
    document.body.classList.toggle("night", night);
  };
  $("#btn-time").addEventListener("click", () => app.toggleNight());

  // ---------- how fresh this is ----------
  const fresh = $("#fresh");
  ui.fresh = () => {
    if (!fresh) return;
    const m = doc.machine?.scannedAt, g = doc.github?.fetchedAt;
    if (!m && !g) return (fresh.hidden = true);
    fresh.textContent = `Updated ${ago(m || g)}`;
    fresh.title = `This machine checked ${ago(m)} · GitHub ${ago(g)}` +
      (app.local ? " · Hangar checks again by itself: this machine every 15 minutes, GitHub every hour" : "");
    fresh.hidden = false;
  };
  ui.fresh();
  setInterval(ui.fresh, 60000);

  // ---------- rescan ----------
  $("#btn-scan")?.addEventListener("click", () => app.rescan());
  ui.scanning = (busy, text) => {
    const b = $("#btn-scan");
    if (!b) return;
    b.classList.toggle("busy", busy);
    b.title = busy ? text || "Scanning..." : "Rescan GitHub and this machine";
  };

  // ---------- hint, notice, toast ----------
  const hint = $("#hint");
  ui.showHint = () => {
    hint.innerHTML = [
      ["drag", "Drag to move"], ["rotate", "Right-drag to turn"], ["wheel", "Scroll to zoom"], ["search", "Press / to find a repo"],
    ].map(([i, t]) => `<div>${icon(i)}${t}</div>`).join("");
    hint.hidden = false;
  };
  ui.hideHint = () => (hint.hidden = true);
  $("#btn-help").addEventListener("click", () => (hint.hidden ? ui.showHint() : ui.hideHint()));

  ui.notice = (html) => {
    const n = $("#notice");
    n.innerHTML = html;
    n.append(el("button", { class: "icon-btn small", "aria-label": "Dismiss", html: icon("close"), onclick: () => (n.hidden = true) }));
    n.hidden = false;
  };

  ui.news = () => {
    if (document.getElementById("news")) return;
    document.body.append(el("button", { id: "news", class: "news", title: "Reload with the latest scan", onclick: () => location.reload(),
      html: `${icon("refresh")}<span>The map has news</span>` }));
  };

  let toastTimer;
  ui.toast = (text, bad) => {
    const t = $("#toast");
    t.textContent = text;
    t.className = `toast${bad ? " bad" : ""}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  };

  return ui;
}
