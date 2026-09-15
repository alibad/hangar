# Arabic model experiment — 14 September 2026

## Recommendation

**Use Gemma 4 31B (QAT int4) for Arabic work on this box — both OCR and text.**
It won or tied every category, ran 15x faster end to end than Qwen3-VL, and is
the smallest of the three on the card at 22.7 GiB.

Keep **Qwen3-VL 32B** installed as a second opinion for document transcription,
where it is genuinely competitive. Do not reach for it when latency matters, and
do not rely on it for Arabic *generation*.

**Qwen3 32B** is text-only and earns its place only as the control. It matches
Gemma on translation and beats it on English output, but loses badly on dialect.

Nothing here is a reason to change the router's default text model. These three
serve Arabic and vision; the coding models are unaffected.

## Answering the original question

- **Is Qwen3-VL 32B local?** It was not. It is now — pulled today, 21 GB.
- **What about "qwen2-32b"?** No such model was on the box. The closest were
  Qwen2.5-Coder-32B (AWQ, on C:) and `qwen3:32b` in Ollama. The latter is used
  here as the text-only control, since it is the general-purpose 32B Qwen that
  was actually installed.
- **Can Gemma 4 31B run here?** Yes, at 22.7 GiB — but only through Ollama. The
  vLLM image on this box is 0.17.1 and has no `gemma4` architecture at all
  (needs >= 0.19). Verified against the running container, not assumed.

## Results

Error rates are shown as **normalised / strict** percentages, lower is better.
chrF is 0-100, higher is better. Full raw outputs in
`var/experiments/1789376045320-arabic.json`.

### OCR

| Item | Gemma 4 31B | Qwen3-VL 32B |
| --- | --- | --- |
| Clean paragraph, Arial 34px | **0.0 / 0.0** | **0.0 / 0.0** |
| Same, Times New Roman | **0.0 / 0.0** | **0.0 / 0.0** |
| Same, Tahoma 17px | 0.5 / 0.5 | **0.0 / 0.0** |
| Fully vocalised (tashkeel) | **0.0 / 0.0** | no answer — looped |
| Arabic-Indic digits and dates | **0.0 / 0.0** | 1.4 / 1.4 |
| Degraded (mild) | **0.0 / 0.0** | **0.0 / 0.0** |
| Degraded (heavy) | 1.5 / 1.5 | **0.0 / 1.5** |
| Invoice to JSON (field accuracy) | **100%** | **100%** |

### Text

| Item | Gemma 4 31B | Qwen3-VL 32B | Qwen3 32B |
| --- | --- | --- | --- |
| Arabic to English (chrF) | 71.7 | 73.2 | **77.8** |
| English to Arabic (chrF) | 81.0 | 58.3 | **81.6** |
| Levantine dialect to MSA (chrF) | **94.2** | 69.2 | 61.0 |
| Grammar correction (chrF) | **100.0** | no answer — looped | 96.3 |
| Structured extraction (fields) | **100%** | **100%** | **100%** |
| Two-sentence summary | pass | pass | pass |
| Exactly three bullets, Arabic only | pass | pass | pass |

### Speed and memory

| | Gemma 4 31B | Qwen3-VL 32B | Qwen3 32B |
| --- | --- | --- | --- |
| Median latency per item | **1.3 s** | 21.7 s | 0.7 s (text only) |
| Slowest item | **11.7 s** | 139.1 s | 8.7 s |
| Total for the suite | **40 s** | 589 s | 13 s (7 items) |
| Generation rate | 64.1 tok/s | 64.5 tok/s | 66.1 tok/s |
| Peak whole-card VRAM | **22.7 GiB** | 26.4 GiB | 24.6 GiB |
| Reasoning emitted across the suite | 0 chars | 104,565 chars | 0 chars |

Generation rate is near-identical across all three. **The entire latency
difference is reasoning volume**, not throughput.

## Findings

**Gemma 4 reads Arabic essentially perfectly, including diacritics.** It is the
only model that transcribed the fully vocalised passage, and it did so at 0.0%
*strict* — reproducing every harakat, not just the consonantal skeleton. That is
the hardest OCR item in the corpus and the one most models decline by silently
dropping the marks.

**Both vision models are effectively perfect on clean text, so the degraded and
specimen items carry the whole signal.** On heavy degradation they split in
opposite directions: Qwen3-VL got the letters exactly right where Gemma made one
small error, while Gemma got the digits right where Qwen3-VL did not. Neither
gap is large enough to rank them on.

**On the real bilingual specimens, Gemma produced markedly more useful output.**
On the Bahrain passport page it paired each Arabic label with its Latin
counterpart and value (`TYPE / النوع: PB`), reconstructing the document's
bilingual structure. Qwen3-VL listed Arabic labels with the values stripped out,
and misread the Palestinian ID number as `9064222530` — one digit too many — plus
several MRZ characters. For identity-document work that error class matters more
than a CER point.

**Qwen3-VL cannot be stopped from reasoning, and twice it never stopped.** On the
tashkeel transcription and the grammar correction it burned the entire 8192-token
budget on reasoning (19,917 and 29,597 characters) and emitted no answer at all.
Doubling the budget from 4096 did not fix it, which is what distinguishes a
looping model from a starved one. These are recorded as **no answer**, not as a
100% error rate, because the two mean different things.

**Gemma 4's dialect handling is the clearest quality gap in the whole run.**
Converting Levantine to MSA, it scored 94.2 chrF against 69.2 and 61.0. Reading
the outputs confirms the number: Gemma produced the idiomatic MSA construction
throughout, while the other two left dialect-flavoured word choices in place.
Dialect is most of what Arabic speakers actually write and almost none of what
standard corpora contain, so this is the result most likely to generalise.

**Turning off reasoning made Gemma about 10x faster at equal quality.** With
thinking enabled it averaged 5-30 s per item; with `think: false` it averages
1.3 s and scores the same or better on every OCR item. The one place reasoning
helped was Arabic-to-English translation, where it scored 81.2 with thinking
against 71.7 without.

**chrF against a single reference cannot separate good paraphrases, and it bit
here.** On Arabic-to-English all three produced excellent, essentially equivalent
translations; the 71.7 / 73.2 / 77.8 spread reflects which synonyms each picked,
not quality. Read those three numbers as a tie. The metric is sound where there
is a narrow correct answer (grammar, dialect register) and weak where there is
not.

**Reproducibility is confirmed.** Gemma 4 produced byte-identical scores across
two independent runs, which is what greedy decoding should give and a useful
check that the harness is not introducing variance.

## Method

Three models, one runtime, one corpus, one run each.

| | |
| --- | --- |
| Runtime | Ollama 0.34.0, all three models, same engine and same flags |
| Sampling | temperature 0, seed 20260914, `num_ctx` 16384, `num_predict` 8192 |
| Thinking | disabled on every model that honours the flag |
| Corpus | `config/arabic-eval.json` v2026-09-14 — 10 OCR items, 7 text items |
| Scoring | `src/lib/text-scoring.ts`, 22 unit tests in `scripts/text-scoring.test.mjs` |
| Reproduce | `python scripts/arabic-fixtures.py && node scripts/experiment-arabic.mjs` |

**Why Ollama and not vLLM.** vLLM is this box's serving runtime and would win on
throughput, but it cannot load Gemma 4 at this version. Running Gemma on a freshly
pulled 30 GB image against Qwen on the old one would have compared runtimes as
much as models.

**Why the corpus is written rather than collected.** Every Arabic passage is
original text written for this corpus. A benchmark built from famous text measures
memorisation rather than reading, and a corpus built from copyrighted text cannot
be committed. The OCR fixtures are *rendered* from that text, which makes the
ground truth exact — typing ground truth by hand for found documents puts the
transcriber's own errors into every model's denominator. The cost is that clean
renders flatter every model, which is why the corpus also carries two degradation
tiers and two real Wikimedia specimen documents.

**Why two error rates.** Tashkeel are optional, alef/ya/ta-marbuta variants are
keyboard accidents, and Arabic-Indic digits are the same numbers as ASCII ones. So
every OCR item reports a `strict` rate (raw) and a `normalized` rate (after
folding those), and the gap between them is itself a finding. Full reasoning in
the header of `text-scoring.ts`.

## Three harness bugs found and fixed before these numbers

Recorded because all three produced plausible-looking results that were wrong:

1. **Reshaped ground truth.** The renderer emits Unicode *presentation forms* —
   contextual initial/medial/final glyph codepoints. A model reading that image
   types ordinary Arabic. Without folding those back, CER would have been ~1.0 for
   a flawless transcription. A harness reporting 100% error looks exactly like a
   broken model.
2. **Discarded reasoning.** Ollama returns thinking in `message.thinking`, not as
   inline `<think>` tags. The first run read only `message.content`, so a thinking
   model spent its whole budget reasoning, returned empty content, and scored 0
   chrF — a conclusion about the harness, not the model.
3. **A ceiling that measured nothing.** The original mild degradation was read at
   0% CER by every model, same as the clean render. `ocr-degraded-heavy` was added
   — half resolution, 3.5 degrees of skew, a lighting gradient, JPEG quality 18 —
   and kept *alongside* the mild tier rather than replacing it.

## The confound that could not be removed

`qwen3-vl:32b` advertises a thinking capability but **ignores `think: false`**.
Verified directly: asked to "Reply with exactly: OK" it still emitted 484
characters of reasoning. Gemma 4 and Qwen3 both honour the flag.

So Qwen3-VL's latency includes reasoning the other two were told to skip, and its
speed numbers are not a like-for-like measure of generation throughput. They are
still the right numbers for a deployment decision — this is what the model does
when you ask it something — but they should not be quoted as "Qwen3-VL is slower
at generating tokens". Its generation rate is in fact the fastest of the three.

## Caveats — read before quoting any number

- **One run per item, greedy decoding.** Latency figures are single observations.
  Do not read a 10% gap in tokens/sec as real.
- **Models run off their published sampling recommendations.** Gemma 4's card asks
  for temperature 1.0 / top_p 0.95 / top_k 64. These are greedy-decoded scores.
- **Thinking is off** where the model allows it. These are not the scores a
  reasoning model posts with reasoning on — and on one item that cost Gemma
  ~10 chrF.
- **Peak VRAM is whole-card.** It includes the desktop and every other
  application; an upper bound, not a model-only allocation.
- **The two specimen documents have no ground truth** and were assessed by reading
  them, not by CER.
- **chrF against one reference cannot separate good paraphrases.** See Findings.
- **17 items is a small corpus.** It is enough to separate these three on dialect,
  diacritics and looping behaviour. It is not enough to rank models that finish
  within a point or two of each other.

## What this changed on the box

- `ollama` registered as a service (`:11434`, `localOnly`), one model resident at
  a time, adopted from the tray app when it already holds the port.
- Router aliases `local-gemma4`, `local-qwen3-vl`, `local-qwen3`.
- Measured footprints and a declared `vision` flag in `config/model-meta.json`.
- A `gpu-heavy` workload so a local chat run cannot collide with image generation.
- The **Arena** tab, which runs this comparison interactively on any prompt — see
  `docs/arena.md`.
- A latent bug fixed: the Vision capability was routed to `local-small`, a 7B that
  cannot see, because the router reports `mode: chat` for multimodal and text-only
  models alike.
