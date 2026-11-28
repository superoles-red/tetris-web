# Feature Specification: WITH COMPUTER shared well correctness

**Feature Branch**: `002-with-computer-fix`
**Created**: 2026-11-28
**Status**: Implemented & verified
**Input**: Owner feedback: "фигуры падают за 2 клетки до дна; на верхних клетках странное
расположение по горизонтали, фигуры проходят друг сквозь друга и сквозь колодец;
продолжение после игры с WITH COMPUTER всё равно глючное".

## Problem

Shared (WITH COMPUTER) well rendering had three independent defects:
1. the drawn frame was 16 game pixels taller than its content (2 cells of black gap at
   the bottom), so falling pieces visually stopped 2 cells above the floor;
2. the computer player's spawn sprites were copied with the wrong horizontal origin
   (`160` instead of the shared-well origin `80`), so pieces were clipped/misplaced and
   overlapped the player's piece and the frame;
3. the game mode (`solo/vs/with`) was not persisted with the saved run; after an app
   restart "Continue" restored a WITH checkpoint but rendered it with the solo layout
   (large stretched picture, wrong crops).

## Acceptance scenarios

1. **Spawn visibility**: in WITH COMPUTER a newly spawned piece is drawn inside the well
   frame from the first visible frame.
2. **Horizontal placement**: the player's and the computer's pieces appear in the left
   and right halves of the shared well respectively; they never overlap, cross the side
   borders or each other at spawn.
3. **Bottom alignment**: when pieces stack on the floor, their bottom row touches the
   frame's bottom border (no 2-cell gap).
4. **Uniform scale**: the shared well field and spawn annex use one uniform scale `k`
   (a tile is 8k wide and 8k tall; no vertical stretching).
5. **Landscape**: the shared well is fully visible above the on-screen controls.
6. **Continue**: after playing WITH COMPUTER, saving, reloading the page and pressing
   Continue, the game is rendered with the WITH layout (two next pieces, shared well),
   not a stretched solo image. Works for old saved slots that do not store the mode
   (mode is inferred from cartridge RAM 0x4f0: 0=solo, 3=vs, 4=with).
7. **No stale restore**: an old `exit`-checkpoint left in localStorage by a *different*
   run (e.g., a previous solo game) must not override the saved slot. Continue after
   WITH COMPUTER must restore the WITH run even when such a stale backup exists; the
   stale backup is cleared. After Continue the chosen mode stays WITH, so a following
   "New Game" also starts WITH.
8. **Corrupted slot recovery**: if a previous build already overwrote the saved slot with a
   different game's checkpoint (while the slot still claims another mode), Continue must
   render the *actual* cartridge state (mode read from RAM 0x4f0), not a stretched layout
   from the stale mode. The stored mode is corrected.
9. **Height parity with the solo well**: in the original ROM both wells have the same
   height in game pixels (content rows 48..224); WITH is only wider (12 tiles vs 10).
   Rendered WITH must use the same pixel scale `k` as solo, so its height matches.
   In portrait the NEXT/NEXT CPU/score HUD is placed above the well (like the original
   WITH screen) so the right info column does not squeeze the well; on short screens a
   compact right column fallback is allowed. Landscape uses the same `k`.
10. **No regressions**: VERSUS mode still shows only the player's NEXT; unit tests and the
   UI audit pass.

## Verification

* `node --test` — 131 tests.
* `tools/self-play.mjs`, `tools/ui-audit.mjs`.
* Pixel measurements on captured frames:
  - floor: lowest piece row = 491, bottom border starts at 492 (1 px gap due to border);
  - OAM probe: player 1 sprites x=88..112, player 2 x=144..168 inside shared well
    x=80..176 — both copied with origin 80.
* Screenshots: `/tmp/d-with-spawn.png`, `/tmp/d-with-late.png`, `/tmp/d-with-land.png`,
  `/tmp/cont-with-ok.png`, `/tmp/d-continue-old.png`.
* Height parity measurement on rendered screenshots: interior height of solo well 513 px,
  WITH well 517 px (0.8% — rounding/borders); screenshots `/tmp/solo-height.png`,
  `/tmp/with-height.png`, landscape `/tmp/with-height-land.png`. In-game measurement:
  both wells have content rows 48..224 (22 rows), WITH interior 96 px vs solo 80 px wide.
* Corrupted-slot E2E: slot info says `with`, checkpoint is solo → Continue renders solo
  correctly and stores `solo` (`/tmp/corrupt-continue.png`).
* Stale exit-backup regression: `tests/saved-run.test.mjs` (6 tests) and E2E
  `/tmp/stale-exit-test.mjs` → Continue restores WITH (`/tmp/e-stale-continue.png`),
  stale key cleared, next New Game row = WITH (`/tmp/e-new-with-after.png`).
