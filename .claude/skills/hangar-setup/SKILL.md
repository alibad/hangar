---
name: hangar-setup
description: "Teach Hangar about the machine it is running on. Probes what is actually listening, writes config/hosts/<id>.json and its start commands, registers the profile, and verifies the console comes up describing this computer instead of somebody else's. Use when the console shows another machine's name or services, when someone has just cloned Hangar, when adding a second or third machine, or when they say the console says it is not their machine, /hangar-setup, set up Hangar, add this machine, or configure the host profile."
---

# Hangar — set up this machine

Hangar decides what it can do by reading one JSON file per machine. Until that
file exists for **this** computer, host resolution falls back to a profile that
ships as an example — so a fresh clone renders another person's services under
another person's machine name. Your job is to replace that guess with a
description of what is really here.

The one rule: **a host profile is a claim about a machine, and every claim in it
must be something you measured.** A profile that lists a service which is not
there is worse than no profile, because the console will report it as *down* and
send someone debugging a service they never installed.

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

  profile    config/hosts/{id}.json — {n} services
  commands   scripts/service-commands.{id}.json — {m} configured, {k} left as TODO
  verified   matchesProfile true · {up}/{n} services up

  Not set up: {anything skipped, and why}
  Unidentified: {ports listening with nothing recognisable behind them}
```

Never report a service as configured when its start command is a placeholder,
and never say setup is complete while the banner is still showing.
