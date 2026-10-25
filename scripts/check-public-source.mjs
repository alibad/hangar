// Review outgoing source AND every unpublished commit; never print matched secrets.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const base = process.argv[2] || "origin/main";
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider credential", /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["personal home path", /(?:[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|example\b|user\b|you\b)[\w.-]+|\/Users\/(?!example\b|user\b|you\b)[\w.-]+)[\\/]/i],
  ["private network identity", /[\w.-]+\.ts\.net\b/],
];
const privatePath = /(^|\/)(?:var|\.atlas|archive|generated|screenshots|\.vercel|\.claude(?!\/skills\/)|\.codex)(\/|$)|(^|\/)\.env(?:\.(?!example$|sample$)[^/]*)?$|(^|\/)service-commands\.json$/;
const findings = new Set();
let file = "";
function inspect(diff, source) {
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); if (privatePath.test(file)) findings.add(`${source}: private runtime path ${file}`); }
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const [name, pattern] of rules) if (pattern.test(line)) findings.add(`${source}: ${name} in ${file}`);
    }
  }
}
for (const commit of git("rev-list", `${base}..HEAD`).trim().split("\n").filter(Boolean)) inspect(git("show", "--format=", "--no-ext-diff", commit), commit.slice(0, 8));
inspect(git("diff", "--no-ext-diff", "HEAD"), "working tree");
for (const path of git("ls-files", "--others", "--exclude-standard").trim().split("\n").filter(Boolean)) {
  if (privatePath.test(path)) findings.add(`untracked: private runtime path ${path}`);
  if (/\.(?:md|txt|json|ya?ml|[cm]?js|tsx?|py|ps1|sh|html|css|svg)$/.test(path)) {
    file = path; inspect(`+++ b/${path}\n` + readFileSync(path, "utf8").split("\n").map(l => "+" + l).join("\n"), "untracked");
  }
}
if (findings.size) { console.error([...findings].join("\n")); process.exitCode = 1; }
else console.log("PASS: outgoing commits and working source contain no matched credentials, personal home paths, or private runtime files. Review screenshots and prose separately.");
