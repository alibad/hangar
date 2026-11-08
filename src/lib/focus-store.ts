import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { applyFocus, emptyFocus, normalizeFocus, type FocusData } from "./focus-board";

// Your goals and weekly numbers are yours, not the project's: they stay in var/, which is never committed.
const FILE = process.env.HANGAR_FOCUS_FILE || join(process.cwd(), "var", "focus.json");
let queue: Promise<unknown> = Promise.resolve();

export async function readFocus(): Promise<FocusData> {
  try { return normalizeFocus(JSON.parse(await readFile(FILE, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFocus();
    if (error instanceof SyntaxError) throw new Error(`${FILE} is not valid JSON. Fix or remove it; Hangar will not overwrite it.`);
    throw error;
  }
}

/** Changes run one at a time, and each lands whole: written beside the file, then renamed over it. */
export function changeFocus(action: unknown): Promise<FocusData> {
  const change = queue.then(async () => {
    const next = applyFocus(await readFocus(), action, () => randomUUID().slice(0, 8));
    await mkdir(dirname(FILE), { recursive: true });
    const temp = `${FILE}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temp, FILE);
    return next;
  });
  queue = change.catch(() => undefined);
  return change;
}
