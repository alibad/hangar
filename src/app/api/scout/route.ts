import { NextRequest, NextResponse } from "next/server";
import { getScout } from "@/lib/model-scout";
import { WireError, unwire, wire } from "@/lib/wired-models";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://localhost:8099";

/**
 * The scout: what exists that this box is not using, and whether it would fit.
 *
 * GET is safe to poll — provider model lists are cached for 15 minutes behind
 * discover(). `?force=1` bypasses that cache, and is what the Refresh button
 * sends; nothing else should.
 */
export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    return NextResponse.json(await getScout({ force }));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * Restart the router so a newly-wired alias is actually served.
 *
 * litellm reads its config once at startup — there is no reload signal — so
 * without this the console would report success on a model that /model/info has
 * never heard of. Failures here are reported rather than swallowed: the config
 * change IS committed at that point, and "wired but needs a restart" is a state
 * the user has to be told about, not one to paper over.
 */
async function restartRouter(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${MANAGER_URL}/services/ai-router/restart`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: body?.error || `Manager returned ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  try {
    if (action === "wire") {
      const models = wire({
        alias: body.alias,
        target: body.target,
        provider: body.provider,
        mode: body.mode,
        source: body.source,
      });
      const restart = await restartRouter();
      return NextResponse.json({
        ok: true,
        wired: models,
        restarted: restart.ok,
        // Deliberately not an error status: the wiring succeeded and is on disk.
        warning: restart.ok
          ? undefined
          : `Wired, but the router did not restart (${restart.detail}). It will pick the model up on its next start.`,
      });
    }

    if (action === "unwire") {
      const alias = String(body?.alias ?? "").trim();
      if (!alias) return NextResponse.json({ error: "No alias given" }, { status: 400 });
      const models = unwire(alias);
      const restart = await restartRouter();
      return NextResponse.json({
        ok: true,
        wired: models,
        restarted: restart.ok,
        warning: restart.ok
          ? undefined
          : `Removed, but the router did not restart (${restart.detail}). It will drop the model on its next start.`,
      });
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    // A rejected alias or target is the user's mistake to fix, not a server
    // fault — say which, and say why, rather than returning a bare 500.
    if (e instanceof WireError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
