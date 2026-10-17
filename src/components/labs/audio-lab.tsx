"use client";

import { FieldSelect } from "@/components/ui/field-select";

import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, Download, ExternalLink, Play, RotateCcw, Square, Upload, Volume2 } from "lucide-react";
import type { LabComponentProps } from "@/lib/labs";
import type { AudioEvent, AudioLayer, AudioLibrary, AudioPilot, AudioRecipe, AudioRevision } from "@/lib/audio-project";
import { validateAudioRecipe, peakAndRms } from "@/lib/audio-project";
import { decodeAudio, renderAudio } from "@/lib/audio-render";
import { useTabActive } from "@/components/tab-pane";
import { getHost } from "@/lib/host";
import { isHostedRuntime } from "@/lib/runtime";

const peaks = new Map<string, Promise<number[]>>();
function Waveform({ url, selected = false }: { url: string; selected?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    if (!peaks.has(url)) peaks.set(url, (async () => { const ctx = new OfflineAudioContext(1, 1, 48000), b = await decodeAudio(url, ctx), data = b.getChannelData(0), out = []; for (let i = 0; i < 140; i++) { let peak = 0; const start = Math.floor(i * data.length / 140), end = Math.floor((i + 1) * data.length / 140); for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(data[j])); out.push(peak); } return out; })());
    peaks.get(url)!.then(values => { if (!live || !ref.current) return; const canvas = ref.current, width = 560, height = 76; canvas.width = width * 2; canvas.height = height * 2; const c = canvas.getContext("2d")!; c.scale(2, 2); c.fillStyle = getComputedStyle(canvas).color; const max = Math.max(...values, .1); for (let i = 0; i < values.length; i++) { const h = Math.max(1, values[i] / max * 60); c.fillRect(i * 4, (height - h) / 2, 2, h); } }).catch(() => { peaks.delete(url); });
    return () => { live = false; };
  }, [url, selected]);
  return <canvas ref={ref} className={`audio-waveform${selected ? " is-selected" : ""}`} role="img" aria-label="Audio waveform" />;
}

export default function AudioLab({ lab }: LabComponentProps) {
  const [pilot, setPilot] = useState<AudioPilot | null>(null), [eventId, setEventId] = useState("main-gun"), [recipe, setRecipe] = useState<AudioRecipe | null>(null);
  const [library, setLibrary] = useState<AudioLibrary>({ revisions: [], assets: [] });
  const [section, setSection] = useState("Workspace"), [selectedLayer, setSelectedLayer] = useState<string | null>(null), [revision, setRevision] = useState<AudioRevision | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [volume, setVolume] = useState(.6), [playing, setPlaying] = useState<string | null>(null), [time, setTime] = useState(0), [match, setMatch] = useState(true);
  const [reviewNotes, setReviewNotes] = useState(""), [license, setLicense] = useState("");
  const [viewerOrigin, setViewerOrigin] = useState("http://127.0.0.1:3463");
  const audio = useRef<HTMLAudioElement | null>(null), currentKey = useRef<string | null>(null), playbackGain = useRef(1), fileInput = useRef<HTMLInputElement>(null);
  const active = useTabActive(), hosted = isHostedRuntime();
  const extraEvents: AudioEvent[] = [...new Map(library.revisions.filter(r => !pilot?.events.some(e => e.id === r.event)).map(r => [r.event, { id: r.event, label: r.event.startsWith("voice-") ? `Crew · ${r.event.slice(6).replaceAll("-", " ")}` : r.event, kind: "voice", currentUrl: r.recipe.layers[0]?.url ?? null, recipe: r.recipe }])).values()];
  const events = [...(pilot?.events ?? []), ...extraEvents];
  const event = events.find(e => e.id === eventId), layer = recipe?.layers.find(l => l.id === selectedLayer);
  const revisions = library.revisions.filter(r => r.event === eventId);
  const stop = () => { audio.current?.pause(); audio.current = null; currentKey.current = null; playbackGain.current = 1; setPlaying(null); setTime(0); };
  useEffect(() => { if (!active) stop(); return () => { audio.current?.pause(); }; }, [active]);
  const refresh = async () => { const r = await fetch("/api/audio-lab"); const value = await r.json(); if (!r.ok) throw new Error(value.error); setLibrary(value); };
  useEffect(() => {
    let live = true;
    Promise.all([fetch("/audio-lab/pilot/project.json").then(r => { if (!r.ok) throw new Error("Tank pilot sources could not be loaded"); return r.json() as Promise<AudioPilot>; }), fetch("/api/audio-lab").then(r => r.json())]).then(([p, saved]) => {
      if (!live) return; setPilot(p); setLibrary(saved.error ? { revisions: [], assets: [] } : saved);
      try { const origin = localStorage.getItem("hangar-audio-viewer"); if (origin) setViewerOrigin(origin); } catch { /* storage unavailable */ }
      const requestedEvent = new URLSearchParams(window.location.search).get("audioEvent");
      const first = p.events.find(e => e.id === requestedEvent) ?? p.events[0]; setEventId(first.id); let draft = first.recipe;
      try { const saved = JSON.parse(localStorage.getItem(`hangar-audio-draft:${first.id}`) ?? "null"); if (validateAudioRecipe(saved)) draft = saved; } catch { /* keep seed */ }
      setRecipe(draft); setSelectedLayer(draft.layers[0].id); if (saved.error) setError(saved.error);
    }).catch(e => { if (live) setError(String(e.message)); }); return () => { live = false; };
  }, []);
  useEffect(() => { if (!recipe) return; try { localStorage.setItem(`hangar-audio-draft:${eventId}`, JSON.stringify(recipe)); } catch { /* keep in-memory draft */ } }, [recipe, eventId]);
  const editLayer = (patch: Partial<AudioLayer>) => setRecipe(r => r ? { ...r, layers: r.layers.map(l => l.id === selectedLayer ? { ...l, ...patch } : l) } : r);
  const chooseEvent = (e: AudioEvent) => { stop(); setEventId(e.id); let draft = e.recipe; try { const saved = JSON.parse(localStorage.getItem(`hangar-audio-draft:${e.id}`) ?? "null"); if (validateAudioRecipe(saved)) draft = saved; } catch { /* retain defaults */ } setRecipe(draft); setSelectedLayer(draft.layers[0].id); setRevision(null); setReviewNotes(""); setMessage(""); setError(""); };
  const loadRevision = (r: AudioRevision) => { stop(); setEventId(r.event); setRecipe(r.recipe); setSelectedLayer(r.recipe.layers[0].id); setRevision(r); setReviewNotes(r.notes); setSection("Workspace"); setMessage(`Loaded ${r.name}. Rendering will create a new revision.`); };
  const play = async (url: string, key: string, levelMatch = false) => {
    if (playing === key) { audio.current?.pause(); setPlaying(null); return; }
    if (audio.current && currentKey.current === key) { try { await audio.current.play(); setPlaying(key); } catch { setError("Playback could not resume"); } return; }
    stop(); setError("");
    try {
      const el = new Audio(url); audio.current = el; currentKey.current = key; let gain = 1;
      if (levelMatch && match && event?.currentUrl && revision) {
        const ctx = new OfflineAudioContext(1, 1, 48000);
        const buffers = await Promise.all([decodeAudio(event.currentUrl, ctx), decodeAudio(revision.url, ctx)]);
        const levels = buffers.map(b => peakAndRms([b.getChannelData(0)]).rmsDb); const target = Math.min(...levels); gain = 10 ** ((target - levels[url === event.currentUrl ? 0 : 1]) / 20);
      }
      if (audio.current !== el) return; playbackGain.current = gain; el.volume = volume * gain; el.loop = Boolean(recipe?.loop && !levelMatch); el.ontimeupdate = () => setTime(el.currentTime); el.onended = () => { setPlaying(null); setTime(0); }; el.onerror = () => { setError("Audio playback failed. The saved revision is unchanged."); stop(); }; await el.play(); setPlaying(key);
    } catch (e) { setError(e instanceof Error ? e.message : "Playback failed"); stop(); }
  };
  const render = async () => {
    if (!recipe || !event) return; stop(); setBusy(true); setError(""); setMessage("Rendering layers locally…");
    try {
      const rendered = await renderAudio(recipe), form = new FormData(); form.set("action", "render"); form.set("audio", new Blob([rendered.wav], { type: "audio/wav" }), "render.wav");
      form.set("metadata", JSON.stringify({ event: event.id, name: `${event.label} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, recipe, peakDb: rendered.peakDb, rmsDb: rendered.rmsDb, notes: reviewNotes }));
      const response = await fetch("/api/audio-lab", { method: "POST", body: form }), saved = await response.json(); if (!response.ok) throw new Error(saved.error);
      setRevision(saved); await refresh(); setMessage(`Saved a new revision · ${rendered.peakDb.toFixed(1)} dBFS sample peak${rendered.reductionDb < -.1 ? " · output gain reduced to prevent clipping" : ""}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Render failed"); setMessage(""); } finally { setBusy(false); }
  };
  const review = async (status: AudioRevision["status"]) => { if (!revision) return; setError(""); try { const form = new FormData(); form.set("action", "review"); form.set("id", revision.id); form.set("status", status); form.set("notes", reviewNotes); const r = await fetch("/api/audio-lab", { method: "POST", body: form }); const result = await r.json(); if (!r.ok) throw new Error(result.error); setRevision({ ...revision, status, notes: reviewNotes }); await refresh(); setMessage(`Marked ${status}. The game installation has not changed.`); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } };
  const importAudio = async (file: File) => { if (!recipe) return; setBusy(true); setError(""); try { if (recipe.layers.length >= 12) throw new Error("A recipe supports up to 12 layers"); const ctx = new OfflineAudioContext(1, 1, 48000), b = await ctx.decodeAudioData(await file.arrayBuffer()); if (b.duration > 600) throw new Error("Choose a clip shorter than 10 minutes"); const form = new FormData(); form.set("action", "import"); form.set("audio", file); form.set("license", license); const r = await fetch("/api/audio-lab", { method: "POST", body: form }); const item = await r.json(); if (!r.ok) throw new Error(item.error); const added: AudioLayer = { id: crypto.randomUUID(), name: file.name, url: item.url, duration: b.duration, start: 0, end: Math.min(b.duration, recipe.length), offset: 0, gainDb: -6, pitch: 0, fadeIn: .01, fadeOut: .05, lowpass: 20000, pan: 0, muted: false, solo: false }; setRecipe(previous => previous ? { ...previous, layers: [...previous.layers, added] } : previous); setSelectedLayer(added.id); await refresh(); setMessage("Imported a copy as a new layer. Your source file is unchanged."); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; } };
  const audition = () => {
    if (!revision || !pilot) return; try { const base = new URL(viewerOrigin); if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:") throw new Error("Use a local http Faction Viewer address"); localStorage.setItem("hangar-audio-viewer", base.origin); const url = new URL(`/viewer/${pilot.faction}/${pilot.actor}`, base); url.searchParams.set("hangarRevision", revision.id); url.searchParams.set("hangarPort", window.location.port || "8003"); window.open(url.href, "_blank", "noopener,noreferrer"); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  };
  if (!pilot || !recipe || !event) return <div className="audio-loading" role="status">{error || "Loading Audio Lab…"}{error && <button onClick={() => window.location.reload()}>Retry</button>}</div>;
  const download = revision?.url;
  const dirty = Boolean(revision && JSON.stringify(recipe) !== JSON.stringify(revision.recipe));
  return <div className="audio-lab">
    <div className="audio-editor">
      <header className="audio-heading"><div><h1>{lab.label}</h1><p>Craft and iterate audio with local tools.</p></div><span className="audio-local">{hosted ? "Hosted preview" : `Local · ${getHost().name}`}</span></header>
      <nav className="audio-sections" aria-label="Audio Lab views">{["Workspace", "Library", "Compare", "Jobs"].map(s => <button key={s} type="button" aria-current={section === s ? "page" : undefined} onClick={() => setSection(s)}>{s}</button>)}</nav>
      {hosted && <p className="audio-notice">Open Hangar locally to render, import, save revisions and connect to your Faction Viewer. Licensed pilot sources are available here for listening.</p>}
      <div className="audio-project-row"><label>Project<strong>{pilot.name}</strong><small>{pilot.actorName}</small></label><label>Sound event<FieldSelect aria-label="Sound event" value={eventId} disabled={busy} onValueChange={(selectedValue) => chooseEvent(events.find(x => x.id === selectedValue)!)}>{events.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</FieldSelect></label><label>Revision<FieldSelect aria-label="Revision" value={revision?.id ?? "draft"} onValueChange={(selectedValue) => { if (selectedValue === "draft") { setRevision(null); return; } loadRevision(revisions.find(r => r.id === selectedValue)!); }}><option value="draft">Working draft</option>{revisions.map((r, i) => <option key={r.id} value={r.id}>{r.name} ({r.status})</option>)}</FieldSelect></label></div>
      {section === "Jobs" ? <div className="audio-empty"><h2>Render activity</h2><p>{busy ? "One local render is in progress. Keep this workspace open." : "No active renders. Effects render on the CPU without loading a GPU model."}</p><p>Music and video retain their existing queues and histories.</p></div> : section === "Library" ? <section className="audio-library"><h2>Project library</h2><p><a href="http://127.0.0.1:3510/" target="_blank" rel="noreferrer">Open existing sound bake-off ↗</a></p><p>Every revision is kept. Loading one creates an editable draft; it does not replace the game.</p>{library.revisions.length === 0 && <p>No saved revisions yet. Render a variation to start the library.</p>}<RevisionList items={library.revisions} onLoad={loadRevision} /><h3>Imported sources</h3>{library.assets.map(a => <div key={a.id} className="audio-library-row"><span>{a.name}<small>{a.license}</small></span><audio controls src={a.url} preload="none" /></div>)}<details><summary>Pilot source provenance · {pilot.provenance.license}</summary><pre>{JSON.stringify(pilot.provenance, null, 2)}</pre></details></section> : <>
        {section === "Workspace" && <>
          <div className="audio-timeline"><div className="audio-ruler"><span>Layers</span><div>{Array.from({ length: 6 }, (_, i) => <span key={i}>{(recipe.length * i / 5).toFixed(1)}s</span>)}</div><span>Gain</span></div>
            {recipe.layers.map(l => <div key={l.id} className={`audio-layer${selectedLayer === l.id ? " is-selected" : ""}${l.muted ? " is-muted" : ""}`}>
              <div className="audio-layer-label"><button type="button" onClick={() => setSelectedLayer(l.id)}>{l.name}</button><div><button aria-label={`Solo ${l.name}`} aria-pressed={l.solo} onClick={() => setRecipe(r => r ? { ...r, layers: r.layers.map(x => x.id === l.id ? { ...x, solo: !x.solo } : x) } : r)}>S</button><button aria-label={`Mute ${l.name}`} aria-pressed={l.muted} onClick={() => setRecipe(r => r ? { ...r, layers: r.layers.map(x => x.id === l.id ? { ...x, muted: !x.muted } : x) } : r)}>M</button></div></div>
              <button type="button" className="audio-wave-button" aria-label={`Select ${l.name} layer`} onClick={() => setSelectedLayer(l.id)}><Waveform url={l.url} selected={selectedLayer === l.id} /></button>
              <label className="audio-layer-gain"><input aria-label={`${l.name} gain`} type="range" min={-36} max={6} step={.5} value={l.gainDb} onChange={e => setRecipe(r => r ? { ...r, layers: r.layers.map(x => x.id === l.id ? { ...x, gainDb: Number(e.target.value) } : x) } : r)} /><small>{l.gainDb.toFixed(1)} dB</small></label>
            </div>)}
            <div className="audio-transport"><button className="audio-play" type="button" disabled={!revision} aria-label={playing === "render" ? "Pause render" : "Play render"} onClick={() => revision && play(revision.url, "render")}><Play size={20} fill="currentColor" /></button><button type="button" aria-label="Stop audio" onClick={stop}><Square size={16} fill="currentColor" /></button><span className="audio-time">{time.toFixed(1)} / {recipe.length.toFixed(1)}s</span><input className="audio-seek" type="range" aria-label="Seek playing audio" min={0} max={Number.isFinite(audio.current?.duration) ? audio.current!.duration : recipe.length} step={.01} value={Math.min(time, Number.isFinite(audio.current?.duration) ? audio.current!.duration : recipe.length)} disabled={!audio.current} onChange={e => { const t = Number(e.target.value); if (audio.current) audio.current.currentTime = t; setTime(t); }} /><Volume2 size={18} /><input type="range" aria-label="Playback volume" min={0} max={1} step={.05} value={volume} onChange={e => { const v = Number(e.target.value); setVolume(v); if (audio.current) audio.current.volume = v * playbackGain.current; }} /><span>{Math.round(volume * 100)}%</span></div>
          </div>
        </>}
        <section className="audio-compare"><header><h2>A / B Comparison</h2><label title="Match average RMS level by reducing the louder clip; this is an audition aid, not a LUFS mastering measurement"><input type="checkbox" checked={match} onChange={e => { stop(); setMatch(e.target.checked); }} />Match loudness</label></header><div className="audio-compare-grid">{[{ key: "reference", title: "Design reference", url: event.currentUrl, subtitle: eventId.startsWith("voice-") ? "Unprocessed neural take" : "Licensed CC0 baseline" }, { key: "candidate", title: revision?.name ?? "Your next variation", url: revision?.url, subtitle: revision ? revision.status : "Render a variation to compare" }].map(c => <div key={c.key}><strong>{c.title}</strong><small>{c.subtitle}</small><div><button type="button" aria-label={`Play ${c.title}`} disabled={!c.url} onClick={() => c.url && play(c.url, c.key, true)}><Play size={15} /></button>{c.url && <Waveform url={c.url} selected={c.key === "candidate"} />}</div></div>)}</div></section>
        <div className="audio-actions"><button type="button" className="audio-primary" disabled={busy || hosted} onClick={render}><AudioLines size={18} />{busy ? "Rendering…" : "Render variation"}</button><button type="button" disabled={!revision || hosted || dirty} onClick={audition}><ExternalLink size={16} />Audition in Faction Viewer</button><small>Local preview</small>{download && <a href={download} download={`${event.id}-${revision!.id}.wav`}><Download size={16} />WAV</a>}</div>
        <section className="audio-recent"><h2>Recent variations</h2>{revisions.length ? <RevisionList items={revisions.slice(0, 5)} onLoad={loadRevision} /> : <p>No saved variations for this event. The source layers are ready to edit.</p>}</section>
      </>}
      {dirty && <p className="audio-notice">Edited draft · render a new variation to audition these changes.</p>}
      {message && <p role="status" className="audio-message">{message}</p>}{error && <p role="alert" className="audio-error">{error}</p>}
    </div>
    <aside className="audio-inspector" aria-label="Audio inspector"><section><header><h2>Brief</h2><span>Editable</span></header><textarea aria-label="Sound brief" value={recipe.notes} maxLength={4000} onChange={e => setRecipe(r => r ? { ...r, notes: e.target.value } : r)} rows={3} /></section>
      {layer && <section><h2>Layer settings</h2><label>Layer<FieldSelect aria-label="Selected layer" value={selectedLayer ?? ""} onValueChange={(selectedValue) => setSelectedLayer(selectedValue)}>{recipe.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</FieldSelect></label>
        {([{ key: "gainDb", name: "Gain", min: -60, max: 12, step: .5, unit: "dB" }, { key: "pitch", name: "Pitch", min: -24, max: 24, step: .5, unit: "st" }, { key: "pan", name: "Pan", min: -1, max: 1, step: .1, unit: "" }, { key: "start", name: "Start", min: 0, max: layer.duration, step: .01, unit: "s" }, { key: "end", name: "End", min: .001, max: layer.duration, step: .01, unit: "s" }, { key: "offset", name: "Offset", min: 0, max: 60, step: .01, unit: "s" }, { key: "fadeIn", name: "Fade in", min: 0, max: 10, step: .01, unit: "s" }, { key: "fadeOut", name: "Fade out", min: 0, max: 10, step: .01, unit: "s" }, { key: "lowpass", name: "Low-pass", min: 40, max: 24000, step: 100, unit: "Hz" }] as const).filter(f => ["gainDb", "pan", "start", "end"].includes(f.key)).map(f => <label key={f.key}>{f.name}<span><input type="number" aria-label={f.name} min={f.min} max={f.max} step={f.step} value={layer[f.key]} onChange={e => editLayer({ [f.key]: Number(e.target.value) })} />{f.unit}</span></label>)}
        <details className="audio-processing"><summary>Processing · pitch, fades & EQ</summary>{([{ key: "gainDb", name: "Gain", min: -60, max: 12, step: .5, unit: "dB" }, { key: "pitch", name: "Pitch", min: -24, max: 24, step: .5, unit: "st" }, { key: "pan", name: "Pan", min: -1, max: 1, step: .1, unit: "" }, { key: "start", name: "Start", min: 0, max: layer.duration, step: .01, unit: "s" }, { key: "end", name: "End", min: .001, max: layer.duration, step: .01, unit: "s" }, { key: "offset", name: "Offset", min: 0, max: 60, step: .01, unit: "s" }, { key: "fadeIn", name: "Fade in", min: 0, max: 10, step: .01, unit: "s" }, { key: "fadeOut", name: "Fade out", min: 0, max: 10, step: .01, unit: "s" }, { key: "lowpass", name: "Low-pass", min: 40, max: 24000, step: 100, unit: "Hz" }] as const).filter(f => !["gainDb", "pan", "start", "end"].includes(f.key)).map(f => <label key={f.key}>{f.name}<span><input type="number" aria-label={f.name} min={f.min} max={f.max} step={f.step} value={layer[f.key]} onChange={e => editLayer({ [f.key]: Number(e.target.value) })} />{f.unit}</span></label>)}</details><button type="button" onClick={() => { const original = event.recipe.layers.find(l => l.id === layer.id); if (original) editLayer(original); }} disabled={!event.recipe.layers.some(l => l.id === layer.id)}><RotateCcw size={15} />Reset layer</button>{recipe.layers.length > 1 && <button type="button" onClick={() => { const kept = recipe.layers.filter(l => l.id !== selectedLayer); setRecipe(r => r ? { ...r, layers: kept } : r); setSelectedLayer(kept[0].id); }}>Remove from recipe</button>}
      </section>}
      <section><h2>Output</h2><label>Length<span><input type="number" aria-label="Output length" min={.1} max={60} step={.1} value={recipe.length} onChange={e => setRecipe(r => r ? { ...r, length: Number(e.target.value) } : r)} />s</span></label><label><input type="checkbox" checked={recipe.loop} onChange={e => setRecipe(r => r ? { ...r, loop: e.target.checked } : r)} />Loop audition</label>{event.note && <p>{event.note}</p>}</section>
      <section><h2>Add a source</h2><input aria-label="Source and license note" placeholder="Source / license or ownership" value={license} onChange={e => setLicense(e.target.value)} maxLength={1000} /><input hidden type="file" ref={fileInput} accept=".wav,.mp3,.ogg,.flac,.webm,.m4a" onChange={e => e.target.files?.[0] && importAudio(e.target.files[0])} /><button type="button" disabled={busy || hosted || !license.trim()} onClick={() => fileInput.current?.click()}><Upload size={15} />Import layer</button><small>Copies under 20 MB. Original files stay unchanged.</small></section>
      <section><h2>Review</h2><textarea aria-label="Review notes" placeholder="What works? What should change?" rows={3} maxLength={4000} value={reviewNotes} onChange={e => setReviewNotes(e.target.value)} /><div className="audio-review-actions"><button disabled={!revision || hosted} onClick={() => review("approved")}><Check size={14} />Approve</button><button disabled={!revision || hosted} onClick={() => review("rejected")}>Reject</button><button disabled={!revision || hosted} onClick={() => review("draft")}>Draft</button></div><small>Review status does not install or publish audio.</small></section>
      <section><h2>Faction Viewer</h2><input aria-label="Local Faction Viewer address" value={viewerOrigin} onChange={e => setViewerOrigin(e.target.value)} /><small>Exact saved revisions only. Current game sounds remain available.</small></section>
    </aside>
  </div>;
}

function RevisionList({ items, onLoad }: { items: AudioRevision[]; onLoad: (r: AudioRevision) => void }) {
  return <div className="audio-revision-list">{items.map(r => <button key={r.id} type="button" className="audio-library-row" onClick={() => onLoad(r)}><Play size={16} /><span>{r.name}<small>{new Date(r.created).toLocaleString()} · {r.recipe.length.toFixed(1)}s · {r.peakDb.toFixed(1)} dBFS</small></span><em>{r.status}</em></button>)}</div>;
}
