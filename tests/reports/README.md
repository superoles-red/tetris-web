# Отчёты прогонов совместимости

Здесь хранятся отчёты сравнения нашего движка с эталоном JSNES 2.1.0
(`node tools/compare.mjs`). **Только хэши и метаданные** — без ROM, дампов
CHR/PRG, скриншотов игры, записей музыки и полных дампов RAM.

## Как сгенерировать

```bash
node tools/compare.mjs --rom /абсолютный/путь/game.nes --frames 600 \
     --scenario gameplay --json tests/reports/YYYY-MM-DD-<dump>-<N>f.json
```

ROM передаётся по абсолютному пути и в отчёт не попадает (только SHA-256,
размер и маппер). WAV/PNG — только в `/tmp`, не сюда. Если отчёт планируется
коммитить, не передавайте `--ram-at` (иначе в отчёте появятся RAM-дампы) и
`--wav/--png`.

Имя файла: `YYYY-MM-DD-<короткое имя дампа>-<кадров>f.json`, например
`2026-11-26-ru-mapper3-120f.json`.

## Формат JSON

| Поле | Содержимое |
|---|---|
| `tool`, `version`, `generatedAt` | версия инструмента и время прогона |
| `note` | напоминание: только хэши/метаданные |
| `rom {sha256,size,mapper}` | идентификация ROM без самих данных |
| `chrReferenceCaveat` | предупреждение для mapper 148 (JSNES-эталон = NROM, CHR-банки не переключаются) |
| `engines {reference,ours}` | версии JSNES/нашего движка |
| `frames`, `sampleRate`, `scenario` | параметры прогона; сценарий в именах кнопок |
| `settings {ramAt,pngAt,mockApu}` | настройки |
| `reference / ours {frameHashes[],ramDumps[],audio,pngFiles,elapsedMs}` | по кадру: `{frame, sha256, cycles, pc}`; RAM-дампы только по запросу; аудио — счётчик и SHA-256; PNG-пути только для локальных прогонов |
| `comparison` | `identical`, `comparedFrames`, `firstMismatchFrame`, `mismatchCount`, `mismatches[]`, `firstRamMismatchFrame`, `ramDiffAtFirstRamMismatch` (счётчик/смещения/пары байт), `cycles {firstDiffFrame, mismatchFrames, maxDelta, lastDelta}`, `audioDiff` |

Код выхода `tools/compare.mjs`: 0 — совпало, 1 — расхождения, 2 — движок не готов.
Отчёт пишется и при расхождениях: это снимок состояния совместимости.

## Что нельзя коммитить

- ROM-файлы и любые дампы CHR/PRG (даже «маленькие фрагменты»);
- скриншоты/PNG кадров игры, WAV-записи музыки;
- полные RAM-дампы (`--ram-at` с hex) для известных коммерческих дампов — они
  могут содержать производные данные игры;
- `tools/.cache/` (CPU-тест Klaus скачивается заново в CI, SHA-256 в коде).

Сравнение кадров на mapper 148 (EN-дамп) побайтово некорректно из-за
dev-патча JSNES 148→NROM; для такого дампа показательны RAM/циклы. RU-дамп
(mapper 3) JSNES поддерживает нативно — кадры сравнимы побайтово.
