# BeTenshi Home cockpit — design QA

- Source visual truth: `C:\Users\Admin\.codex\generated_images\019fe1e7-9ef6-7103-8656-23e22e30d150\exec-4c6f8242-614a-45a0-a83b-02cf99ab8134.png`
- Implementation capture: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-home-1440x1024.png`
- Browser URL/state: `http://127.0.0.1:8003/#stack`, dark warm theme, Text workstream selected, prompt populated, Resource map expanded, Backstage collapsed
- CSS viewport: 1440 × 1024, device scale factor 1
- Source pixels: 1487 × 1058
- Implementation pixels: 1430 × 1017 (the in-app browser capture excludes its outer scrollbar/chrome pixels)
- Density normalization: both artifacts are approximately 1.406:1 and were compared fit-to-frame at the same application viewport and state. No device frame or browser chrome is present in either artifact.

## Full-view comparison evidence

The selected mock and implementation were opened together in the same comparison input at original detail. The implementation preserves the mock's five-part hierarchy: single-row global navigation; task-first multimodal composer plus a `Can it run?` verdict; compact workstream rows; live request rail; resource map and Backstage strip. The live implementation intentionally substitutes current machine telemetry and traffic for the mock's sample values.

## Focused-region evidence

A separate crop was not needed because the source and implementation are desktop-sized originals and all important dense regions were legible in the full comparison. The composer, workstream columns, request metadata, GPU/RAM lanes, status controls, and Backstage strip were also inspected through the browser DOM at the same state.

## Required fidelity surfaces

- Fonts and typography: Passed. The implementation uses the console's existing sans stack with a 14–16px product baseline, compact 10–12px operational metadata, strong 22–26px hero hierarchy, restrained weights, and matching line lengths. No clipped or broken text was observed.
- Spacing and layout rhythm: Passed. Page margins, 12px section gaps, two-column desktop grid, compact list rows, radii, dividers, and above-the-fold proportions match the selected direction. Backstage remains visible at the lower edge of the 1440 × 1024 frame.
- Colors and visual tokens: Passed. Warm charcoal surfaces, copper/orange primary action, restrained green readiness, low-elevation borders, and the existing theme-token system match the visual intent. Contrast was raised on helper and workstream metadata after the first pass.
- Image quality and asset fidelity: Passed. The target contains no photographic or illustrative assets. The implementation uses the supplied BeTenshi icon from `public/icons/icon.svg` and Phosphor icons for UI controls; it contains no placeholder images, custom inline SVGs, emoji icons, or raster substitutions.
- Copy and content: Passed. App copy is concise and standalone. Machine state, request activity, model residency, ports, memory, queue, and service status are live rather than invented.
- Icons: Passed. One consistent Phosphor family is used for the new cockpit, aligned at 12–18px with appropriate regular/duotone/fill states.
- States and interactions: Passed. Text and image prompt handoff, prompt persistence, primary Run routing, resource collapse, Backstage expansion, service action visibility, primary navigation, and request navigation were exercised.
- Accessibility and responsiveness: Passed. Controls are semantic and labeled, focus styles remain visible, reduced motion is respected globally, and there is no horizontal overflow at desktop, tablet, or mobile. Measured widths: desktop 1430 ≤ 1440, tablet 824 ≤ 834, mobile 380 ≤ 390.

## Comparison history

### Pass 1 — blocked

- [P2] Backstage fell below the 1024px fold and the header reported `Degraded` while the page said there were no active issues.
  - Fix: compressed hero and workstream vertical rhythm, kept the Resource map useful, and based header readiness on actionable service attention rather than intentionally stopped on-demand services.
- [P2] Workstream rows lacked the mock's recent-work context and some helper text was too dim.
  - Fix: added a live recent-request column and increased secondary-text contrast.
- [P2] The original desktop workstream grid could overflow a narrow viewport.
  - Fix: introduced two-column mobile, four-column tablet, and five-column desktop workstream layouts; verified scroll widths in the browser.

### Pass 2 — passed

Post-fix source and implementation were reopened together. No actionable P0, P1, or P2 differences remain. The official blue BeTenshi logo is intentionally retained instead of recoloring it to the mock's copper mark, and live telemetry naturally differs from the static mock; both are acceptable product-grounded deviations.

## Primary interactions tested

- Text composer → Chat & Code with the prompt preserved
- Image composer → Image Studio with the prompt preserved
- Home draft persistence across reload
- Resource map expand/collapse
- Backstage expand and service Start/Restart/Stop control rendering
- Home, Models, Requests, and workstream navigation
- 1440 × 1024 desktop, 834 × 1024 tablet, and 390 × 844 mobile layouts
- Browser console checked after reload and interactions: zero errors or warnings

## Follow-up polish

- [P3] Recent requests can appear homogeneous when the live traffic ring is dominated by one caller; that is accurate data, not a layout defect.
- [P3] Production mode will not show the Next.js development helper visible in local development screenshots.

## Light-mode revision

- Reported-state capture: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-265f6cea-44f1-46f9-901c-186a268adff7.png`
- Revised implementation: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-home-light-1048x873.png`
- Viewport: 1048 x 873 CSS pixels, light theme, live telemetry and recent requests
- [P1] The cockpit grid activated only at the 1280px breakpoint, so the reported 1048px desktop viewport stacked the verdict and request rail below the main content. Fixed by moving the two-column operational layout to the 1024px breakpoint with a narrower rail.
- [P2] The generated light palette flattened the canvas and cards into a nearly uniform off-white surface. Fixed with an explicit light cockpit system: warm gradient canvas, crisp paper surfaces, copper hierarchy, tinted section headers, differentiated rows, and restrained layered shadows.
- [P2] The focused composer showed a doubled red/orange outline. Fixed by keeping the accessible focus treatment on the composer container and suppressing the nested textarea outline in light mode.
- Header readiness now remains visible at the reported desktop width. The compact mobile header still prioritizes identity, search, refresh, theme, and profile controls.
- Browser verification passed at 1048 x 873 and 390 x 844 with no horizontal overflow. Dark mode was toggled and visually checked at 1048 x 873, then the deliverable was returned to light mode.

## Workstreams submenu interaction revision

- Source visual truth: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-b17980c3-a70b-45ab-8e22-97ca48ac0fdb.png`
- Open-state implementation: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-workstreams-menu-open-980x1270.png`
- Closed-after-selection implementation: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-workstreams-menu-closed-after-select-980x1270.png`
- Browser viewport: 980 x 1270 CSS pixels at density 1. The 490 x 327 source is a focused crop, so the header/menu region was compared rather than treating the surrounding page crop as a layout difference.
- [P1] Selecting a submenu destination changed the active workstream but left the native `details` menu open over the destination. Fixed by explicitly dismissing the menu before navigation.
- The open-state header, menu placement, typography, colors, copy, icons, and spacing remain visually consistent with the supplied source. No image assets are involved in this interaction.
- Verified selection dismissal (`#qwen`), outside-click dismissal, Escape dismissal, and focus return to the Workstreams summary. The browser was left on Image Studio with the menu closed.

## Persistent resource-capacity revision

- Source visual truth: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-237e115c-6ff8-4c1b-a38f-a675190ec7ac.png`
- Implementation capture: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-resource-pulse-and-map-1048x873.png`
- Source pixels: 709 x 300 focused Resource Map crop. Implementation pixels: 1038 x 865 at a 1048 x 873 CSS viewport and density 1.
- State: light theme, Home, persistent capacity strip focused after activation, detailed Resource Map expanded and scrolled into view.
- [P1] The detailed map was one of the stack's key operational surfaces but lived below the first viewport on Home and disappeared entirely in workstream views. Fixed with a sticky, always-visible Machine capacity strip directly beneath global navigation.
- The strip preserves the source's essential GPU and System RAM occupancy, exact used/total values, health signal, and live telemetry. At wide desktop widths it also exposes utilization, temperature, power, and queue depth.
- Activating the strip navigates from any workstream to Home and scrolls the full Resource Map into view; the original detailed per-service bars remain intact.
- Typography, spacing, light/dark tokens, copy, and Phosphor icon treatment were checked. No image assets are involved. The 709 x 300 source crop and the full-page implementation were compared together at original detail, with the focused Resource Map used for component-level fidelity.
- Verified at 1048 x 873 and 390 x 844 with no horizontal overflow. Light and dark themes passed, the detail interaction passed, and browser console errors were checked.

## Services destination revision

- Source visual truth: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-921cd806-42ca-4641-9eb4-5e07957fc5fe.png`
- Implementation capture: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-services-control-center-1048x873.png`
- Source pixels: 624 x 79 focused navigation crop. Implementation pixels: 1038 x 865 at a 1048 x 873 CSS viewport and density 1.
- State: light theme, Services selected, All services filter, live service and footprint data.
- [P1] Services looked like a primary navigation destination but only selected Home and scrolled to a collapsed Backstage section. Fixed by introducing a first-class `#services` destination with its own active navigation state and command-palette entry.
- [P1] Service entry points lacked context and routed users toward raw process surfaces. Fixed with purpose copy, status, port, live VRAM/RAM footprint, model tags, log access, lifecycle controls, and service-aware routes into Chat, Speech, Image Studio, 3D Body, Segment, or Models. Browser applications and monitoring tools retain direct external launch links.
- [P2] The destination had no useful discovery controls. Fixed with live summary counts, service/model search, status filters, empty-state recovery, and result counts.
- Typography, spacing, color tokens, copy, Phosphor icons, light/dark contrast, and mobile reflow were checked. No image assets are involved. The source navigation crop and full destination capture were compared together at original detail; the new screen intentionally adds the missing destination rather than reproducing the broken blank outcome.
- Verified at 1048 x 873 and 390 x 844 with no horizontal overflow. Search, filters, active navigation, `#services` persistence, and service-to-workstream routing were exercised. Browser console errors were checked.

## All workstream destinations revision

- Visual-system references: `C:\Users\Admin\.codex\generated_images\019fe1e7-9ef6-7103-8656-23e22e30d150\exec-4c6f8242-614a-45a0-a83b-02cf99ab8134.png` and `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\implementation-services-control-center-1048x873.png`.
- Implementation captures: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\01-chat.png` through `07-models.png`, plus `08-models-dark.png` and `09-chat-mobile.png`.
- Pages covered: Chat & Code, Speech Lab, Image Studio, Requests, 3D Body, Segment, and Models.
- [P1] Every destination used a different legacy composition and opened without a strong page-level explanation. Fixed with a shared work-surface header, consistent iconography, contextual status chips, paper/charcoal surfaces, and a common type, border, shadow, and focus system.
- [P1] Chat forced the model picker, metrics, and playground into a long vertical stack at the reported 1048px desktop width. Fixed with a 900px operational breakpoint: model and telemetry form a compact rail while the conversation remains the primary canvas.
- [P1] Chat overflowed horizontally at 390px because model lifecycle actions contributed their minimum width to the page grid. Fixed with a zero-minimum mobile grid and wrapped model action rows. Rechecked at 390 x 844 with no horizontal overflow.
- [P2] Speech treated transcription and synthesis as unrelated vertical blocks. Fixed with two peer workspaces at desktop, each retaining its own model choice and lifecycle controls, and a single-column phone flow.
- [P2] Image Studio, Requests, 3D Body, Segment, and Models were visually flat in light mode. Fixed by remapping legacy semantic gray utilities inside the new page scope to warm paper, crisp controls, stronger secondary text, differentiated tables and toolbars, and restrained copper accents while preserving status colours.
- [P2] Vision pages opened as a small service row above a large blank canvas. Fixed with a clear capability header, visible on-demand state, focused service controls, and a substantial upload/task workspace that explains the expected output before a file is selected.
- Light comparison: the existing Services control center and redesigned Chat were inspected together at the same 1048 x 873 viewport. Panel hierarchy, canvas tint, copper accent, typography, radii, and control density are visually consistent.
- Dark comparison: the selected warm-charcoal mock and redesigned Models page were inspected together. Secondary-text contrast was raised after the first dark pass while retaining the low-glare charcoal hierarchy.
- Interactions exercised: Workstreams menu open/select/close, destination routing, theme toggle, Chat prompt starters, live Requests data, model/service stopped states, and responsive reflow.
- Verification: `npx tsc --noEmit`, all 8 `npm test` cases, and `npm run build --webpack` passed. The production build retains the repository's existing optional `undici`, middleware-deprecation, and live DuckDB lock warnings.

## Per-process GPU-consumer revision

- Source visual truth: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-ffcba1d3-d9ee-49b0-a1f9-5c0e51aa758e.png`.
- Implementation captures: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\resource-consumers-detail-1048x873.png` and `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\resource-consumers-mobile-390x844.png`.
- Source pixels: 706 x 288 focused crop. Desktop implementation: 1038 x 865 at a 1048 x 873 CSS viewport. Mobile implementation: 380 x 822 at a 390 x 844 CSS viewport. Density is 1; browser chrome accounts for the capture-to-viewport delta.
- State: light theme, Home, Resource Map expanded, live RTX 5090 telemetry and Windows GPU process counters.
- [P1] The source grouped almost all occupied VRAM into `Other`, so the most important operational question—what should I stop?—was unanswered. Fixed by reading Windows `GPUProcessMemory` dedicated-memory counters, resolving PIDs and services, and rendering the dominant consumers directly in the GPU lane and a detailed list.
- [P1] NVIDIA's Windows WDDM driver returns `N/A` for per-process memory through `nvidia-smi`; the earlier implementation treated that as a permanent attribution limit. Fixed with the same Windows performance-counter source used by Task Manager. The current map identifies the Docker / WSL GPU VM, Windows desktop compositor, Qwen-Image, named desktop apps, and a bounded smaller-process group.
- [P2] A VM aggregate alone would still hide which BeTenshi model was responsible. Fixed by probing registered containerized LLM services and annotating the VM row with the currently reachable workload, presently `vLLM (Qwen2.5-7B)`. The UI explicitly states that WDDM cannot split the VM's memory by container.
- Full-view comparison: the source and revised implementation were opened together. The original card structure, GPU/RAM hierarchy, capacity lane, ticks, health, utilization, temperature, and power remain intact; the revised view adds the missing consumer explanation immediately beneath the lane.
- Focused-region evidence: the consumer rows were inspected at full browser detail. Names, notes, process/service identity, memory values, lane colors, and grouping remain legible at 1048px and stack into full-width rows at 390px.
- Fonts and typography: passed; the consumer hierarchy uses the existing 9–11px operational scale and tabular memory values.
- Spacing and layout rhythm: passed; six bounded consumer rows fit in two/three desktop columns and one mobile column without obscuring RAM.
- Colors and tokens: passed; existing copper, violet, sky, and slate semantics distinguish services, containers, system processes, and apps in light mode.
- Image/asset fidelity: passed; no image assets are required. Existing Phosphor iconography and native UI marks are retained.
- Copy/content: passed; `Other` is used only as a bounded smaller-app aggregate, and the container attribution limitation is stated plainly.
- Primary interaction tested: the persistent Machine capacity strip scrolls to the expanded detailed Resource Map. Mobile scroll width equals client width (380px), so no horizontal overflow remains.
- Verification: live `/api/gpu` process data inspected, `npx tsc --noEmit`, all 8 `npm test` cases, and `npm run build --webpack` passed. Existing optional `undici`, middleware-deprecation, and live DuckDB lock warnings remain unrelated.

final result: passed

## Image Studio compact run-setup revision

- Source visual truth: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-5c1f789f-ff95-4c30-8ca9-bcad1e5f34c9.png`
- Primary implementation capture: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\12-image-studio-compact-rail-1063x711.png`
- Focused popup captures: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\13-image-studio-model-dialog-1063x711.png` and `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\14-image-studio-runtime-dialog-1063x711.png`
- Responsive captures: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\15-image-studio-rail-mobile-390x844.png` and `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\16-image-studio-model-sheet-mobile-390x844.png`
- Viewport and density: desktop source and implementation are both 1063 x 711 pixels at a 1063 x 711 CSS viewport and density 1. Mobile implementation is 390 x 844 pixels at a 390 x 844 CSS viewport and density 1. No density normalization was required.
- State: light theme, Image Studio, Create -> Generate, local Qwen-Image selected and running.

### Full-view comparison evidence

The reported screenshot and revised desktop capture were opened together in one comparison input at original detail. The reported right rail exposed two full model cards, routing copy, lifecycle actions, and diagnostics at all times, making its height substantially exceed the creation form and forcing History below a large empty left-side gap. The revised rail is a compact `Run setup` summary with two rows: current model and current runtime. History now begins immediately below the creation canvas and summary at the same viewport.

### Focused-region comparison evidence

The model and runtime dialogs were inspected together at original detail. The model popup preserves local/cloud selection, running state, footprint data, and routing scope. The runtime popup preserves health, latency, Stop/Restart/Logs/Refresh, and expandable checkpoint diagnostics. Both dialogs use the existing warm-paper visual system, keep controls legible, and avoid duplicating operational detail in the primary layout.

### Comparison history

#### Pass 1 - blocked

- [P1] The persistent right rail was taller than the primary creation card, creating a large blank region before History and making operational metadata dominate the task.
- [P2] Model choice, VRAM footprint, service lifecycle, and checkpoint diagnostics were all permanently expanded despite being occasional setup actions.
- [P2] Moving the same full rail below the workbench on mobile would make the creation flow unnecessarily long.

Fixes: replaced the rail with a compact two-row summary; moved model selection into a focused dialog; moved service lifecycle and checkpoint diagnostics into a separate management dialog; added Escape and outside-click dismissal, focus trapping, focus restoration, and body-scroll locking; and rendered mobile dialogs as full-width bottom sheets.

#### Pass 2 - passed

The revised desktop, model dialog, runtime dialog, mobile layout, and mobile sheet were reopened after the fixes. No actionable P0/P1/P2 issue remains. At 390px, `documentWidth == bodyWidth == viewport == 390`, and the dialog measures exactly 390px wide with no horizontal overflow.

### Required fidelity surfaces

- Fonts and typography: passed. The compact rail uses the existing 10-14px operational hierarchy, with concise labels, bold selected values, and readable secondary state text. Dialog headings and explanatory copy remain optically balanced and do not wrap awkwardly.
- Spacing and layout rhythm: passed. The right-side content is bounded to one compact card, rows use consistent padding and dividers, and the History section rises directly under the workbench. Dialogs use restrained width and internal spacing; the mobile version becomes a bottom sheet.
- Colors and visual tokens: passed. Warm paper surfaces, copper focus/action accents, green readiness, amber footprint warnings, border colors, and shadows match the rest of the light console.
- Image quality and asset fidelity: passed. No raster artwork is required for this operational surface. Existing Lucide icons are crisp, consistently sized, and no emoji, placeholder art, or custom inline SVG was introduced.
- Copy and content: passed. `Run setup`, `Change`, and `Manage` make the hierarchy explicit while retaining the complete routing, runtime, and diagnostic language inside the appropriate dialog.
- Accessibility and responsiveness: passed. The dialogs are semantic and labelled, Escape closes them, focus is trapped and restored to the trigger, outside-click closes them, and mobile has no horizontal overflow. Tap targets remain practical.

### Primary interactions tested

- Open and close the model dialog
- Open the runtime dialog and expand checkpoint diagnostics
- Escape dismissal and trigger focus restoration
- Dialog focus trapping and body-scroll lock
- Desktop 1063 x 711 and mobile 390 x 844 layouts
- Mobile bottom-sheet presentation
- Fresh browser tab checked after reload and interactions: zero console errors; only normal React DevTools and HMR development logs
- `npx tsc --noEmit` passed
- All 8 `npm test` cases passed
- `npm run build --webpack` passed; the existing optional `undici`, middleware deprecation, URL parser deprecation, and live DuckDB lock warnings remain unrelated

### Follow-up polish

- [P3] The local Next.js development badge can overlap the bottom edge of screenshots; it is development chrome and is absent from production.

final result: passed

## Image Studio workbench correction

- Reported broken-state visual: `C:\Users\Admin\AppData\Local\Temp\codex-clipboard-fe7a4c89-a9e3-4b5b-b685-433d8e7022e2.png`
- Revised desktop capture: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\10-image-studio-workbench-1047x711.png`
- Revised mobile capture: `C:\Users\Admin\Code\AI\betenshi-console\design-qa-artifacts\post-redesign\11-image-studio-mobile-390x844.png`
- Source pixels: 1047 × 679 (the supplied image is a focused content crop). Desktop implementation pixels: 1037 × 704 from a 1047 × 711 CSS viewport; the in-app capture excludes its scrollbar/chrome edge. Mobile implementation pixels: 380 × 822 from a 390 × 844 CSS viewport. Density is 1.
- State: light theme, Image Studio, Create → Generate, local Qwen-Image selected and running.

### Full-view comparison evidence

The supplied crop and revised browser capture were opened together in one comparison input. The reported layout spent the entire first viewport on a large decorative hero, model cards, a service banner, and three separate navigation systems; the actual creation form began below the crop. The revised layout makes the page identity a compact title row, merges workflow modes into one tab bar, places the prompt and Generate action in the primary left workbench, and bounds model/runtime controls in a right rail. The primary task is fully visible at the same desktop width.

### Focused-region evidence

The top 700px workbench region was inspected at original detail because hierarchy and control density—not imagery—were the failure. The prompt, microphone action, size, steps, CFG, advanced settings, and Generate button are readable without scrolling. The model rail retains local/cloud selection, current memory footprint, service health, lifecycle actions, and collapsed diagnostics without competing with the task.

### Comparison history

#### Pass 1 — blocked

- [P1] Page identity was rendered as an oversized hero card, using scarce vertical space without adding task value.
- [P1] `Studio / Activity`, `Local / Cloud`, and three labelled mode groups formed competing navigation hierarchies.
- [P1] The prompt and primary Generate action were below the visible viewport in the reported 1047px-wide state.
- [P2] Service operations and checkpoint diagnostics had equal visual weight to image creation.
- [P2] The same billboard header pattern affected Chat, Speech, Requests, Models, and vision workstreams.

Fixes: replaced the shared billboard with a compact page-title row; moved Create/Activity into that header; consolidated Generate/Edit/Batch/Compare/Jobs into one semantic tablist; introduced a task-first workbench with a bounded runtime rail; kept diagnostics collapsed; and applied the compact header correction across every shared tool page.

#### Pass 2 — passed

The revised desktop and mobile captures were reopened after the fixes. The primary task is above the fold, all five workflow tabs are visible at 390px, the page has no horizontal overflow (`scrollWidth == clientWidth == 380`), and the model/service rail stacks cleanly below the task on mobile. No actionable P0/P1/P2 findings remain.

### Required fidelity surfaces

- Fonts and typography: passed. One clear 24–27px page title, 12px operational controls, and 11px metadata hierarchy; no decorative headline scale or cramped labelled mode clusters remain.
- Spacing and layout rhythm: passed. Compact title divider, 16px workbench gap, one dominant canvas, 18–21rem runtime rail, and bounded panel padding. The creation form is visible at 1047 × 711.
- Colors and tokens: passed. Existing warm paper/copper theme is preserved, with readable emerald and amber footprint text in light mode and restrained elevation.
- Image quality and assets: passed. This surface requires no raster artwork; the existing Phosphor image icon remains aligned and no placeholder or custom-drawn asset was introduced.
- Copy and content: passed. The header and mode helper text now explain the current task in one sentence; the long checkpoint explanation remains available only in diagnostics.
- Responsiveness and accessibility: passed. Create/Activity and workflow choices use semantic tablists with selected states; focus styling remains global; mobile has no overflow; reduced motion remains respected.

### Primary interactions tested

- Create / Activity switch and return to Create
- Generate, Edit, Batch, Compare, and Jobs workflow tabs
- Edit input state, batch workspace, comparison workspace, and jobs state rendering
- Local/cloud model selector and service controls retained
- Desktop 1047 × 711 and mobile 390 × 844
- Browser console checked after reload and interactions: zero errors or warnings
- `npx tsc --noEmit`, all 8 `npm test` cases, and `npm run build` passed. The existing middleware-convention, optional `undici`, URL parser, and live DuckDB warnings remain outside this layout correction.

final result: passed
