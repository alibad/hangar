# Arena

One prompt, several chat models, side by side, with scores.

`src/components/arena-view.tsx` is the surface; `src/app/api/arena/run/route.ts`
runs one model; `src/app/api/arena/judge/route.ts` grades a finished set.
Scoring is `src/lib/text-scoring.ts`, unit-tested in
`scripts/text-scoring.test.mjs`.

## Why it exists

The console could already run **one** text model (the LLM tab's playground) and
compare **several image** models (the compare view). The gap between those two
was the question this box exists to answer: *is the local model good enough for
this job, or is it worth paying a vendor?* That is not answerable by alternating
between tabs and remembering what the other one said.

The Models tab ranks models by published benchmarks. Those are about models in
general. The Arena is about **your prompt** — which is the only evidence that
settles a routing decision for work you actually do.

## What makes it a measurement

**Scores, not impressions.** Supply a reference and every tile is scored against
it. Two modes, because the two shapes of ground truth need different maths:

| Mode | Reference is | Reports |
| --- | --- | --- |
| Reference text | the correct answer | CER (strict + normalised), WER, chrF, Arabic ratio |
| Expected JSON | an object of field → value | field accuracy, which fields missed, whether JSON parsed at all |

The scoring module is shared with `scripts/experiment-arabic.mjs`, so a number
here and a number in a committed write-up mean the same thing. That is the whole
reason it is a library rather than inline code.

**Arabic is handled properly, not incidentally.** See the long note at the top of
`text-scoring.ts`. The short version: raw string comparison is wrong for Arabic,
because tashkeel are optional, alef/ya/ta-marbuta variants are keyboard
accidents, and Arabic-Indic digits are the same numbers as ASCII ones. So both a
`strict` and a `normalized` rate are always shown, and **the gap between them is
itself the finding** — low normalised with high strict means the model read the
text correctly but did not reproduce its diacritics. Every text input and every
output bubble is `dir="auto"`, so RTL renders as RTL.

**Cost and footprint sit beside quality.** A cloud model winning by two chrF
points at a cent a call, against a local one that is free but holds 20 GB of a
32 GB card, is a trade-off you can only make with all three numbers on screen.

## Design decisions worth keeping

**Fan-out is per-model and client-side.** One server call that awaits every model
can report nothing but "running" until the slowest lands, and a cold local 31B
makes that minutes of dead screen. `/api/image/compare` was abandoned for exactly
this; do not reintroduce the pattern here. Each tile owns its request, its state,
and its cancel button.

**Local models run strictly one at a time; cloud models run in parallel.** This
is the constraint that shapes the whole surface. Each local model is 20-26 GB of
a 31.8 GB card and Ollama is configured `OLLAMA_MAX_LOADED_MODELS=1`, so
selecting three does not mean three run at once — it means three run in turn with
a swap between each.

The first version fired everything at once and let the resource coordinator sort
it out. That was wrong twice over: every tile claimed to be "running" when at most
one could be, and two simultaneous local requests raced their own eviction against
their admission check. Local models are now an explicit sequential queue, each
waiting tile showing its position, while cloud models — which cost money rather
than memory — still fan out. The contestant list is drawn as two lanes for the
same reason: they are different kinds of commitment, and a single grid of 26 cards
implied 26 interchangeable options.

The selection badge carries the run order rather than a tick, because with one
model resident at a time *when* a model goes is the useful thing to know.

**Everything routes through the AI Router, even local models.** The router's
callback records alias, latency, tokens and cost into the Requests view, so an
Arena run is visible beside every other call on the box. `X-Source:
console-arena` tags the rows. Calling a serving port directly would be faster to
write and invisible afterwards.

**Local runs take a `gpu-heavy` lease; cloud runs do not.** A 31B is 20+ GB of a
32 GB card, so an Arena run and a FLUX generation cannot both be in flight — and
without the lease the failure is not a queue, it is an out-of-memory in whichever
started second. A refused admission comes back as HTTP 409 with the
coordinator's own explanation of what is holding the card, so the tile can say
what to stop. Cloud models cost money rather than memory, and taking a GPU lease
for one would block local work for nothing.

**An attached image narrows the field to models that can see.** Eligibility comes
from the declared `vision` flag in `config/model-meta.json`, never from the
alias. Selecting a text-only model with an image attached is refused server-side
too: a tile that quietly answered from the prompt alone would look like a real,
terrible result, which is worse than an error.

**Temperature 0.** Every Arena task is convergent — transcribe, translate,
extract, compare — and greedy decoding makes a re-run reproducible. That is the
difference between a comparison and an anecdote.

## The judge

For summarisation, dialect rewriting and open prose there is no reference string,
and inventing one just measures agreement with whoever wrote it. The **Grade**
button sends the finished outputs to another model for ranking.

Three constraints, because an LLM judge is easy to fool:

- **Blind.** Outputs are relabelled A, B, C and the mapping is kept server-side.
  Model names in the prompt buy a large, well-documented bias toward the famous
  one. The mapping is returned to the *reader* afterwards, not to the judge.
- **Never a contestant.** Self-preference is the best-documented failure mode of
  LLM-as-judge; the route refuses a judge that produced one of the answers.
- **Advisory, and labelled as such.** It is one model's opinion, shown beside the
  deterministic scores, never replacing them.

## A model is not a service

Three router aliases share the single `ollama` service, which broke an assumption
the rest of the console rests on: that one model means one service.

- **Status.** `status: "ready"` means the *runtime* is up, which was true for all
  three the moment Ollama started — so the picker showed three models "running" on
  a card that holds one. `CatalogModel.loaded` is the honest answer, read from
  Ollama's `/api/ps`, and is `undefined` for pinned services like vLLM where the
  question does not arise. The picker shows three states for an on-demand model:
  *loaded*, *ready to load*, *runtime stopped*.
- **Stop.** The service-level Stop killed the runtime and every sibling alias with
  it. On-demand models get **Unload** instead (`POST /api/ollama/unload`), which
  frees the card and leaves the runtime serving. Stopping the runtime still lives
  on the Services tab, where it means what it says.
- **`exclusiveLocal`.** The Text tab stops the *other* local models before
  switching. For these three that resolved to stopping the service hosting the
  model just selected — pressing Use took down what you picked. Models sharing a
  runtime are now excluded from that sweep and displaced by the runtime itself.
- **Footprints.** Per-model figures in one lane summed to ~73 GB on a 31.8 GB
  card. The lane now says once that models sharing a runtime are mutually
  exclusive, rather than repeating a caveat on every row.

Any future runtime that loads on demand should be added to `ON_DEMAND_SERVICES`
in `src/lib/providers.ts`; everything above keys off that set.

## Adding a capability to it

The Arena lists whatever the router serves with `mode: chat`. Nothing here needs
editing when a model is added — wire the alias and, if it is multimodal, set
`"vision": true` in `config/model-meta.json`. Forgetting the flag does not break
the Arena; it just means the model is never offered once an image is attached.
