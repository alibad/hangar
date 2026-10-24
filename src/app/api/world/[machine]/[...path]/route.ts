// The legacy route remains an API alias for older clients, never an external service.
export { GET, POST } from "../../../atlas/[machine]/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
