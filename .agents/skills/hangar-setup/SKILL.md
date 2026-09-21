---
name: hangar-setup
description: Install and configure Hangar on this local machine with a working local LLM. Use when someone points to this skill, asks Codex to set up Hangar, add a machine, choose a model for their hardware, or fix a console showing another machine's profile.
---

# Set up Hangar on this machine

Hangar is a local AI operations console. Set it up from measured facts about the
current computer; do not copy another machine's services or invent capabilities.

## 1. Get the repository

First check whether the current directory is already Hangar:

```bash
git remote get-url origin
```

If it is not, verify Git and Node.js 22 or newer, then clone and install:

```bash
git --version
node --version
git clone https://github.com/alibad/hangar.git
cd hangar
npm install
```

If a prerequisite is missing, explain it. Get approval before installing or
replacing system software.

## 2. Inspect before changing anything

```bash
node -e 'console.log(require("os").hostname())'
ls config/hosts/
node scripts/detect-host.mjs
```

If a matching profile already exists, do not flatten it. Report what differs
and offer a field-by-field refresh.

Read the detector output. Preserve its distinction between Apple unified memory
and discrete GPU memory. Only configure services that respond and are identified.
An open port alone is not proof of a capability.

## 3. Ensure a local text model works

Inspect Ollama before installing or downloading anything:

```bash
ollama --version
ollama list
curl -s http://localhost:11434/api/tags
```

- Reuse a suitable installed chat model when one fits.
- If Ollama is installed but stopped, start it normally and probe again.
- If Ollama is absent, explain that Hangar needs a local inference service and
  ask before installing it from `https://ollama.com/download`.
- If no suitable model is installed, recommend one from measured available
  memory. `qwen3:8b` is a sensible default around 8 GB available. State the
  download size and ask before pulling it.

Prove the exact selected model answers:

```bash
ollama run <exact-installed-model-tag> "Reply with exactly: LOCAL MODEL OK"
```

## 4. Describe this machine

Create `config/hosts/<id>.json`, using the lowercased hostname with `.local`
removed. Read `config/hosts/example.json` for the schema.

- The filename and `id` must match.
- `name` is the user's name for the computer.
- `memory.kind` must come from detection.
- `services` contains only verified services.
- Capability ids are `text`, `vision`, `image`, `stt`, and `tts`.
- `workstreams` contains only work actually backed by a listed service.
- `runtimes` declares which ENGINE drives each capability. `services` says what
  is listening; `runtimes` says what does the work and whether its output has
  been checked. Add it — `example.json` documents every field.
- Keep `publicUrl` expressed with `${PUBLIC_DOMAIN}`; do not hard-code a host.

### Choosing a driver

| Capability | Apple silicon | NVIDIA | CPU-only / other |
|---|---|---|---|
| text, vision, embedding | `ollama` | `ollama` or `vllm` | `ollama` |
| image | `mflux` | `comfyui` or `qwen-native` | `null` |
| stt / tts | `mlx-audio` | `whisper` / `kokoro` | `null` |
| video | `draw-things-cli` | `comfyui` | `null` |

`driver: null` is a legitimate answer and is better than a guess: it makes the
console say the capability is not set up rather than offering a dead button.

On Apple silicon prefer `mflux` over `draw-things-cli`. The standalone Draw
Things CLI ships Metal 4 cooperative-tensor shaders that macOS 27's Metal
compiler rejects; the older build returns a valid PNG of pure noise without
erroring, and the current one crashes. The same weights render correctly in the
Draw Things GUI app. Install mflux with `uv tool install mflux` after asking,
and expect roughly 5 GB of weights on the first run.

### Prove every runtime

```bash
node scripts/doctor.mjs            # run everything, record nothing
node scripts/doctor.mjs --write    # record only what genuinely passed
```

The doctor runs a real job per capability and inspects the OUTPUT: it measures
an image for noise, transcribes the speech it just synthesized, and checks that
embeddings rank related text above unrelated text. It writes `verifiedAt` only
on a pass and clears a previous pass on a failure.

Never write `verifiedAt` by hand. It is the console's whole basis for claiming a
capability works, and a hand-written one is a claim nobody checked. This field
exists because a machine produced pure static for four days while every health
check reported success.

Create `scripts/service-commands.<id>.json` from the example. Discover real
commands using the running process, service launcher, or user input. Never invent
absolute paths. Use `skip` for externally managed services. This file is ignored
by Git because it is specific to one disk.

Register the profile in both places documented by `config/hosts/example.json`:

1. Import and add it to `HOST_PROFILES` in `src/lib/host.ts`.
2. Add its id to the `known` set in `next.config.ts`.

## 5. Verify the outcome

```bash
npm test
npm run build
curl -s http://localhost:8003/api/host
curl -s http://localhost:8003/api/health
node scripts/doctor.mjs
```

Start or restart Hangar when needed. Do not report success until `/api/host`
shows `matchesProfile: true`, the console identifies this computer, and the local
model responds. A declared service reporting down must be investigated or removed.

A service that is up while its runtime fails the doctor is the most important
thing to report: that is a machine which looks healthy and produces garbage.

## 6. Offer optional integration

Do not silently enable these:

- Background startup: `./scripts/install-agents.sh` on macOS, or the Windows
  scheduled-task flow using `scripts/start-console.ps1`.
- Agent access: use the Services page's configuration for Claude Code or Codex,
  backed by `scripts/mcp-hangar.mjs`.
- Visual capture: `node scripts/walk-console.mjs --host <id>`.

## Report

State what was measured, what was configured, what was verified, and what remains
unavailable or unidentified. Report listening and working as separate numbers:
`{up}/{n} services up` and `{v}/{r} runtimes verified`. Never call a placeholder
start command configured, never present a health check as proof that a
capability works, and never claim setup is complete while the host mismatch
warning remains.
