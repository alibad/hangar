import { LABS, labTab, type ConsoleTab } from "./labs";

export type WorkstreamLink = { id: ConsoleTab; label: string; hint: string };
export type WorkstreamGroup = { id: string; label: string; links: WorkstreamLink[] };
const labLink = (id: string, label?: string): WorkstreamLink => {
  const lab = LABS.find(l => l.id === id)!;
  return { id: labTab(id), label: label ?? lab.label, hint: lab.hint };
};

/** Navigation groups organise tools without changing their routes or stores. */
export const WORKSTREAMS: WorkstreamGroup[] = [
  { id: "audio", label: "Audio", links: [
    labLink("audio", "Effects"),
    { id: "voices", label: "Voices & Speech", hint: "Synthesize speech and manage neural voices" },
    { id: "speech-recognition", label: "Speech Recognition", hint: "Microphone, files and dictation" },
    labLink("music", "Music"),
  ] },
  { id: "visual", label: "Visual", links: [
    { id: "qwen", label: "Image Studio", hint: "Generate, edit, compare and evaluate" },
    { id: "video", label: "Video Studio", hint: "Text and image to video" },
    labLink("video"), labLink("forge"),
    { id: "sam3", label: "Mask & Segment", hint: "Image segmentation and video tracking" },
    labLink("3d"),
  ] },
  { id: "text", label: "Chat & Code", links: [
    { id: "llm", label: "Chat & Code", hint: "Think, code and debug" },
    { id: "arena", label: "Model Arena", hint: "Compare models on one prompt" },
  ] },
  { id: "process", label: "Decisions & Processes", links: [labLink("decide"), labLink("process")] },
];

export const SYSTEM_LINKS: WorkstreamLink[] = [
  { id: "services", label: "Services", hint: "Start, stop and inspect local services" },
  { id: "models", label: "Models", hint: "Discover, route and manage models" },
  { id: "requests", label: "Requests", hint: "Live traffic and failures" },
  { id: "usage", label: "AI Usage", hint: "Providers, tokens and cost" },
  { id: "storage", label: "Storage", hint: "Local files, drives and guarded moves" },
];

export const speechTab = (tab: string) => ["speech", "voices", "speech-recognition"].includes(tab);
export const workstreamFor = (tab: string) => WORKSTREAMS.find(g => g.links.some(l => l.id === tab) || (tab === "speech" && g.id === "audio"));
