// Generates src/app/themes.css.
//
// The console was built with ~300 hardcoded Tailwind color classes spread over
// 14 hues, with no consistent meaning: primary actions were pink in the Qwen
// studio and indigo everywhere else, success was both green and emerald, and so
// on. Rather than rewrite every class, we remap Tailwind's own `--color-{hue}-
// {stop}` variables per theme and collapse the 14 hues onto four semantic ramps
// (accent / ok / warn / error) plus the neutrals. Tailwind v4 emits utilities as
// `var(--color-pink-600)`, so redefining those vars on `html[data-theme=…]`
// re-themes the whole app at runtime with no component changes.
//
// Run: node scripts/gen-themes.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "themes.css");

// Which Tailwind hue maps onto which semantic ramp. Every hue the codebase
// actually uses has to appear here or it would keep its stock Tailwind color
// and drift out of theme.
// The accent splits three ways. Collapsing all eight cool hues onto one hue made
// every primary action agree — the original point — but it also flattened the
// service-category badges (ai=violet, sky, emerald…), which had been relying on
// hue alone to tell categories apart. catA/catB are the same accent rotated a
// little, so categories stay distinguishable without leaving the theme's family.
const FAMILIES = {
  accent: ["indigo", "blue", "violet", "pink"],
  catA: ["purple", "fuchsia"],
  catB: ["sky", "cyan"],
  ok: ["green", "emerald", "teal", "lime"],
  warn: ["amber", "yellow", "orange"],
  err: ["red", "rose"],
};

/** Hue offset from the accent, in degrees, for the categorical ramps. */
const CAT_ROTATION = { catA: 32, catB: -32 };

// Lightness and chroma-multiplier per stop. Tuned for a dark-first UI: 400 is
// the workhorse for text, 500 for dots and tinted fills, 600 for solid buttons
// (dark enough that `text-white` on top still clears 4.5:1).
const STOPS = [
  [50, 0.97, 0.18], [100, 0.93, 0.35], [200, 0.87, 0.55], [300, 0.79, 0.8],
  [400, 0.71, 0.95], [500, 0.63, 1.0], [600, 0.55, 1.0], [700, 0.48, 0.92],
  [800, 0.41, 0.8], [900, 0.35, 0.68], [950, 0.25, 0.55],
];

// Offsets from the theme's darkest surface. 950 is the page canvas, 900 the
// card, 800/700 borders, 600-400 muted text, 100 body text.
const NEUTRAL_DARK = [
  [950, 0], [900, 0.04], [800, 0.09], [700, 0.15], [600, 0.28], [500, 0.36],
  [400, 0.46], [300, 0.58], [200, 0.7], [100, 0.8], [50, 0.86],
];

// Light mode inverts the scale so the dark-coded markup (`bg-gray-950` on body,
// `text-gray-100`) keeps reading correctly without touching a single class.
const NEUTRAL_LIGHT = [
  [950, 0.985], [900, 0.955], [800, 0.9], [700, 0.83], [600, 0.57], [500, 0.48],
  [400, 0.38], [300, 0.27], [200, 0.175], [100, 0.105], [50, 0.06],
];

// chroma / hue derived from each palette's source brand color.
const THEMES = [
  { id: "claude", accent: [0.131, 38.8], ok: [0.106, 142.8], warn: [0.127, 75.4], err: [0.143, 28.3], nu: [0.004, 84.6, 0.18] },
  { id: "betenshi", accent: [0.162, 272.3], ok: [0.153, 163.2], warn: [0.164, 84.4], err: [0.166, 22.2], nu: [0.023, 283.8, 0.14] },
  { id: "openai", accent: [0.124, 169.5], ok: [0.124, 169.5], warn: [0.155, 77.3], err: [0.21, 24.1], nu: [0.0, 0, 0.13] },
  { id: "gemini", accent: [0.18, 260.0], ok: [0.16, 148.5], warn: [0.17, 84.0], err: [0.206, 29.1], nu: [0.002, 286.2, 0.15] },
  // The only theme whose accent is LIGHTER than its surfaces. xAI's look is an
  // absence of accent colour, so a normal mid-grey ramp reads as a bug rather
  // than a choice. The curve runs near-white at the stops the UI actually uses
  // (400 for text, 600 for fills), and --on-accent goes dark to match.
  {
    id: "grok", accent: [0.007, 286.2], ok: [0.201, 151.5], warn: [0.171, 80.5], err: [0.232, 28.7], nu: [0.0, 0, 0.1],
    accentStops: [
      [50, 1.0, 0.1], [100, 0.995, 0.2], [200, 0.99, 0.3], [300, 0.975, 0.4],
      [400, 0.955, 0.5], [500, 0.93, 0.6], [600, 0.9, 0.7], [700, 0.78, 0.8],
      [800, 0.62, 0.9], [900, 0.45, 1.0], [950, 0.3, 1.0],
    ],
    onAccent: "oklch(0.14 0 0)",
  },
  { id: "mistral", accent: [0.197, 46.8], ok: [0.207, 128.8], warn: [0.183, 95.8], err: [0.217, 25.2], nu: [0.006, 80, 0.12] },
  { id: "stability", accent: [0.259, 322.1], ok: [0.146, 169.3], warn: [0.164, 84.4], err: [0.192, 23.6], nu: [0.014, 307.5, 0.13] },
  { id: "perplexity", accent: [0.119, 209.8], ok: [0.181, 145.6], warn: [0.14, 79.9], err: [0.175, 31.5], nu: [0.02, 195.6, 0.14] },
  { id: "huggingface", accent: [0.175, 92.6], ok: [0.142, 158.4], warn: [0.173, 66.6], err: [0.181, 22.8], nu: [0.009, 285.3, 0.12] },
  { id: "nvidia", accent: [0.194, 130.8], ok: [0.194, 130.8], warn: [0.172, 84.9], err: [0.219, 20.9], nu: [0.0, 0, 0.11] },
];

const r3 = (n) => Number(n.toFixed(3));

/**
 * One ramp definition, shared by every theme.
 *
 * @param role    the ramp name.
 * @param source  which theme variables drive it — defaults to the role's own.
 *                The categorical ramps borrow the accent's and rotate the hue.
 * @param stops   lightness/chroma table, so a theme can override the curve.
 */
function ramp(role, source = role, stops = STOPS) {
  const rot = CAT_ROTATION[role];
  const hue = rot ? `calc(var(--${source}-h) + ${rot})` : `var(--${source}-h)`;
  const lines = [];
  for (const [stop, l, m] of stops) {
    lines.push(`  --${role}-${stop}: oklch(${l} calc(var(--${source}-c) * ${m}) ${hue});`);
  }
  return lines.join("\n");
}

function aliases() {
  const lines = [];
  for (const [role, hues] of Object.entries(FAMILIES)) {
    for (const hue of hues) {
      for (const [stop] of STOPS) lines.push(`  --color-${hue}-${stop}: var(--${role}-${stop});`);
    }
  }
  return lines.join("\n");
}

function neutrals(scale, absolute) {
  return scale
    .map(([stop, v]) => {
      const l = absolute ? v : `calc(var(--nu-l) + ${r3(v)})`;
      return `  --color-gray-${stop}: oklch(${l} var(--nu-c) var(--nu-h));`;
    })
    .join("\n");
}

// Tailwind ships its palette on `:root`, so these overrides need to outrank it.
// `html:root` is one specificity point higher and beats it regardless of the
// order the stylesheets happen to land in.
const header = `/* GENERATED by scripts/gen-themes.mjs — do not edit by hand. */

/* Every Tailwind hue the app uses is aliased onto one of four semantic ramps.
   Themes only redeclare the chroma/hue pairs below; the ramps regenerate. */
html:root {
${ramp("accent")}
${ramp("catA", "accent")}
${ramp("catB", "accent")}
${ramp("ok")}
${ramp("warn")}
${ramp("err")}

  /* Foreground for text sitting ON an accent fill. A literal text-white can't
     work for every theme — Grok's accent is near-white — so accent-filled
     controls use .on-accent instead and this flips with the theme. */
  --on-accent: oklch(0.99 0 0);

${aliases()}
}

/* Dark is the default coding of the markup: gray-950 is the canvas, gray-100 the text. */
html:root {
${neutrals(NEUTRAL_DARK, false)}
}

/* Light mode flips the neutral scale so the same classes keep their meaning. */
html:root:not(.dark) {
${neutrals(NEUTRAL_LIGHT, true)}
}
`;

const blocks = THEMES.map((t) => {
  const [ac, ah] = t.accent, [okc, okh] = t.ok, [wc, wh] = t.warn, [ec, eh] = t.err;
  const [nc, nh, nl] = t.nu;

  // A theme with a light accent has to re-emit the accent ramp (and the two
  // categoricals derived from it) on its own curve, and flip --on-accent so the
  // text on a filled button stays readable.
  const inverted = t.accentStops
    ? `\n${ramp("accent", "accent", t.accentStops)}\n${ramp("catA", "accent", t.accentStops)}\n${ramp("catB", "accent", t.accentStops)}\n  --on-accent: ${t.onAccent};\n`
    : "";

  return `html:root[data-theme="${t.id}"] {
  --accent-c: ${ac};
  --accent-h: ${ah};
  --ok-c: ${okc};
  --ok-h: ${okh};
  --warn-c: ${wc};
  --warn-h: ${wh};
  --err-c: ${ec};
  --err-h: ${eh};
  --nu-c: ${nc};
  --nu-h: ${nh};
  --nu-l: ${nl};
${inverted}
  /* Keep the shadcn token layer pointed at the same accent so any component
     using --primary/--ring agrees with the raw Tailwind classes. */
  --primary: var(--accent-500);
  --primary-foreground: oklch(0.12 0 0);
  --ring: var(--accent-500);
  --destructive: var(--err-500);
}`;
}).join("\n\n");

writeFileSync(OUT, `${header}\n${blocks}\n`);
console.log(`wrote ${OUT} — ${THEMES.length} themes`);
