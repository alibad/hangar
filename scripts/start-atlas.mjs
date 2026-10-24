// Called by the existing supervisor. No software install and no browser window.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [process.env.ATLAS_REPO_DIR, resolve(root, "../repo-atlas"), resolve(root, "../../repo-atlas")].filter(Boolean);
const atlas = candidates.find(p => existsSync(resolve(p, "atlas.py")));
if (!atlas) { console.error("Atlas is not installed beside Hangar. Set ATLAS_REPO_DIR in the supervisor environment to its checkout."); process.exit(1); }
const command = process.env.ATLAS_PYTHON || (process.platform === "win32" ? "py" : "python3");
const args = [...(command === "py" ? ["-3"] : []), resolve(atlas, "atlas.py"), "serve", "--no-open", "--port", process.env.ATLAS_PORT || "7788"];
const child = spawn(command, args, { cwd: atlas, stdio: "inherit", windowsHide: true });
child.on("error", e => { console.error(`Could not start Atlas: ${e.message}`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
