#!/usr/bin/env node
// Лог записей в APU-регистры с номерами CPU-циклов + эталонные сэмплы
// JSNES 2.1.0 — для дифференциального теста APU (dev-only).
//
// API:
//   import { runApuLog, replayApuWrites } from './tools/reference/apu-log.mjs';
//   const log = await runApuLog({ romPath, frames: 600 });
//   // log.apuWrites: [{frame, cycle, address, value}], log.audio: {sampleCount,...}
//
// CLI:
//   node tools/reference/apu-log.mjs --rom /path/game.nes --frames 600 \
//        --scenario gameplay --wav /tmp/ref.wav --out /tmp/apu-log.json
//
// Циклы: абсолютное число CPU-циклов с момента loadROM (JSNES cpu._cpuCycleBase
// + счётчик шинных циклов текущей инструкции). Порядок записей сохраняется;
// replayApuWrites() воспроизводит его на нашей модели APU между вызовами advance.

import { readFile, writeFile } from 'node:fs/promises';
import { runJsnes } from './jsnes-runner.mjs';
import { normalizeScenario, SCENARIOS } from './scenario.mjs';
import { isMain, parseArgs, intOption, formatError } from './cli.mjs';

/**
 * Прогон JSNES с логом записей APU.
 * @param {{
 *   romPath?: string, romBytes?: Uint8Array,
 *   frames?: number, scenario?: any, sampleRate?: number,
 *   wavPath?: string|null, includeSamples?: boolean, clipToTvSize?: boolean,
 * }} options
 */
export async function runApuLog(options) {
  const {
    romPath,
    romBytes,
    frames = 600,
    scenario = [],
    sampleRate = 48000,
    wavPath = null,
    includeSamples = false,
    clipToTvSize = false,
  } = options;
  let bytes = romBytes;
  if (!bytes) {
    if (!romPath) throw new Error('runApuLog: нужен romPath или romBytes.');
    try {
      bytes = new Uint8Array(await readFile(romPath));
    } catch (error) {
      throw new Error(`Не удалось прочитать ROM "${romPath}": ${error.message}`);
    }
  }

  let currentFrame = 0;
  let nesRef = null;
  const apuWrites = [];
  const normalized = normalizeScenario(scenario);
  const result = await runJsnes({
    romBytes: bytes,
    frames,
    scenario: normalized,
    sampleRate,
    captureAudio: true,
    returnSamples: includeSamples,
    clipToTvSize,
    wavPath,
    onReady: nes => {
      nesRef = nes;
      const papu = nes.papu;
      const originalWrite = papu.writeReg.bind(papu);
      // Записи APU делаются из mid-instruction импорта записи: фиксируем цикл
      // на момент вызова. 0x4014 (DMA) и 0x4016 (контроллер) сюда не доходят.
      papu.writeReg = (address, value) => {
        const cycle = nes.cpu._cpuCycleBase + (nes.cpu.instrBusCycles ?? 0);
        apuWrites.push({
          frame: currentFrame,
          cycle,
          address: address & 0xff,
          addressHex: `$${((address & 0xff) + 0x4000).toString(16).padStart(4, '0')}`,
          value: value & 0xff,
        });
        return originalWrite(address, value);
      };
    },
    onFrameStart: frame => {
      currentFrame = frame;
    },
  });
  if (!nesRef) throw new Error('runApuLog: JSNES не инициализировался.');

  const log = {
    engine: result.engine,
    engineVersion: result.engineVersion,
    rom: { ...result.rom, path: romPath ?? null },
    sampleRate,
    clipToTvSize,
    frames,
    scenario: result.scenario,
    frameCycles: result.frameHashes.map(frame => ({ frame: frame.frame, cycles: frame.cycles })),
    apuWrites,
    audio: result.audio
      ? {
          sampleRate: result.audio.sampleRate,
          sampleCount: result.audio.sampleCount,
          sha256: result.audio.sha256,
          ...(result.audio.wav ? { wav: result.audio.wav } : {}),
          ...(includeSamples && result.audio.samples ? { samples: result.audio.samples } : {}),
        }
      : null,
  };
  return log;
}

/**
 * Воспроизводит лог записей через нашу модель APU.
 * @param {any} apu  экземпляр нашего APU (advance/writeReg)
 * @param {{apuWrites: {cycle:number, address:number, value:number}[]}} log
 * @returns {number} сколько CPU-циклов продвинуто
 */
export function replayApuWrites(apu, log) {
  let cycle = 0;
  const writes = log.apuWrites ?? log;
  for (const write of writes) {
    const delta = Math.max(0, write.cycle - cycle);
    if (delta > 0) {
      apu.advance(delta);
      cycle += delta;
    }
    apu.writeReg(write.address, write.value);
  }
  return cycle;
}

const HELP = `
Лог записей APU JSNES (dev-only).

Использование:
  node tools/reference/apu-log.mjs --rom <path.nes> --frames 600 [опции]

Опции:
  --frames <N>            кадров прогнать (по умолчанию 600)
  --scenario <name>       none | menu | gameplay
  --press <spec>          сценарий DSL: "start@100+4"
  --input <file.json>     файл со списком событий ввода
  --sample-rate <Hz>      частота сэмплов эталона (по умолчанию 48000)
  --wav <path>            записать эталонный WAV (обычно в /tmp)
  --samples               включить сами сэмплы в JSON (большой файл)
  --out <path>            записать JSON в файл (иначе stdout)
  --quiet                 без итога в stderr
  --help                  эта справка
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
  let scenario = [];
  if (args.scenario !== undefined) {
    const name = String(args.scenario);
    if (!(name in SCENARIOS)) {
      console.error(`Ошибка: неизвестный сценарий "${name}". Доступно: ${Object.keys(SCENARIOS).join(', ')}.`);
      process.exit(2);
    }
    scenario = SCENARIOS[name];
  }
  if (args.input !== undefined) {
    scenario = JSON.parse(await readFile(String(args.input), 'utf8'));
  }
  try {
    const log = await runApuLog({
      romPath: String(args.rom),
      frames: intOption(args.frames, 600),
      scenario,
      sampleRate: intOption(args['sample-rate'], 48000),
      wavPath: args.wav ? String(args.wav) : null,
      includeSamples: args.samples === true,
    });
    const json = JSON.stringify(log, null, 2);
    if (args.out) await writeFile(String(args.out), json + '\n');
    else process.stdout.write(json + '\n');
    if (!args.quiet) {
      console.error(
        `JSNES ${log.engineVersion}: ${log.apuWrites.length} записей APU за ${log.frames} кадров ` +
          `(${log.apuWrites.filter(w => w.value !== undefined).length} с данными)`,
      );
      if (log.audio) console.error(`  аудио: ${log.audio.sampleCount} сэмплов, sha ${log.audio.sha256.slice(0, 16)}…`);
      if (args.out) console.error(`  JSON: ${args.out}`);
    }
  } catch (error) {
    console.error(`Ошибка apu-log: ${formatError(error)}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
