import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const mark = await readFile(new URL("../public/brand/foundry.png", import.meta.url));
for (const size of [32, 64, 192, 512]) {
  await sharp(mark).trim().resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(fileURLToPath(new URL(`../public/icons/icon-${size}.png`, import.meta.url)));
}
// Compatibility for existing icon.svg consumers. The chosen artwork is raster,
// not an invented vector approximation of its faceted geometry.
const icon = await readFile(new URL("../public/icons/icon-192.png", import.meta.url));
await writeFile(new URL("../public/icons/icon.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><title>Hangar Foundry Island</title><image width="192" height="192" href="data:image/png;base64,${icon.toString("base64")}"/></svg>\n`);
