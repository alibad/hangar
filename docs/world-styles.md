# Twelve ways to explore your projects

Open **World**, then the world-style button beside **Size**. Select a preview to
change the scene immediately; **Explore** closes the chooser. The arrow buttons
step between worlds. Escape closes it and returns focus to the style button.
The colour-theme menu also offers a compact world-style selector.

![The twelve worlds, captured from the renderer with fictional projects](../public/world-styles/overview.webp)

| World | Projects appear as | Family setting |
| --- | --- | --- |
| Buildings | Lots, houses and towers | Original floating islands |
| Airplanes | Gliders through airliners | Original floating islands |
| Galaxy | Banded planets, rings and moons | Orbital rings and star dust |
| Forest | Branches and broad canopies | Woodland clearings |
| Ocean reef | Branching coral with bright tips | Sand, rocks and water rings |
| Mountains | Faceted snowy peaks | Contour terraces |
| Space fleet | Starships with paired engines | Orbital formations |
| Garden | Leaves, buds and blossoms | Circular planting beds |
| Constellation | Stars with rays and satellites | Family constellation lines |
| Mechanical | Stacked gears and wheels | Brass-marked turntables |
| Neural network | Branching node clusters | Family webs |
| Museum | Rings, crystals and layered sculptures | Plinths in open galleries |

These are different representations of the same catalog. The **Size** switch
uses commits or GitHub repository size. Size and complexity express those facts,
not completion, quality, business value or approval. A project without an
observed commit count keeps the existing repository-size fallback. Activity,
attention, local availability, websites, actual coding jobs and running app ports
keep their existing layer meanings. Connections in the constellation and neural
views mean shared island/family membership; they do not claim dependencies or
communication between repositories.

Switching worlds preserves project coordinates, family anchors, camera, selection,
search filters and arrival replay. The choice is saved in this browser, using the
existing `bt-world-style` preference. The standalone viewer has the same options
in its header and accepts `?style=forest` (or any registered world ID). Unknown
saved values fall back to buildings. No service setting or project file changes
when a world is selected.

Geometry is procedural and stays local. Small pieces are merged by material into
two to five meshes per new project form; replaced geometry and materials are
disposed. Forms fit the existing seven-unit plots. Space views hide the original
terrain, waterfalls and birds; ground views replace the terrain with their own
surfaces. Day/night, lighter graphics and reduced motion remain available.

## Local verification

No GitHub Actions are needed. With dependencies installed:

```sh
npm run test:world
npx tsc --noEmit
python3 engine/selftest.py
HANGAR_BUILD_DIR=var/world-build npm run build
```

For the browser check, start that build on an unused port (the normal console
can keep running):

```sh
HANGAR_BUILD_DIR=var/world-build npx next start -H 127.0.0.1 -p 8017
```

In another terminal, point at installed Playwright Core and Chrome/Chromium if
they are not already discoverable:

```sh
export PLAYWRIGHT_CORE=/absolute/path/to/playwright-core/index.mjs
export CHROMIUM=/absolute/path/to/chrome
HANGAR_URL=http://127.0.0.1:8017 npm run check:world
HANGAR_URL=http://127.0.0.1:8017 node scripts/check-world-scale.mjs
```

The browser check intercepts the world data with nine fictional projects and
rejects service writes. It exercises all twelve chooser options, real mesh
picking, selection, camera retention, filters, work markers, replay, catalog
refresh, persistence, focus return, and 1440/390/320-pixel layouts. The scale check also exercises 210 projects across seven families and checks GPU
resource counts over 30 world changes. Private QA
screenshots go under ignored `var/world-style-qa/`.

`HANGAR_URL=http://127.0.0.1:8017 npm run capture:world` regenerates the committed
chooser thumbnails and overview from the same renderer and fictional catalog.
Those previews use a fixed camera (framed higher for tall buildings), daylight
and medium graphics, with labels and
the host's navigation portal hidden to make the project forms easier to compare.
No real project names, session data or machine configuration enter these assets.
