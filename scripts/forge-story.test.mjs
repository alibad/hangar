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
