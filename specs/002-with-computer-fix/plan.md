# Implementation Plan: WITH COMPUTER correctness

1. `compositor.js`
   * shared well outer height = `176*k + 2*border` (32 px spawn annex + 144 px field),
     so the field bottom meets the inner bottom of the frame;
   * field blit destination = `innerY + 32k`, height `144k`;
   * spawn sprites for both players copied with `originX = 80` (shared well origin);
   * landscape layout reserves control height (`h - 2*pad - 70`).
2. `app.js`
   * persist `settings.opponent` in localStorage settings;
   * store `opponent` in the saved-run slot info;
   * on Continue use slot mode, otherwise infer from cartridge RAM `0x4f0`
     (0 solo, 3 vs, 4 with) — fixes old saves;
   * re-run `renderer.resize()` after entering the game and on `visibilitychange`.
3. Verification harness: `tools/ui-audit.mjs` (geometry screenshots/measurements),
   `tools/self-play.mjs` (play to game over + records).
