# Hangar at AI Tinkerers Doha Round 3

Monday, 21 September 2026 · 15-minute live segment

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

## The 15:00 run of show

| Time | Surface | Show and say | Visible proof |
| --- | --- | --- | --- |
| 0:00–1:15 | Home | “A Hangar is where models and services wait, fit, and move. This is its Console.” | Header reads **Hangar** and **B5 console**. |
| 1:15–3:15 | Home | This UI comes from the host profile rather than pretending every machine is the same. | Apple M5 Max, 128 GB unified memory, exactly two declared services. |
| 3:15–5:15 | Services | Stop Ollama, wait for **On demand**, then Start and wait for **Ready**. Do not click twice. | Each transition completes before the next action; manager remains ready. |
| 5:15–7:45 | Models | Show installed Ollama tags, capability badges, exact/estimated footprint language, and unavailable aliases marked **not installed**. | `local-ollama` is ready; resident memory is 18.2 GB only after the model is loaded. |
| 7:45–10:45 | Chat & Code | Ask: “In one sentence, explain why unified memory changes AI model scheduling on Apple silicon.” | A local answer appears, attributed to the actual Ollama model, without a fallback warning. |
| 10:45–12:45 | Home → Requests | Return Home to show the resident model and live memory. Open Requests. | Stop, start, and chat rows name target **ollama**, status **200**, and measured latency. |
| 12:45–14:15 | Public tab | Open the public domain and point out the same Hangar identity. | HTTPS serves the deployed commit. Remote machine controls are deliberately not claimed unless the private manager tunnel is live. |
| 14:15–15:00 | Close | “The important part is not a model list. It is an operator seeing what is actually installed, what fits, what is resident, and what just happened.” | Leave Requests visible. |

## Presenter guardrails

- Stop/start only `ollama`. Never stop `manager` or the console presenting the
  demo.
- Wait for the status badge to settle before another control action. The API
  also enforces a 120-second upper bound.
- Do not claim that Vercel itself controls B5. The public deployment is the
  shipped Console; live machine control requires an authenticated manager
  tunnel, and the on-stage operator path is local.
- Do not describe the 18.2 GB figure as measured physical RAM. It is the
  configured resident footprint used for admission decisions; Home's system
  memory gauge is the live machine measurement.
- If a service transition exceeds 20 seconds, skip to the fallback video rather
  than debugging on stage.

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
- **Ollama does not restart:** do not retry repeatedly. Keep manager running,
  play the fallback video, and use its captured Requests view as evidence.
- **Model reply stalls:** wait 20 seconds, then switch to the fallback. The
  model is intentionally warm, so a longer delay signals a real fault.
- **Browser layout is wrong:** use 1440×900 or larger and reset zoom to 100%.
- **Public site is healthy but machine cards are down:** state the boundary:
  the deployed UI is live; this B5 operator session is the verified control
  plane. Do not turn missing remote connectivity into a green status.

## Evidence checklist

- `npm test`: 112/112.
- `npx tsc --noEmit`: pass.
- `npm run build`: pass.
- Two `docs/walkthrough/event-rehearsal-*.json` receipts: all checks pass.
- Two browser walk records plus Retina screenshots from the tested build.
- Fallback MP4, captions, narration transcript, and evidence log in the event
  delivery folder.
