---
name: hangar-setup
description: "Install and configure Hangar on a local machine with a working local LLM. Clones and bootstraps the public repository when needed, probes what is actually listening, writes config/hosts/<id>.json and its start commands, registers the profile, and verifies the console describes this computer instead of somebody else's. Use when someone points you to this skill, has just discovered Hangar, sees another machine's name or services, wants to add a machine, or says /hangar-setup, set up Hangar, add this machine, or configure the host profile."
---

# Hangar — install and set up this machine

Hangar decides what it can do by reading one JSON file per machine. Until that
file exists for **this** computer, host resolution falls back to a profile that
ships as an example — so a fresh clone renders another person's services under
another person's machine name. Your job is to replace that guess with a
description of what is really here. If Hangar has not been cloned yet, begin by
putting the public repository on this machine and installing its dependencies.

The one rule: **a host profile is a claim about a machine, and every claim in it
must be something you measured.** A profile that lists a service which is not
there is worse than no profile, because the console will report it as *down* and
send someone debugging a service they never installed.

---

## Before Step 0 — get Hangar onto the machine

First establish whether the current directory is already the Hangar repository:

```bash
git remote get-url origin
```

If it is not, check that Git and Node.js 22 or newer are available, then clone
the public repository into an appropriate development directory:

```bash
git --version
node --version
git clone https://github.com/alibad/hangar.git
cd hangar
npm install
```

If Git or Node is missing, explain what is missing and use the platform's normal
package manager or official installer after getting the user's approval. Do not
silently replace an existing Node installation or install a second package
manager. All remaining commands run from the Hangar repository root.

---

## Step 0 — Is this even needed?

```bash
node -e 'console.log(require("os").hostname())'
ls config/hosts/
```

If a profile already matches this hostname (case-insensitive, `.local`
stripped), **stop and say so.** Re-running setup over a working profile is how a
hand-tuned one gets flattened. Offer `--refresh` semantics instead: show what
changed and let the user choose, field by field.

If the console is running, `/api/host` answers the question directly:

```bash
curl -s localhost:8003/api/host
```

`matchesProfile: false` is the case this skill exists for.

---

## Step 1 — Measure the machine

```bash
node scripts/detect-host.mjs
```

This prints hostname, platform, accelerator, memory model, and which known
ports answer HTTP. **Read its output rather than trusting the defaults** — two
things in it decide how the whole console behaves:

**`memory.kind` is the field that matters most.**

| | Means | Consequence |
|---|---|---|
| `unified` | Apple silicon — CPU and GPU share ONE pool | One memory bar; a model's footprint is one number |
| `discrete` | A card and a host with SEPARATE budgets | Two bars; the fit check refuses a model that will not fit the card |

Getting this wrong does not error. It silently budgets against the wrong
ceiling, and the first sign is a model that will not load for no visible reason.

**Ports that are open but answered nothing are reported separately and left
out.** That is deliberate, and you must not override it by assuming. If the user
says a service really is there, confirm what it is — ask, or read its start
command — before adding it.

### Ensure there is a local text model

Hangar should open with at least one useful local LLM. Inspect before installing:

```bash
ollama --version
ollama list
curl -s http://localhost:11434/api/tags
```

- If Ollama is installed but stopped, start it using the platform's normal app
  or service command, then probe it again.
- If Ollama is missing, explain that Hangar needs a local inference service and
  offer to install Ollama from `https://ollama.com/download`. Installation is a
  system change, so obtain the user's approval before doing it.
- If Ollama has at least one chat-capable model, reuse it unless it clearly will
  not fit this machine.
- If it has no suitable text model, use the measured memory to recommend one.
  `qwen3:8b` is the default for a machine with at least roughly 8 GB available.
  Tell the user the download is several gigabytes and get approval before
  running `ollama pull qwen3:8b`.

Prove the chosen model answers before adding it to the profile:

```bash
ollama run <model> "Reply with exactly: LOCAL MODEL OK"
```

Record the exact installed model tag returned by `ollama list`; do not invent or
normalize it.

---

## Step 2 — Write the profile

Copy the draft into `config/hosts/<id>.json` where `<id>` is the hostname,
lowercased, `.local` stripped. **The filename must equal the `id` field** —
`scripts/host-profiles.test.mjs` enforces it.

Read `config/hosts/example.json` alongside: it documents every field inline and
is validated by the same test suite, so it cannot have drifted.

Then fill in what a port scan cannot answer:

- **`name`** — what the user calls this machine, not the hostname if they differ.
- **`serves`** — capability ids are exactly `text`, `vision`, `image`, `stt`,
  `tts`. The value is the *served-model-name* to send as `model`, which is often
  not the model's Hub id. A typo does not error; the matching tab silently
  reports itself unavailable.
- **`workstreams`** — left empty by the detector on purpose. This is a judgement
  about what the machine is *for*. Declare only what its services genuinely
  back; every entry's `serviceId` must exist in `services`. Declaring work the
  host cannot do is the exact bug host profiles were introduced to fix.
- **`publicUrl`** — leave as `https://<id>.${PUBLIC_DOMAIN}` unless the machine
  has no off-box address at all, in which case set it equal to `localUrl`. Never
  write a literal hostname; a test refuses it.

---

## Step 2b — Declare the runtimes, then prove them

`services` says what is listening. **`runtimes` says what actually DRIVES each
capability, and whether anyone has checked that its output is real.** Add the
block to the profile you just wrote — `config/hosts/example.json` documents
every field inline.

This block is not bookkeeping. In September 2026 one machine produced pure
colour static for four days, and every layer reported success: the service was
up, the port answered, the PNG was structurally valid, the gallery showed it
with a latency badge, the request log said 200. Nothing looked at the pixels.

```json
"runtimes": {
  "text":  { "driver": "ollama",  "model": "<the tag you proved>", "label": "...", "serviceId": "ollama" },
  "image": { "driver": "mflux",   "model": "flux2-klein-4b",       "label": "...", "serviceId": "qwen" },
  "stt":   { "driver": "mlx-audio", "model": "...", "serviceId": "qwen" }
}
```

**Choosing a driver.** Match the hardware, not the brand:

| Capability | Apple silicon | NVIDIA | CPU-only / other |
|---|---|---|---|
| text, vision, embedding | `ollama` | `ollama` or `vllm` | `ollama` |
| image | `mflux` | `comfyui` or `qwen-native` | leave `null` |
| stt / tts | `mlx-audio` | `whisper` / `kokoro` | leave `null` |
| video | `draw-things-cli` | `comfyui` | leave `null` |

`driver: null` is a legitimate, useful answer. It makes the console say "no
image engine is set up here" instead of offering a button into a dead tab.

**On Apple silicon, prefer `mflux` over `draw-things-cli`.** Both can drive
FLUX.2 Klein. The standalone Draw Things CLI ships Metal 4 cooperative-tensor
shaders (`matmul2d_descriptor`, `execution_simdgroups`) that macOS 27's Metal
compiler rejects: the older build fails **silently**, returning a valid PNG of
noise, and the current one crashes with a shader error. The same weights render
correctly in the Draw Things GUI app, so it is the binary, not the machine.
mflux runs on MLX — a different compute stack, and the one the speech models
already use.

### Installing an engine the machine does not have

Ask first; an install is a system change. Then install, then prove:

```bash
# Apple silicon image generation (downloads ~5 GB of weights on first run)
uv tool install mflux            # or: pipx install mflux

# Speech, either platform — follow the engine's own install docs
```

### Then prove every one of them

```bash
node scripts/doctor.mjs            # run everything, record nothing
node scripts/doctor.mjs --write    # record only what genuinely passed
```

The doctor runs a **real job per capability and inspects the output**: it
measures an image for noise, transcribes the speech it just synthesized, and
checks that embeddings score related text above unrelated text. It writes
`verifiedAt` only on a pass, and **clears a previous pass on a failure** — a
stale claim that a capability works is precisely the lie this exists to prevent.

**Never write `verifiedAt` by hand.** It is the console's entire basis for
saying a capability works. If the doctor did not write it, it is not true.

A failing capability is a fine outcome to report. Say which driver failed and
what the doctor saw; leave it declared and unverified rather than deleting it,
so the machine still says what it has.

---

## Step 3 — Start commands

Create `scripts/service-commands.<id>.json`, modelled on
`scripts/service-commands.example.json`. Without it every Start button fails.

Get the commands from the user or from how the services are running now — do
not invent paths. `ps`, `lsof -i :<port>`, or the service's own launcher is
evidence; a plausible-looking path is not. `skip` is a legitimate value for
anything managed outside the console.

This file is gitignored, because start commands are absolute paths into one
disk. Say so, so nobody is surprised when it does not survive a fresh clone.

---

## Step 4 — Register it

Two one-line edits, both noted at the end of `example.json`:

1. `src/lib/host.ts` — import the JSON and add it to `HOST_PROFILES`.
2. `next.config.ts` — add the id to the `known` set in `detectHostId()`.

The duplication is deliberate and commented there: `next.config.ts` cannot
import from `src/`, and `host.ts` must not import `os` because client
components pull in the service registry.

---

## Step 5 — Prove it

```bash
npm test          # host-profiles.test.mjs validates what you just wrote
npm run build
```

Then restart the console and check it describes **this** machine:

```bash
curl -s localhost:8003/api/host
```

`matchesProfile` must now be `true`, and the amber "not your machine's profile"
banner on Home must be gone. If it is still there, the filename, the `id`, or
the `known` set disagree with the hostname — check all three.

Finally, confirm the services you declared are the ones the console sees:

```bash
curl -s localhost:8003/api/health
```

A service you added that reports `down` is either not running or not really
there. Find out which before telling the user setup is complete.

And confirm the capabilities, which a health check cannot tell you:

```bash
node scripts/doctor.mjs
```

Every capability you declared should pass. A service that is `up` while its
runtime fails the doctor is the single most important thing to report — it is a
machine that looks healthy and produces garbage.

---

## Step 6 — Offer the rest, don't assume it

Ask before doing any of these; none is part of "describe this machine":

- **Run it in the background** — `./scripts/install-agents.sh` (macOS launchd;
  it retires any pre-rename `com.betenshi.*` agents). Windows uses a Scheduled
  Task via `scripts/start-console.ps1`. Needs `npm run build` first.
- **Give an agent the stack** — the Services page has an *Agent access* panel
  with ready config for Claude Code and Codex, pointing at
  `scripts/mcp-hangar.mjs`. Nine tools: start/stop services, read logs and GPU,
  transcribe, speak, generate an image.
- **Capture what it looks like** — `node scripts/walk-console.mjs --host <id>`.

---

## Report

State plainly what was measured, what was written, and what is still unproven:

```
Hangar now knows about {name} ({platform}/{gpu}, {memory kind}).

  profile    config/hosts/{id}.json — {n} services, {r} runtimes
  commands   scripts/service-commands.{id}.json — {m} configured, {k} left as TODO
  listening  matchesProfile true · {up}/{n} services up
  working    {v}/{r} runtimes verified by scripts/doctor.mjs

  Not set up: {anything skipped, and why}
  Unidentified: {ports listening with nothing recognisable behind them}
```

Never report a service as configured when its start command is a placeholder,
and never say setup is complete while the banner is still showing.
