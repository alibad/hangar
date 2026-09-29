/**
 * Runs once when the console's server starts. The Video Forge is a loop, not a
 * request handler: without this it would only start ticking the first time
 * someone opened its page, and a console restarted mid-window would not start
 * vllm-small again until then.
 *
 * The import must sit INSIDE the runtime check, in this exact shape: Next
 * replaces NEXT_RUNTIME at build time and drops the branch from the edge
 * bundle. An early `return` instead left DuckDB in the edge compile and broke
 * every page.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/forge/forge");
  }
}
