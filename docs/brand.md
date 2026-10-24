# Hangar identity

The open portal is the primary mark: two cobalt doors and a warm diamond between
them. The floating foundry is a supporting illustration for the world entrance.
Keep the portal's empty space open and its silhouette legible at small sizes.

- Cobalt `#174BFF`: identity and primary actions.
- Basalt `#171B24`: structure and dark surfaces.
- Warm light `#FFB85C` to `#FFE4AA`: the doorway, with restrained glow.
- Light UI accents use darker cobalt; dark UI accents use lighter cobalt for contrast.
- Status colors keep separate meanings and always have text or shape labels.
- Do not introduce terracotta surfaces or color every project by provider.

`public/brand/portal.svg` is the scalable production mark. `public/brand/foundry.png`
is the supporting illustration. Rebuild installation icons with
`node scripts/build-brand.mjs` after editing the mark.

The reference imagery was produced with the built-in image generator, using the
selected portal and island images as edit targets. Prompt direction: preserve
silhouettes; cobalt faces; basalt shadows; warm light only at the central doorway;
no terracotta; transparent background; no text. The production vector simplifies
the portal for small sizes. No user session data or machine configuration is used.
