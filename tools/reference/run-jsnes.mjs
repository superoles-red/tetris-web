#!/usr/bin/env node
// Эталонный прогон JSNES 2.1.0 на ROM игрока (dev-only).
//
// API:
//   import { runReferenceFile, runReference } from './tools/reference/run-jsnes.mjs';
//   const result = await runReferenceFile({ romPath, frames: 600, scenario: 'gameplay' });
//
// CLI-примеры (ROM читается по абсолютному пути, в репозиторий не копируется):
//   node tools/reference/run-jsnes.mjs --rom /path/game.nes --frames 600 \
//        --scenario gameplay --ram-at 1,60,600 --json /tmp/jsnes.json
//   node tools/reference/run-jsnes.mjs --rom /path/game.nes --frames 300 \
//        --press start@100+4 --ppu-at 200 --wav /tmp/ref.wav
//
// Формат кадра в SHA-256: Uint32Array(256*240) цвета 0x00BBGGRR, байты
// little-endian. Номера кадров в выводе 1-based.

import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { sha256Hex } from './hashing.mjs';
import { runJsnes, JSNES_VERSION } from './jsnes-runner.mjs';
import { normalizeScenario, parseScenarioText, SCENARIOS } from './scenario.mjs';
import { capturePpuState } from './ppu-state.mjs';
import { isMain, parseArgs, intOption, intListOption, formatError } from './cli.mjs';

/**
 * Прогон эталона из файла ROM.
 * @param {{romPath: string} & Parameters<typeof runJsnes>[0]} options
 */
export async function runReferenceFile(options) {
  const { romPath, ...rest } = options;
  if (!romPath) throw new Error('Не задан путь к ROM (--rom).');
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(romPath));
  } catch (error) {
    throw new Error(`Не удалось прочитать ROM "${romPath}": ${error.message}`);
  }
  const result = await runJsnes({ ...rest, romBytes: bytes });
  result.rom.path = romPath;
  return result;
}

/** Разбор --scenario/--press в нормализованный сценарий. */
export function resolveScenario(args) {
  const events = [];
  if (args.scenario !== undefined) {
    const name = String(args.scenario);
    if (!(name in SCENARIOS)) {
      throw new Error(`Неизвестный сценарий "${name}". Доступно: ${Object.keys(SCENARIOS).join(', ')}.`);
    }
    events.push(...SCENARIOS[name]);
  }
  if (args.press !== undefined) {
    events.push(...parseScenarioText([].concat(args.press).join(',')));
  }
  return normalizeScenario(events);
}

const HELP = `
Эталонный прогон JSNES ${JSNES_VERSION} на ROM (dev-only).

Использование:
  node tools/reference/run-jsnes.mjs --rom <path.nes> [опции]

Опции:
  --rom <path>          ROM игрока (обязательно; в репозиторий не копируется)
  --frames <N>          сколько кадров прогнать (по умолчанию 600)
  --scenario <name>     none | menu | gameplay
  --press <spec>        сценарий DSL: "start@100+4,a@140+4" (можно повторять)
  --input <file.json>   файл со списком событий ввода
  --sample-rate <Hz>    частота аудио для эталона (по умолчанию 48000)
  --no-audio            не собирать аудио-сэмплы
  --wav <path>          записать WAV (обычно в /tmp)
  --ram-at <список>     кадры для RAM-дампов: "1,60,600"
  --ram-start <addr>    начало RAM-дампа (по умолчанию 0)
  --ram-end <addr>      конец RAM-дампа (по умолчанию 0x800)
  --no-ram-hex          не включать hex в RAM-дампы (только SHA-256)
  --ppu-at <список>     кадры для снятия состояния PPU (JSON)
  --png-at <список>     кадры для PNG (в /tmp)
  --png-prefix <path>   префикс путей PNG, например /tmp/ref
  --json <path>         записать JSON в файл (иначе JSON идёт в stdout)
  --quiet               без человекочитаемого итога в stderr
  --help                эта справка
`;

async function main() {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(HELP.trimStart() + '\n');
    return;
  }
  if (!args.rom) {
    console.error('Ошибка: нужен --rom <path.nes>. См. --help.');
    process.exit(2);
  }
  let scenario;
  if (args.input !== undefined) {
    const text = await readFile(String(args.input), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error(`Ошибка: ${args.input} — не JSON (${error.message}).`);
      process.exit(2);
    }
    scenario = normalizeScenario(parsed);
  } else {
    scenario = resolveScenario(args);
  }
  try {
    const result = await runReferenceFile({
      romPath: String(args.rom),
      frames: intOption(args.frames, 600),
      scenario,
      sampleRate: intOption(args['sample-rate'], 48000),
      captureAudio: args['no-audio'] !== true,
      ramAt: intListOption(args['ram-at'], []),
      ramStart: intOption(args['ram-start'], 0x0000),
      ramEnd: intOption(args['ram-end'], 0x0800),
      ramHex: args['no-ram-hex'] !== true,
      ppuAt: intListOption(args['ppu-at'], []),
      capturePpuState,
      pngAt: intListOption(args['png-at'], []),
      pngPrefix: args['png-prefix'] ? String(args['png-prefix']) : null,
      wavPath: args.wav ? String(args.wav) : null,
    });
    const json = JSON.stringify(result, null, 2);
    if (args.json) {
      await writeFile(String(args.json), json + '\n');
    } else {
      process.stdout.write(json + '\n');
    }
    if (!args.quiet) {
      const { rom, frameHashes, audio, ramDumps, ppuStates, pngFiles } = result;
      console.error(
        `JSNES ${JSNES_VERSION}: ${frameHashes.length} кадров, ROM ${rom.sha256.slice(0, 12)}… ` +
          `маппер ${rom.mapper}${rom.jsnesHeaderPatched ? '→NROM(dev)' : ''}`,
      );
      if (frameHashes.length) {
        console.error(`  первый кадр ${frameHashes[0].sha256.slice(0, 16)}…, последний ${frameHashes.at(-1).sha256.slice(0, 16)}…`);
      }
      if (ramDumps.length) console.error(`  RAM-дампы: ${ramDumps.map(d => d.frame).join(', ')}`);
      if (ppuStates.length) console.error(`  PPU-состояния: ${ppuStates.map(s => s.frame).join(', ')}`);
      if (audio) console.error(`  аудио: ${audio.sampleCount} сэмплов @${audio.sampleRate} Гц, sha ${audio.sha256.slice(0, 16)}…`);
      for (const file of pngFiles) console.error(`  PNG: ${file.path}`);
      if (args.json) console.error(`  JSON: ${args.json}`);
    }
  } catch (error) {
    console.error(`Ошибка эталона: ${formatError(error)}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
