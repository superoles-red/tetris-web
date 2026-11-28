# Tasks: UI defect round

Legend: [ ] todo, [x] done and verified.

- [x] T001 Title frame: mirror right border into left (no duplicate/crop) + screenshot check — PASS: canvas border mirror diff = 0 (audit), screenshot `/tmp/a-home2.png`
- [x] T002 Title animation: verify >=3 distinct firework regions over loop — PASS: 8 distinct regions over 10 s recorded loop (audit)
- [x] T003 Menu ornament: symmetric 9-slice (30 px) from title corners/edges — PASS: black fraction L/R = 0.11/0.11, T/B = 0.12/0.13; screenshot `/tmp/c-settings.png`
- [x] T004 Background: fixed pattern fills safe-area — PASS: simulated iPhone insets, 0 all-black rows top/bottom (`/tmp/a-safe2.png`)
- [x] T005 Pause button: top offset in portrait — PASS: `top:14px` inside safe zone (screenshots)
- [x] T006 WITH well: fixed source ImageData height (sprites were lost), uniform scale, spawn inside closed extended frame, landscape reserves control height — PASS: screenshots `/tmp/b-with-spawn.png`, `/tmp/b-with-late.png`, `/tmp/b-with-land.png`
- [x] T007 Labels: VS = only NEXT; WITH = NEXT + NEXT CPU — PASS: `/tmp/audit-vs.png`, `/tmp/audit-with-late.png`
- [x] T008 Records: name visible (slot 92.6 px, font `TengenTap-ru` = game font), Latin in RU font, ROM digits equal for RU/EN (glyph check: true) — PASS
- [x] T009 Continue: root cause = `opponent` was not persisted; saved run restored as solo → wrong crops/stretch. Fixed + PASS: `/tmp/audit-continue.png`, `/tmp/cont-with-ok.png`; canvas 390×844 = CSS 390×844
- [ ] T010 Run unit tests, build site, deploy, report PASS/FAIL per criterion with screenshots
