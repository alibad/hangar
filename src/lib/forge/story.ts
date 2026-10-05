/**
 * Stories: instead of what is trending, the forge makes short films — a
 * parable, a fable, a thought experiment, a letter, a silent film — each with
 * one lesson. A local model expands a seed into a shot list: one line per shot,
 * a picture for the still, a motion for the clip. Montage turns the finished
 * shots into the film (voices, music, titles).
 *
 * Variety is the point: every film rotates its format (how it is told), its
 * source (a told tale, a thought experiment, or a premise invented from a
 * theme, a place and a hero) and its look, choosing what was used least lately.
 *
 * Continuity: the image model sees one picture at a time and nothing else, so
 * the writer names every character in frame as {Name} and the code pastes in
 * their full look; a second pass by the same model reads the whole shot list as
 * a continuity supervisor ("two figures sank" → {Frog} and {Scorpion} sank).
 *
 * The writer is a large local model through Ollama (gemma4 31B by default),
 * run inside the forge's GPU turn after vllm-small is paused — it needs ~18 GB
 * and writes far better scenes than the 7B that writes the trending briefs.
 *
 * Import-free (types only), so the tests load this exact file.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const STORY_MODEL = process.env.FORGE_STORY_MODEL ?? "gemma4:31b-it-qat";
const STORY_FALLBACK_MODEL = process.env.FORGE_STORY_FALLBACK_MODEL ?? "qwen3-vl:8b";

export type StoryKind = "parable" | "fable" | "myth" | "folktale" | "thought" | "original";
export type StorySeed = { id: string; kind: StoryKind; premise: string };

// ── formats: how a film is told ─────────────────────────────────────────────

export type FormatId = "tale" | "monologue" | "letter" | "verse" | "dialogue" | "silent" | "documentary" | "thought" | "micro";

export type StoryFormat = {
  id: FormatId;
  /** On the title card and in the lab: "A silent film". */
  label: string;
  shots: number;
  /** False for a silent film: its lines are title cards, nobody speaks. */
  voiced: boolean;
  /** One line's rules, for the writer. */
  line: string;
  /** Looks that suit it, preferred most of the time. */
  looks?: number[];
};

export const FORMATS: Record<FormatId, StoryFormat> = {
  tale: {
    id: "tale",
    label: "A tale",
    shots: 14,
    voiced: true,
    line: 'ONE sentence the narrator says over this 5-second shot, 6 to 14 words. Warm, simple, literary; past tense like a told tale. Together the lines tell the whole story; the last two land the lesson gently, without preaching. No quotation marks inside lines — report speech instead (He told them the sky was only as wide as the well). "speaker" is always "Narrator".',
  },
  monologue: {
    id: "monologue",
    label: "A monologue",
    shots: 12,
    voiced: true,
    line: 'ONE sentence, 6 to 14 words, spoken by the main character about their own life, in the first person ("I"), looking back. Their own voice and way of seeing: an old ferryman speaks plainly, a fox slyly, a lighthouse slowly and patiently. "speaker" is always that character\'s name.',
    looks: [0, 1, 4, 8],
  },
  letter: {
    id: "letter",
    label: "A letter",
    shots: 12,
    voiced: true,
    line: 'ONE sentence of a letter, 6 to 14 words, written by one character to another and read aloud by its writer: first person, addressed to "you" (a mother to a son at sea, a keeper to the next keeper, a tree to the child who planted it). The last line closes the letter. The pictures show the world the letter speaks of — the writer, the one it is for, the distance between them. "speaker" is always the letter\'s writer.',
    looks: [0, 1, 13, 2],
  },
  verse: {
    id: "verse",
    label: "A poem",
    shots: 12,
    voiced: true,
    line: 'ONE line of a poem, 6 to 12 words, with a steady, speakable rhythm. Rhyme the lines in pairs (1 with 2, 3 with 4…) only where it comes naturally — never force a rhyme. Together the lines are one poem that tells the whole story in order, in plain words: it must make sense to someone who hears it once. "speaker" is always "Narrator".',
    looks: [1, 6, 12, 3],
  },
  dialogue: {
    id: "dialogue",
    label: "A conversation",
    shots: 14,
    voiced: true,
    line: 'ONE sentence, 5 to 14 words. Two or three voices tell the story between them: a narrator and one or two characters, taking turns. A character\'s line is what they say aloud, in their own voice (no quotation marks, no "she said"); the narrator\'s lines tell what happens. At least five lines are spoken by characters. "speaker" is "Narrator" or the speaking character\'s exact name.',
  },
  silent: {
    id: "silent",
    label: "A silent film",
    shots: 12,
    voiced: false,
    line: 'A title card, 3 to 10 words, as in a 1920s silent film: a short line of story (Winter came early that year.) or a character\'s words after a dash (— You will never reach the moon.). Nobody speaks aloud; the pictures carry the story and the cards bridge it — together they must name who it is about and what happens, so the story is clear without sound. "speaker" is always "Narrator".',
    looks: [7, 15],
  },
  documentary: {
    id: "documentary",
    label: "A nature documentary",
    shots: 12,
    voiced: true,
    line: 'ONE sentence, 6 to 16 words, in the voice of a nature documentary narrator: present tense, calm wonder, precise natural detail, observing as if it were real. The creatures behave like themselves; the lesson lives in what they do, never in a moral. "speaker" is always "Narrator".',
    looks: [16],
  },
  thought: {
    id: "thought",
    label: "A thought experiment",
    shots: 12,
    voiced: true,
    line: 'ONE sentence, 6 to 16 words. The narrator walks the viewer through a thought experiment, speaking to them as "you" (Imagine you wake in a room where…). Concrete and visual: build the puzzle step by step, show its twist, and end on an open question to the viewer, not an answer. "speaker" is always "Narrator". The "lesson" is that question.',
    looks: [11, 10, 14, 3],
  },
  micro: {
    id: "micro",
    label: "A very short story",
    shots: 7,
    voiced: true,
    line: 'ONE sentence, 5 to 12 words: a koan-like micro-story in seven shots — still, simple images, and one turn in the last two shots that changes how everything before it looks — a turn the viewer gets at once, not a riddle. Past tense. "speaker" is always "Narrator".',
    looks: [3, 11, 5],
  },
};

const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

/** The format used least among recent films (never the last one twice), ties at random. */
export function pickFormat(recentFormats: string[], rand = Math.random): FormatId {
  const window = recentFormats.slice(0, FORMAT_IDS.length * 2);
  const count = (f: FormatId) => window.filter((x) => x === f).length;
  const pool = FORMAT_IDS.filter((f) => f !== recentFormats[0]);
  const least = Math.min(...pool.map(count));
  const best = pool.filter((f) => count(f) === least);
  return best[Math.floor(rand() * best.length)];
}

// ── sources: what a film is about ───────────────────────────────────────────

/**
 * Public-domain parables, fables, folktales, myths and thought experiments,
 * and original premises. The model retells or invents; the seed only fixes
 * what the story is about.
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
  { id: "north-wind-sun", kind: "fable", premise: "The North Wind and the Sun argue over who is stronger and test it on a traveller in a cloak. The Wind blows harder and harder and the traveller only clutches the cloak tighter; the Sun shines gently and warmly, and the traveller takes it off. Lesson: gentleness persuades where force fails." },
  { id: "lion-mouse", kind: "fable", premise: "A lion catches a tiny mouse and, amused by its promise to repay him one day, lets it go. Later the lion is caught in a hunter's net; the mouse gnaws through the ropes one by one. Lesson: no kindness is wasted, and the small can save the great." },
  { id: "crow-pitcher", kind: "fable", premise: "A thirsty crow finds a pitcher with a little water at the bottom, too low for its beak. It drops in pebbles, one by one, until the water rises to the brim. Lesson: patience and ingenuity beat strength." },
  { id: "belling-cat", kind: "fable", premise: "The mice hold a council about the cat. A young mouse proposes tying a bell around its neck, and everyone cheers — until an old mouse asks who will put the bell on the cat. Lesson: it is easy to propose what is hard to do." },
  { id: "strawberry", kind: "parable", premise: "A man chased by a tiger climbs down a cliff on a vine; below him waits another tiger, and two mice begin to gnaw the vine. Beside him grows one wild strawberry. He picks it. How sweet it tastes. Lesson: the present moment is all we ever have." },
  { id: "nasreddin-coat", kind: "folktale", premise: "Nasreddin comes to a feast in his old work clothes and is seated by the door and ignored. He goes home, puts on a splendid fur coat, returns, and is given the best seat. He begins feeding soup to his coat: 'Eat, coat — it was you they invited.' Lesson: honour the person, not the clothes." },
  { id: "anansi-wisdom", kind: "folktale", premise: "Anansi the spider gathers all the wisdom of the world into a clay pot and tries to hide it at the top of a tall tree, but the pot tied to his front keeps him from climbing. His small son suggests tying it to his back. Furious that he did not have all the wisdom after all, Anansi drops the pot and wisdom scatters across the world. Lesson: no one holds all the wisdom." },
  { id: "crane-wife", kind: "folktale", premise: "A poor man frees a wounded crane from a trap. Soon a gentle woman comes to his door and becomes his wife; she weaves cloth of wondrous beauty in a closed room, asking him never to look. He grows greedy for more cloth and peeks: a crane is pulling out her own feathers to weave. She flies away. Lesson: love asks for trust, not for more." },
  { id: "old-mother-mountain", kind: "folktale", premise: "A cruel lord orders all old people sent away to the mountains. A son carries his mother up the slope, and she breaks twigs along the path so he will not lose his way home. He cannot leave her and hides her at home. When the lord sets impossible riddles, her wisdom answers them, and the law is undone. Lesson: the old carry what the young have not yet learned." },
  { id: "empty-pot", kind: "folktale", premise: "An old emperor gives every child a seed: whoever grows the most beautiful flower will rule after him. A boy tends his seed with care but nothing grows; the other children come with magnificent flowers. He brings his empty pot. The emperor had cooked the seeds: only he was honest. Lesson: honesty takes courage, and it is seen." },
  { id: "hummingbird", kind: "folktale", premise: "A great fire sweeps through the forest; all the animals flee and watch. A tiny hummingbird flies again and again to the river and drops a single bead of water on the flames. The big animals laugh: what can you do? 'I am doing what I can.' Lesson: do your part, however small." },
  { id: "useless-tree", kind: "parable", premise: "A carpenter passes an enormous old oak by a shrine and scorns it: its wood is twisted and knotted, good for nothing. That night the tree speaks in his dream: because I was useless, no one cut me down, and I grew this great and gave this much shade. Lesson: the usefulness of being useless; not everything must serve." },
  { id: "tailor-coat", kind: "folktale", premise: "A poor tailor wears his coat until it is worn out, then makes it into a jacket; when that wears out, a vest; then a cap; then a button; and when the button is lost, he has a story to tell about it all. Lesson: something can always be made from what is left." },
  { id: "canute-tide", kind: "parable", premise: "Flattering courtiers tell the king that even the sea obeys him. He has his throne carried to the shore and commands the rising tide to stop. The waves wash over his feet and his robe. 'Let all know how empty the power of kings is.' Lesson: humility before what no one commands." },
  { id: "stone-soup", kind: "folktale", premise: "Hungry travellers come to a village where no one will share. They set a pot of water to boil with a single stone, saying stone soup is delicious but better with a carrot; curious villagers each add something, and soon the whole village eats together. Lesson: shared, a little becomes plenty." },
  { id: "bamboo-fern", kind: "parable", premise: "A man ready to quit asks the forest why he should go on. He is shown a fern and a bamboo planted on the same day: the fern covered the ground at once, while for five years the bamboo showed nothing — growing roots. In the sixth year it rose a hundred feet. Lesson: growth begins underground, out of sight." },
  { id: "fisherman", kind: "parable", premise: "A visitor finds a fisherman dozing in his boat after a small morning catch and urges him to fish all day, buy more boats, build a fleet and grow rich — so that one day he can retire to a quiet village, fish a little in the morning, and doze in the sun. 'That,' says the fisherman, 'is what I am doing now.' Lesson: know what you are working for." },
  { id: "experience-machine", kind: "thought", premise: "The experience machine: imagine a machine that can give you any life you want — love, triumph, discovery — so perfectly that, once inside, you would never know it was not real. Would you plug in for the rest of your life? Why does something in us say no?" },
  { id: "veil-of-ignorance", kind: "thought", premise: "The veil of ignorance: imagine you must design the rules of a whole society before you know who you will be in it — rich or poor, strong or frail, which country, which body. Behind that veil, what rules would you choose?" },
  { id: "buridan", kind: "thought", premise: "Buridan's donkey: a hungry donkey stands exactly halfway between two identical bales of hay and, having no reason to prefer either, cannot choose — and stands there, starving, between plenty. What is a reason to choose, and when is any choice better than none?" },
  { id: "marys-room", kind: "thought", premise: "Mary's room: Mary has spent her whole life in a black-and-white room and knows every fact about colour — the wavelengths, the eyes, the brain. One day she opens the door and sees a red apple for the first time. Does she learn something new? What can knowledge not hold?" },
  { id: "eternal-return", kind: "thought", premise: "The eternal return: imagine that one evening a voice tells you that you will live this exact life again, and again, forever — every joy and every pain, in the same order. Would you despair, or would you love your life enough to want it again?" },
  { id: "gyges-ring", kind: "thought", premise: "The ring of Gyges: a shepherd finds a ring in a cave that makes him invisible when he turns it. No one would ever know what he did. If you could never be caught, would you still be good? What is goodness for, if not for being seen?" },
  { id: "stopped-clock", kind: "thought", premise: "The stopped clock: you glance at a clock in a quiet station, it says two o'clock, and it is two o'clock — but the clock stopped exactly twelve hours ago. You were right, and you were lucky. Did you know the time? What is the difference between being right and knowing?" },
  { id: "teleporter", kind: "thought", premise: "The teleporter: a machine scans you, dissolves you here, and builds you again, atom for atom, on Mars, with every memory intact. The person who steps out feels exactly like you. Is it you who arrives? And if the machine forgot to dissolve the original?" },
  { id: "sorites-heap", kind: "thought", premise: "The heap: a heap of sand on a beach. Take away one grain: still a heap. Take away another; one grain never turns a heap into no heap — and yet, grain by grain, the heap is gone. When did it stop being a heap? And when does a person change?" },
  { id: "beetle-box", kind: "thought", premise: "The beetle in a box: everyone in a village has a small box with something inside they call a 'beetle'. No one can ever look into anyone else's box. Everyone talks about their beetle. Could every box hold something different — or nothing — and would anyone ever know? Is your 'pain' the same as mine?" },
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

/** Thought experiments; the cave, the ship and the butterfly dream work as one too. */
const THOUGHT_SEEDS = new Set(["cave", "theseus-ship", "butterfly-dream", ...STORY_SEEDS.filter((s) => s.kind === "thought").map((s) => s.id)]);

/** An original premise from a theme, a place and a hero (the writer invents the plot). */
export const INVENT = {
  themes: [
    "patience: some things cannot be hurried",
    "letting go of an old grudge",
    "the courage to begin again after failing",
    "a small kindness to a stranger that returns in an unexpected way",
    "attention: wonder hides in ordinary things",
    "pride before a fall",
    "envy: the far bank of the river only looks greener",
    "knowing when you have enough",
    "impermanence: nothing lasts, and that is why it is precious",
    "honesty when a lie would be easier",
    "listening as a kind of love",
    "the strength it takes to ask for help",
    "home is the people, not the place",
    "curiosity opens doors that fear keeps shut",
    "a promise kept across many years",
    "what we give away, we keep",
    "fear is smaller up close",
    "the long way round shows you more",
    "forgiving yourself",
    "failure as a teacher",
  ],
  settings: [
    { text: "a night train crossing a snowy steppe" },
    { text: "a lighthouse on a rocky northern island", nature: true, habitat: "shore" },
    { text: "a floating market on a misty river at dawn" },
    { text: "a desert observatory under a sky full of stars", nature: true, habitat: "land" },
    { text: "a snowbound mountain monastery" },
    { text: "a coral reef in shallow turquoise water", nature: true, habitat: "sea" },
    { text: "a city of canals and small stone bridges" },
    { text: "a greenhouse on the Moon" },
    { text: "an old cinema in a small seaside town" },
    { text: "a beekeeper's hillside of wildflowers", nature: true, habitat: "land" },
    { text: "a vast white salt flat after rain", nature: true, habitat: "land" },
    { text: "a tiny post office high in the mountains" },
    { text: "the deep sea, where lantern fish glow", nature: true, habitat: "sea" },
    { text: "a library that orbits a quiet planet" },
    { text: "a bamboo forest in summer rain", nature: true, habitat: "land" },
    { text: "an autumn orchard at harvest", nature: true, habitat: "land" },
    { text: "a fishing village on stilts" },
    { text: "a frozen lake at dusk", nature: true, habitat: "shore" },
    { text: "a clock tower above a sleeping town" },
    { text: "a caravan route across red sand dunes", nature: true, habitat: "land" },
    { text: "a rooftop garden in a crowded city" },
    { text: "a tiny island with a single tree", nature: true, habitat: "shore" },
    { text: "a puppet theatre after closing time" },
    { text: "a tidal marsh where herons wade", nature: true, habitat: "shore" },
  ],
  heroes: [
    { text: "an old ferryman" },
    { text: "a young mapmaker" },
    { text: "a red fox", animal: true, habitat: "land" },
    { text: "a small lamplighter robot" },
    { text: "a girl who collects echoes in jars" },
    { text: "an old tortoise", animal: true, habitat: "land" },
    { text: "a retired astronaut" },
    { text: "a crow who collects buttons", animal: true, habitat: "land" },
    { text: "a glassblower" },
    { text: "a paper crane that has come to life" },
    { text: "a night watchman" },
    { text: "a snow leopard cub", animal: true, habitat: "land" },
    { text: "a baker who wakes before dawn" },
    { text: "a hermit crab looking for a bigger shell", animal: true, habitat: "shore" },
    { text: "a clockmaker's apprentice" },
    { text: "an elderly gardener" },
    { text: "a whale calf", animal: true, habitat: "sea" },
    { text: "a wandering musician" },
    { text: "a grey heron", animal: true, habitat: "shore" },
    { text: "a boy who is afraid of the dark" },
    { text: "a honeybee who gets lost", animal: true, habitat: "land" },
    { text: "a postwoman on a bicycle" },
    { text: "a young octopus", animal: true, habitat: "sea" },
    { text: "a pair of old swans", animal: true, habitat: "shore" },
  ],
};

/** A premise invented from a theme, a place and a hero not used in recent invented seeds. */
export function inventSeed(recentSeeds: string[], opts: { nature?: boolean } = {}, rand = Math.random): StorySeed {
  const recent = recentSeeds.filter((s) => s.startsWith("invent:")).map((s) => s.slice(7).split("|").map(Number));
  const fresh = <T>(list: T[], slot: number, ok: (x: T) => boolean = () => true) => {
    const idx = list.map((x, i) => i).filter((i) => ok(list[i]) && !recent.some((r) => r[slot] === i));
    const from = idx.length ? idx : list.map((x, i) => i).filter((i) => ok(list[i]));
    return from[Math.floor(rand() * from.length)];
  };
  const t = fresh(INVENT.themes, 0);
  const s = fresh(INVENT.settings, 1, (x) => !opts.nature || !!x.nature);
  // An animal only where it lives: the shore meets both land and sea.
  const where = (INVENT.settings[s] as { habitat?: string }).habitat;
  const fits = (x: { habitat?: string }) => !where || !x.habitat || x.habitat === where || x.habitat === "shore" || where === "shore";
  const h = fresh(INVENT.heroes, 2, (x) => !opts.nature || (!!x.animal && fits(x)));
  return {
    id: `invent:${t}|${s}|${h}`,
    kind: "original",
    premise: `An original story about ${INVENT.heroes[h].text}, set in ${INVENT.settings[s].text}. Its heart: ${INVENT.themes[t]}. Invent the plot yourself — a want, an obstacle, a turn, and an ending that earns the lesson without stating it.`,
  };
}

/**
 * Pick a seed not used lately. A thought experiment for that format; animals
 * in nature for a documentary; otherwise told tales alternate with originals,
 * and an original is invented from a theme, a place and a hero half the time.
 */
export function pickSeed(recentSeeds: string[], lastKind?: StoryKind, format?: FormatId, rand = Math.random): StorySeed {
  const used = new Set(recentSeeds);
  const fromPool = (pool: StorySeed[]) => {
    const fresh = pool.filter((s) => !used.has(s.id));
    const from = fresh.length ? fresh : pool.filter((s) => s.id !== recentSeeds[0]);
    return from[Math.floor(rand() * from.length)];
  };
  if (format === "thought") return fromPool(STORY_SEEDS.filter((s) => THOUGHT_SEEDS.has(s.id)));
  if (format === "documentary") return rand() < 0.7 ? inventSeed(recentSeeds, { nature: true }, rand) : fromPool(STORY_SEEDS.filter((s) => s.kind === "fable"));
  const general = STORY_SEEDS.filter((s) => s.kind !== "thought");
  const wantOriginal = lastKind && lastKind !== "original";
  if (wantOriginal) {
    const hand = general.filter((s) => s.kind === "original" && !used.has(s.id));
    return !hand.length || rand() < 0.5 ? inventSeed(recentSeeds, {}, rand) : hand[Math.floor(rand() * hand.length)];
  }
  const told = general.filter((s) => s.kind !== "original");
  return fromPool(lastKind ? told : general);
}

// ── looks ───────────────────────────────────────────────────────────────────

/** Visual styles; one per story keeps the shots of one film consistent. */
export const LOOKS = [
  "cinematic 35mm film still, anamorphic lens, soft natural light, gentle film grain, muted earthy colors, shallow depth of field",
  "hand-painted animated film background style, soft watercolor textures, warm golden light, painterly clouds, storybook atmosphere",
  "classical oil painting brought to life, chiaroscuro lighting, rich deep colors, visible brushwork, museum quality",
  "Chinese ink wash painting style with subtle color, misty mountains, soft paper texture, calm and spacious composition",
  "stop-motion miniature film, handcrafted felt and clay figures, tiny practical sets, warm tungsten light, tilt-shift depth of field",
  "papercut shadow-puppet animation, layered paper silhouettes, warm backlight glowing through, delicate cut-paper textures",
  "Japanese ukiyo-e woodblock print come to life, flat bold colors, fine black outlines, patterned waves and clouds, washi paper texture",
  "1920s silent film, black and white, orthochromatic film grain, soft vignette, flickering projector light, theatrical staging",
  "hand-drawn Japanese animated film, soft cel shading, lush painted backgrounds, warm afternoon light, gentle wind in the grass",
  // The art style, not a window: "stained glass window come to life" put literal church windows into an orchard.
  "stained-glass art style: every shape, figure and sky built from jewel-toned glass pieces with dark lead lines, light glowing through the colours, the scene itself outdoors or wherever the story is",
  "linocut print in two inks, deep indigo and warm vermilion on cream paper, bold carved lines, hand-printed texture",
  "charcoal and white chalk drawing on toned grey paper, smudged soft edges, expressive strokes, quiet and contemplative",
  // Not "patterned borders": Qwen-Image 2.1 painted the page's border round every frame.
  "Persian miniature painting style, flat perspective, lapis blue and gold leaf, delicate patterned detail within the scene itself",
  "gouache children's picture book illustration, soft pastel colors, rounded shapes, cozy hand-painted textures",
  "low-poly 3D diorama, soft studio lighting, matte pastel materials, a miniature world under glass",
  "moody film noir, high-contrast black and white, hard shadows, rain-slick streets, light through venetian blinds",
  "nature documentary cinematography, telephoto lens, golden hour backlight, crisp natural detail, shallow depth of field",
];
// No photoreal "cinematic photograph" of people: Wan 5B keeps painted, inked
// and clay characters steady, while photoreal faces are where it morphs. The
// documentary look is for animals and landscapes only (its format's own).

/** Looks kept for their own formats. */
const LOOK_ONLY: Record<number, FormatId[]> = { 7: ["silent"], 15: ["silent", "thought"], 16: ["documentary"] };

/** The format's own looks most of the time, else the look used least lately. */
export function pickLook(recentLooks: string[], format: FormatId, rand = Math.random): string {
  const allowed = LOOKS.map((l, i) => i).filter((i) => !LOOK_ONLY[i] || LOOK_ONLY[i].includes(format));
  const own = FORMATS[format].looks?.filter((i) => allowed.includes(i));
  const pool = own?.length && (rand() < 0.65 || LOOK_ONLY[own[0]]) ? own : allowed;
  const window = recentLooks.slice(0, 12);
  const count = (i: number) => window.filter((l) => l.toLowerCase().startsWith(LOOKS[i].toLowerCase().slice(0, 24))).length;
  const least = Math.min(...pool.map(count));
  const best = pool.filter((i) => count(i) === least);
  return LOOKS[best[Math.floor(rand() * best.length)]];
}

// ── the screenplay ──────────────────────────────────────────────────────────

export type StoryShot = {
  /** Heard (or, in a silent film, shown) over this shot: one sentence. */
  narration: string;
  /** Who says it: "Narrator" or a character's name. */
  speaker?: string;
  /** What the still shows, with every character in frame written out in full. */
  picture: string;
  /** What moves during the 5-second clip, and how the camera moves. */
  motion: string;
  /** The characters in frame (their names). */
  cast?: string[];
};

export type StoryCharacter = {
  name: string;
  look: string;
  kind?: "human" | "animal" | "creature" | "object";
  gender?: "female" | "male" | "none";
  age?: "child" | "young" | "adult" | "old";
  /** The character drawn once (file under the video root), referenced by every shot they are in. */
  sheet?: string;
};

/** The technology a film is made with — chosen per film, credited at its end. See stack.ts. */
export type StoryStack = {
  pickedAt: string;
  video: { key: string; label: string; videoModel: string; tier: "low" | "high"; steps?: number };
  /** The model that draws the first frames (and the character sheets). */
  pictures?: string;
  /** Who reads each speaker's lines ("Narrator" and characters); none for a silent film. */
  voices?: Record<string, { key: string; engine: "chatterbox" | "kokoro"; voice: string; label: string }>;
  /** The lead voice: the option this film tries. */
  voice?: { key: string; label: string };
  score: { key: string; label: string; style?: string };
  finish: { key: "lanczos" | "esrgan"; label: string };
  /** Set when the video model could not get memory and the film moved to another. */
  fallback?: string;
};

export type Story = {
  id: string;
  createdAt: string;
  seed: string;
  kind: StoryKind;
  format?: FormatId;
  title: string;
  logline: string;
  lesson: string;
  /** One visual style shared by every shot. */
  look: string;
  /** A music brief for the score. */
  score: string;
  characters: StoryCharacter[];
  shots: StoryShot[];
  model: string;
  latencyMs: number;
  /** The writer's own problems, fixed or noted, and the continuity pass's fixes. */
  notes: string[];
  stack?: StoryStack;
  /** The viewer test: how clearly a first-time viewer follows the lines, before and after the editor. */
  clarity?: { score: number; summary: string; before?: number; edits?: string[] };
};

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    logline: { type: "string" },
    lesson: { type: "string" },
    look: { type: "string" },
    score: { type: "string" },
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          look: { type: "string" },
          kind: { type: "string", enum: ["human", "animal", "creature", "object"] },
          gender: { type: "string", enum: ["female", "male", "none"] },
          age: { type: "string", enum: ["child", "young", "adult", "old"] },
        },
        required: ["name", "look", "kind", "gender", "age"],
      },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          narration: { type: "string" },
          speaker: { type: "string" },
          picture: { type: "string" },
          motion: { type: "string" },
          cast: { type: "array", items: { type: "string" } },
        },
        required: ["narration", "speaker", "picture", "motion", "cast"],
      },
    },
  },
  required: ["title", "logline", "lesson", "look", "score", "characters", "shots"],
};

export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const PICTURE_RULES = [
  "- \"picture\": the still image, written as an image-generation prompt of 30 to 60 words: the subject, the setting, the light, the time of day, and the framing (wide establishing shot, medium shot, close-up of hands or an object, over-the-shoulder, silhouette against the sky…).",
  "  The model drawing it sees ONLY this one picture — not the story, not the other shots. So every character in the frame is written as their name in curly braces, {Mira} or {Frog}, and the system pastes in their full look. Never write a character any other way in a picture: not 'two figures', not 'they', not 'the pair', not 'a person', not 'silhouettes' — {Frog} and {Scorpion} sink into the dark water. Name the place and the time of day again in every picture.",
  "- \"cast\": the names of the characters visible in this shot, exactly as in \"characters\" ([] if none).",
  "- \"motion\": what moves during the clip and how the camera moves, 10 to 25 words (e.g. \"slow push-in; wind ripples the grass, the old man's robe stirs, clouds drift\"). Motion should be gentle and physical — wind, water, light, a slow turn of the head, walking away, a hand opening. No fast action, no fighting, no crowds running.",
];

function prompt(seed: StorySeed, format: StoryFormat, shots: number, look: string): string {
  const minutes = Math.round(((shots * 5.6) / 60) * 4) / 4;
  return [
    `You are the writer and director of a short film — about ${minutes} minute${minutes === 1 ? "" : "s"} long — made entirely by AI: each shot is first drawn as a still image, then animated into a 5-second clip. ${format.voiced ? "One line is heard over each shot." : "Nobody speaks: each line is shown on screen as a title card."} Think like a filmmaker: a real story with a beginning, a turn and an ending, told with images.`,
    "",
    `The form: ${format.label.toLowerCase()}. Every line follows it.`,
    "",
    `The story: ${seed.premise}`,
    seed.kind === "original"
      ? "Make it your own: invent the details, the setting and the small moments that make it feel like a real film."
      : seed.kind === "thought"
        ? "Make the idea visible: one concrete situation the viewer can picture, shot by shot."
        : "Retell it in your own words, with vivid concrete details; you may set it in any fitting time and place.",
    "",
    `Write exactly ${shots} shots. For each shot:`,
    `- "narration": ${format.line}`,
    '- "speaker": who says the line (see above).',
    ...PICTURE_RULES,
    "",
    "Clarity comes first. The viewer sees this film once, with no other context, and must be able to say afterwards who it was about, what they wanted, what happened and what it meant:",
    "- Shot 1 names the main character and where they are; by shot 3 the viewer knows what they want or what is wrong.",
    "- Every line follows from the one before (then, so, but, until). Say it when time passes or the place changes.",
    "- One idea per line, in plain words a ten-year-old understands: concrete actions and objects, not abstractions. Use a metaphor only when its meaning is obvious.",
    "- A small cast — one or two main characters, three at most — each called by the same name every time, and introduced before they matter.",
    "- A turn the viewer can see, about two thirds of the way in, then the ending that comes from it.",
    "- The last line makes the meaning clear in plain words, without preaching.",
    "- Each picture shows exactly what its line says, so the eyes and the ears tell the same story.",
    "",
    "Then make it beautiful, like a master storyteller:",
    "- Concrete, sensory images (the cold of the river, the smell of cedar smoke, the weight of a stone) and varied rhythm: some lines short, some longer.",
    "- One small surprising detail the viewer will remember.",
    "- Never use these tired words: tapestry, testament, whisper(ed) of, heart of, journey, embrace, profound, realm, delve, symphony, dance of, vibrant, beacon.",
    "",
    "Rules that make the film look good:",
    "- Vary the framing like a real film: open wide, then move closer; mix landscapes, medium shots, details (hands, objects, eyes, footprints) and silhouettes. At most a third of shots are close-ups of faces.",
    "- Keep each character visually simple and distinctive so they can be drawn the same way every time; animals and silhouettes animate beautifully.",
    "- A character who is not a person must never become one: a frog stays a frog in every shot, even when it talks.",
    "- No text, letters, signs, books with readable pages, logos or screens in any picture.",
    "- Nothing gory, violent or frightening; it is a gentle film for all ages.",
    "",
    `"look": the visual style for every shot. Use this one, adapting the wording to the story if it helps: "${look}".`,
    '"score": a music brief for the soundtrack, 10 to 20 words, instruments and mood (e.g. "solo cello and soft piano, slow, tender, a gentle swell at the end"). Instrumental only.',
    '"title": the film\'s title, 1 to 5 words, evocative, no colon. "logline": one sentence that makes someone want to watch it. "lesson": the lesson in one short sentence (max 14 words).',
    '"characters": every character who appears or speaks: "name" (one word, as used in {braces}), "look" — their FULL visual description, the exact words pasted into every picture they are in (species or age, build, hair or fur, clothing and colours, one distinctive object) — "kind" (human, animal, creature or object), "gender" (female, male or none) and "age". An empty list if the story has none.',
    "",
    "Reply with JSON only.",
  ].join("\n");
}

/**
 * The viewer test: the writer reads the film as a first-time viewer would —
 * only the lines, in order, nothing of the plan behind them — and says what
 * it understood, how clearly, and where it stumbled. (The owner, 5 Oct: the
 * films must be understandable to whoever watches them.)
 */
function viewerPrompt(raw: Record<string, unknown>, format: StoryFormat): string {
  const shots = (Array.isArray(raw.shots) ? raw.shots : []) as Record<string, unknown>[];
  return [
    `You are watching a short film (${format.label.toLowerCase()}) for the first time, once, with no other information. ${format.voiced ? "You hear one line over each 5-second shot" : "One title card is shown over each 5-second shot"}, and the picture shows what the line says. These are all the lines, in order:`,
    "",
    `Title: ${String(raw.title ?? "")}`,
    ...shots.map((x, i) => `${i + 1}. ${x.speaker && x.speaker !== "Narrator" ? `${String(x.speaker)}: ` : ""}${String(x.narration)}`),
    "",
    'Reply with JSON: "summary" — in two plain sentences, who it is about, what happens and what it means, as you understood it from the lines alone; "score" — 1 to 5, how easily a first-time viewer follows it (5: a child could retell it; 4: clear, one small doubt; 3: the gist, but some lines puzzle; 2: hard to follow; 1: lost); "confusing" — every line a first-time viewer would stumble on (a name never introduced, a jump in time or place, a metaphor whose meaning is unclear, a "he" or "it" with no clear owner, an event that comes from nowhere), each with "shot" (its number) and "why". An empty list if none.',
  ].join("\n");
}

const VIEWER_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    score: { type: "integer" },
    confusing: { type: "array", items: { type: "object", properties: { shot: { type: "integer" }, why: { type: "string" } }, required: ["shot", "why"] } },
  },
  required: ["summary", "score", "confusing"],
};

export type ViewerTest = { summary: string; score: number; confusing: { shot: number; why: string }[] };

/** A viewer test's reply, or null when it is unusable. */
export function readViewerTest(reply: unknown, shots: number): ViewerTest | null {
  const r = reply as { summary?: unknown; score?: unknown; confusing?: unknown } | null;
  const score = Math.round(Number(r?.score));
  if (!r || !Number.isFinite(score)) return null;
  const confusing = (Array.isArray(r.confusing) ? r.confusing : [])
    .map((c) => ({ shot: Math.round(Number((c as { shot?: unknown }).shot)), why: clean((c as { why?: unknown }).why, 200) }))
    .filter((c) => c.shot >= 1 && c.shot <= shots && c.why);
  return { summary: clean(r.summary, 400), score: Math.max(1, Math.min(5, score)), confusing };
}

/** The editor: rewrites the lines the viewer stumbled on, aiming at what the story means to say. */
function editorPrompt(raw: Record<string, unknown>, format: StoryFormat, test: ViewerTest): string {
  const shots = (Array.isArray(raw.shots) ? raw.shots : []) as Record<string, unknown>[];
  return [
    `You are the script editor of a short film (${format.label.toLowerCase()}). A first-time viewer, who heard only the lines, scored how clearly they could follow it ${test.score}/5 and understood: "${test.summary}"`,
    "",
    `What the film means to say: ${String(raw.logline ?? "")} The lesson: ${String(raw.lesson ?? "")}`,
    "",
    "Where the viewer stumbled:",
    ...(test.confusing.length ? test.confusing.map((c) => `- line ${c.shot}: ${c.why}`) : ["- (no single line; the whole was hard to follow)"]),
    "",
    "The lines:",
    ...shots.map((x, i) => `${i + 1}. [${String(x.speaker ?? "Narrator")}] ${String(x.narration)}`),
    "",
    `Rewrite the lines so a first-time viewer understands who it is about, what happens and what it means. Fix every line the viewer stumbled on, and any other line that needs it for the story to follow; leave clear lines exactly as they are. Keep the form — ${format.label.toLowerCase()}: ${format.line.split(".")[0]}. Keep each line's speaker, its shot (the picture shows that moment), about the same length, and the story's events and ending. Plain, concrete words; introduce a name before using it; no riddles.`,
    "",
    'Reply with JSON: "shots", one entry per line in order, each with "narration" (the new line, or the same one) and "fix" (what you changed, in a few words, or "").',
  ].join("\n");
}

const EDITOR_SCHEMA = {
  type: "object",
  properties: {
    shots: { type: "array", items: { type: "object", properties: { narration: { type: "string" }, fix: { type: "string" } }, required: ["narration", "fix"] } },
  },
  required: ["shots"],
};

/** The editor's lines over the writer's: only lines that came back usable replace the old ones. */
export function applyEdits(raw: Record<string, unknown>, reply: unknown): { raw: Record<string, unknown>; fixes: string[] } {
  const shots = Array.isArray(raw.shots) ? (raw.shots as Record<string, unknown>[]) : [];
  const edited = (reply as { shots?: { narration?: unknown; fix?: unknown }[] })?.shots;
  if (!Array.isArray(edited) || edited.length !== shots.length) return { raw, fixes: [] };
  const fixes: string[] = [];
  const next = shots.map((x, i) => {
    const narration = clean(edited[i]?.narration, 240);
    if (!narration || words(narration) < 2 || narration === clean(x.narration, 240)) return x;
    fixes.push(`line ${i + 1}: ${clean(edited[i]?.fix, 120) || "clearer"}`);
    return { ...x, narration };
  });
  return fixes.length ? { raw: { ...raw, shots: next }, fixes } : { raw, fixes };
}

/** The second read: a continuity supervisor checks every picture against the story. */
function continuityPrompt(raw: Record<string, unknown>, format: StoryFormat): string {
  const chars = (Array.isArray(raw.characters) ? raw.characters : []) as Record<string, unknown>[];
  const shots = (Array.isArray(raw.shots) ? raw.shots : []) as Record<string, unknown>[];
  return [
    `You are the continuity supervisor of a short AI film (${format.label.toLowerCase()}). Each shot's picture is drawn by an image model that sees ONLY that picture's text — nothing about the story, the characters or the other shots. A picture that says "the two figures drift down" gets two people, even if the story is about a frog and a scorpion.`,
    "",
    "The characters (written in pictures as {Name}; the system pastes in the look):",
    ...chars.map((c) => `- {${String(c.name)}} (${String(c.kind ?? "?")}): ${String(c.look)}`),
    "",
    "The shots:",
    ...shots.map((s, i) => `${i + 1}. line: ${String(s.narration)}\n   picture: ${String(s.picture)}`),
    "",
    "Check every shot and fix its picture where needed:",
    "- Every character the line is about, or who would be seen in this moment, is in the picture as {Name}. Replace every vague stand-in — figures, they, both, the pair, the two, someone, a person, a shape, silhouettes — with the {Name}s it means.",
    "- No person appears unless a human character is meant to be there; animals and objects stay what they are.",
    "- The place, the time of day, the weather and the season follow from the shots around it, and are named in the picture, since the model knows nothing else.",
    "- Keep the framing, the light and the style of the picture; change only what continuity needs. A picture that is already right is returned unchanged.",
    "",
    'Reply with JSON: "shots", one entry per shot in order, each with "picture" (the corrected picture, or the same one), "cast" (the names in frame) and "fix" (what you changed, in a few words, or "" if nothing).',
  ].join("\n");
}

const CONTINUITY_SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: { picture: { type: "string" }, cast: { type: "array", items: { type: "string" } }, fix: { type: "string" } },
        required: ["picture", "cast", "fix"],
      },
    },
  },
  required: ["shots"],
};

async function askOllama(model: string, text: string, timeoutMs: number, format: object = SCHEMA): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      // Unload right after: the card is needed for the stills and clips.
      keep_alive: 0,
      format,
      options: { temperature: format === SCHEMA ? 0.85 : 0.2, top_p: 0.95, num_ctx: 8192, num_predict: 4000 },
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Words that stand in for characters without saying who they are. */
const VAGUE = /\b(figures?|the pair|the two|both of them|someone|a person|two shapes|silhouettes of (two|the))\b/i;
const PLURAL = /\b(they|both|together|the two|each other|their)\b/i;

/**
 * Write every character in frame out in full: {Name} becomes their look (the
 * first time; "the frog" after), a bare capitalised name does too, a cast
 * member the picture leaves out is put in front, and a vague stand-in with no
 * one named ("the two figures sank") gets the characters the line is about.
 */
export function castPicture(picture: string, cast: string[], characters: StoryCharacter[], context: { narration: string; previousCast?: string[] }): { picture: string; cast: string[] } {
  const byName = new Map(characters.map((c) => [c.name.toLowerCase(), c]));
  const inFrame = new Set<string>();
  for (const n of cast) if (byName.has(n.toLowerCase())) inFrame.add(byName.get(n.toLowerCase())!.name);
  const short = (c: StoryCharacter) => (c.look.toLowerCase().includes(c.name.toLowerCase()) ? `the ${c.name.toLowerCase()}` : c.look.split(/\s+/).slice(0, 6).join(" "));
  const pasted = new Set<string>();
  let out = picture.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    const c = byName.get(raw.trim().toLowerCase());
    if (!c) return raw.trim();
    inFrame.add(c.name);
    if (pasted.has(c.name)) return short(c);
    pasted.add(c.name);
    return c.look;
  });
  // A writer sometimes names a character instead of describing them; a name
  // means nothing to the image model. Only a capitalised name is replaced, and
  // only when the look is not already there ("Frog" vs "a green frog").
  for (const c of characters) {
    if (out.toLowerCase().includes(c.look.toLowerCase().slice(0, 30))) {
      inFrame.add(c.name);
      continue;
    }
    const re = new RegExp(`\\b${escapeRe(c.name)}\\b`);
    if (re.test(out)) {
      out = out.replace(re, c.look);
      inFrame.add(c.name);
    }
  }
  // "They both sank slowly" over "the two figures drift downward": nobody named.
  if (VAGUE.test(out) && ![...inFrame].length && characters.length) {
    const said = characters.filter((c) => new RegExp(`\\b${escapeRe(c.name)}\\b`, "i").test(context.narration)).map((c) => c.name);
    const guess = said.length ? said : PLURAL.test(context.narration) && characters.length <= 3 ? characters.map((c) => c.name) : (context.previousCast ?? []);
    for (const n of guess) inFrame.add(n);
  }
  const missing = [...inFrame].map((n) => byName.get(n.toLowerCase())!).filter((c) => c && !out.toLowerCase().includes(c.look.toLowerCase().slice(0, 30)));
  if (missing.length) out = `${missing.map((c) => c.look).join(" and ")}. ${out}`;
  return { picture: out, cast: [...inFrame] };
}

/** Check and tidy what the writer returned; throws when it is not a usable film. */
export function shapeStory(raw: unknown, want: number, format?: FormatId): Omit<Story, "id" | "createdAt" | "seed" | "kind" | "model" | "latencyMs"> {
  const j = (raw ?? {}) as Record<string, unknown>;
  const notes: string[] = [];
  const characters: StoryCharacter[] = (Array.isArray(j.characters) ? (j.characters as Record<string, unknown>[]) : [])
    .map((c) => ({
      name: clean(c.name, 40).replace(/[{}]/g, ""),
      look: clean(c.look, 300),
      ...(["human", "animal", "creature", "object"].includes(String(c.kind)) ? { kind: c.kind as StoryCharacter["kind"] } : {}),
      ...(["female", "male", "none"].includes(String(c.gender)) ? { gender: c.gender as StoryCharacter["gender"] } : {}),
      // The look wins over the age field: the writer called "a six year old boy" adult and "an elderly man" young.
      ...(() => {
        const look = String(c.look ?? "").toLowerCase();
        if (String(c.kind) === "human" && /\b(boy|girl|child|kid|toddler|baby|[1-9]|1[0-2]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ]?(year[- ]old)?\b/.test(look) && /\b(boy|girl|child|kid|toddler|baby|year[- ]old)\b/.test(look) && !/\b(old man|old woman|elderly|grand(father|mother))\b/.test(look))
          return { age: "child" as const };
        if (/\b(elderly|old man|old woman|aged|grey-haired|white-haired|wrinkled)\b/.test(look)) return { age: "old" as const };
        return ["child", "young", "adult", "old"].includes(String(c.age)) ? { age: c.age as StoryCharacter["age"] } : {};
      })(),
    }))
    .filter((c) => c.name && c.look)
    .slice(0, 4);
  const shotsIn = Array.isArray(j.shots) ? (j.shots as Record<string, unknown>[]) : [];
  const shots: StoryShot[] = [];
  for (const s of shotsIn) {
    // {Name} tags are for the pictures only: a poem's line kept them, and they were subtitled.
    let narration = clean(s.narration, 240).replace(/[{}]/g, "").replace(/\s*\.\.\.$/, ".");
    const draft = clean(s.picture, 700);
    const motion = clean(s.motion, 300);
    if (!narration || !draft) continue;
    if (words(narration) > 20) {
      // A line longer than the shot spills into the next one; cut it at a clause.
      const cut = narration.split(/(?<=[,;:—])\s+/);
      let out = "";
      for (const part of cut) if (words(out + " " + part) <= 18) out = `${out} ${part}`.trim();
      narration = (out || narration.split(/\s+/).slice(0, 16).join(" ")).replace(/[,;:—]$/, ".");
      notes.push(`shortened a long narration line to "${narration}"`);
    }
    // A poem's line may end on a comma or a dash; anything else ends a sentence.
    // ("spin," became "spin,." on screen in the first poem.)
    if (/[,;:—–-]$/.test(narration)) narration = format === "verse" ? narration : narration.replace(/[\s,;:—–-]+$/, ".");
    else if (!/[.!?…]$/.test(narration)) narration += ".";
    const speakerIn = clean(s.speaker, 40).replace(/[{}]/g, "");
    const speaker = characters.find((c) => c.name.toLowerCase() === speakerIn.toLowerCase())?.name ?? "Narrator";
    const cast = Array.isArray(s.cast) ? (s.cast as unknown[]).map((x) => clean(x, 40).replace(/[{}]/g, "")) : [];
    const placed = castPicture(draft, cast, characters, { narration, previousCast: shots[shots.length - 1]?.cast });
    if (VAGUE.test(draft) && !/\{/.test(draft) && placed.cast.length) notes.push(`shot ${shots.length + 1}: "${draft.match(VAGUE)![0]}" written out as ${placed.cast.join(" and ")}`);
    shots.push({ narration, speaker, picture: placed.picture, motion: motion || "slow cinematic push-in, gentle natural movement", cast: placed.cast });
  }
  if (shots.length < Math.min(7, want)) throw new Error(`the writer gave ${shots.length} usable shots, need at least ${Math.min(7, want)}`);
  const title = clean(j.title, 60).replace(/[.:]$/, "");
  if (!title) throw new Error("the writer gave no title");
  return {
    title,
    logline: clean(j.logline, 240),
    lesson: clean(j.lesson, 140).replace(/\.$/, "") + (/\?$/.test(clean(j.lesson, 140)) ? "" : "."),
    look: clean(j.look, 300),
    score: clean(j.score, 200) || "solo piano and soft strings, slow, tender, cinematic",
    characters,
    shots: shots.slice(0, want + 2),
    notes,
  };
}

/**
 * The continuity pass over the writer's raw reply: the same model reads the
 * whole shot list and fixes pictures that lose who is in them. Returns the
 * raw reply with the pictures replaced, and what it changed.
 */
export function applyContinuity(raw: Record<string, unknown>, reply: unknown): { raw: Record<string, unknown>; fixes: string[] } {
  const shots = Array.isArray(raw.shots) ? (raw.shots as Record<string, unknown>[]) : [];
  const fixed = (reply as { shots?: { picture?: unknown; cast?: unknown; fix?: unknown }[] })?.shots;
  if (!Array.isArray(fixed) || fixed.length !== shots.length) return { raw, fixes: [] };
  const fixes: string[] = [];
  const next = shots.map((s, i) => {
    const f = fixed[i];
    const picture = clean(f?.picture, 700);
    if (!picture || words(picture) < 8) return s;
    const fix = clean(f?.fix, 160);
    if (fix && picture !== clean(s.picture, 700)) fixes.push(`shot ${i + 1}: ${fix}`);
    return { ...s, picture, cast: Array.isArray(f?.cast) ? f.cast : s.cast };
  });
  return { raw: { ...raw, shots: next }, fixes };
}

/** Write one story, then have it read for continuity. Tries the large writer, then the small one. */
export async function writeStory(opts: { seed: StorySeed; shots: number; look?: string; format?: FormatId }): Promise<Story> {
  const format = FORMATS[opts.format ?? "tale"];
  const look = opts.look ?? LOOKS[Math.floor(Math.random() * LOOKS.length)];
  const text = prompt(opts.seed, format, opts.shots, look);
  const problems: string[] = [];
  for (const model of [STORY_MODEL, STORY_FALLBACK_MODEL]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        const reply = await askOllama(model, text, 8 * 60_000);
        const m = /\{[\s\S]*\}/.exec(reply);
        if (!m) throw new Error("no JSON in the reply");
        let raw = JSON.parse(m[0]) as Record<string, unknown>;
        let shaped = shapeStory(raw, opts.shots, format.id);
        const notes: string[] = [];
        // The viewer test reads the shaped lines (what will be heard), and the editor's lines are shaped again.
        let clarity: Story["clarity"];
        try {
          const v0 = Date.now();
          const ask = async (r: Record<string, unknown>) => readViewerTest(JSON.parse(/\{[\s\S]*\}/.exec(await askOllama(model, viewerPrompt(r, format), 4 * 60_000, VIEWER_SCHEMA))?.[0] ?? "null"), opts.shots);
          const asShaped = (r: Record<string, unknown>) => ({ ...r, shots: shapeStory(r, opts.shots, format.id).shots });
          const first = await ask(asShaped(raw));
          if (first) {
            clarity = { score: first.score, summary: first.summary };
            if (first.score < 5 || first.confusing.length) {
              const reply = await askOllama(model, editorPrompt(asShaped(raw), format, first), 5 * 60_000, EDITOR_SCHEMA);
              const em = /\{[\s\S]*\}/.exec(reply);
              const { raw: edited, fixes } = applyEdits(asShaped(raw), em ? JSON.parse(em[0]) : null);
              if (fixes.length) {
                const again = await ask(edited);
                // The editor's lines are kept unless the viewer follows them less well.
                if (!again || again.score >= first.score) {
                  raw = edited;
                  shaped = shapeStory(raw, opts.shots, format.id);
                  clarity = { score: again?.score ?? first.score, summary: again?.summary ?? first.summary, before: first.score, edits: fixes };
                }
              }
            }
            notes.push(
              clarity?.edits
                ? `Viewer test (${Math.round((Date.now() - v0) / 1000)} s): ${clarity.before}/5, so the editor rewrote ${clarity.edits.length} line${clarity.edits.length > 1 ? "s" : ""} (${clarity.edits.join("; ")}); now ${clarity.score}/5 — "${clarity.summary}"`
                : `Viewer test (${Math.round((Date.now() - v0) / 1000)} s): ${first.score}/5 — "${first.summary}"${first.confusing.length ? `; still unclear: ${first.confusing.map((c) => `line ${c.shot} (${c.why})`).join("; ")}` : ""}`,
            );
          }
        } catch (err) {
          notes.push(`Viewer test skipped: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        }
        try {
          const c0 = Date.now();
          const fixReply = await askOllama(model, continuityPrompt(raw, format), 6 * 60_000, CONTINUITY_SCHEMA);
          const cm = /\{[\s\S]*\}/.exec(fixReply);
          const { raw: revised, fixes } = applyContinuity(raw, cm ? JSON.parse(cm[0]) : null);
          const reshaped = shapeStory(revised, opts.shots, format.id);
          raw = revised;
          shaped = reshaped;
          notes.push(fixes.length ? `Continuity pass (${Math.round((Date.now() - c0) / 1000)} s) fixed ${fixes.length} picture${fixes.length > 1 ? "s" : ""}: ${fixes.join("; ")}` : `Continuity pass (${Math.round((Date.now() - c0) / 1000)} s): every picture already right`);
        } catch (err) {
          notes.push(`Continuity pass skipped: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        }
        return {
          id: `story-${Date.now().toString(36)}`,
          createdAt: new Date().toISOString(),
          seed: opts.seed.id,
          kind: opts.seed.kind,
          format: format.id,
          ...shaped,
          look: shaped.look || look,
          model,
          latencyMs: Date.now() - t0,
          notes: [...problems, ...shaped.notes, ...notes],
          ...(clarity ? { clarity } : {}),
        };
      } catch (err) {
        problems.push(`${model} try ${attempt}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240));
      }
    }
  }
  throw new Error(problems.join("; "));
}

/** The still prompt for one shot: the picture plus the film's look. */
export function shotStillPrompt(story: Pick<Story, "look">, shot: Pick<StoryShot, "picture">): string {
  const look = story.look.replace(/\.$/, "");
  return shot.picture.toLowerCase().includes(look.toLowerCase().slice(0, 40)) ? shot.picture : `${shot.picture} ${look}.`;
}

// The film shows a 2.39:1 strip of this 16:9 frame: a face near the top was cut at the eyes
// (The Golden Hour Loop, The First Bloom), so heads sit in the middle band.
export const STORY_STILL_SUFFIX = "Cinematic composition, beautiful light, highly detailed, no text, no lettering, no signs, no logos, no watermark. A full-bleed picture that fills the whole frame edge to edge: no border, no ornamental frame, no margin. Framed for a wide cinema strip: every face and head in the middle band of the frame with clear space above the heads, nothing important near the top or bottom edge.";

export const STORY_AVOID =
  "text, letters, words, subtitles, watermark, logo, border, ornamental frame, deformed hands, extra fingers, distorted face, morphing, melting, flicker, jump cut, crowd running, blurry";

/** Does the story have a person in it? Old stories (no kinds) are assumed to. */
export const storyHasHumans = (characters: StoryCharacter[]) => !characters.length ? false : characters.some((c) => !c.kind || c.kind === "human");
