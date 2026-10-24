import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const mark = await readFile(new URL("../public/brand/portal.svg", import.meta.url));
await writeFile(new URL("../public/icons/icon.svg", import.meta.url), mark);
for (const size of [192, 512]) {
  await sharp(mark).resize(size, size).png().toFile(fileURLToPath(new URL(`../public/icons/icon-${size}.png`, import.meta.url)));
}
