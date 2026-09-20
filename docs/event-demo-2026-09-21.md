# Hangar at AI Tinkerers Doha Round 3

Monday, 21 September 2026 · Console + MCP · 8:10–8:30 PM

## Locked event timing

- Doors: **6:00 PM**.
- Isha and settle: **6:50–7:15 PM**.
- Kickoff: **7:15–7:30 PM**.
- Hangar Console + MCP: **8:10–8:30 PM**, the final program slot.
- Live demo: **8:10–8:25 PM**. Audience Q&A: **8:25–8:30 PM**.

Console owns 5:45 of the live demo, then hands off cleanly to MCP. Do not let
Console borrow MCP or Q&A time.

## Name the product once

**Hangar is the product. Console is its operator surface.** BeTenshi and B5 are
machine profiles managed by Hangar. The private repository and Vercel project
retain the historical `betenshi-console` slug; that is infrastructure history,
not the product name. The public entry point is `console.humanquest.net`.

## Safe initial state

- Present from B5 on mains power, with Wi-Fi connected.
- Open the tested production build at `http://127.0.0.1:8003` as the working
  operator surface. Keep `https://console.humanquest.net` open in a second tab
  to prove the shipped build and public identity.
- Manager and Ollama are running; Ollama is manager-owned, not an adopted
  process. Text routing is `local-ollama` → `qwen3.8:27b-mlx`.
- Keep the 27B model warm. Reliability matters more than performing a cold-load
  delay on stage.
- Close unrelated windows and disable notifications. Keep the fallback video
  and this runbook available offline.
- Be at the ready screen by **8:08 PM**. Home is the opening tab; Requests is
  pre-opened in a second tab; the fallback video is paused at 0:00.

## Combined 15:00 live demo

| Clock | Owner / surface | Show and say | Visible proof |
| --- | --- | --- | --- |
| 8:10:00–8:10:30 | Shared frame | “Hangar makes local AI infrastructure legible and operable. Console is the human surface; MCP is the agent surface.” | One system, two interfaces. |
| 8:10:30–8:11:30 | Console · Home | “This is B5, live—not a generic dashboard.” Show the ready state and capacity strip. | **Hangar**, **B5 console**, Apple M5 Max, 128 GB unified memory, 2/2 services. |
| 8:11:30–8:12:40 | Console · Models | Point to the installed route, unavailable aliases, and the resident footprint. | `local-ollama` is ready; `qwen3.8:27b-mlx` occupies 18.2 GB; absent tags are not presented as runnable. |
| 8:12:40–8:14:35 | Console · Chat & Code | Ask the prepared one-sentence unified-memory question. Speak while the warm local model answers. | The actual Ollama model responds locally without a fallback warning. |
| 8:14:35–8:15:45 | Console · Requests | Show the chat row and the preflight stop/start rows. “The UI records what happened, where, how long it took, and whether it worked.” | Target **ollama**, HTTP **200**, measured latency; bounded controls are already evidenced without risking a live restart. |
| 8:15:45–8:16:15 | Console → MCP | “That is the operator view. Now we expose the same real machine to an agent through MCP.” Stop speaking and hand over. | Leave Requests visible as the continuity surface. |
| 8:16:15–8:24:40 | MCP | MCP-owned live flow. Console presenter stays out unless called on. | MCP demonstrates the agent surface against the same Hangar runtime. |
| 8:24:40–8:25:00 | Shared close | “One runtime: observable for humans, usable by agents.” | End on the result, not setup. |

## Q&A · 8:25–8:30 PM

- First answer questions from the surface already visible; do not navigate while
  another presenter is answering.
- Console's shortest proof line: “Installed, fits, resident, and happened are
  four different facts; Hangar keeps them different.”
- If asked about start/stop, point to the successful Requests rows and explain
  that the bounded control was rehearsed twice. Do not restart Ollama during the
  five-minute Q&A.
- At **8:29:30**, take the last question. At **8:30:00**, thank the room and end.

## Presenter guardrails

- Do not perform live stop/start in the locked 15-minute flow. The rehearsed
  stop/start rows are the proof. If an organizer explicitly asks for the control
  after the program, stop/start only `ollama`, never `manager` or the console.
- Wait for the status badge to settle before another control action. The API
  also enforces a 120-second upper bound.
- Do not claim that Vercel itself controls B5. The public deployment is the
  shipped Console; live machine control requires an authenticated manager
  tunnel, and the on-stage operator path is local.
- Do not describe the 18.2 GB figure as measured physical RAM. It is the
  configured resident footprint used for admission decisions; Home's system
  memory gauge is the live machine measurement.
- If the model has not answered 20 seconds after submission, play the fallback
  immediately. The Console segment has no recovery budget.

## Reset between runs

1. Ensure `manager` and `ollama` both read **Ready** on Services.
2. Set Text routing to `local-ollama` and Vision routing to
   `local-qwen3-vl` on Models.
3. Send the demo prompt once so the 27B model is warm.
4. Return to Home, scroll to the top, then reload. Confirm B5, 128 GB unified
   memory, and exactly two services.
5. Open Requests in a second tab. Existing rows are evidence, not a failure;
   the rehearsal receipt records the fresh stop/start/chat sequence.
6. If anything differs, run:
   `HANGAR_URL=http://127.0.0.1:8003 node scripts/rehearse-event-demo.mjs --label preflight`

## Failure branches

- **Wi-Fi/public DNS fails:** continue on the localhost production build and say
  that machine operation is local-first. Show the fallback public-site capture
  at the end.
- **Ollama is not ready at 8:08:** do not restart it on stage. Play the fallback
  for the Console portion and preserve the MCP handoff at 8:16:15.
- **Model reply stalls:** wait 20 seconds, then switch to the fallback. The
  model is intentionally warm, so a longer delay signals a real fault.
- **Browser layout is wrong:** use 1440×900 or larger and reset zoom to 100%.
- **Public site is healthy but machine cards are down:** omit the public tab; it
  is not part of the timed path. This B5 operator session is the verified control
  plane. Do not turn missing remote connectivity into a green status.

## Evidence checklist

- `npm test`: 112/112.
- `npx tsc --noEmit`: pass.
- `npm run build`: pass.
- Two `docs/walkthrough/event-rehearsal-*.json` receipts: all checks pass.
- Two browser walk records plus Retina screenshots from the tested build.
- Fallback MP4, captions, narration transcript, and evidence log in the event
  delivery folder.
