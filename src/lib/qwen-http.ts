import http from "node:http";
import https from "node:https";

/**
 * node:http POST — no headersTimeout unlike undici/fetch. Qwen can take 5+ min.
 *
 * `label` names the upstream in error messages. It exists because the AI Router
 * borrows this function for the same reason Qwen needs it (a routed local
 * generation is still a 5-minute request), and reporting a router failure as
 * "Qwen 500" sends you debugging the wrong service.
 */
export function nodePost(
  url: string,
  body: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  label = "Qwen",
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Cancelled")); return; }

    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let msg = "";
          res.on("data", (c: Buffer) => (msg += c.toString()));
          res.on("end", () => reject(new Error(`${label} ${res.statusCode}: ${msg.slice(0, 300)}`)));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);

    if (signal) {
      signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("Cancelled"));
      }, { once: true });
    }

    req.write(body);
    req.end();
  });
}
