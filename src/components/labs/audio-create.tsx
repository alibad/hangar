"use client";

import { AudioLines, Dices, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberField, TextAreaField, TextField } from "@/components/ui/form-field";
import { EFFECTS_MODEL } from "@/lib/audio-generation";

export type GeneratorStatus = { available: boolean; busy?: boolean; fits?: boolean; reason: string };
type Props = {
  prompt: string; length: number; seed: number; busy: boolean; hosted: boolean; hasLayers: boolean;
  status: GeneratorStatus | null; pendingFile: File | null; license: string;
  onPrompt: (value: string) => void; onLength: (value: number) => void; onSeed: (value: number) => void;
  onGenerate: () => void; onChooseFile: () => void; onImport: () => void; onCancelImport: () => void; onLicense: (value: string) => void;
};

export function AudioCreate(props: Props) {
  const { busy, hosted, status, hasLayers } = props;
  return <section className="audio-create" aria-labelledby="audio-create-title">
    <header><div className="audio-create-title">{props.pendingFile ? <Upload size={18} /> : <Sparkles size={18} />}<h2 id="audio-create-title">{props.pendingFile ? "Import a recording" : hasLayers ? "Generate another layer" : "Create a sound effect"}</h2></div><span className="audio-engine-tag"><span />Local · CPU</span></header>
    {!props.pendingFile && <><form onSubmit={e => { e.preventDefault(); props.onGenerate(); }}>
      <TextAreaField label="Describe your sound" placeholder="A glass bottle gently struck with a spoon. One clear chime, a short ringing tail, no background noise." rows={4} maxLength={4000} value={props.prompt} onChange={e => props.onPrompt(e.target.value)} disabled={busy} hint="Describe the action, material, space, and how it should end. No recording needed." />
      <div className="audio-create-controls">
        <NumberField label="Duration" value={Math.min(props.length, 30)} min={.1} max={30} step={.1} unit="sec" onValueChange={props.onLength} disabled={busy} />
        <div className="audio-seed-field"><NumberField label="Seed" value={props.seed} min={0} max={2147483647} step={1} onValueChange={props.onSeed} disabled={busy} /><Button type="button" variant="outline" aria-label="Randomize seed" title="Randomize seed" disabled={busy} onClick={() => props.onSeed(crypto.getRandomValues(new Uint32Array(1))[0] % 2147483648)}><Dices size={17} /></Button></div>
        <Button type="submit" className="audio-generate-button" disabled={busy || hosted || !status?.available || status.busy || !props.prompt.trim()}><Sparkles size={16} />{busy ? "Working locally…" : hasLayers ? "Generate layer" : "Generate effect"}</Button>
      </div>
      <div className="audio-engine-note"><AudioLines size={14} /><span>{EFFECTS_MODEL} · cached weights · up to 30 seconds</span></div>
      {(!status || !status.available || status.busy || status.fits === false) && <p className="audio-generator-status" role="status">{!status ? "Checking local generator…" : !status.available ? status.reason : status.busy ? "Another effect is generating. Please wait for it to finish." : "Low memory: generation needs 12 GB free, including headroom. Free some memory before generating."}</p>}
    </form>
    <footer><span>Have a recording?</span><Button type="button" variant="outline" onClick={props.onChooseFile} disabled={busy || hosted}><Upload size={15} />Import recording</Button><small>WAV, MP3, OGG, FLAC, WebM, M4A · up to 20 MB</small></footer></>}
    {props.pendingFile && <div className="audio-import-card"><header><strong>{props.pendingFile.name}</strong><Button type="button" variant="ghost" aria-label="Cancel import" onClick={props.onCancelImport} disabled={busy}><X size={16} /></Button></header><TextField label="Source or license note (optional)" placeholder="e.g. My recording, or the source URL and license" maxLength={1000} value={props.license} onChange={e => props.onLicense(e.target.value)} disabled={busy} /><Button type="button" variant="outline" disabled={busy || hosted} onClick={props.onImport}><Upload size={15} />Add recording as a layer</Button><small>A local copy is added. Your original file stays unchanged.</small></div>}
  </section>;
}
