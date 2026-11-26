# Dev-эталон и сравнение с JSNES

**Только для разработки.** Эти инструменты не входят в сайт (`tools/` исключён в
`tools/build-site.mjs`), не попадают на GitHub Pages и не импортируются из
`app.js`/`src/nes/engine.js`. JSNES 2.1.0 — `devDependency` (Apache-2.0), см.
`THIRD_PARTY_NOTICES.md`.

Зачем: наш движок — собственный (рекомпилятор 6502→WASM + свои PPU/APU), поэтому
единственный способ проверить его поведение — сравнить с независимой реализацией
NES. Эталон — JSNES 2.1.0 из npm. Все результаты — хэши/метаданные; игровой ROM
читается по абсолютному пути и **никогда не копируется в репозиторий**.

## Правила

- ROM — только по абсолютному пути снаружи репозитория (`.gitignore` запрещает
  `*.nes`, `tests/fixtures/roms/`). Не коммитить ROM, дампы CHR/PRG, скриншоты
  игры, записи музыки.
- Временные файлы (JSON, WAV, PNG) — только в `/tmp`.
- В `tests/reports/` можно коммитить отчёты сравнения (хэши и метаданные, без
  ROM); формат — `tests/reports/README.md`.
- Номера кадров везде **1-based**: кадр 1 — первый выполненный кадр.
- Кадр хэшируется как `Uint32Array(256*240)` цвета `0x00BBGGRR`, байты
  little-endian → SHA-256 (одинаково для JSNES и нашего PPU).
- У эталона `ppu.clipToTvSize = false`, чтобы сравнивать полный кадр 256×240.

## Ограничение mapper 148

JSNES 2.1.0 не поддерживает маппер 148 (Tengen Tetris). Для эталона копия
заголовка в памяти объявляется как NROM: у Tetris фиксированные 32 КиБ PRG, код
и данные читаются верно, но **CHR-банки не переключаются**. Поэтому на EN-дампе
(mapper 148) побайтовое сравнение кадров некорректно — смотрите RAM и циклы;
на RU-дампе (mapper 3, CNROM) JSNES поддерживает маппер нативно, и кадры
сравнимы побайтово. Оригинальный маппер и SHA-256 ROM при этом фиксируются в
отчёте (`rom.jsnesHeaderPatched: true`).

## Установка

```bash
npm ci                 # jsnes ставится из devDependencies
```

## `run-jsnes.mjs` — прогон эталона

API: `runReferenceFile({ romPath, frames, scenario, ramAt, ppuAt, ... })`,
`runJsnes({ romBytes, ... })` (см. `jsnes-runner.mjs`).

```bash
# 600 кадров, сценарий доводит игру до геймплея, RAM-дампы на кадрах 1/193/300
node tools/reference/run-jsnes.mjs --rom /abs/path/game.nes --frames 600 \
     --scenario gameplay --ram-at 1,193,300 --json /tmp/ref.json

# то же, но JSON в stdout; WAV и PNG — в /tmp
node tools/reference/run-jsnes.mjs --rom /abs/path/game.nes --frames 300 \
     --press "start@100+4,start@160+4" --wav /tmp/ref.wav \
     --png-at 200 --png-prefix /tmp/refimg
```

Основные поля JSON: `rom {sha256,size,mapper,jsnesHeaderPatched}`, `frames`,
`scenario`, `frameHashes[] {frame,sha256,cycles,pc}`, `ramDumps[] {frame,start,end,sha256,hex}`,
`ppuStates[]`, `audio {sampleRate,sampleCount,sha256,wav}`, `pngFiles[]`.

Сценарии ввода (`tools/reference/scenario.mjs`): JSON-файл через `--input`
(формы `{frame,buttons,hold}`, `{frame,down,up}`, `{from,until,buttons}`),
DSL `--press "start@100+4,a@140"` или пресеты `none|menu|gameplay`.
Пресет `gameplay` доводит Tengen Tetris до сцены игры ($29=0) примерно к 340-му
кадру и двигает фигуру.

## `ppu-state.mjs` — снимок состояния PPU

API: `capturePpuState(ppu)`, `runPpuStates({romPath, frames:[...], includeTiles, includeBuffer, includeJsnesJson})`.

```bash
node tools/reference/ppu-state.mjs --rom /abs/path/game.nes --frames 1,60,200 \
     --scenario gameplay --out /tmp/ppu-states.json
# + полный JSNES ppu.toJSON() (для ppu.fromJSON) и декодированные тайлы:
node tools/reference/ppu-state.mjs --rom /abs/path/game.nes --frames 60 --to-json --tiles
```

Состояние: `registers` (флаги $2000/$2001), `scroll` (loopy-регистры и счётчики),
`memory {vramMem, chrWindow, nameTables, paletteRam, spriteMem}` (hex),
`palettes {imgPalette, sprPalette}`, `mirroring`, `timing {scanline, curX, ...}`,
`buffer {sha256}` (опционально `pixels`), опционально `ptTile` и `jsnesToJSON`.
Снимается на границе кадра (после `endFrame`, т.е. состояние «как после кадра N»).

## `apu-log.mjs` — лог записей APU + эталонные сэмплы

API: `runApuLog({romPath, frames, scenario, sampleRate, wavPath, includeSamples})`,
`replayApuWrites(apu, log)` — воспроизводит лог на нашей модели APU.

```bash
node tools/reference/apu-log.mjs --rom /abs/path/game.nes --frames 600 \
     --scenario gameplay --wav /tmp/ref-apu.wav --out /tmp/apu-log.json
```

`apuWrites[] {frame, cycle, address, addressHex, value}` — записи $4000-$4017 в
порядке выполнения; `cycle` — абсолютные CPU-циклы с момента `loadROM`
(`cpu._cpuCycleBase + instrBusCycles`); `frameCycles[]` — циклы на границах кадров;
`audio {sampleRate, sampleCount, sha256, wav}`. Сэмплы пишутся только в `/tmp`.

## `tools/compare.mjs` — наше vs JSNES

```bash
# полное сравнение кадров, RAM, циклов, аудио
node tools/compare.mjs --rom /abs/path/game.nes --frames 600 --scenario gameplay \
     --json /tmp/compare.json

# только эталон / только наш движок
node tools/compare.mjs --rom /abs/path/game.nes --frames 200 --engine=jsnes
node tools/compare.mjs --rom /abs/path/game.nes --frames 200 --engine=ours

# PNG кадра расхождения и WAV обеих сторон — в /tmp
node tools/compare.mjs --rom /abs/path/game.nes --frames 300 --png-at 66 \
     --png /tmp/cmp --wav /tmp/cmp
```

Вывод: номер первого расходящегося кадра, SHA-пары, первое расхождение RAM
(кадр, смещения, байты), расхождение аудио (первый сэмпл, max|Δ|, RMS), дельта
циклов по кадрам. Код выхода: 0 — совпало, 1 — расхождения, 2 — движок не готов.
`--allow-mock-apu` — только для раннего bring-up (тихая заглушка APU, если
`src/nes/apu.js` ещё нет).

Наш движок подключается динамически: `src/nes/console.js` → `createConsole(rom,
{sampleRate, onAudioSample})`, кадр — `console.frame()`, буфер —
`console.ppu.buffer`, RAM — `console.cpuMem`. Пока модулей ядра нет, инструмент
сообщает об этом понятной ошибкой (код 2), а не падает.

## `tools/fetch-cpu-test.mjs` — тест Klaus Dormann

```bash
node tools/fetch-cpu-test.mjs           # скачать в tools/.cache/ (в .gitignore)
node tools/fetch-cpu-test.mjs --force   # заново, если апстрим обновился
```

Скачивает `6502_functional_test.bin` (GPL-3.0, Klaus Dormann) с
`raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests` по пину SHA-256
(`fa12bfc7…`, 65536 байт). В репозиторий файл не коммитится; в CI скачивается
заново. При несовпадении пина — понятная ошибка.

## CPU-тесты

- `node tests/cpu-conformance.mjs` — функциональный тест Klaus через наш
  `Console`/WASM. Обёртка переносит код $0400→$8000, правит 84 абсолютных
  операнда, 2 inline-указателя и 10 immediate-байт; пропускает блоки, которых
  нет на 2A03 (decimal ADC/SBC) и которые требуют записи в ROM (self-modifying
  branch range); RAM-исполняемые `jsr ex_*` заменяет эквивалентными `abs` по
  адресу операнда. Успех = PC на relocated `$B069`, `test_case=$F0`.
  Real-прогон: 26 199 427 инструкций, ~2.6 с. `--mock-peripherals` — только CPU.
- `node tests/cpu-differential.mjs` — случайные программы из документированных
  инструкций (синтетический NROM, без игрового ROM) против JSNES: PC/A/X/Y/SP/P/
  циклы/RAM после каждой инструкции. `--seeds/--steps`, `--include-jmp-indirect`,
  `--ignore-cycles`. Короткая версия для `npm test` —
  `tests/cpu-differential.test.mjs`.
