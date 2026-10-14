"use client";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Mic, RefreshCw } from "lucide-react";
import { renderAudio } from "@/lib/audio-render";
import type { AudioRecipe, AudioRevision } from "@/lib/audio-project";
import { isHostedRuntime } from "@/lib/runtime";
import { ServiceControl } from "./service-control";

const LINES = [
  { id: "voice-select", label: "Selected", text: "Tank crew ready." },
  { id: "voice-move", label: "Move order", text: "Moving to position." },
  { id: "voice-attack", label: "Attack order", text: "Target acquired. Firing." },
  { id: "voice-under-fire", label: "Under fire", text: "Taking fire. Holding position." },
];
type Engines = { engines: { id: string; name: string }[]; engine?: string; voices: { id: string; label: string }[]; error?: string; serviceId?: string };
export default function TankVoiceDirector() {
  const [data, setData] = useState<Engines>({ engines: [], voices: [] }), [engine, setEngine] = useState("tts"), [voice, setVoice] = useState("am_michael");
  const [line, setLine] = useState(LINES[0].id), [text, setText] = useState(LINES[0].text), [speed, setSpeed] = useState(1), [radio, setRadio] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [revisions, setRevisions] = useState<AudioRevision[]>([]), [result, setResult] = useState<AudioRevision | null>(null);
  const takeAudio = useRef<HTMLAudioElement>(null), hosted = isHostedRuntime();
  const lineDrafts = useRef<Record<string, string>>({});
  const [restored, setRestored] = useState(false);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem("hangar-tank-voice-draft") ?? "null"); if (saved && typeof saved.engine === "string" && typeof saved.voice === "string" && LINES.some(l => l.id === saved.line) && typeof saved.text === "string") { setEngine(saved.engine); setVoice(saved.voice); setLine(saved.line); setText(saved.text); setSpeed(typeof saved.speed === "number" ? saved.speed : 1); setRadio(saved.radio !== false); lineDrafts.current = saved.lines ?? {}; } } catch { /* keep the initial draft */ } setRestored(true); }, []);
  useEffect(() => { if (!restored) return; lineDrafts.current[line] = text; try { localStorage.setItem("hangar-tank-voice-draft", JSON.stringify({ engine, voice, line, text, speed, radio, lines: lineDrafts.current })); } catch { /* in-memory draft remains */ } }, [restored, engine, voice, line, text, speed, radio]);
  const refresh = async () => {
    const [r, library] = await Promise.all([fetch(`/api/audio-lab/voice?engine=${encodeURIComponent(engine)}`).then(r => r.json()), fetch("/api/audio-lab").then(r => r.json())]);
    setData(r);
    setRevisions((library.revisions ?? []).filter((r: AudioRevision) => r.event.startsWith("voice-")));
  };
  useEffect(() => { let live = true; fetch(`/api/audio-lab/voice?engine=${encodeURIComponent(engine)}`).then(r => r.json()).then(r => { if (!live) return; setData(r); }).catch(() => { if (live) setError("Local voice engine could not be reached"); }); fetch("/api/audio-lab").then(r => r.json()).then(r => { if (live) setRevisions((r.revisions ?? []).filter((v: AudioRevision) => v.event.startsWith("voice-"))); }); return () => { live = false; }; }, [engine]);
  const generate = async () => {
    setBusy(true); setError(""); takeAudio.current?.pause();
    try {
      const r = await fetch("/api/audio-lab/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine, voice, speed, input: text }) });
      if (!r.ok) throw new Error((await r.json()).error);
      const bytes = await r.arrayBuffer(), ctx = new OfflineAudioContext(1, 1, 48000), b = await ctx.decodeAudioData(bytes.slice(0));
      const form = new FormData(); form.set("action", "import"); form.set("audio", new Blob([bytes], { type: "audio/wav" }), `${line}.wav`); form.set("license", `Project-authored tank line; local ${r.headers.get("X-Audio-Engine")} voice ${voice}; text: ${text}`);
      const uploaded = await fetch("/api/audio-lab", { method: "POST", body: form }); const source = await uploaded.json(); if (!uploaded.ok) throw new Error(source.error);
      const recipe: AudioRecipe = { length: Math.min(60, b.duration + .1), loop: false, notes: JSON.stringify({ text, voice, engine, speed, radio }), layers: [{ id: source.id, name: "Tank crew voice", url: source.url, duration: b.duration, start: 0, end: b.duration, offset: 0, gainDb: -2, pitch: 0, lowpass: radio ? 3200 : 20000, pan: 0, fadeIn: .005, fadeOut: .02, solo: false, muted: false }] };
      const rendered = await renderAudio(recipe), savedForm = new FormData(); savedForm.set("action", "render"); savedForm.set("audio", new Blob([rendered.wav], { type: "audio/wav" }), "voice.wav"); savedForm.set("metadata", JSON.stringify({ event: line, name: `${LINES.find(l => l.id === line)!.label} · ${voice}`, recipe, peakDb: rendered.peakDb, rmsDb: rendered.rmsDb, notes: text }));
      const savedResponse = await fetch("/api/audio-lab", { method: "POST", body: savedForm }), saved = await savedResponse.json(); if (!savedResponse.ok) throw new Error(saved.error); setResult(saved); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Voice take failed"); } finally { setBusy(false); }
  };
  const audition = (r: AudioRevision) => { const url = new URL("http://127.0.0.1:3463/viewer/saudi-arabia/r2m1a2s"); url.searchParams.set("hangarRevision", r.id); url.searchParams.set("hangarPort", window.location.port || "8003"); window.open(url.href, "_blank", "noopener,noreferrer"); };
  return <section className="tank-voice-director"><header><div><span className="tank-voice-eyebrow">RTS AI / Tank pilot</span><h2>Direct the tank crew</h2><p>Keep one voice across the crew’s complete set of lines.</p></div><span className="audio-local">Local neural speech</span></header>
    <div className="tank-voice-controls"><label>Engine<select aria-label="Tank voice engine" value={engine} onChange={e => setEngine(e.target.value)}>{data.engines.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>Voice<select aria-label="Tank crew voice" value={voice} onChange={e => setVoice(e.target.value)}>{!data.voices.some(v => v.id === voice) && <option value={voice} disabled>{voice} · choose an available voice</option>}{data.voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label><label>Delivery speed<input aria-label="Tank speech speed" type="number" min={.7} max={1.3} step={.05} value={speed} onChange={e => setSpeed(Number(e.target.value))} /></label><label><input type="checkbox" checked={radio} onChange={e => setRadio(e.target.checked)} />Radio low-pass</label><button type="button" aria-label="Refresh tank voices" onClick={() => refresh().catch(e => setError(String(e)))}><RefreshCw size={16} /></button></div>
    <div className="tank-voice-lines">{LINES.map(l => <button key={l.id} type="button" aria-pressed={line === l.id} onClick={() => { lineDrafts.current[line] = text; setLine(l.id); setText(lineDrafts.current[l.id] ?? l.text); setResult(null); }}>{l.label}{revisions.some(r => r.event === l.id) && <span> · {revisions.filter(r => r.event === l.id).length}</span>}</button>)}</div>
    <textarea aria-label="Tank voice line" value={text} maxLength={1000} onChange={e => setText(e.target.value)} rows={2} />
    <div className="tank-voice-actions"><button type="button" className="audio-primary" disabled={busy || hosted || !text.trim() || !data.voices.some(v => v.id === voice) || !!data.error} onClick={generate}><Mic size={16} />{busy ? "Generating local take…" : "Generate take"}</button>{result && <><audio ref={takeAudio} src={result.url} controls /><button type="button" onClick={() => audition(result)}><ExternalLink size={15} />Audition on tank</button></>}</div>
    {(error || data.error) && <p className="audio-error" role="alert">{error || data.error}</p>}{data.serviceId && <ServiceControl id={data.serviceId} up={false} probe={async () => { await refresh(); const r = await fetch(`/api/audio-lab/voice?engine=${encodeURIComponent(engine)}`); return !(await r.json()).error; }} />}
    {revisions.length > 0 && <details><summary>Saved crew takes · {revisions.length}</summary>{revisions.map(r => <div key={r.id} className="tank-voice-take"><span>{r.name}<small>{r.notes}</small></span><audio controls preload="none" src={r.url} /><button type="button" onClick={() => audition(r)}>Audition</button></div>)}</details>}
    <p className="tank-voice-footnote">General speech synthesis and voice cloning remain available below. Manage cloned voices with their engine’s existing controls.</p>
  </section>;
}
