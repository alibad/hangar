import { join } from "node:path";
import { createIslandStore } from "./islands";

// Private machine-local organization; var/ is excluded from source control.
export const islandStore = createIslandStore(join(process.cwd(), "var", "islands.json"));
