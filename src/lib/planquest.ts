import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const PLANQUEST_ORIGIN = "https://my.plans.quest";
export const PLANQUEST_MCP = `${PLANQUEST_ORIGIN}/mcp`;
export const PLANQUEST_COOKIE = "hangar_planquest_state";
const CALLBACK = "/api/planquest/oauth/callback";
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const random = () => randomBytes(32).toString("base64url");
type Token = { access_token: string; refresh_token: string; scope: string; expiresAt: number };
type Pending = { hash: string; cookieHash: string; verifier: string; redirect: string; expiresAt: number; returnTo: string };
type Store = { clientId?: string; token?: Token; connectedAt?: string; pending?: Pending };
export type PlanSummary = { id: string; title: string; description: string; access: string; archived: boolean; folders: string[]; url: string; updatedAt: string | null };
export type PlanDetail = PlanSummary & { progress: number; milestones: { id: string; title: string; progress: number; endDate: string; keyResults: { title: string; progress: number }[] }[] };
export class PlanQuestError extends Error { status: number; constructor(message: string, status = 502) { super(message); this.status = status; } }
export function validatePlanId(id: unknown): string {
  if (typeof id !== "string" || !/^[\w-]{1,160}$/.test(id)) throw new PlanQuestError("Choose a plan from PlanQuest.", 400);
  return id;
}
export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password) throw new PlanQuestError("Connect from your local Hangar app.", 400);
  return url.origin;
}
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const text = (v: unknown, limit = 2000) => typeof v === "string" ? v.slice(0, limit) : "";
const percent = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
// People keep sign-in details in plan descriptions. Those lines never leave the server: not shown, not searchable.
const SECRET_LINE = /\b(pass(word|code|phrase)?|pwd|secret|token|api[\s_-]?key|private[\s_-]?key|user\s?name|login|credentials?)\b[^\n]{0,40}[:=]/i;
export const HIDDEN_LINE = "•••• hidden: looks like a sign-in detail";
export function hideSecrets(value: string): string {
  return value.split(/\r?\n/).map(line => SECRET_LINE.test(line) ? HIDDEN_LINE : line).join("\n");
}
function summary(raw: Record<string, unknown>): PlanSummary {
  const id = validatePlanId(raw.id);
  return { id, title: text(raw.title, 120) || "Untitled plan", description: hideSecrets(text(raw.description)), access: text(raw.access, 20), archived: raw.archived === true, folders: Array.isArray(raw.folder_path) ? raw.folder_path.map(v => text(v, 120)) : [], url: `${PLANQUEST_ORIGIN}/plans/${encodeURIComponent(id)}`, updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null };
}

// Credentials live in the OS user's private configuration directory, never in a checkout.
// Injectable transport/storage make the entire authorization lifecycle testable without live credentials.
export function createPlanQuestClient(options: { directory?: string; fetch?: typeof fetch; now?: () => number; protectDirectory?: (dir: string) => Promise<void> } = {}) {
  const directory = options.directory || join(homedir(), ".hangar", "planquest");
  const file = join(directory, "connection.json");
  const request = options.fetch || fetch;
  const now = options.now || Date.now;
  let queue = Promise.resolve();
  // The plan list is read once a minute at most: opening the picker repeatedly should not wait on PlanQuest each time.
  let listed: { at: number; plans: PlanSummary[] } | null = null;
  const forget = () => { listed = null; };
  function serial<T>(fn: () => Promise<T>): Promise<T> { const result = queue.then(fn); queue = result.then(() => undefined, () => undefined); return result; }
  async function read(): Promise<Store> { try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new PlanQuestError("Cannot read the local PlanQuest connection.", 500); } }
  async function save(data: Store) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (options.protectDirectory) await options.protectDirectory(directory);
    else if (platform() === "win32") {
      const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
      await promisify(execFile)("icacls", [directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"], { windowsHide: true });
    }
    const temp = `${file}.${random()}.tmp`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, file);
  }
  async function remote(path: string, init?: RequestInit): Promise<Response> {
    try { return await request(`${PLANQUEST_ORIGIN}${path}`, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(25000) }); }
    catch { throw new PlanQuestError("PlanQuest is unreachable. Your saved link is unchanged.", 503); }
  }
  async function body(response: Response): Promise<Record<string, any>> {
    const reader = response.body?.getReader(); if (!reader) throw new PlanQuestError("PlanQuest returned an empty response.");
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 2_000_000) { await reader.cancel(); throw new PlanQuestError("PlanQuest returned too much data. Open the plan in PlanQuest."); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new PlanQuestError("PlanQuest returned an unsupported response."); }
  }
  function token(raw: Record<string, any>): Token {
    if (typeof raw.access_token !== "string" || !raw.access_token || typeof raw.refresh_token !== "string" || !raw.refresh_token || typeof raw.scope !== "string" || !raw.scope.split(" ").includes("plans:read") || typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0) throw new PlanQuestError("PlanQuest did not grant read access. Connect again.", 401);
    return { access_token: raw.access_token, refresh_token: raw.refresh_token, scope: raw.scope, expiresAt: now() + raw.expires_in * 1000 };
  }
  async function access(): Promise<string> { return serial(async () => {
    const data = await read();
    if (!data.token || !data.clientId) throw new PlanQuestError("Connect PlanQuest to browse your plans.", 401);
    if (data.token.expiresAt > now() + 60000) return data.token.access_token;
    const response = await remote("/api/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: data.clientId, refresh_token: data.token.refresh_token, resource: PLANQUEST_MCP }) });
    if (!response.ok) { if (response.status < 500) { delete data.token; forget(); await save(data); } throw new PlanQuestError("Your PlanQuest connection needs a new sign-in.", 401); }
    data.token = token(await body(response)); await save(data); return data.token.access_token;
  }); }
  async function call(name: "list_plans" | "get_plan", args: Record<string, unknown>) {
    const bearer = await access();
    async function rpc(method: string, params: unknown, id?: number) {
      const response = await remote("/mcp", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) });
      if (!response.ok) throw new PlanQuestError(response.status === 401 ? "Your PlanQuest access expired or was revoked. Reconnect to continue." : "PlanQuest could not read this plan. Check your access and retry.", response.status === 401 ? 401 : 502);
      if (id === undefined) return {};
      const result = await body(response);
      if (result.error || result.result?.isError) throw new PlanQuestError("PlanQuest could not read this plan. It may have moved or your access changed.", 403);
      return result.result;
    }
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Hangar", version: "1.0.0" } }, 1);
    await rpc("notifications/initialized", {});
    const result = await rpc("tools/call", { name, arguments: args }, 2);
    if (!result?.structuredContent) throw new PlanQuestError("PlanQuest returned no structured plan data.");
    return result.structuredContent;
  }
  return {
    async status() { const data = await read(); return { connected: !!data.token, connectedAt: data.token ? data.connectedAt : null, endpoint: PLANQUEST_MCP, scope: "plans:read" }; },
    async begin(origin: string, returnTo: string) { return serial(async () => {
      const base = loopbackOrigin(origin), redirect = base + CALLBACK;
      const data = await read();
      if (!data.clientId) {
        const response = await remote("/api/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Hangar — project plans", redirect_uris: [`http://127.0.0.1:8003${CALLBACK}`, `http://localhost:8003${CALLBACK}`, `http://[::1]:8003${CALLBACK}`], token_endpoint_auth_method: "none" }) });
        const result = await body(response);
        if (!response.ok || typeof result.client_id !== "string") throw new PlanQuestError("PlanQuest could not register Hangar. Try again.");
        data.clientId = result.client_id;
      }
      const state = random(), cookie = random(), verifier = random();
      data.pending = { hash: hash(state), cookieHash: hash(cookie), verifier, redirect, expiresAt: now() + 600000, returnTo: /^\/#(?:projects|world)(?:&repo=[\w%:-]+)?$/.test(returnTo) ? returnTo : "/#projects" };
      await save(data);
      const url = new URL("/oauth/authorize", PLANQUEST_ORIGIN);
      url.search = new URLSearchParams({ client_id: data.clientId!, redirect_uri: redirect, response_type: "code", scope: "plans:read", resource: PLANQUEST_MCP, state, code_challenge: hash(verifier), code_challenge_method: "S256" }).toString();
      return { url: url.toString(), cookie };
    }); },
    async finish(origin: string, state: string, cookie: string, code: string, denied = false) { return serial(async () => {
      const data = await read(), pending = data.pending;
      if (!pending || pending.expiresAt < now() || !equal(hash(state), pending.hash) || !equal(hash(cookie), pending.cookieHash) || pending.redirect !== loopbackOrigin(origin) + CALLBACK) throw new PlanQuestError("This connection attempt expired or belongs to another browser. Start again in Hangar.", 400);
      delete data.pending; await save(data);
      if (denied) return { returnTo: pending.returnTo, connected: false };
      if (!code || code.length > 1000) throw new PlanQuestError("PlanQuest did not return an authorization code.", 400);
      const response = await remote("/api/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: data.clientId!, code, code_verifier: pending.verifier, redirect_uri: pending.redirect, resource: PLANQUEST_MCP }) });
      if (!response.ok) throw new PlanQuestError("PlanQuest sign-in expired. Start the connection again.", 401);
      data.token = token(await body(response)); data.connectedAt = new Date(now()).toISOString(); forget(); await save(data);
      return { returnTo: pending.returnTo, connected: true };
    }); },
    async disconnect() { return serial(async () => {
      const data = await read(); let revoked = true;
      for (const value of [data.token?.access_token, data.token?.refresh_token].filter(Boolean)) {
        try { const r = await remote("/api/oauth/revoke", { method: "POST", body: new URLSearchParams({ token: value! }) }); if (!r.ok) revoked = false; } catch { revoked = false; }
      }
      forget(); await save({ clientId: data.clientId }); return { disconnected: true, revoked };
    }); },
    async plans(fresh = false) {
      if (!fresh && listed && now() - listed.at < 60_000) return listed.plans;
      const data = await call("list_plans", { include_archived: false }); if (!Array.isArray(data.plans)) throw new PlanQuestError("PlanQuest returned no plan list.");
      const plans = data.plans.map(summary) as PlanSummary[];
      listed = { at: now(), plans };
      return plans;
    },
    async plan(id: string): Promise<PlanDetail> {
      const data = await call("get_plan", { plan_id: validatePlanId(id) }); const p = data.plan;
      if (!p || p.id !== id || !Array.isArray(p.milestones)) throw new PlanQuestError("PlanQuest returned an unexpected plan.");
      return { ...summary(p), progress: percent(p.progress), milestones: p.milestones.filter((m: any) => !m.archived).map((m: any) => ({ id: text(m.id, 160), title: hideSecrets(text(m.objective, 500)), progress: percent(m.progress), endDate: text(m.end_date, 50), keyResults: Array.isArray(m.key_results) ? m.key_results.filter((k: any) => !k.scratched).map((k: any) => ({ title: hideSecrets(text(k.description, 500)), progress: percent(k.progress) })) : [] })) };
    },
  };
}
export const planquest = createPlanQuestClient();
