# Hangar identity

**Foundry Island is the selected primary identity.** The blue faceted floating
island forms an H around a warm doorway. Keep its irregular rocky silhouette,
navy shadow faces, blue surface texture, perspective and doorway proportions.
It connects the brand to Atlas's island world. The open-portal and folded-H
explorations are superseded; do not mix them into the primary identity.

- Cobalt `#174BFF`: primary UI actions; the artwork retains its original blue shades.
- Basalt `#171B24`: structure and dark surfaces.
- Warm light `#FFB85C` to `#FFE4AA`: the doorway, with restrained glow.
- Light UI accents use darker cobalt; dark UI accents use lighter cobalt for contrast.
- Status colors keep separate meanings and always have text or shape labels.
- Preserve the selected colors. Do not recolor the island or redesign its interior.

## Assets

- `public/brand/foundry-island-master.png`: the unmodified selected presentation,
  including the HANGAR wordmark. This is the visual reference, not an app icon.
- `public/brand/foundry.png`: a transparent island-only cutout for the app.
- `public/icons/icon-{32,64,192,512}.png`: generated icons for browser and installation.
- `public/icons/icon.svg`: compatibility wrapper embedding the raster icon; it is
  not a vector recreation. The favicon and manifest use the PNG exports directly.

Run `node scripts/build-brand.mjs` to rebuild the icons. The header uses the mark
at 32px beside accessible text. Small favicons retain the silhouette and doorway;
do not add the presentation's wordmark or small secondary emblem at those sizes.

The master was created with the built-in image generator and selected from the
Foundry Island exploration. The same tool prepared the cutout. Prompt direction:
extract only the large island, remove the background and presentation text, keep
the existing shape, facets, blue colors and warm doorway; no redesign. The master
remains unchanged. No session data, machine configuration or private screenshots
are included in these assets.
