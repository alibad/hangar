/** Only construct commit links for a known GitHub repository and a Git object ID. */
export function commitUrl(repository, sha) {
  if (typeof repository !== "string" || !/^[a-f0-9]{7,40}$/i.test(sha || "")) return null;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(repository);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}/commit/${sha}`;
}
