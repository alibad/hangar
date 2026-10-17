/** A live HTTP server may still be loading its model. Opaque health bodies
 * keep their HTTP-only contract; explicit not-ready answers must be honoured. */
export function serviceBodyReady(body: unknown): boolean {
  if (!body || typeof body !== "object") return true;
  const value = body as { ready?: unknown; ok?: unknown; status?: unknown };
  return value.ready !== false && value.ok !== false &&
    !["loading", "starting", "error", "failed"].includes(String(value.status ?? "").toLowerCase());
}
