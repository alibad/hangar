#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const [repo, kind, model, file, hfBin, hfHome, ollamaBin, stateDir] = process.argv.slice(2);

const repoPattern = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const modelPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const filePattern = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._+@/ -]*\.gguf$/i;

function fail(message) {
  console.error(`HANGAR_RUNTIME_FAILED ${message}`);
  process.exit(1);
}

if (!repoPattern.test(repo ?? "")) fail("Invalid Hugging Face repository id.");
if (!modelPattern.test(model ?? "")) fail("Invalid Ollama model name.");
if (!['ollama-gguf', 'ollama-safetensors'].includes(kind)) fail("Unsupported runtime adapter.");
if (kind === "ollama-gguf" && !filePattern.test(file ?? "")) fail("Invalid GGUF artifact path.");
for (const executable of [hfBin, ollamaBin]) {
  if (!path.isAbsolute(executable ?? "") || !fs.existsSync(executable)) fail(`Executable not found: ${executable}`);
}

fs.mkdirSync(stateDir, { recursive: true });
const workDir = path.join(stateDir, `runtime-${repo.replace(/[^\w.-]/g, "_")}`);
fs.mkdirSync(workDir, { recursive: true });

try {
  console.log(`Downloading ${repo}${file ? ` · ${file}` : ""}…`);
  const args = ["download", repo];
  if (file) args.push(file);
  // HF_HOME is shared with Hangar's inventory scanner and every managed
  // runtime. Passing --cache-dir here would incorrectly skip HF_HOME's /hub
  // layout and make the successful download invisible to the console.
  args.push("--quiet");
  const downloaded = await execFileP(hfBin, args, {
    env: { ...process.env, HF_HOME: hfHome, HF_HUB_DISABLE_TELEMETRY: "1" },
    maxBuffer: 1024 * 1024,
  });
  const lines = downloaded.stdout.trim().split(/\r?\n/).filter(Boolean);
  const source = lines.at(-1);
  if (!source || !fs.existsSync(source)) throw new Error("Hugging Face did not return a downloaded path.");

  const modelfile = path.join(workDir, "Modelfile");
  fs.writeFileSync(modelfile, `FROM ${JSON.stringify(source)}\n`, "utf8");
  console.log(`${kind === "ollama-safetensors" ? "Experimentally importing" : "Registering"} ${model} with Ollama…`);
  const createArgs = ["create", model, "-f", modelfile];
  if (kind === "ollama-safetensors") createArgs.push("--experimental");
  await execFileP(ollamaBin, createArgs, {
    env: { ...process.env, OLLAMA_HOST: process.env.OLLAMA_HOST || "127.0.0.1:11434" },
    maxBuffer: 16 * 1024 * 1024,
  });
  console.log(`HANGAR_RUNTIME_READY ${model}`);
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
}
