# Constitution — Tengen Tetris BYOP port

1. **Original graphics only.** Any decoration must be assembled from the player's ROM
   graphics (title frame, CHR tiles, sprites). No hand-drawn replacements of game art.
2. **Spec before work.** Every defect/feature gets a spec with acceptance scenarios in
   `specs/`, then a plan and tasks. Work is not "done" until its acceptance check passes.
3. **Self-test before delivery.** Before reporting to the owner, run the automated
   self-play test (start each mode, play, game over, records, resume) and the UI audit;
   attach evidence (screenshots / measured values).
4. **No silent patches.** Every edit is verified by re-reading the modified code
   (`grep`/`read`) and by an automated check; a failed replacement is a bug, not a detail.
5. **No game data in the repo or site.** ROM/CHR/dumps/screenshots/music of the game are
   never committed or published; runtime assets are generated from the player's ROM.
6. **Honest reporting.** Report PASS/FAIL per acceptance scenario. Do not call a task
   done if its check failed or was not executed.
