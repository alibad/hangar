// Bundled engine only: never discovers, imports, or launches another checkout.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.env.HANGAR_ENGINE_PYTHON || (process.platform === "win32" ? "py" : "python3");
const args = [...(command === "py" ? ["-3"] : []), resolve(root, "engine/main.py"), "serve", "--port", process.env.HANGAR_ENGINE_PORT || "7789"];
const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
child.on("error", error => { console.error(`Hangar engine could not start: ${error.message}. Install Python 3.10+ or set HANGAR_ENGINE_PYTHON.`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
