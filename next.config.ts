import type { NextConfig } from "next";
import os from "os";

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
