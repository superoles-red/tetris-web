# Tasks: WITH COMPUTER correctness

- [x] T001 Frame height equals content: shared well 176k + borders, field bottom aligned — PASS
      (lowest piece row 491 vs border 492 in `/tmp/e-with-bottom.png`)
- [x] T002 Spawn sprites: both players copied with shared-well origin 80 — PASS
      (probe: OAM p1 x=88..112, p2 x=144..168; `/tmp/d-with-spawn.png`, `/tmp/d-with-late.png`)
- [x] T003 No overlap/through-the-wall at spawn — PASS (screenshots: left/right halves)
- [x] T004 Uniform scale, no stretching — PASS (code mapping 96→96k, 144→144k; screenshots)
- [x] T005 Landscape fully visible above controls — PASS (`/tmp/d-with-land.png`)
- [x] T006 Continue restores WITH layout: mode saved in slot + settings; old slots inferred
      from RAM 0x4f0 — PASS (`/tmp/cont-with-ok.png`, `/tmp/d-continue-old.png`)
- [x] T007 Regression: VS shows only player's NEXT; 131 unit tests; build — PASS
- [x] T008 Stale exit-backup from another run must not override Continue; clear it; mode
      stays WITH afterwards — PASS: unit tests `tests/saved-run.test.mjs` (135 total),
      E2E stale-exit scenario (`/tmp/e-stale-continue.png`, `/tmp/e-new-with-after.png`)
- [x] T009 Corrupted slot (mode says WITH, checkpoint is solo): Continue renders actual
      cartridge state and corrects stored mode — PASS: E2E (`/tmp/corrupt-continue.png`),
      `opponentFromRam()` unit test, 136 tests total
- [x] T010 Height parity: WITH rendered at the same scale/height as solo (in-game both
      22 rows; screenshots 513 px vs 517 px), portrait HUD moved above the well —
      PASS (`/tmp/solo-height.png`, `/tmp/with-height.png`, `/tmp/with-height-land.png`)
