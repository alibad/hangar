/**
 * Stories: instead of what is trending, the forge makes short narrated films —
 * a parable, a fable, a philosophical tale or an original little movie scene,
 * each with one lesson. A local model expands a seed into a shot list: one
 * line of narration per shot, a picture for the still, a motion for the clip.
 * Montage turns the finished shots into the film (narration, music, titles).
 *
 * The writer is a large local model through Ollama (gemma4 31B by default),
 * run inside the forge's GPU turn after vllm-small is paused — it needs ~18 GB
 * and writes far better scenes than the 7B that writes the trending briefs.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const STORY_MODEL = process.env.FORGE_STORY_MODEL ?? "gemma4:31b-it-qat";
const STORY_FALLBACK_MODEL = process.env.FORGE_STORY_FALLBACK_MODEL ?? "qwen3-vl:8b";

export type StorySeed = { id: string; kind: "parable" | "fable" | "myth" | "original"; premise: string };

/**
 * Public-domain parables, fables and myths, and original premises. The model
 * retells or invents; the seed only fixes what the story is about.
 */
export const STORY_SEEDS: StorySeed[] = [
  { id: "farmer-maybe", kind: "parable", premise: "The Taoist farmer whose horse runs away. Neighbours say 'bad luck', he says 'maybe'. The horse returns with wild horses, his son breaks a leg taming one, soldiers pass by and cannot take a lame son. Lesson: we rarely know what is good or bad fortune." },
  { id: "stonecutter", kind: "parable", premise: "The stonecutter who wishes to be a rich merchant, then a prince, then the sun, the cloud, the wind, the mountain — and finds a stonecutter chipping at him. Lesson: contentment; the power you envy is never where you think." },
  { id: "two-monks", kind: "parable", premise: "Two monks at a flooded river; the elder carries a stranded traveller across and sets her down. Hours later the younger monk is still upset. The elder: 'I set her down at the river. You are still carrying her.' Lesson: let go of what is past." },
  { id: "tea-cup", kind: "parable", premise: "A proud scholar visits a Zen master to learn. The master pours tea into his cup and keeps pouring as it overflows. 'Like this cup, you are full of your own opinions. How can I show you anything until you empty your cup?' Lesson: beginner's mind." },
  { id: "butterfly-dream", kind: "parable", premise: "Zhuangzi dreams he is a butterfly, wakes, and cannot tell whether he is a man who dreamt of being a butterfly or a butterfly now dreaming it is a man. Lesson: the boundaries we are sure of may be softer than we think." },
  { id: "empty-boat", kind: "parable", premise: "A man rowing on a misty river is struck by another boat and shouts in anger — until he sees the boat is empty, and his anger has nowhere to go. Lesson: most of what we take personally has no one in it." },
  { id: "cracked-pot", kind: "parable", premise: "A water bearer carries two pots on a pole; one is cracked and leaks, and is ashamed. He shows it the flowers that grew only along its side of the path, watered every day by its leak. Lesson: our flaws can be where the beauty grows." },
  { id: "oak-reed", kind: "fable", premise: "A proud oak mocks the reeds for bending in every breeze. A great storm comes; the reeds bend and survive, the oak stands firm and is torn from the ground. Lesson: flexibility outlasts rigid strength." },
  { id: "tortoise-hare", kind: "fable", premise: "The hare races the tortoise, runs far ahead, naps under a tree in the afternoon sun, and wakes to see the tortoise crossing the finish line. Lesson: steady effort beats talent that rests." },
  { id: "ant-grasshopper", kind: "fable", premise: "All summer the grasshopper plays music while the ant stores grain; when winter comes the grasshopper knocks at the ant's door in the snow. Retell it with a kind ending: the ant shares, and asks for music in return. Lesson: prepare — and that both work and art keep us alive." },
  { id: "cave", kind: "myth", premise: "Plato's cave: prisoners chained since birth watch shadows on a wall and take them for the world. One is freed, climbs into blinding sunlight, sees the real world, and returns to tell the others — who do not believe him. Lesson: the hardest chains are the ideas we never question." },
  { id: "theseus-ship", kind: "myth", premise: "The ship of Theseus is kept in a harbour for centuries; every rotten plank is replaced until no original wood remains. Is it still the same ship? An old shipwright and a child wonder about it — and about themselves, who also change every day. Lesson: identity is a story, not a material." },
  { id: "sisyphus", kind: "myth", premise: "Sisyphus is condemned to roll a boulder up a mountain forever; it always rolls back down. On the walk down, he notices the light, the wind, the path — and smiles. Lesson: meaning is found in the climbing, not the summit." },
  { id: "icarus", kind: "myth", premise: "Daedalus builds wings of feathers and wax for himself and his son Icarus to escape an island. 'Not too low, or the sea will soak the feathers; not too high, or the sun will melt the wax.' Icarus, thrilled, flies higher and higher. Lesson: the middle way; freedom needs judgement." },
  { id: "midas", kind: "myth", premise: "King Midas wishes that everything he touches turns to gold. His roses, his bread, his wine turn to gold — and then his daughter. He begs to undo it and washes in a river. Lesson: what we truly value is rarely what glitters." },
  { id: "blind-elephant", kind: "parable", premise: "Six blind travellers meet an elephant. One touches the trunk — a snake; one the leg — a tree; one the ear — a fan; one the side — a wall. They argue for hours, each right and each wrong. Lesson: everyone holds a piece of the truth." },
  { id: "frog-well", kind: "parable", premise: "A frog lives at the bottom of a well and thinks the sky is the size of the opening above him. A sea turtle passing by tells him of the ocean, and he cannot imagine it — until he climbs out. Lesson: our view is only as wide as where we stand." },
  { id: "mustard-seed", kind: "parable", premise: "A grieving mother asks a sage to bring back her child. He asks her to bring a mustard seed from a house that has never known loss. She knocks at every door in the village and finds none — and learns she is not alone. Lesson: grief is shared by all; compassion heals." },
  { id: "planting-trees", kind: "parable", premise: "A traveller sees an old man planting a carob tree that takes seventy years to fruit. 'You will never eat from it.' 'I found the world full of trees my grandparents planted. I plant for those who come after me.' Lesson: we live in the shade of others' kindness." },
  { id: "this-too", kind: "parable", premise: "A king asks his wise men for words that will make him happy when he is sad and humble when he is proud. They give him a ring engraved inside: 'This too shall pass.' He reads it in triumph and in defeat. Lesson: everything is temporary." },
  { id: "monkey-jar", kind: "parable", premise: "Hunters set a jar with a narrow neck holding nuts. A monkey reaches in, grabs a fistful, and cannot pull its fist out — and will not let go, even as night falls. Lesson: to be free, open your hand." },
  { id: "elephant-rope", kind: "parable", premise: "A huge circus elephant is held by a thin rope tied to a small stake. As a baby it pulled and could not break free; now grown, it no longer tries. One night a fire comes, and it pulls — and the stake comes out. Lesson: old limits may no longer be real." },
  { id: "key-lamp", kind: "parable", premise: "Nasreddin searches the ground under a street lamp at night. A neighbour helps, then asks where he dropped the key. 'In my house.' 'Then why look here?' 'There is more light here.' Lesson: we look where it is easy, not where the answer is." },
  { id: "carpenter-house", kind: "parable", premise: "An old carpenter ready to retire is asked by his employer to build one last house. His heart is not in it; he uses poor wood and careless joints. At the end the employer hands him the key: 'This house is my gift to you.' Lesson: we are building our own house every day." },
  { id: "sand-stone", kind: "parable", premise: "Two friends cross a desert; they quarrel and one strikes the other, who writes in the sand: 'Today my friend hurt me.' Later he is saved from drowning in an oasis and carves into stone: 'Today my friend saved my life.' Lesson: write hurts in sand, kindness in stone." },
  { id: "scorpion-frog", kind: "fable", premise: "A scorpion asks a frog to carry it across a river; the frog fears being stung, but the scorpion says it would drown too. Midway it stings the frog. 'Why?' 'It is my nature.' Lesson: know the nature of what you trust." },
  { id: "diogenes", kind: "parable", premise: "Diogenes walks through the market in broad daylight holding a lit lantern, peering into faces. Asked why: 'I am looking for an honest person.' Lesson: honesty is rarer than light at noon — and begins with ourselves." },
  { id: "lighthouse", kind: "original", premise: "An original story: the last keeper of a lighthouse that ships no longer need keeps lighting the lamp every night. One stormy night a small fishing boat with no instruments finds its way home by his light. Lesson: keep your light on even when no one seems to need it." },
  { id: "paper-boat", kind: "original", premise: "An original story: a child folds a paper boat and sets it on a rain gutter. It travels through puddles, a stream, a river, past cities and forests, and finally reaches the sea at sunrise. Lesson: small beginnings can carry us farther than we imagine." },
  { id: "clockmaker", kind: "original", premise: "An original story: an old clockmaker builds a clock that runs backwards, hoping to win back time with his late wife. The clock ticks backwards but the seasons outside keep turning. He finally sets it running forward and opens the shop door to spring. Lesson: time only moves one way; love what is in front of you." },
  { id: "snowman", kind: "original", premise: "An original story: a snowman in a winter field longs to see summer. A robin tells him about it every day. When spring comes he melts into a stream that waters the first flowers — and in a way, he sees summer. Lesson: change is not an ending." },
  { id: "garden-robot", kind: "original", premise: "An original story: a small gardening robot on an abandoned space station keeps tending one last plant for hundreds of years, long after the crew has gone. One day the plant flowers, and a ship appears in the window. Lesson: patience and care are their own kind of hope." },
  { id: "mountain-climber", kind: "original", premise: "An original story: an old woman climbs a mountain she has looked at from her window her whole life. At the summit, she turns and sees her own small house in the valley, and understands it was the view she loved. Lesson: we sometimes travel far to see what was always home." },
  { id: "lantern-festival", kind: "original", premise: "An original story: on a night of floating lanterns, a boy's lantern will not light. An old woman next to him shares her flame; his lantern lights another, and that one another, until the whole river glows. Lesson: light shared is not light lost." },
  { id: "fox-moon", kind: "original", premise: "An original story: a young fox tries every night to catch the moon's reflection in a pond, and every time it breaks into ripples. An old owl tells him to sit still. He does, and the moon settles, perfect, in the water. Lesson: some things come only when we stop grasping." },
  { id: "bridge-builder", kind: "original", premise: "An original story: an old traveller crosses a deep gorge at dusk, then stops and builds a bridge over it. A young man asks why; he will never pass this way again. 'A child is coming behind me who will have to cross in the dark.' Lesson: build for those who follow." },
  { id: "music-box", kind: "original", premise: "An original story: in a flooded, forgotten city, a rusty music box is found by a diver. Wound once, it plays a lullaby, and fish gather in the drowned ballroom. Lesson: beauty survives in the most unlikely places." },
  { id: "whale-song", kind: "original", premise: "An original story: a whale sings at a frequency no other whale can hear and travels the oceans alone for years. One day, far away, another voice answers in the same strange note. Lesson: keep singing your own song; someone is listening." },
];

export type StoryShot = {
  /** Said over this shot by the narrator: one sentence, 6 to 16 words. */
  narration: string;
  /** What the still shows: subject, setting, light, framing; character looks repeated in full. */
  picture: string;
  /** What moves during the 5-second clip, and how the camera moves. */
  motion: string;
};

export type Story = {
  id: string;
  createdAt: string;
  seed: string;
  kind: StorySeed["kind"];
  title: string;
  logline: string;
  lesson: string;
  /** One visual style shared by every shot. */
  look: string;
  /** A music brief for the score. */
  score: string;
  characters: { name: string; look: string }[];
  shots: StoryShot[];
  model: string;
  latencyMs: number;
  /** The writer's own problems, fixed or noted. */
  notes: string[];
};

/** Visual styles the writer picks from; one per story keeps the shots of one film consistent. */
export const LOOKS = [
  "cinematic 35mm film still, anamorphic lens, soft natural light, gentle film grain, muted earthy colors, shallow depth of field",
  "hand-painted animated film background style, soft watercolor textures, warm golden light, painterly clouds, storybook atmosphere",
  "classical oil painting brought to life, chiaroscuro lighting, rich deep colors, visible brushwork, museum quality",
  "Chinese ink wash painting style with subtle color, misty mountains, soft paper texture, calm and spacious composition",
  "stop-motion miniature film, handcrafted felt and clay figures, tiny practical sets, warm tungsten light, tilt-shift depth of field",
  "moody cinematic photograph, blue hour light, deep shadows, volumetric fog, teal and amber color grade",
];

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    logline: { type: "string" },
    lesson: { type: "string" },
    look: { type: "string" },
    score: { type: "string" },
    characters: { type: "array", items: { type: "object", properties: { name: { type: "string" }, look: { type: "string" } }, required: ["name", "look"] } },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: { narration: { type: "string" }, picture: { type: "string" }, motion: { type: "string" } },
        required: ["narration", "picture", "motion"],
      },
    },
  },
  required: ["title", "logline", "lesson", "look", "score", "characters", "shots"],
};

export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Pick a seed not used in the stories made lately, alternating told and original tales. */
export function pickSeed(recentSeeds: string[], lastKind?: StorySeed["kind"]): StorySeed {
  const used = new Set(recentSeeds);
  let pool = STORY_SEEDS.filter((s) => !used.has(s.id));
  if (!pool.length) pool = STORY_SEEDS.filter((s) => s.id !== recentSeeds[0]);
  const wantOriginal = lastKind && lastKind !== "original";
  const preferred = pool.filter((s) => (wantOriginal ? s.kind === "original" : s.kind !== "original"));
  const from = preferred.length ? preferred : pool;
  return from[Math.floor(Math.random() * from.length)];
}

function prompt(seed: StorySeed, shots: number, look: string): string {
  return [
    "You are the writer and director of a short narrated film — about a minute and a quarter long — made entirely by AI: each shot is first drawn as a still image, then animated into a 5-second clip, and a calm narrator reads one line over each shot. Think like a filmmaker: a real story with a beginning, a turn and an ending, told with images.",
    "",
    `The story: ${seed.premise}`,
    seed.kind === "original" ? "Make it your own: invent the details, the setting and the small moments that make it feel like a real film." : "Retell it in your own words, with vivid concrete details; you may set it in any fitting time and place.",
    "",
    `Write exactly ${shots} shots. For each shot:`,
    '- "narration": ONE sentence the narrator says over this 5-second shot, 6 to 14 words. Warm, simple, literary; past tense like a told tale. Together the lines tell the whole story; the last two lines land the lesson gently, without preaching. No quotation marks inside lines — report speech instead (He told them the sky was only as wide as the well).',
    '- "picture": the still image, written as an image-generation prompt of 30 to 60 words: the subject, the setting, the light, the time of day, and the framing (wide establishing shot, medium shot, close-up of hands or an object, over-the-shoulder, silhouette against the sky…). The model drawing it knows nothing about the other shots, so whenever a character appears, repeat their FULL look every time (age, build, hair, clothing and colours, one distinctive object) exactly as in "characters". Never use names in a picture — describe.',
    '- "motion": what moves during the clip and how the camera moves, 10 to 25 words (e.g. "slow push-in; wind ripples the grass, the old man\'s robe stirs, clouds drift"). Motion should be gentle and physical — wind, water, light, a slow turn of the head, walking away, a hand opening. No fast action, no fighting, no crowds running.',
    "",
    "Rules that make the film look good:",
    "- Vary the framing like a real film: open wide, then move closer; mix landscapes, medium shots, details (hands, objects, eyes, footprints) and silhouettes. At most a third of shots are close-ups of faces.",
    "- Keep each character visually simple and distinctive so they can be drawn the same way every time; animals and silhouettes animate beautifully.",
    "- No text, letters, signs, books with readable pages, logos or screens in any picture.",
    "- Nothing gory, violent or frightening; it is a gentle film for all ages.",
    "",
    `"look": the visual style for every shot. Use this one, adapting the wording to the story if it helps: "${look}".`,
    '"score": a music brief for the soundtrack, 10 to 20 words, instruments and mood (e.g. "solo cello and soft piano, slow, tender, a gentle swell at the end"). Instrumental only.',
    '"title": the film\'s title, 1 to 5 words, evocative, no colon. "logline": one sentence that makes someone want to watch it. "lesson": the lesson in one short sentence (max 14 words).',
    '"characters": each character\'s name and FULL visual description (the exact words to repeat in every picture). An empty list if the story has none.',
    "",
    "Reply with JSON only.",
  ].join("\n");
}

async function askOllama(model: string, text: string, timeoutMs: number): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      // Unload right after: the card is needed for the stills and clips.
      keep_alive: 0,
      format: SCHEMA,
      options: { temperature: 0.85, top_p: 0.95, num_ctx: 8192, num_predict: 4000 },
      messages: [{ role: "user", content: text }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

const clean = (s: unknown, max = 600) =>
  String(s ?? "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Check and tidy what the writer returned; throws when it is not a usable film. */
export function shapeStory(raw: unknown, want: number): Omit<Story, "id" | "createdAt" | "seed" | "kind" | "model" | "latencyMs"> {
  const j = (raw ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  const shotsIn = Array.isArray(j.shots) ? (j.shots as Record<string, unknown>[]) : [];
  const shots: StoryShot[] = [];
  for (const s of shotsIn) {
    let narration = clean(s.narration, 240).replace(/\s*\.\.\.$/, ".");
    const picture = clean(s.picture, 700);
    const motion = clean(s.motion, 300);
    if (!narration || !picture) continue;
    if (words(narration) > 20) {
      // A line longer than the shot spills into the next one; cut it at a clause.
      const cut = narration.split(/(?<=[,;:—])\s+/);
      let out = "";
      for (const part of cut) if (words(out + " " + part) <= 18) out = `${out} ${part}`.trim();
      narration = (out || narration.split(/\s+/).slice(0, 16).join(" ")).replace(/[,;:—]$/, ".");
      notes.push(`shortened a long narration line to "${narration}"`);
    }
    if (!/[.!?]$/.test(narration)) narration += ".";
    shots.push({ narration, picture, motion: motion || "slow cinematic push-in, gentle natural movement" });
  }
  if (shots.length < Math.min(8, want)) throw new Error(`the writer gave ${shots.length} usable shots, need at least ${Math.min(8, want)}`);
  const title = clean(j.title, 60).replace(/[.:]$/, "");
  if (!title) throw new Error("the writer gave no title");
  const characters = (Array.isArray(j.characters) ? (j.characters as Record<string, unknown>[]) : [])
    .map((c) => ({ name: clean(c.name, 40), look: clean(c.look, 300) }))
    .filter((c) => c.name && c.look)
    .slice(0, 4);
  // The 7B and sometimes the 31B forget to repeat a character's look; a name
  // in a picture means nothing to the image model.
  for (const shot of shots) {
    for (const c of characters) {
      const re = new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(shot.picture)) shot.picture = shot.picture.replace(re, c.look);
    }
  }
  return {
    title,
    logline: clean(j.logline, 240),
    lesson: clean(j.lesson, 140).replace(/\.$/, "") + ".",
    look: clean(j.look, 300),
    score: clean(j.score, 200) || "solo piano and soft strings, slow, tender, cinematic",
    characters,
    shots: shots.slice(0, want + 2),
    notes,
  };
}

/** Write one story. Tries the large writer, then the small one. */
export async function writeStory(opts: { seed: StorySeed; shots: number; look?: string }): Promise<Story> {
  const look = opts.look ?? LOOKS[Math.floor(Math.random() * LOOKS.length)];
  const text = prompt(opts.seed, opts.shots, look);
  const problems: string[] = [];
  for (const model of [STORY_MODEL, STORY_FALLBACK_MODEL]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        const reply = await askOllama(model, text, 8 * 60_000);
        const m = /\{[\s\S]*\}/.exec(reply);
        if (!m) throw new Error("no JSON in the reply");
        const shaped = shapeStory(JSON.parse(m[0]), opts.shots);
        return {
          id: `story-${Date.now().toString(36)}`,
          createdAt: new Date().toISOString(),
          seed: opts.seed.id,
          kind: opts.seed.kind,
          ...shaped,
          look: shaped.look || look,
          model,
          latencyMs: Date.now() - t0,
          notes: [...problems, ...shaped.notes],
        };
      } catch (err) {
        problems.push(`${model} try ${attempt}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240));
      }
    }
  }
  throw new Error(problems.join("; "));
}

/** The still prompt for one shot: the picture plus the film's look. */
export function shotStillPrompt(story: Pick<Story, "look">, shot: StoryShot): string {
  return `${shot.picture} ${story.look}.`;
}

export const STORY_STILL_SUFFIX = "Cinematic composition, beautiful light, highly detailed, no text, no lettering, no signs, no logos, no watermark.";

export const STORY_AVOID =
  "text, letters, words, subtitles, watermark, logo, deformed hands, extra fingers, distorted face, morphing, melting, flicker, jump cut, crowd running, blurry";
