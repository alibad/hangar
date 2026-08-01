import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
