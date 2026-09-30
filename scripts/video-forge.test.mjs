// Tests for the Video Forge's rules: what never reaches the model, what a
// brief may not contain, and the nightly window's clock. rules.ts is
// import-type-only, loaded through Node's type stripping, so these check the
// exact file the console runs. sources.ts is loaded for its address guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unsafeReason, peopleIn, writingIn, shortlist, windowMinutesLeft, nextWindowStart } from "../src/lib/forge/rules.ts";
import { assertPublicUrl } from "../src/lib/forge/sources.ts";

test("tragedy, crime and politics are filtered before the model sees them", () => {
  for (const t of ["earthquake seattle", "earthquakes today", "Lizzie Borden murders", "Senate vote on budget", "wildfires near LA", "Deaths in 2026", "president speech"]) {
    assert.ok(unsafeReason(t), `${t} should be unsafe`);
  }
  for (const t of ["Harvest moon", "NHL schedule", "Diwali", "Great Barrier Reef", "Asian Games medal table", "autumn equinox"]) {
    assert.equal(unsafeReason(t), null, `${t} should pass`);
  }
});

test("people in a prompt are caught, scenery is not", () => {
  assert.equal(peopleIn("Security checkpoint, TSA officers standing and checking passes"), "officers");
  assert.equal(peopleIn("A stadium filled with cheering spectators"), "spectators");
  assert.ok(peopleIn("a street lined with shops and vendors"));
  assert.equal(peopleIn("The harvest moon rises over wheat fields, slow push-in"), null);
  // "human" and words that merely contain a person-word do not trigger it.
  assert.equal(peopleIn("a mandolin on a manor table, human-scale architecture"), null);
});

test("writing on screen is caught — video models cannot render it", () => {
  assert.ok(writingIn("A digital scoreboard with LED lights displaying the medal table"));
  assert.ok(writingIn("a neon sign reading OPEN"));
  assert.equal(writingIn("moonlight on a quiet lake, mist drifting"), null);
});

test("shortlist drops unsafe and recent topics, dedupes, and interleaves sources", () => {
  const signals = [
    { source: "google-trends", title: "baseball" },
    { source: "google-trends", title: "earthquake seattle" },
    { source: "google-trends", title: "Baseball" },
    { source: "google-trends", title: "Diwali" },
    { source: "wikipedia", title: "Harvest moon" },
    { source: "wikipedia", title: "Asian Games" },
    { source: "hacker-news", title: "A new telescope" },
  ];
  const { candidates, dropped } = shortlist(signals, ["Diwali"]);
  assert.deepEqual(candidates.map((c) => c.title), ["baseball", "Harvest moon", "A new telescope", "Asian Games"]);
  assert.deepEqual(candidates.map((c) => c.n), [1, 2, 3, 4]);
  assert.ok(dropped.some((d) => d.title === "earthquake seattle"));
  assert.ok(dropped.some((d) => d.title === "Diwali" && d.why === "made recently"));
});

test("window clock: inside, outside, and across midnight", () => {
  const at = (h, m) => new Date(2026, 8, 30, h, m);
  const win = { start: "01:00", end: "07:00" };
  assert.equal(windowMinutesLeft(win, at(0, 59)), null);
  assert.equal(windowMinutesLeft(win, at(1, 0)), 360);
  assert.equal(windowMinutesLeft(win, at(6, 45)), 15);
  assert.equal(windowMinutesLeft(win, at(7, 0)), null);
  const late = { start: "23:00", end: "05:00" };
  assert.equal(windowMinutesLeft(late, at(23, 30)), 330);
  assert.equal(windowMinutesLeft(late, at(4, 0)), 60);
  assert.equal(windowMinutesLeft(late, at(12, 0)), null);
  assert.equal(nextWindowStart(win, at(0, 30)).getHours(), 1);
  assert.equal(nextWindowStart(win, at(2, 0)).getDate(), 1); // tomorrow: Oct 1
});

test("read() refuses anything that is not on the public internet", async () => {
  for (const u of ["http://127.0.0.1:8099/services", "http://localhost:4000/v1/models", "http://192.168.1.10/", "http://10.0.0.5/", "http://[::1]/", "file:///C:/Windows/win.ini", "http://169.254.169.254/latest/meta-data", "http://user:pw@example.com/"]) {
    await assert.rejects(assertPublicUrl(u), undefined, u);
  }
  const ok = await assertPublicUrl("https://en.wikipedia.org/wiki/Harvest_moon");
  assert.equal(ok.hostname, "en.wikipedia.org");
});

test("saying the frame is empty of people is allowed", () => {
  assert.equal(peopleIn("an empty airport checkpoint with no travelers, fluorescent light"), null);
  assert.equal(peopleIn("a stadium without spectators under floodlights"), null);
  assert.equal(peopleIn("the terminal, empty of passengers at dawn"), null);
  assert.equal(peopleIn("no crowds; later, travelers stream in"), "travelers");
});

test("the first all-day run's bad briefs are filtered now; courts for sport are not", () => {
  for (const t of ["Flour replacing cocaine exhibit in Fiji court case", "Flydubai aircraft activates hijack-related code en route to Tel Aviv", "Crystal Jade holding companies receivership", "Counterfeit Postage Labels Website Shut Down", "PS5 Relapse Exploit"]) {
    assert.ok(unsafeReason(t), `${t} should be unsafe`);
  }
  for (const t of ["tennis court at dawn", "basketball court under lights", "Real-time Solar System with asteroids and satellites", "a method for brewing coffee"]) {
    assert.equal(unsafeReason(t), null, `${t} should pass`);
  }
});

test("brands and acronyms in a prompt are caught; plain words and LED are not", async () => {
  const { brandIn } = await import("../src/lib/forge/rules.ts");
  assert.equal(brandIn("a phone showing WhatsApp on a desk"), "WhatsApp");
  assert.equal(brandIn("a city street from GTA at night"), "GTA");
  assert.equal(brandIn("an iPhone on a table"), "iPhone");
  assert.equal(brandIn("an LED display in a dark room, UV light"), null);
  assert.equal(brandIn("A harvest moon over wheat fields"), null);
  assert.ok(unsafeReason("nigerian civil service strike october"));
});
