import type { NextConfig } from "next";
import os from "os";
import { readFileSync } from "fs";

/**
 * Decide which host profile this console runs as — ONCE, here, at config load.
 *
 * Published as NEXT_PUBLIC_HOST_ID so that server routes and client components
 * read the same string, and no module below needs `os` (two client components
 * import the service registry, and `os` does not bundle for the browser).
 *
 * Rule (mirrors resolveHostId in src/lib/host.ts, kept inline because config
 * cannot import from src): explicit HOST_ID wins; then a hostname that names a
 * profile; then a Mac is B5; everything else — including a Vercel build box,
 * which is Linux with a random hostname — is BeTenshi, so the deployed console
 * keeps its public targets exactly as before.
 */
function detectHostId(): string {
  const known = new Set(["betenshi", "b5"]);
  const env = (process.env.HOST_ID ?? "").trim().toLowerCase();
  if (known.has(env)) return env;
  const host = os.hostname().trim().toLowerCase().replace(/\.local$/, "");
  if (known.has(host)) return host;
  if (process.platform === "darwin") return "b5";
  return "betenshi";
}

/**
 * Publish this host's image runtime alongside its id.
 *
 * `src/lib/image-models.ts` has to know which engine drives images, because
 * that decides whether the studio offers ComfyUI's three checkpoints or a
 * single local model. It used to answer that with
 * `process.env.NEXT_PUBLIC_HOST_ID === "b5"` — one machine's name, deciding
 * what every machine can generate with.
 *
 * Reading the profile there instead would be the obvious fix, and it is wrong
 * for the same reason `os` cannot be imported below this file: image-models is
 * loaded by a bundler-free `node --test` suite, and a relative TypeScript
 * import chain does not resolve without a bundler. So the value is resolved
 * once here, exactly as the host id already is, and read as a plain string.
 */
function detectImageRuntime(hostId: string): string {
  try {
    const profile = JSON.parse(readFileSync(`./config/hosts/${hostId}.json`, "utf8"));
    const image = profile?.runtimes?.image;
    if (!image) return "";
    return JSON.stringify({ driver: image.driver ?? null, label: image.label ?? null });
  } catch {
    // A missing or malformed profile must not fail the build: the console
    // already has a foreign-profile banner for exactly this case.
    return "";
  }
}

/**
 * The domain a tunnelled host publishes its services under.
 *
 * Host profiles carry `https://llm.${PUBLIC_DOMAIN}` rather than a literal
 * hostname, so that a shared repository does not also ship a map of which
 * services a machine exposes and what runs behind each. Resolved in
 * src/lib/host.ts as the profile loads; `example.com` when unset.
 *
 * Set PUBLIC_DOMAIN in .env.local on a machine that really has a tunnel.
 */
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_HOST_ID: detectHostId(),
    NEXT_PUBLIC_IMAGE_RUNTIME: detectImageRuntime(detectHostId()),
    NEXT_PUBLIC_PUBLIC_DOMAIN: (process.env.PUBLIC_DOMAIN ?? "").trim(),
    NEXT_PUBLIC_HANGAR_RUNTIME:
      (process.env.HANGAR_RUNTIME ?? "").trim().toLowerCase() === "hosted" || process.env.VERCEL
        ? "hosted"
        : "local",
  },
  // duckdb is a native addon — never bundle it, `require` it at runtime.
  //
  // This alone isn't enough for `next build`: Next 16 builds with Turbopack by
  // default, whose node-pre-gyp reader treats `napi_versions` as a required
  // field, and duckdb@1.4.4 ships a `binary` block without it — the build dies
  // with "missing field `napi_versions`" before it emits anything. Turbopack
  // traces the package even though it's listed as external, so the build script
  // passes --webpack. Dev still uses Turbopack, which doesn't hit this path.
  serverExternalPackages: ["duckdb"],
};

export default nextConfig;
