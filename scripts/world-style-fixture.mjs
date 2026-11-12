// Deliberately fictional catalog, safe for published preview images and browser tests.
export const styleFixture = () => ({
  generatedAt: "2026-01-01T00:00:00Z", apps: [], stats: { toCommit: 1, toPush: 0, toPull: 0, openPRs: 1 },
  families: [{ id: "studio", name: "Creative studio", repos: 9 }],
  repos: ["Aurora", "Bloom", "Current", "Drift", "Ember", "Flux", "Grove", "Halo", "Iris"].map((name, i) => ({
    id: name.toLowerCase(), name, family: "studio", stage: ["tent", "house", "midrise", "tower", "skyscraper", "house", "tower", "midrise", "tent"][i],
    sizeKB: [120, 2800, 18000, 90000, 900000, 3500, 220000, 35000, 250][i], commitCount: [9, 48, 160, 700, 1800, 55, 950, 230, 12][i],
    recency: ["live", "recent", "quiet"][i % 3], onMachine: true, notes: {}, meaning: {},
    homepage: i === 4 ? "https://example.com" : null, openPRs: i === 3 ? 1 : 0,
    sites: i === 0 ? [{ role: "canonical", rel: "aurora", dirty: 2 }] : [], risks: [], createdAt: "2025-01-01T00:00:00Z",
  })),
});

export async function interceptWorld(page, doc) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = json => route.fulfill({ json });
    // Refuse writes; these checks never act on a real repository or service.
    if (!["GET", "HEAD"].includes(route.request().method())) throw new Error(`Unexpected write: ${path}`);
    if (/\/proxy\/atlas$/.test(path)) return reply(doc);
    if (/\/proxy\/status$/.test(path)) return reply({ scanning: false, generatedAt: doc.generatedAt });
    if (/\/proxy\/apps$/.test(path)) return reply({ apps: [] });
    if (/\/proxy\/work$/.test(path)) return reply({ jobs: [] });
    if (/\/proxy\/sessions\/library$/.test(path)) return reply({ sessions: [], groups: [], sections: [], providers: [] });
    return route.continue();
  });
}
