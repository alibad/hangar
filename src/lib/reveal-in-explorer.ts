import { execFile } from "child_process";
import path from "path";

export type RevealResult = {
  ok: boolean;
  path: string;
  /** An Explorer window already showed the folder and was brought forward instead of opening another. */
  reused?: boolean;
  /** Windows accepted the window as the foreground one. */
  focused?: boolean;
  error?: string;
};

const SCRIPT = path.join(process.cwd(), "scripts", "reveal-in-explorer.ps1");

/**
 * Show a folder, or select a file, in Windows Explorer on the machine running
 * the console, in front of the browser.
 *
 * Not `execFile("explorer.exe", [dir])`: the server is a background process,
 * so Windows opened that window behind the browser, where it looked as if the
 * button did nothing and each retry left another hidden window. The script
 * reuses an open window for the folder and takes the foreground properly.
 */
export function revealInExplorer(target: string, opts: { select?: boolean } = {}): Promise<RevealResult> {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Path", target];
  if (opts.select) args.push("-Select");
  return new Promise((resolve) => {
    execFile("powershell.exe", args, { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
      const last = String(stdout).trim().split(/\r?\n/).pop() ?? "";
      try {
        resolve(JSON.parse(last) as RevealResult);
      } catch {
        resolve({ ok: false, path: target, error: String(stderr || err?.message || "Explorer did not open").trim().slice(0, 300) });
      }
    });
  });
}
