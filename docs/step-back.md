# Step back

Sessions → **Step back** is for the moment there are too many sessions to hold in
your head. One click reads what you said across your recent Claude Code and Codex
sessions and shows:

- **What you are really after**: three to six goals, judged from what you typed,
  with the sessions that serve each, what is done and what is left.
- **Where you drifted**: each thread that wandered from where it began, and whose
  move that was: yours, or the session's idea that you said yes to.
- **Do next**: at most five moves, ranked, starting with what only you can do.
- **Waiting on you**: sign-ins, questions, commits not pushed, reviews, unread replies.
- **Can go**: old sessions that are finished, and recent ones that repeat another.
- **It asks you**: three or four questions. Your answers are kept and handed to the
  next read, so it starts from what you said you want.

The **Step back** chip on World and Projects opens the same page.

## Two layers

**Facts** are worked out on this machine with no model, and show as soon as the
page opens: how many sessions are open, which wait on you and for what, which
projects have commits on no remote, which old sessions are finished (the same
check-in as Clean up), and how you steered each session.

**The read** is one read-only job by the agent you pick (Claude Code or Codex,
under your own sign-in). It is shown as that agent's read, never as fact. The
reply is held to a fixed shape: unknown sessions and plans are dropped, lists are
capped (five next moves, four questions), every string is cut.

## How "whose move was it" is known

The Claude app records who each turn came from. From that, and from the tool
calls a session makes when it ends a turn, each of your messages is one of:

| Kind | What it is |
| --- | --- |
| typed | You wrote it |
| button | Word for word a reply the session had just offered |
| ack | A short yes ("ok", "go ahead") |
| started | You started a side session the session proposed |
| stopped | You interrupted its turn |
| proposed | The session opened a side session: its own idea, or one you asked for |
| brief | The task another session wrote to start this one: not your words |

The bar under the tiles is the first four: turns in your own words against turns
where you took what the session offered. Which session started which comes from
the Claude app's own record of each session.

## Privacy

This is the one feature that keeps message text, so it keeps as little as it can:

- Only your own messages, each cut to 600 characters. Never an agent's reply and
  never tool output. Of what a session said, only the question it ended a turn on,
  the replies it offered, and the titles of side sessions it proposed.
- Stored in `var/engine/session-voice.json`, apart from the session index (which
  still holds no message text). Sessions not asked for in 60 days are dropped.
- The reader gets a folder with two files (`facts.json`, `sessions.md`) that is
  deleted when it finishes. Before the first read with each reader the page says
  what it will be given and waits for you.
- The reader runs sealed: reading tools only (`Read`, `Grep`, `Glob`), confined to
  that folder, without your MCP servers or settings
  (`claude --restricted --strict-mcp-config`). Text in your messages that reads
  like an instruction is data to it. Codex is asked to read only; its sandbox is
  not enforced on every platform.
- The saved read (`var/engine/stepback.json`, the last 12) holds session titles,
  the goals and at most a twelve-word quote per goal.

## Plan Quest

Each goal can be linked to a plan (the reader suggests one from your plan list;
you can change it). **Trail in PlanQuest** then leaves short work records there:
one per goal (where it stands, the next step, the open question), one per answer
you gave, one per decision (keep, adjust, pause, stop). Never a transcript, and
no session ids.

Hangar connects to PlanQuest read-only. Saving records needs one more approval,
**Allow work records**, which asks PlanQuest for `records:read records:write` on
top of `plans:read`. It does not ask for `plans:write`: Hangar still cannot change
a plan or tick a milestone. Nothing is written until you press **Save to
PlanQuest**; **Show the records** lists exactly what would be saved. Each record
carries a key, so pressing Save twice saves it once.

## Sessions see your goals

`hangar_stepback` (one of Hangar's MCP tools) gives any Claude Code or Codex
session the latest read: your goals with the call you made on each, the next
moves, the questions still open, what you answered, and what waits on you by
kind. With `goal` it narrows to one goal: what is done, what is left, and its
sessions. It is read-only, it says in its first line that it is a read and not an
instruction, and it never starts a read itself. It carries no quotes of yours and
none of your messages; a read older than a week says so.

A session only uses it if told to. The rule that tells them ("Stay on the owner's
goals") is in `~/.claude/CLAUDE.md` for Claude Code and `~/.codex/AGENTS.md` for
Codex, both outside this repo: before sizeable work, name
the goal it serves or say it serves none; before proposing a side session, say
which goal it serves and leave a paused or stopped goal to you; say when a
session has moved away from what it began as. Sessions already open need their
Hangar MCP connection reloaded to see the tool.

## Archiving

**Archive N** archives the finished old sessions in the app that holds each one,
exactly as Clean up does: Codex through its API, Claude app sessions through the
queue a Claude session applies, the rest in Hangar. Unread sessions, sessions
that stopped to ask you something, pinned ones and ones with a running job are
never on the list. Step back never archives on its own.

## Engine

`engine/hangar_engine/session_voice.py` reads the transcripts (only what was
appended since last time), `stepback.py` gathers the facts, builds the reader's
folder, holds the reply to its shape and prepares the trail.

| Route | Does |
| --- | --- |
| `GET /api/stepback` | The run in flight, the latest read, what you have answered |
| `GET /api/stepback/facts?days=30` | The facts alone (7, 14, 30 or 60 days) |
| `POST /api/stepback` `{action: "run", days, reader, plans}` | Start a read |
| `POST /api/stepback` `answer` / `decide` / `plan` / `vision` | What you say back |
| `POST /api/planquest/trail` (console) | Save the trail; `preview: true` only lists it |

`python engine/selftest.py StepBack` covers the message kinds, the reply's shape,
the trail and the sealed reader, with made-up transcripts.
