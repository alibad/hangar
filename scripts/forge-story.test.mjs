// Tests for the Video Forge's story films: how a writer's shot list is checked
// and tidied, and how seeds are chosen. story.ts is import-free, loaded through
// Node's type stripping, so these check the exact file the console runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSeed, shapeStory, shotStillPrompt, STORY_SEEDS, words } from "../src/lib/forge/story.ts";

const shot = (narration, picture = "a wide river valley at dawn", motion = "slow push-in") => ({ narration, picture, motion });
const raw = (shots, extra = {}) => ({ title: "The Empty Boat", logline: "x", lesson: "Let it go", look: "ink wash painting", score: "solo flute", characters: [], shots, ...extra });

test("a character's name becomes their look, but a look already there is not pasted again", () => {
  const frog = { name: "Frog", look: "a small plump emerald green frog with large golden eyes" };
  const s = shapeStory(
    raw(
      [
        shot("One.", "Medium shot of a small plump emerald green frog with large golden eyes on a stone"),
        shot("Two.", "Frog sits on a lily pad at dusk"),
        ...Array.from({ length: 8 }, (_, i) => shot(`Line ${i}.`)),
      ],
      { characters: [frog] },
    ),
    10,
  );
  assert.equal(s.shots[0].picture, "Medium shot of a small plump emerald green frog with large golden eyes on a stone");
  assert.equal(s.shots[1].picture, "a small plump emerald green frog with large golden eyes sits on a lily pad at dusk");
});

test("a narration line too long for its shot is cut at a clause, and every line ends a sentence", () => {
  const long = "The old man walked along the river for many hours, thinking of his son, of the war, of the horses that had run away into the hills";
  const s = shapeStory(raw([shot(long), shot("No full stop here"), ...Array.from({ length: 8 }, (_, i) => shot(`Line ${i}.`))]), 10);
  assert.ok(words(s.shots[0].narration) <= 18, s.shots[0].narration);
  assert.match(s.shots[0].narration, /[.!?]$/);
  assert.equal(s.shots[1].narration, "No full stop here.");
});

test("too few usable shots is an error, not a short film", () => {
  assert.throws(() => shapeStory(raw([shot("One."), shot("Two.")]), 14), /usable shots/);
  assert.throws(() => shapeStory({ ...raw(Array.from({ length: 10 }, () => shot("A line."))), title: "" }, 10), /no title/);
});

test("the film's look is added to a still prompt once", () => {
  assert.equal(shotStillPrompt({ look: "ink wash painting." }, shot("x", "A frog on a stone")), "A frog on a stone ink wash painting.");
  assert.equal(shotStillPrompt({ look: "ink wash painting" }, shot("x", "Ink wash painting, a frog on a stone")), "Ink wash painting, a frog on a stone");
});

test("seeds are not repeated while unused ones remain, and told tales alternate with originals", () => {
  const used = STORY_SEEDS.slice(0, 5).map((s) => s.id);
  for (let i = 0; i < 30; i++) assert.ok(!used.includes(pickSeed(used).id));
  for (let i = 0; i < 20; i++) assert.equal(pickSeed([], "parable").kind, "original");
  for (let i = 0; i < 20; i++) assert.notEqual(pickSeed([], "original").kind, "original");
});

// ── continuity, variety and stacks ──
import { applyContinuity, castPicture, FORMATS, LOOKS, pickFormat, pickLook } from "../src/lib/forge/story.ts";
import { pickStack } from "../src/lib/forge/stack.ts";

const frog = { name: "Frog", look: "a small plump emerald green frog with large golden eyes", kind: "animal", gender: "male", age: "adult" };
const scorpion = { name: "Scorpion", look: "a slender obsidian black scorpion with a curved stinger", kind: "animal", gender: "none", age: "adult" };

test("a {Name} in a picture becomes the character's full look, the second mention a short one", () => {
  const r = castPicture("{Frog} carries {Scorpion} across the river; {Frog} looks back", [], [frog, scorpion], { narration: "x" });
  assert.equal(r.picture, `${frog.look} carries ${scorpion.look} across the river; the frog looks back`);
  assert.deepEqual(r.cast.sort(), ["Frog", "Scorpion"]);
});

test("'the two figures' with nobody named gets the characters the line is about (the scorpion film's shot 13)", () => {
  const r = castPicture("Wide shot from underwater looking up as the two figures drift downward.", [], [frog, scorpion], { narration: "They both sank slowly into the depths of the river." });
  assert.ok(r.picture.startsWith(`${frog.look} and ${scorpion.look}. Wide shot`), r.picture);
  const one = castPicture("A lone figure on the bank at dusk.", [], [frog, scorpion], { narration: "He waited.", previousCast: ["Scorpion"] });
  assert.ok(one.picture.startsWith(scorpion.look), one.picture);
});

test("a cast member the picture leaves out is put in front of it", () => {
  const r = castPicture("Close-up of a ripple on dark water at night.", ["Frog"], [frog, scorpion], { narration: "x" });
  assert.equal(r.picture, `${frog.look}. Close-up of a ripple on dark water at night.`);
});

test("the continuity pass replaces pictures only when it returns one per shot", () => {
  const rawStory = { shots: [{ picture: "two figures sink" }, { picture: "{Frog} on a stone at dawn by the river bank" }] };
  const ok = applyContinuity(rawStory, { shots: [{ picture: "{Frog} and {Scorpion} sink into the dark green river at dusk", cast: ["Frog", "Scorpion"], fix: "named the two figures" }, { picture: "{Frog} on a stone at dawn by the river bank", cast: ["Frog"], fix: "" }] });
  assert.equal(ok.raw.shots[0].picture, "{Frog} and {Scorpion} sink into the dark green river at dusk");
  assert.deepEqual(ok.fixes, ["shot 1: named the two figures"]);
  assert.equal(applyContinuity(rawStory, { shots: [{ picture: "x", cast: [], fix: "" }] }).raw, rawStory);
});

test("formats rotate: never the same twice in a row, and every one comes up", () => {
  const seen = [];
  for (let i = 0; i < 27; i++) {
    const f = pickFormat(seen.slice().reverse());
    assert.notEqual(f, seen[seen.length - 1]);
    seen.push(f);
  }
  for (const id of Object.keys(FORMATS)) assert.ok(seen.includes(id), id);
});

test("a format's own look: the documentary look only for documentaries", () => {
  for (let i = 0; i < 10; i++) assert.equal(pickLook([], "documentary", () => 0.1), LOOKS[16]);
  for (let i = 0; i < 40; i++) assert.notEqual(pickLook([], "tale"), LOOKS[16]);
});

test("a stack: silent films have no voice, a first-person film gets its speaker's gender, a conversation distinct voices", () => {
  const silent = pickStack({ format: "silent", characters: [], shots: [{}] }, []);
  assert.equal(silent.voices, undefined);
  assert.ok(silent.video.videoModel && silent.score.key && silent.finish.key);
  const woman = { name: "Mira", look: "an old woman", kind: "human", gender: "female", age: "old" };
  for (let i = 0; i < 12; i++) {
    const mono = pickStack({ format: "monologue", characters: [woman], shots: [{ speaker: "Mira" }] }, []);
    assert.ok(["default", "af_heart", "bf_emma"].includes(mono.voices.Mira.voice), mono.voices.Mira.voice);
  }
  const talk = pickStack({ format: "dialogue", characters: [frog, woman], shots: [{ speaker: "Narrator" }, { speaker: "Frog" }, { speaker: "Mira" }] }, []);
  const vs = Object.values(talk.voices).map((v) => v.voice);
  assert.equal(new Set(vs).size, 3, vs.join(","));
});

test("each part of the stack goes to the option used least lately", () => {
  const recent = ["wan5b", "wan14b", "ltx"].map((k) => ({ video: { key: k }, score: { key: "brief" }, finish: { key: "lanczos" }, voice: { key: "chatterbox" } }));
  const st = pickStack({ format: "tale", characters: [], shots: [{}] }, recent);
  assert.equal(st.video.key, "hunyuan");
  assert.notEqual(st.score.key, "brief");
});

test("the quality slot makes the film with Wan 2.2 14B at its full 20 steps", () => {
  const st = pickStack({ format: "tale", characters: [], shots: [{}] }, [], { quality: true });
  assert.equal(st.video.key, "wan14b-full");
  assert.equal(st.video.videoModel, "wan2.2-14b");
  assert.equal(st.video.steps, 20);
});

test("a child in a conversation gets a light young voice", () => {
  const boy = { name: "Kael", look: "a young boy", kind: "human", gender: "male", age: "child" };
  const st = pickStack({ format: "dialogue", characters: [boy], shots: [{ speaker: "Narrator" }, { speaker: "Kael" }] }, []);
  assert.equal(st.voices.Kael.voice, "af_sky");
});

test("a poem's line may end on a comma; any other line ends a sentence, never with ',.'", () => {
  const lines = (fmt) => shapeStory(raw([shot("In the cold blue depth where currents spin,"), ...Array.from({ length: 8 }, (_, i) => shot(`Line ${i}.`))]), 9, fmt).shots[0].narration;
  assert.equal(lines("verse"), "In the cold blue depth where currents spin,");
  assert.equal(lines("tale"), "In the cold blue depth where currents spin.");
});

test("a character's age follows their look when the writer's age field disagrees", () => {
  const s = shapeStory(raw(Array.from({ length: 9 }, (_, i) => shot(`Line ${i}.`)), { characters: [
    { name: "Leo", look: "a six year old boy with messy curly red hair", kind: "human", gender: "male", age: "adult" },
    { name: "Elian", look: "an elderly man with a thin silver beard", kind: "human", gender: "male", age: "young" },
    { name: "Mira", look: "a woman in her thirties with a green scarf", kind: "human", gender: "female", age: "adult" },
  ] }), 9);
  assert.deepEqual(s.characters.map((c) => c.age), ["child", "old", "adult"]);
});

test("a child telling their own story gets a child's voice", () => {
  const leo = { name: "Leo", look: "a six year old boy", kind: "human", gender: "male", age: "child" };
  const st = pickStack({ format: "monologue", characters: [leo], shots: [{ speaker: "Leo" }] }, []);
  assert.equal(st.voices.Leo.voice, "af_sky");
});

test("a documentary's invented animal lives where it is set (no honeybee in the deep sea)", async () => {
  const { inventSeed, INVENT } = await import("../src/lib/forge/story.ts");
  for (let i = 0; i < 300; i++) {
    const seed = inventSeed([], { nature: true });
    const [, si, hi] = seed.id.slice(7).split("|").map(Number);
    const where = INVENT.settings[si].habitat, lives = INVENT.heroes[hi].habitat;
    assert.ok(where === "shore" || lives === "shore" || where === lives, `${INVENT.heroes[hi].text} in ${INVENT.settings[si].text}`);
  }
});

import { applyEdits, readViewerTest } from "../src/lib/forge/story.ts";

test("the viewer test's reply is read safely: score clamped, stray shot numbers dropped", () => {
  const t = readViewerTest({ summary: "A fox learns to share.", score: 7, confusing: [{ shot: 3, why: "who is Mira?" }, { shot: 40, why: "no such line" }, { shot: 2, why: "" }] }, 12);
  assert.equal(t.score, 5);
  assert.deepEqual(t.confusing, [{ shot: 3, why: "who is Mira?" }]);
  assert.equal(readViewerTest({ summary: "x", score: "not a number", confusing: [] }, 12), null);
  assert.equal(readViewerTest(null, 12), null);
});

test("the editor's lines replace only the lines it changed, and a wrong-length reply changes nothing", () => {
  const story = { shots: [{ narration: "Mira the fox lived by the river.", speaker: "Narrator" }, { narration: "It glowed.", speaker: "Narrator" }] };
  const out = applyEdits(story, { shots: [{ narration: "Mira the fox lived by the river.", fix: "" }, { narration: "Her lantern glowed on the dark water.", fix: "said what glowed" }] });
  assert.equal(out.raw.shots[0], story.shots[0]);
  assert.equal(out.raw.shots[1].narration, "Her lantern glowed on the dark water.");
  assert.equal(out.raw.shots[1].speaker, "Narrator");
  assert.deepEqual(out.fixes, ["line 2: said what glowed"]);
  assert.equal(applyEdits(story, { shots: [{ narration: "Only one.", fix: "" }] }).raw, story);
});
