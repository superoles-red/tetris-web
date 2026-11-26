# Third-party notices

## JSNES (development only)

`jsnes@2.1.0` — Apache License 2.0, © Ben Firshman and contributors,
https://github.com/bfirsh/jsnes

Used **only** as a development-time reference implementation for automated
comparison tests (`tools/compare.mjs`, devDependency). It is not bundled, not
served on GitHub Pages, and not part of the game runtime.

## NES hardware documentation

PPU/APU/CPU timing follows public hardware documentation (nesdev.org wiki:
https://www.nesdev.org/wiki/). The NTSC palette values used for rendering are
the widely published NES palette constants (data, not code).

## No game data

This repository contains no ROM files, no CHR/PRG dumps, no screenshots of the
game, and no recordings of its music. The game body is supplied by the player
at runtime and never leaves the player's device.
