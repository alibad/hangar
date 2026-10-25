// Bundled engine only: never discovers, imports, or launches another checkout.
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// launchd starts the console with PATH=/usr/bin:/bin, where macOS's python3 is 3.9, so the first
// python3 on PATH is not good enough: take the first interpreter that is 3.10+, else let main.py say why.
const PYTHONS = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
const supported = cmd => spawnSync(cmd, ["-c", "import sys; sys.exit(sys.version_info < (3, 10))"], { stdio: "ignore" }).status === 0;
const command = process.env.HANGAR_ENGINE_PYTHON || (process.platform === "win32" ? "py" : PYTHONS.find(supported) || "python3");
const args = [...(command === "py" ? ["-3"] : []), resolve(root, "engine/main.py"), "serve", "--port", process.env.HANGAR_ENGINE_PORT || "7789"];
const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
child.on("error", error => { console.error(`Hangar engine could not start: ${error.message}. Install Python 3.10+ or set HANGAR_ENGINE_PYTHON.`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
