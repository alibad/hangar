import { NextRequest, NextResponse } from "next/server";
import { atlasBase, fleetGuard, peerBase } from "@/lib/fleet";
import { planquest, PlanQuestError, PLANQUEST_COOKIE, loopbackOrigin, type WorkRecordInput } from "@/lib/planquest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

async function handle(request: NextRequest, context: Context) {
  const path = (await context.params).path.join("/");
  const callback = path === "oauth/callback" && request.method === "GET";
  // OAuth returns via a cross-site navigation. Only this callback bypasses the
  // fetch-site check; PKCE + browser-bound, single-use state authenticate it.
  const headers = new Headers(request.headers);
  if (callback) { headers.delete("sec-fetch-site"); headers.delete("origin"); }
  const denied = fleetGuard(new Request(request.url, { method: request.method, headers }));
  if (denied) return denied;
  try {
    const origin = loopbackOrigin(`http://${request.headers.get("host")}`);
    if (callback) {
      let connected = false, back = "world";
      try {
        const query = request.nextUrl.searchParams;
        const finished = await planquest.finish(origin, query.get("state") || "", request.cookies.get(PLANQUEST_COOKIE)?.value || "", query.get("code") || "", query.has("error"));
        connected = finished.connected;
        if (finished.returnTo === "/#sessions") back = "sessions";  // Step back asked; everything else returns to the map
      } catch { /* Keep OAuth values and upstream details out of URLs and logs. */ }
      const response = NextResponse.redirect(`${origin}/?planquest=${connected ? "connected" : "failed"}#${back}`, 303);
      response.cookies.set(PLANQUEST_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/api/planquest/oauth", maxAge: 0 });
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (request.method === "GET") {
      if (path === "status") return json(await planquest.status());
      if (path === "plans") {
        const query = (request.nextUrl.searchParams.get("q") || "").trim().toLowerCase().slice(0, 200);
        const plans = await planquest.plans(request.nextUrl.searchParams.get("fresh") === "1");
        return json({ plans: plans.filter(p => !query || `${p.title} ${p.description} ${p.folders.join(" ")}`.toLowerCase().includes(query)) });
      }
      if (path.startsWith("plans/")) return json({ plan: await planquest.plan(path.slice(6)) });
    }
    if (request.method === "POST") {
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: "Request is too large." }, 413);
      let input: Record<string, unknown>;
      try { input = JSON.parse(raw || "{}"); if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); }
      catch { return json({ error: "Send a JSON object." }, 400); }
      if (path === "connect") {
        // records: true also asks for the right to save work records (Step back's trail); the default stays read-only.
        const result = await planquest.begin(origin, input.returnTo === "/#sessions" ? "/#sessions" : "/#projects", input.records === true);
        const response = json({ url: result.url });
        response.cookies.set(PLANQUEST_COOKIE, result.cookie, { httpOnly: true, sameSite: "lax", path: "/api/planquest/oauth", maxAge: 600 });
        return response;
      }
      if (path === "disconnect") return json(await planquest.disconnect());
      if (path === "trail") {
        // Step back's trail. The records come from the engine's own saved read, never from the browser: the page only
        // says which step back and, optionally, which of its records. preview lists them without saving anything.
        const base = await atlasBase();
        const engine = (body: unknown) => fetch(`${base}/api/stepback`, { method: "POST", headers: { "Content-Type": "application/json", "X-Atlas": "1", "X-Hangar": "1" }, body: JSON.stringify(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
        const listed = await engine({ action: "records", ...(typeof input.run === "string" ? { run: input.run.slice(0, 40) } : {}) });
        if (!listed.ok) return json({ error: "There is no step back to save yet." }, 400);
        const { run, records } = await listed.json() as { run: string; records: (WorkRecordInput & { saved?: unknown })[] };
        if (input.preview === true) return json({ run, records });
        const only = Array.isArray(input.keys) ? new Set(input.keys.filter((k): k is string => typeof k === "string")) : null;
        const saved: Record<string, string> = {}, failed: { key: string; title: string; error: string }[] = [];
        for (const record of records.filter(r => !r.saved && (!only || only.has(r.key))).slice(0, 40)) {
          try { saved[record.key] = (await planquest.record(record)).url; }
          catch (error) {
            const known = error instanceof PlanQuestError;
            failed.push({ key: record.key, title: record.title, error: known ? error.message : "PlanQuest could not save this record." });
            if (known && [401, 403].includes(error.status)) break;  // no access: the rest would fail the same way
          }
        }
        if (Object.keys(saved).length) await engine({ action: "recorded", run, records: saved });
        return json({ run, saved, failed });
      }
      if (path === "link") {
        if (typeof input.repo !== "string" || !input.repo || input.repo.length > 200) return json({ error: "Choose an indexed project." }, 400);
        const machine = input.machine ?? "local";
        if (typeof machine !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(machine)) return json({ error: "Choose a connected machine." }, 400);
        const base = machine === "local" ? await atlasBase() : await peerBase(machine);
        // The client supplies an ID, never a title/URL. Verify access and fetch
        // canonical metadata before changing the project's local association.
        const plan = await planquest.plan(typeof input.plan_id === "string" ? input.plan_id : "");
        if (plan.archived) return json({ error: "Choose an active plan." }, 400);
        const response = await fetch(`${base}${machine === "local" ? "/api/plans" : "/api/world/local/proxy/plans"}`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Atlas": "1", "X-Hangar": "1" },
          body: JSON.stringify({ repo: input.repo, title: plan.title, url: plan.url }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) return json({ error: "The project link could not be saved. Check that Atlas and this project are available on the selected machine." }, response.status >= 500 ? 503 : 400);
        const saved = await response.json();
        return json({ link: saved.link, plan });
      }
    }
    return json({ error: "Unknown PlanQuest operation." }, 404);
  } catch (error) {
    return json({ error: error instanceof PlanQuestError ? error.message : "PlanQuest could not complete this request. Check the connection and retry." }, error instanceof PlanQuestError ? error.status : 503);
  }
}
export const GET = handle;
export const POST = handle;
