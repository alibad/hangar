/** Never show a JSON parser exception (or an upstream HTML error page) to a user. */
export async function workspaceResponse<T>(response: Response): Promise<T> {
  let data: unknown;
  try { data = JSON.parse(await response.text()); } catch { /* Handle below with the HTTP status. */ }
  if (!response.ok) {
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") throw new Error(data.error);
    if (response.status === 404) throw new Error("This machine’s workspace service does not support this operation yet. Update the service, then retry.");
    throw new Error(`The workspace service could not complete the request (${response.status}). Please retry.`);
  }
  if (!data || typeof data !== "object") throw new Error("The workspace service returned an unreadable response. Please retry.");
  return data as T;
}
