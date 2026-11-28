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
7. **No regressions**: VERSUS mode still shows only the player's NEXT; unit tests and the
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
