# Labs

A Lab is the console's entry point for experimenting with one capability —
text, image, music, 3D, video, decisions — on whichever machine the console is
running on, with a cloud model beside it where one exists. This page is for the
session adding the next one. The Lab contract it implements is in
[explorations/README.md](explorations/README.md#the-lab-contract).

## Adding a Lab

Three files, none of them `src/app/page.tsx`:

1. **A registry line** in `src/lib/labs.ts`:

   ```ts
   {
     id: "music",                       // tab becomes #lab-music; runs are recorded under it
     label: "Music Lab",
     hint: "Prompt → a clip, local model beside a cloud one",
     keywords: "audio song musicgen stable-audio",
     capability: "music",               // which `serves` capability its models come from
     input: "prompt",                   // prompt | image+prompt | audio | image | structured
     output: "audio",                   // text | image | audio | mesh | video | json
     cloudComparison: false,            // true only if the router has a cloud model for it
     doc: "docs/music-experiment-2026-09-30.md", // optional; a .md directly under docs/
     load: () => import("@/components/labs/music-lab"),
   },
   ```

   That line is what makes the tab, the `#lab-music` route, the command-palette
   entry (Ctrl K) and the Workstreams menu item. Nothing else lists tabs.

2. **A component**, `src/components/labs/<name>.tsx`, default-exporting a
   component that takes `{ lab }` and renders `<LabShell>`. It owns only its
   input state:

   ```tsx
   export default function MusicLab({ lab }: LabComponentProps) {
     const [prompt, setPrompt] = useState("");
     return (
       <LabShell<MusicOutput>
         lab={lab}
         canRun={!!prompt.trim()}
         input={<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
         run={async (model, { compareGroup, signal }) => {
           const r = await fetch("/api/labs/music/run", { method: "POST", signal,
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ model: model.id, prompt, compareGroup }) });
           return r.json(); // a LabRunResult<MusicOutput>
         }}
         renderOutput={(r) => <audio controls src={r.output!.url} />}
       />
     );
   }
   ```

3. **A run route**, `src/app/api/labs/<id>/run/route.ts`, that measures and
   records the run and answers with a `LabRunResult`:

   ```ts
   const measured = await measureRun(() => callTheService(...), { local });
   const run = await recordLabRun({
     lab: "music", capability: "music", model, local, compareGroup,
     inputSummary: prompt, params: { durationS }, seed,
     status: measured.ok ? "ok" : "error",
     error: measured.ok ? null : String(measured.error),
     ...measured.measurement,            // latencyMs, peakVramGb, baselineVramGb, vramNote
     outputPath, outputSummary,
   });
   ```

   `measureRun` never throws — a failed run is still a run worth recording.
   Return HTTP 200 with `ok: false` for a model failure so the shell shows it in
   that model's column. Set `resourceBlocked: true` when the resource
   coordinator refused, and the shell offers to free the card in place.

The smallest complete example is the **Decision Lab**:
`src/components/labs/decision-lab.tsx` and `src/app/api/labs/decide/run/route.ts`.

Text has no Lab: the **Arena** is the text and vision experiment surface. It
records every run under `lab: "arena"` through the same `measureRun` /
`recordLabRun` pair (`src/app/api/arena/run/route.ts`) and shows the record with
the shared `RecentRuns` table (`src/components/labs/recent-runs.tsx`), which any
surface that records runs can drop in.

`npm test` checks the registry (`scripts/labs.test.mjs`): unique slug ids, a
capability from the vocabulary, a component file that exists with a default
export, and a doc that exists. `npx tsc --noEmit` checks the rest.

## Making the models appear

The shell lists models from `GET /api/labs/models?capability=<id>`, which merges
two sources, both scoped to **this host**:

- **The router catalogue**, for capabilities the router can route (text, vision,
  image, stt, tts): cloud models, plus local ones whose backing service is in
  this host's profile.
- **Host services that declare the capability** in `config/hosts/<host>.json`:

  ```json
  "serves": { "music": "musicgen-large" }
  "serves": { "video": ["wan2.2-ti2v-5b", "ltx-2.5"] }
  ```

  A list is for one runtime hosting several models (ComfyUI); each name gets a
  row, and the first is the service's default. Status comes from the service's
  `healthPath`; Start/Stop goes through the manager and the resource
  coordinator like everywhere else.

Each row's footprint, licence, params and checkpoint come from
`config/model-meta.json`, keyed by router alias — or, for a service-declared
model, `local-<served-name>` (falling back to the bare name). Declare `license`
there after checking the model card on the hub; an undeclared one is shown as
**licence not declared**, not guessed.

Capability ids are `CAPABILITY_IDS` in `src/lib/capabilities.ts`: text, vision,
image, stt, tts, music, 3d, video, decision. Add one there if you need it; only
the first five are routable by the router (`CAPABILITIES` in `providers.ts`,
type-checked to be a subset).

If a Lab's capability has nothing on this host, the shell says so, names the
file to declare it in, and shows the model scout's candidates for that
capability with a fit verdict for this machine.

## The runs record

Every Lab run is a row in `lab_runs` in the console's DuckDB store
(`src/lib/db.ts`, `%LOCALAPPDATA%\betenshi\betenshi.db`) — the same store as the
image gallery and batch jobs, so there is one thing to back up and no new
migration per Lab. Capability-specific settings go in `params` (JSON).

| column | meaning |
|---|---|
| `lab`, `capability`, `model`, `host`, `local` | what ran, where |
| `compare_group` | shared by the runs of one side-by-side comparison |
| `input_summary`, `params`, `seed` | what was asked (trimmed), and how |
| `status`, `error` | `ok` or `error` |
| `latency_ms` | wall-clock on the server |
| `peak_vram_gb`, `baseline_vram_gb`, `vram_note` | see below |
| `cost_usd` | the router's cost figure for a cloud call; null locally ("not metered", not "free") |
| `output_path`, `output_summary` | where a file landed; a short excerpt |

- Read: `GET /api/labs/runs?lab=<id>&limit=30`.
- Write from the server: `recordLabRun()` in `src/lib/lab-runs.ts`.
- Write from a client (a run the server could not wrap): `POST /api/labs/runs`
  with the same fields. VRAM is ignored there — only the server can sample the
  card while the work happens.

**What the VRAM number is.** The highest card-wide `memory.used` that
nvidia-smi reported while the run was in flight, sampled every 0.5 s, next to
the reading just before it. It is not per-process (nvidia-smi on Windows does not
report that), so a concurrent job inflates it, and a model that reserved its
memory at start-up (vLLM) shows peak ≈ baseline. A cold Ollama or ComfyUI run
shows the load. On a unified-memory host (B5) it is not recorded — "VRAM" there
is system RAM and moves with everything — and cloud runs have none.

## What is deliberately not here yet

- The Image, Speech, Arena, Segment and 3D Body tabs are **not** on the shell.
  Migrating them is a follow-up; each already works, and moving them is only
  worth doing once a second Lab of the same kind shows what the shell is
  missing.
- A cloud comparison comes only from the router. Cloud video and music models
  (not routable) belong inside their own Lab for now.

  When the fair comparison is a *different* capability, a Lab declares
  `compareCapability`. The Decision Lab (`capability: "decision"`) sets it to
  `"text"`: the router has no cloud "decision" model, and the thing a decision
  model would replace is an LLM asked the same typed question. The shell then
  asks for `/api/labs/models?capability=decision&compare=text`, which appends
  that capability's router models (host-narrowed as usual) flagged
  `compare: true`. They appear only in the comparison picker, local ones like
  `local-gemma4` included and marked "(local)", never among the Lab's own
  models. It needs `cloudComparison: true`, and `validateLabs()` rejects an
  unknown id or the Lab's own capability. The run route gets the compare
  model's id and has to know how to call it; the Decision Lab's does that
  through `/api/decide`.
- The runs record has no comparison view beyond the Lab's "Recent runs" list.
  The rows carry `compare_group` so one can be built without a migration.
