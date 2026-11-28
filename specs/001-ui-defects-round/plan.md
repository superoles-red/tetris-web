# Implementation Plan: UI defect round

**Branch**: `001-ui-defects-round`
**Spec**: `specs/001-ui-defects-round/spec.md`

## Technical approach

1. **Title frame symmetry** — render the title canvas 256×240 by mirroring the right
   border strip into the left border columns (instead of duplicating or cropping), so
   both sides are identical.
2. **Title animation variety** — keep the palette-indexed recorded loop (>=8 s) and
   verify firework regions vary; extend capture only if the check fails.
3. **Menu ornament** — build the panel border as a real 9-slice sampled from the title
   screen corners/edges (30 px), not by rotating a single strip; use CSS
   `border-image` slice 30.
4. **Background safe areas** — background pattern is fixed to the viewport
   (`#machine::before { position: fixed; inset: 0 }`); verify with simulated iPhone
   safe-area insets.
5. **WITH well** — frame the 18-row field plus a 4-row spawn annex; blit source
   rectangles with a single uniform scale (`k`); draw spawn sprites inside the annex;
   in landscape reserve control height so the frame is not clipped.
6. **Records** — fix the zero-width name column (min width, clamp font size >= 9px);
   add Latin glyphs to the RU built-in font; use ROM digits for both UI languages.
7. **Resume/Continue** — re-run `renderer.resize()` on the next frames and on
   `visibilitychange`; assert canvas backing size equals CSS size.
8. **Labels** — CPU preview only in WITH mode.

## Test strategy

* Add a browser self-test script that plays each mode, resumes, opens records and
  writes PASS/FAIL per acceptance criterion.
* Screenshot every criterion for the owner.
* Do not report success for a criterion whose automated check fails.

## Files

* `app.js`, `compositor.js`, `style.css`, `controls.css`, `index.html`, `locale.js`
* `src/byop/game-skin.js`, `src/byop/pixel-font.js`, `src/byop/game-font.js`
* `tests/*.test.mjs`, `/tmp/e2e/*.mjs` (self-test harness)
