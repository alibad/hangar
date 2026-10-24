// Optional, explicit one-time migration. No runtime dependency on its source.
import { copyFile, mkdir, readdir, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/import-atlas.mjs <old-checkout>. Private data goes only into ignored var/engine.");
const target = resolve("var/engine");
const files = ["roots.json", "islands.json", "project-plans.json", "session-library.json", "cache/github.json"];
try { files.push(...(await readdir(join(source, ".atlas/machines"))).filter(n => n.endsWith(".json")).map(n => `machines/${n}`)); } catch { /* No machine cache. */ }
const pairs = [...files.map(name => [join(source, ".atlas", name), join(target, name)]), ...["spine.json", "families.json"].map(name => [join(source, "spine", name), join(target, "spine", name)])];
let copied = 0;
for (const [from, to] of pairs) {
  try { await access(from); } catch { continue; }
  await mkdir(dirname(to), { recursive: true });
  // COPYFILE_EXCL: never replace new preferences with an old import.
  try { await copyFile(from, to, 1); copied++; } catch (e) { if (e.code !== "EEXIST") throw e; }
}
console.log(`Imported ${copied} local data files. Source left unchanged; no logs, credentials, or running-job state copied.`);
