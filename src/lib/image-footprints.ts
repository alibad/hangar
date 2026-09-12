import modelMeta from "../../config/model-meta.json";
import type { Footprint } from "../components/model-footprint";

/** A shared runtime is not a shared model footprint. */
export function imageFootprint(id: string): Footprint | undefined {
  return (modelMeta as Record<string, { footprint?: Footprint }>)[`local-${id}`]?.footprint;
}
