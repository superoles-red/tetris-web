# Feature Specification: UI defect round — authentic frames, WITH well, records, safe areas

**Feature Branch**: `001-ui-defects-round`
**Created**: 2026-11-28
**Status**: Draft
**Input**: Feedback from the owner after the previous build (screenshots and voice notes).

## Problem

Several visible defects remained after repeated partial fixes. The user asks for a
spec-driven process: every item below must have an objective acceptance check and may
not be reported as done until that check passes on the built site.

## User Scenarios & Testing

### User Story 1 — Title screen looks like the original (Priority: P1)

As a player I want the title screen frame and animation to be identical to the
original game, so the main menu feels authentic.

**Independent Test**: Open the home screen, capture the animated title canvas over a
full loop, compare left/right frame borders pixel-by-pixel symmetry and verify that
fireworks occupy different screen regions over the loop.

**Acceptance Scenarios**:
1. Given the home screen, the left and right border columns of the title frame are
   mirror-symmetric (no duplicated strip, no black cut, no half squares).
2. Given the home screen animation loop (>=8 s), detected firework regions vary in
   position (at least 3 distinct regions).
3. No black band is visible at the top or bottom of the portrait screen (safe areas
   are covered by the background pattern).

### User Story 2 — Menu frames match the original ornament (Priority: P1)

As a player I want every menu panel to use the same decorative frame as the title
screen, without cropped inner/outer edges.

**Independent Test**: Screenshot settings, pause, confirm and records panels; verify
outer warm cell ring and inner blue braid are continuous on all four sides, corners
are complete, no black strip at any edge.

**Acceptance Scenarios**:
1. Four corners and four edges of the panel border are non-black and visually match
   the title frame ornament.
2. No side shows a black vertical/horizontal band inside the border.

### User Story 3 — WITH COMPUTER well is authentic (Priority: P1)

As a player in WITH COMPUTER mode I must see pieces spawn inside the shared well,
with the same pixel size as the falling pieces, and both next pieces labelled.

**Independent Test**: Start WITH COMPUTER, capture several frames around spawn,
verify piece pixels appear inside the well frame from the first spawn frame, tile
aspect ratio equals 1:1 (no stretching), and labels "NEXT" and "NEXT CPU" are visible.

**Acceptance Scenarios**:
1. Spawned piece is fully visible inside the shared well frame within 1 frame of spawn.
2. Shared-well tile width/height ratio matches the field tile ratio (no stretch).
3. In landscape the shared well bottom is fully visible above the on-screen controls.
4. Labels: player's next = NEXT, computer's next = NEXT CPU (WITH only).

### User Story 4 — Records show names in the game font (Priority: P1)

As a player I want to see my name in the records table, in the same pixel font as the
rest of the game, for both RU and EN interfaces and for Latin/Cyrillic names.

**Independent Test**: Complete a run, enter a name, open records and read the table;
verify the name cell has non-zero width and the rendered glyphs come from the game
font (RU built-in Cyrillic + Latin, EN ROM glyphs). Verify digits match the ROM HUD
digits and are equal for RU/EN interfaces of the same ROM.

**Acceptance Scenarios**:
1. Name cell width > 0 and name text visible for RU and EN UI.
2. Latin name in RU UI renders with the pixel font (not system fallback).
3. Digits in UI are the original ROM digits (no hand-drawn glyphs), same for RU/EN.

### User Story 5 — Resume/Continue renders correctly (Priority: P1)

As a player I want Continue from the main menu to restore the game without the
canvas being stretched or cropped.

**Independent Test**: Play VS and WITH modes, save, reload the page (PWA-like),
Continue; capture the screen and compare canvas backing size to CSS size and the
rendered layout to a freshly started game.

**Acceptance Scenarios**:
1. After Continue the rendered layout equals a fresh run (well aspect, HUD positions).
2. Canvas backing store equals CSS box size (ratio 1:1 device-independent) after resume.

### User Story 6 — Labels and mode rules (Priority: P2)

**Acceptance Scenarios**:
1. VERSUS COMPUTER shows only the player's next piece (NEXT), no CPU preview.
2. WITH COMPUTER shows both (NEXT, NEXT CPU).

## Out of scope

* Online multiplayer.
* New game modes.
* Font glyph redesign beyond records visibility.

## Verification method

* `node --test` — unit suite (must stay green).
* `node tools/build-site.mjs` — static artifact builds.
* Playwright scripts in `/tmp/e2e` (self-play, screenshots, pixel checks) run against
  the local server and the deployed GitHub Pages URL.
* Every acceptance scenario above gets an automated check or an owner-visible
  screenshot in the final report; failing checks are reported as NOT DONE.
