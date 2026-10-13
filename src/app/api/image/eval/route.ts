import { NextRequest, NextResponse } from "next/server";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

// The image evaluation suite, its runs, and the user's verdicts on them.
//
// Runs are written by scripts/experiment-image-suite.mjs; this route only reads
// them and records judgements. Everything lives under experiments/image-eval/
// in the repo, not in var/, so a run and the verdicts on it can be committed
// together and a later rerun compared against them.
//
// Verdicts are the user's, not the model's or ours: the brief is explicit that
// images are not scored by vibes. An objective check is a yes/no a person can
// answer ("five apples?"); a pick is the taste call ("which one do I like").

const DIR = path.join(process.cwd(), "experiments", "image-eval");
const RUNS = path.join(DIR, "runs");
const VERDICTS = path.join(DIR, "verdicts");
const SAFE_RUN = /^[A-Za-z0-9._-]{1,80}$/;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function GET(req: NextRequest) {
  const suite = await readJson(path.join(DIR, "suite.json"), null);
  if (!suite) return NextResponse.json({ error: "experiments/image-eval/suite.json is missing" }, { status: 404 });
  const runs = (await readdir(RUNS).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort()
    .reverse();
  const wanted = req.nextUrl.searchParams.get("run");
  const run = wanted && SAFE_RUN.test(wanted) && runs.includes(wanted) ? wanted : runs[0];
  const manifest = run ? await readJson(path.join(RUNS, `${run}.json`), null) : null;
  const verdicts = run ? await readJson(path.join(VERDICTS, `${run}.json`), {}) : {};
  return NextResponse.json({ suite, runs, run: run ?? null, manifest, verdicts });
}

type VerdictBody = { run?: string; cell?: string; check?: string; value?: boolean | null };

/**
 * Record one judgement. `cell` is "study|model|promptId|seed|variant"; `check`
 * is an objective check's text, or "__pick" for a taste pick. null clears it.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as VerdictBody;
  const { run, cell, check } = body;
  if (!run || !SAFE_RUN.test(run) || typeof cell !== "string" || !cell || cell.length > 300 || typeof check !== "string" || !check || check.length > 300) {
    return NextResponse.json({ error: "run, cell and check are required" }, { status: 400 });
  }
  const value = body.value === true || body.value === false ? body.value : null;
  await mkdir(VERDICTS, { recursive: true });
  const file = path.join(VERDICTS, `${run}.json`);
  const all = await readJson<Record<string, Record<string, boolean>>>(file, {});
  const entry = { ...(all[cell] ?? {}) };
  if (value === null) delete entry[check];
  else entry[check] = value;
  if (Object.keys(entry).length) all[cell] = entry;
  else delete all[cell];
  await writeFile(file, JSON.stringify(all, null, 2) + "\n");
  return NextResponse.json({ ok: true, cell, verdict: entry });
}
