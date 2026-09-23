export type HubFile = { path: string; size: number };

/** Stable, router-safe local name for a model imported into Ollama. */
export function runtimeModelName(repo: string): string {
  const slug = repo
    .toLowerCase()
    .replace(/(?:[-_.]gguf)$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 48);
  return `hangar-${slug || "model"}`;
}

/**
 * Pick a useful GGUF rather than blindly pulling a repository containing every
 * quantisation. Q4_K_M is the best general default for a first install; avoid
 * multimodal projector files and incomplete numbered shards.
 */
export function chooseGgufFile(files: HubFile[]): HubFile | undefined {
  const candidates = files.filter(
    (file) =>
      file.path.toLowerCase().endsWith(".gguf") &&
      !/(?:^|[/_.-])mmproj(?:[/_.-]|$)/i.test(file.path) &&
      !/-\d{5}-of-\d{5}\.gguf$/i.test(file.path),
  );
  const preference = (name: string) => {
    const lower = name.toLowerCase();
    if (/q4[_-]k[_-]m/.test(lower)) return 0;
    if (/q5[_-]k[_-]m/.test(lower)) return 1;
    if (/q4[_-]k[_-]s/.test(lower)) return 2;
    if (/q4[_-]0/.test(lower)) return 3;
    if (/q5/.test(lower)) return 4;
    if (/q6/.test(lower)) return 5;
    if (/q8/.test(lower)) return 6;
    if (/f16|bf16/.test(lower)) return 8;
    return 7;
  };
  return [...candidates].sort((a, b) => preference(a.path) - preference(b.path) || a.size - b.size)[0];
}
