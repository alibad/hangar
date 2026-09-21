import { NextRequest, NextResponse } from "next/server";
import { discover, getScout } from "@/lib/model-scout";
import { WireError, unwire, wire, wireMany } from "@/lib/wired-models";
import {
  DownloadError,
  cancelDownload,
  clearDownload,
  resolveRepo,
  startDownload,
  startRuntimeInstall,
} from "@/lib/hf-download";
import { getManagerHeaders, getManagerUrl } from "@/lib/services";

/**
 * The scout: what exists that this box is not using, and whether it would fit.
 *
 * GET is safe to poll — provider model lists are cached for 15 minutes behind
 * discover(). `?force=1` bypasses that cache, and is what the Refresh button
 * sends; nothing else should.
 */
export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";

  // Resolving a name to a Hub repo is a separate, on-demand question — it costs
  // up to nine calls to huggingface.co and is only asked when someone opens one
  // model's detail. Folding it into the main payload would put that cost on
  // every poll, for every model on screen.
  const resolve = req.nextUrl.searchParams.get("resolve");
  if (resolve) {
    try {
      return NextResponse.json(await resolveRepo(resolve));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

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
    const res = await fetch(`${getManagerUrl()}/services/ai-router/restart`, {
      method: "POST",
      headers: getManagerHeaders(),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: body?.error || `Manager returned ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The alias a vendor id gets when wired in bulk.
 *
 * Vendor ids are already alias-shaped, so the id itself is the least surprising
 * name. Mirrors defaultAlias() in the Scout view — the button and the bulk
 * action must agree, or "wire all" would create a second copy of every model a
 * user had already wired one at a time.
 */
function aliasFor(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
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

    /**
     * Wire every cloud model the configured vendors offer and the router does
     * not already serve.
     *
     * The candidate list comes from discover() server-side rather than from the
     * request body: a client posting a list it read a minute ago would wire
     * whatever that snapshot happened to contain, and the point of "all" is that
     * it means all of them as of now. One config write, one router restart.
     */
    if (action === "wire-all") {
      const providers = await discover({ force: true });
      const entries = providers
        .filter((p) => p.reachable)
        .flatMap((p) =>
          p.models
            .filter((m) => !m.wiredAs)
            .map((m) => ({
              alias: aliasFor(m.modelId),
              target: m.target,
              provider: p.provider,
              mode: m.mode,
              source: "wire-all",
            })),
        );

      const { wired, added, skipped } = wireMany(entries);
      // Nothing changed on disk, so the router has nothing new to read. Skipping
      // the restart here is what keeps a second click from taking the gateway
      // down for a minute to accomplish nothing.
      if (!added.length) {
        return NextResponse.json({
          ok: true,
          wired,
          added,
          skipped,
          restarted: false,
          message: "Every cloud model your providers offer is already wired.",
        });
      }

      const restart = await restartRouter();
      return NextResponse.json({
        ok: true,
        wired,
        added,
        skipped,
        restarted: restart.ok,
        warning: restart.ok
          ? undefined
          : `Wired ${added.length}, but the router did not restart (${restart.detail}). It will pick them up on its next start.`,
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

    /**
     * Weights. Deliberately fire-and-forget: `hf download` on a 55 GB repo runs
     * for tens of minutes, so the job is started detached and its progress read
     * back through the normal GET. Holding the request open would tie a
     * multi-hour transfer to one browser tab.
     */
    if (action === "download") {
      return NextResponse.json({ ok: true, job: startDownload(String(body?.repo ?? "").trim()) });
    }
    if (action === "install-runtime") {
      const repo = String(body?.repo ?? "").trim();
      const file = String(body?.file ?? "").trim();
      // Re-resolve server-side: runtime kind, executable arguments, and the
      // selected artifact are never trusted just because a browser posted them.
      const resolution = await resolveRepo(repo);
      const variant = [resolution.primary, ...resolution.variants].find((item) => item?.repo === repo);
      if (!variant?.setup) {
        return NextResponse.json(
          { error: variant?.setupReason ?? `No automatic runtime adapter is available for ${repo}.` },
          { status: 400 },
        );
      }
      if (variant.setup.file && file && variant.setup.file !== file) {
        return NextResponse.json({ error: "The selected artifact no longer matches the repository plan." }, { status: 409 });
      }
      return NextResponse.json({ ok: true, job: startRuntimeInstall(repo, variant.setup) });
    }
    if (action === "cancel-download") {
      await cancelDownload(String(body?.repo ?? "").trim());
      return NextResponse.json({ ok: true });
    }
    if (action === "clear-download") {
      clearDownload(String(body?.repo ?? "").trim());
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    // A rejected alias, target or repo id is the user's mistake to fix, not a
    // server fault — say which, and say why, rather than returning a bare 500.
    if (e instanceof WireError || e instanceof DownloadError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
