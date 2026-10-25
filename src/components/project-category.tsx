"use client";
import { useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { ArrowLeft, Check, ChevronsUpDown, Folder, Loader2, Pencil, Plus, Search } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import type { Island } from "@/lib/islands";
import "./project-category.css";

export default function ProjectCategory({ machine, project, islands, onChanged }: {
  machine: string; project: { id: string; family: string }; islands: Island[]; onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [mode, setMode] = useState<"pick" | "create" | "rename">("pick"), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const current = islands.find(i => i.id === project.family);
  const choices = islands.filter(i => !i.hidden || i.id === project.family).sort((a, b) => a.name.localeCompare(b.name));
  const duplicate = islands.some(i => i.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase() && (mode !== "rename" || i.id !== project.family));
  async function save(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      await workspaceResponse(await fetch(`/api/world/${machine}/proxy/islands`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify(body) }));
      await onChanged(); setOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="project-category">
    <Combobox.Root<Island> items={choices} value={current || null} itemToStringLabel={i => i.name} isItemEqualToValue={(a, b) => a.id === b.id} open={open} onOpenChange={value => { if (busy) return; setOpen(value); if (value) { setMode("pick"); setQuery(""); setError(""); } }} inputValue={query} onInputValueChange={setQuery} onValueChange={value => { if (mode === "pick" && !busy && value && value.id !== project.family) void save({ action: "assign-island", island: value.id, repos: [project.id] }); }}>
      <Combobox.Trigger className="pc-trigger" disabled={busy} aria-label={`Change category: ${current?.name || "Uncategorized"}`}><Folder size={14}/><span>{current?.name || "Uncategorized"}</span>{busy ? <Loader2 size={14} className="pc-spinner"/> : <ChevronsUpDown size={14}/>}</Combobox.Trigger>
      <Combobox.Portal><Combobox.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="pc-positioner"><Combobox.Popup className="pc-popup" initialFocus={search}>
        <div hidden={mode !== "pick"}>
          <div className="pc-search"><Search size={16}/><Combobox.Input ref={search} placeholder="Find a category…" aria-label="Search categories" disabled={busy}/></div>
          <Combobox.Empty className="pc-empty">No matching categories.</Combobox.Empty>
          <Combobox.List className="pc-list">{(island: Island) => <Combobox.Item key={island.id} value={island} disabled={busy || mode !== "pick" || island.hidden} className="pc-option"><span>{island.name}{island.hidden ? " · hidden" : ""}</span><small>{island.repos}</small><Combobox.ItemIndicator><Check size={15}/></Combobox.ItemIndicator></Combobox.Item>}</Combobox.List>
          <div className="pc-footer"><button disabled={busy} onClick={() => { setName(query.trim()); setMode("create"); }}><Plus size={15}/>{query.trim() ? `Create “${query.trim()}”…` : "Create category…"}</button>{current && current.id !== "uncategorized" && <button disabled={busy} onClick={() => { setName(current.name); setMode("rename"); }}><Pencil size={15}/>Rename current category…</button>}</div>
        </div>
        {mode !== "pick" && <form className="pc-form" onSubmit={e => { e.preventDefault(); if (!name.trim() || duplicate || busy) return; void save(mode === "create" ? { action: "create-island", name, repos: [project.id] } : { action: "rename-island", island: project.family, name }); }}>
          <button type="button" className="pc-back" disabled={busy} onClick={() => { setMode("pick"); setError(""); requestAnimationFrame(() => search.current?.focus()); }}><ArrowLeft size={14}/>Categories</button>
          <label>{mode === "create" ? "New category" : "Rename category"}<input autoFocus value={name} maxLength={60} disabled={busy} onChange={e => setName(e.target.value)} placeholder="Category name"/></label>
          <p>{mode === "create" ? "This project will move into the new category." : `Updates the category name for all ${current?.repos || 0} projects. Their status stays the same.`}</p>
          {duplicate && <p role="status">A category already has this name.</p>}
          <button className="pc-save" disabled={busy || !name.trim() || duplicate}>{busy ? "Saving…" : mode === "create" ? "Create & move project" : "Save name"}</button>
        </form>}
        {error && <p className="pc-error" role="alert">{error}</p>}
      </Combobox.Popup></Combobox.Positioner></Combobox.Portal>
    </Combobox.Root>
    {!open && error && <p className="pc-error" role="alert">{error}</p>}
  </div>;
}
