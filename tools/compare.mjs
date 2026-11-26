#!/usr/bin/env node
// Побайтовое сравнение нашего движка с эталоном JSNES 2.1.0 (dev-only).
//
// Один и тот же ROM и сценарий ввода прогоняются обоими движками; сравниваются
// SHA-256 кадров (Uint32Array 256×240, BGR 0x00BBGGRR), RAM $0000-$07FF,
// при желании — аудио и PNG (в /tmp).
//
// Примеры:
//   node tools/compare.mjs --rom /path/game.nes --frames 600 --scenario gameplay
//   node tools/compare.mjs --rom /path/game.nes --frames 200 --engine=ours
//   node tools/compare.mjs --rom /path/game.nes --frames 600 --input /tmp/in.json \
//        --ram-at 1,60,600 --wav /tmp/cmp --png-at 200 --png /tmp/cmp --json /tmp/report.json
//
// Наш движок подключается динамически: src/nes/console.js → createConsole(rom,
// {sampleRate, onAudioSample}); кадр — console.frame(); буфер — console.ppu.buffer;
// RAM — console.cpuMem. Если модулей ядра ещё нет, инструмент сообщает об этом
// понятной ошибкой (код выхода 2), а не падает трейсом.
//
// Код выхода: 0 — расхождений нет, 1 — есть расхождения, 2 — движок не готов / ошибка.

import { readFile, writeFile } from 'node:fs/promises';
import { sha256Hex, hashFrameBuffer, hashSamples, ramDump, diffRam } from './reference/hashing.mjs';
import { normalizeScenario, applyScenarioAtFrame, scenarioToJson, SCENARIOS } from './reference/scenario.mjs';
import { writeWav } from './reference/wav.mjs';
import { writePng, framePngPath } from './reference/png.mjs';
import {
  isMain,
  parseArgs,
  intOption,
  intListOption,
  formatError,
  NotReadyError,
} from './reference/cli.mjs';

export const COMPARE_TOOL_VERSION = 1;

// --- наш движок -------------------------------------------------------------

/** Тихое APU-заглушка для раннего сравнения кадров, пока src/nes/apu.js нет. */
function createSilentApu({ sampleRate = 48000 } = {}) {
  return {
    sampleRate,
    irqPending: false,
    channels: { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 },
    reset() {},
    advance() {},
    writeReg() {},
    readReg() {
      return 0;
    },
    acknowledgeIrq() {},
    toJSON() {
      return {};
    },
    fromJSON() {},
  };
}

/**
 * Динамически подключает наш движок и понятно объясняет, чего не хватает.
 * @returns {Promise<{createConsole: Function, Console?: Function}>}
 */
export async function loadOurEngine() {
  const moduleUrl = new URL('../src/nes/console.js', import.meta.url);
  let module;
  try {
    module = await import(moduleUrl);
  } catch (error) {
    throw new NotReadyError(
      `Наш движок ещё не загружается: ${formatError(error)}. ` +
        'Инструмент готов и запустится, когда появятся src/nes/console.js, ppu.js и apu.js.',
    );
  }
  if (typeof module.createConsole !== 'function') {
    throw new NotReadyError('src/nes/console.js не экспортирует createConsole(romBytes, options).');
  }
  return module;
}

function frameMethodOf(consoleInstance) {
  const method = consoleInstance.frame ?? consoleInstance.runFrame ?? consoleInstance.stepFrame;
  if (typeof method !== 'function') {
    throw new NotReadyError('У нашего Console нет метода frame()/runFrame(): сравнение кадров невозможно.');
  }
  return method.bind(consoleInstance);
}

function ramOf(consoleInstance) {
  const ram = consoleInstance.cpuMem ?? consoleInstance.cpu?.mem ?? null;
  if (!ram || ram.length < 0x800) {
    throw new NotReadyError('У нашего Console нет живой RAM (console.cpuMem / console.cpu.mem).');
  }
  return ram;
}

function buttonFns(consoleInstance) {
  if (typeof consoleInstance.buttonDown !== 'function') {
    throw new NotReadyError('У нашего Console нет buttonDown/buttonUp.');
  }
  // Контракт §3.2: player 1-based + код JSNES 0..7. Старый JSNES-фасад — (player, code).
  return {
    down: code => consoleInstance.buttonDown(1, code),
    up: code => consoleInstance.buttonUp(1, code),
  };
}

/**
 * Прогон нашего движка на N кадров.
 * @param {{
 *   romBytes: Uint8Array, frames: number, scenario?: any, sampleRate?: number,
 *   ramAt?: number[], ramHex?: boolean, pngAt?: number[], pngPrefix?: string|null,
 *   wavPath?: string|null, allowMockApu?: boolean,
 *   onFrameEnd?: (frame:number, info:any) => void,
 * }} options
 */
export async function runOurs(options) {
  const {
    romBytes,
    frames,
    scenario: rawScenario = [],
    sampleRate = 48000,
    ramAt = [],
    ramHex = true,
    pngAt = [],
    pngPrefix = null,
    wavPath = null,
    allowMockApu = false,
    collectRamSnapshots = false,
    clipToTvSize = false,
  } = options;
  const scenario = normalizeScenario(rawScenario);
  const engine = await loadOurEngine();
  const left = [];
  const right = [];
  const consoleOptions = {
    sampleRate,
    onAudioSample: (l, r) => {
      left.push(l);
      right.push(r);
    },
  };
  let mockApu = false;
  if (allowMockApu) {
    consoleOptions.apu = createSilentApu({ sampleRate });
    mockApu = true;
  }
  let consoleInstance;
  const startedAt = Date.now();
  try {
    consoleInstance = await engine.createConsole(romBytes, consoleOptions);
  } catch (error) {
    throw new NotReadyError(
      `Наш Console не создался: ${formatError(error)}. ` +
        (allowMockApu ? '' : 'Если APU ещё не готов, можно временно добавить --allow-mock-apu.'),
    );
  }
  const runFrame = frameMethodOf(consoleInstance);
  // JSNES-совместимый дефолт PPU — clipToTvSize=true (обрезка «телевизора»).
  // Для сравнения полного кадра 256×240 выключаем её у обеих сторон.
  if (consoleInstance.ppu && 'clipToTvSize' in consoleInstance.ppu) {
    consoleInstance.ppu.clipToTvSize = clipToTvSize;
  } else if (consoleInstance.ppu) {
    consoleInstance.ppu.clipToTvSize = clipToTvSize;
  }
  const ram = ramOf(consoleInstance);
  const buttons = buttonFns(consoleInstance);
  const ppu = consoleInstance.ppu;
  if (!ppu || !(ppu.buffer instanceof Uint32Array)) {
    throw new NotReadyError('У нашего Console нет ppu.buffer (Uint32Array 256×240) — сравнивать кадры не с чем.');
  }

  const frameSet = new Set(ramAt);
  const pngFrameSet = new Set(pngAt);
  const ramSnapshots = collectRamSnapshots ? [] : null;
  const result = {
    engine: 'ours',
    engineVersion: 'local',
    mockApu,
    rom: {
      sha256: sha256Hex(romBytes),
      size: romBytes.length,
      mapper: (romBytes[6] >> 4) | (romBytes[7] & 0xf0),
    },
    sampleRate,
    frames,
    scenario: scenarioToJson(scenario),
    frameHashes: [],
    ramDumps: [],
    pngFiles: [],
    audio: null,
  };

  for (let frame = 1; frame <= frames; frame++) {
    applyScenarioAtFrame(scenario, frame, buttons.down, buttons.up);
    runFrame();
    const buffer = ppu.buffer;
    const frameHash = hashFrameBuffer(buffer);
    const frameInfo = {
      frame,
      sha256: frameHash,
      cycles: consoleInstance.cycles ?? null,
      pc: consoleInstance.pc ?? null,
    };
    result.frameHashes.push(frameInfo);
    if (frameSet.has(frame)) {
      result.ramDumps.push({ frame, ...ramDump(ram, { start: 0, end: 0x800, hex: ramHex }) });
    }
    if (ramSnapshots) ramSnapshots.push(Uint8Array.from(ram.subarray(0, 0x800)));
    if (pngFrameSet.has(frame)) {
      result.pngFiles.push(await writePng(framePngPath(pngPrefix, frame), buffer));
    }
  }
  result.elapsedMs = Date.now() - startedAt;

  if (left.length && right.length) {
    const audio = {
      sampleRate,
      sampleCount: Math.min(left.length, right.length),
      sha256: hashSamples(left, right),
    };
    if (wavPath) audio.wav = await writeWav(wavPath, { sampleRate, left, right });
    if (options.returnSamples) audio.samples = { left, right };
    result.audio = audio;
  }
  return { result, consoleInstance, ram, ramSnapshots };
}

// --- сравнение --------------------------------------------------------------

/**
 * Сравнивает результаты двух прогонов (одинаковая длина, кадры 1-based).
 * @param {any} reference результат runJsnes
 * @param {any} ours результат runOurs().result
 * @param {{maxReport?: number, referenceRam?: Uint8Array[]|null, oursRam?: Uint8Array[]|null}} [options]
 */
export function compareRuns(reference, ours, options = {}) {
  const { maxReport = 10, referenceRam = null, oursRam = null } = options;
  const length = Math.min(reference.frameHashes.length, ours.frameHashes.length);
  const mismatches = [];
  let firstMismatchFrame = null;
  let mismatchCount = 0;
  for (let index = 0; index < length; index++) {
    const refFrame = reference.frameHashes[index];
    const ourFrame = ours.frameHashes[index];
    if (refFrame.sha256 === ourFrame.sha256) continue;
    mismatchCount++;
    if (firstMismatchFrame === null) firstMismatchFrame = refFrame.frame;
    if (mismatches.length < maxReport) {
      mismatches.push({
        frame: refFrame.frame,
        jsnes: refFrame.sha256,
        ours: ourFrame.sha256,
        jsnesCycles: refFrame.cycles,
        oursCycles: ourFrame.cycles,
        jsnesPc: refFrame.pc,
        oursPc: ourFrame.pc,
      });
    }
  }

  // Первый кадр, где разошлась RAM (даже если картинка ещё совпадает).
  let firstRamMismatchFrame = null;
  let ramDiffAtFirstMismatch = null;
  let ramDiffAtFirstRamMismatch = null;
  if (referenceRam && oursRam) {
    const ramLength = Math.min(referenceRam.length, oursRam.length);
    for (let index = 0; index < ramLength; index++) {
      const diff = diffRam(referenceRam[index], oursRam[index], { maxDiffs: 8 });
      if (diff.count === 0) continue;
      if (firstRamMismatchFrame === null) {
        firstRamMismatchFrame = index + 1;
        ramDiffAtFirstRamMismatch = diff;
      }
      if (index + 1 === firstMismatchFrame) ramDiffAtFirstMismatch = diff;
      if (firstMismatchFrame !== null && index + 1 > firstMismatchFrame) break;
    }
  }

  // Аудио: сравниваем сэмплы, если оба движка их отдают.
  let audioDiff = null;
  const refSamples = reference.audio?.samples;
  const ourSamples = ours.audio?.samples;
  if (refSamples && ourSamples) {
    const count = Math.min(refSamples.left.length, ourSamples.left.length);
    let firstDiffSample = null;
    let maxAbsDiff = 0;
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      const dl = Math.abs(refSamples.left[i] - ourSamples.left[i]);
      const dr = Math.abs(refSamples.right[i] - ourSamples.right[i]);
      const d = Math.max(dl, dr);
      if (d > 1e-3 && firstDiffSample === null) firstDiffSample = i;
      if (d > maxAbsDiff) maxAbsDiff = d;
      sumSquares += dl * dl + dr * dr;
    }
    audioDiff = {
      jsnesSamples: refSamples.left.length,
      oursSamples: ourSamples.left.length,
      firstDiffSample,
      maxAbsDiff: Number(maxAbsDiff.toFixed(6)),
      rmsDiff: Number(Math.sqrt(sumSquares / Math.max(1, count * 2)).toFixed(6)),
    };
  }

  // Циклы на кадрах: полезно и для mapper148, где кадровый буфер сравнивать
  // побайтово нельзя из-за dev-патча JSNES 148→NROM (CHR-банки не переключаются).
  let firstCycleDiffFrame = null;
  let maxCycleDelta = 0;
  let cycleMismatchFrames = 0;
  for (let index = 0; index < length; index++) {
    const refCycles = reference.frameHashes[index].cycles;
    const ourCycles = ours.frameHashes[index].cycles;
    if (refCycles == null || ourCycles == null) continue;
    const delta = ourCycles - refCycles;
    if (delta === 0) continue;
    cycleMismatchFrames++;
    if (firstCycleDiffFrame === null) firstCycleDiffFrame = reference.frameHashes[index].frame;
    if (Math.abs(delta) > Math.abs(maxCycleDelta)) maxCycleDelta = delta;
  }

  return {
    identical: mismatchCount === 0 && firstMismatchFrame === null,
    comparedFrames: length,
    firstMismatchFrame,
    mismatchCount,
    mismatches,
    firstRamMismatchFrame,
    ramDiffAtFirstMismatch,
    ramDiffAtFirstRamMismatch,
    cycles: {
      firstDiffFrame: firstCycleDiffFrame,
      mismatchFrames: cycleMismatchFrames,
      maxDelta: maxCycleDelta,
      lastDelta:
        reference.frameHashes.at(-1)?.cycles != null && ours.frameHashes.at(-1)?.cycles != null
          ? ours.frameHashes.at(-1).cycles - reference.frameHashes.at(-1).cycles
          : null,
    },
    audioDiff,
  };
}

// --- CLI --------------------------------------------------------------------

function parsePressItems(text) {
  return text
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const match = /^([a-z0-9+]+)@(\d+)(?:\+(\d+))?$/i.exec(item);
      if (!match) throw new Error(`Неверный --press "${item}". Формат: кнопка@кадр[+удержание].`);
      const event = { frame: Number(match[2]), buttons: match[1].split('+') };
      if (match[3] !== undefined) event.hold = Number(match[3]);
      return event;
    });
}

async function resolveScenarioFromArgs(args) {
  if (args.input !== undefined) {
    const text = await readFile(String(args.input), 'utf8');
    try {
      return normalizeScenario(JSON.parse(text));
    } catch (error) {
      throw new Error(`${args.input}: не удалось разобрать сценарий (${error.message}).`);
    }
  }
  const events = [];
  if (args.scenario !== undefined) {
    const name = String(args.scenario);
    if (!(name in SCENARIOS)) throw new Error(`Неизвестный сценарий "${name}". Доступно: ${Object.keys(SCENARIOS).join(', ')}.`);
    events.push(...SCENARIOS[name]);
  }
  if (args.press !== undefined) events.push(...parsePressItems([].concat(args.press).join(',')));
  return normalizeScenario(events);
}

const HELP = `
Сравнение нашего движка с эталоном JSNES 2.1.0 (dev-only).

Использование:
  node tools/compare.mjs --rom <path.nes> [--frames N] [--engine=both|jsnes|ours]

Опции:
  --rom <path>          ROM игрока (обязательно; в репозиторий не копируется)
  --frames <N>          кадров сравнить (по умолчанию 600)
  --engine <mode>       both (по умолчанию) | jsnes | ours
  --scenario <name>     none | menu | gameplay
  --press <spec>        сценарий DSL: "start@100+4,a@140+4"
  --input <file.json>   файл со списком событий ввода
  --sample-rate <Hz>    частота аудио (по умолчанию 48000)
  --ram-at <список>     кадры с RAM-дампами в отчёте: "1,60,600"
  --no-ram-hex          в RAM-дампах только SHA-256 (без hex)
  --wav <prefix>        WAV-файлы: <prefix>-jsnes.wav и <prefix>-ours.wav (в /tmp)
  --png <prefix>        префикс PNG: <prefix>-<движок>-frameNNNNNN.png (в /tmp)
  --png-at <список>     кадры для PNG (обычно кадр расхождения)
  --json <path>         записать JSON-отчёт (куда коммитить: tests/reports/)
  --allow-mock-apu      dev-bring-up: тихая APU-заглушка, если src/nes/apu.js ещё нет
  --quiet               без человекочитаемого итога в stderr
  --help                эта справка

Код выхода: 0 — совпало, 1 — расхождения, 2 — движок не готов / ошибка.
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
  const engineMode = String(args.engine ?? 'both');
  if (!['both', 'jsnes', 'ours'].includes(engineMode)) {
    console.error(`Ошибка: --engine должен быть both|jsnes|ours, пришло "${engineMode}".`);
    process.exit(2);
  }
  const frames = intOption(args.frames, 600);
  const sampleRate = intOption(args['sample-rate'], 48000);
  const ramAt = intListOption(args['ram-at'], []);
  const pngAt = intListOption(args['png-at'], []);
  const pngPrefix = args.png ? String(args.png) : null;
  const wavPrefix = args.wav ? String(args.wav) : null;
  const quiet = args.quiet === true;

  let scenario;
  try {
    scenario = await resolveScenarioFromArgs(args);
  } catch (error) {
    console.error(`Ошибка сценария: ${error.message}`);
    process.exit(2);
  }

  let romBytes;
  try {
    romBytes = new Uint8Array(await readFile(String(args.rom)));
  } catch (error) {
    console.error(`Ошибка: не удалось прочитать ROM "${args.rom}": ${error.message}`);
    process.exit(2);
  }
  const romSha256 = sha256Hex(romBytes);
  const mapper = (romBytes[6] >> 4) | (romBytes[7] & 0xf0);
  const chrBankCaveat = mapper === 148;
  const report = {
    tool: 'compare',
    version: COMPARE_TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    note: 'Отчёт сравнения: только хэши и метаданные, без ROM и без дампов памяти.',
    rom: {
      sha256: romSha256,
      size: romBytes.length,
      mapper,
    },
    // JSNES 2.1.0 не поддерживает маппер 148; для эталона заголовок копии
    // объявлен как NROM, т.е. CHR-банки не переключаются. Кадровые хэши
    // сравнивать побайтово нельзя, RAM и циклы — можно.
    chrReferenceCaveat: chrBankCaveat
      ? 'JSNES-эталон для mapper 148 собран как NROM (dev-обход): CHR-банки не переключаются, кадры сравнивать побайтово нельзя; смотрите RAM/циклы.'
      : null,
    engines: { reference: 'jsnes 2.1.0', ours: 'local' },
    frames,
    sampleRate,
    scenario: scenarioToJson(scenario),
    settings: { ramAt, pngAt, mockApu: args['allow-mock-apu'] === true },
    reference: null,
    ours: null,
    comparison: null,
  };

  const referenceRam = [];
  const oursRam = [];
  let referenceSamples = null;
  let ourSamples = null;

  try {
    let reference = null;
    if (engineMode === 'both' || engineMode === 'jsnes') {
      const { runReferenceFile } = await import('./reference/run-jsnes.mjs');
      reference = await runReferenceFile({
        romPath: String(args.rom),
        frames,
        scenario,
        sampleRate,
        captureAudio: true,
        returnSamples: engineMode === 'both',
        ramAt,
        ramHex: args['no-ram-hex'] !== true,
        pngAt: pngPrefix ? pngAt : [],
        pngPrefix: pngPrefix ? `${pngPrefix}-jsnes` : null,
        wavPath: wavPrefix ? `${wavPrefix}-jsnes.wav` : null,
        onFrameEnd: (frame, nes) => {
          referenceRam[frame - 1] = Uint8Array.from(nes.cpu.mem.subarray(0, 0x800));
        },
      });
      referenceSamples = reference.audio?.samples ?? null;
      report.reference = {
        engine: reference.engine,
        engineVersion: reference.engineVersion,
        rom: { ...reference.rom },
        frameHashes: reference.frameHashes,
        ramDumps: reference.ramDumps,
        audio: reference.audio ? { ...reference.audio, samples: undefined } : null,
        pngFiles: reference.pngFiles,
        elapsedMs: reference.elapsedMs,
      };
      if (!quiet) {
        console.error(
          `JSNES: ${reference.frameHashes.length} кадров, ROM ${romSha256.slice(0, 12)}…, ` +
            `маппер ${reference.rom.mapper}${reference.rom.jsnesHeaderPatched ? '→NROM(dev)' : ''}`,
        );
      }
    }

    let ours = null;
    if (engineMode === 'both' || engineMode === 'ours') {
      const oursRun = await runOurs({
        romBytes,
        frames,
        scenario,
        sampleRate,
        ramAt,
        ramHex: args['no-ram-hex'] !== true,
        pngAt: pngPrefix ? pngAt : [],
        pngPrefix: pngPrefix ? `${pngPrefix}-ours` : null,
        wavPath: wavPrefix ? `${wavPrefix}-ours.wav` : null,
        allowMockApu: args['allow-mock-apu'] === true,
        returnSamples: engineMode === 'both',
        collectRamSnapshots: engineMode === 'both',
      });
      ours = oursRun.result;
      ourSamples = ours.audio?.samples ?? null;
      for (const snapshot of oursRun.ramSnapshots ?? []) oursRam.push(snapshot);
      report.ours = {
        engine: ours.engine,
        engineVersion: ours.engineVersion,
        mockApu: ours.mockApu,
        rom: ours.rom,
        frameHashes: ours.frameHashes,
        ramDumps: ours.ramDumps,
        audio: ours.audio ? { ...ours.audio, samples: undefined } : null,
        pngFiles: ours.pngFiles,
        elapsedMs: ours.elapsedMs,
      };
      if (!quiet) {
        console.error(
          `наш движок: ${ours.frameHashes.length} кадров${ours.mockApu ? ' (APU-заглушка)' : ''}` +
            (ours.audio ? `, аудио ${ours.audio.sampleCount} сэмплов` : ''),
        );
      }
    }

    if (engineMode === 'both') {
      // Сэмплы нужны для аудио-диффа, но в JSON-отчёт не попадают (большой объём).
      if (referenceSamples) report.reference.audio.samples = referenceSamples;
      if (ourSamples) report.ours.audio.samples = ourSamples;
      const comparison = compareRuns(report.reference, report.ours, {
        referenceRam,
        oursRam,
      });
      if (report.reference.audio) delete report.reference.audio.samples;
      if (report.ours.audio) delete report.ours.audio.samples;
      report.comparison = comparison;
      if (!quiet) {
        if (report.chrReferenceCaveat) console.error(`ℹ ${report.chrReferenceCaveat}`);
        if (comparison.cycles.firstDiffFrame !== null) {
          console.error(
            `  циклы: первое расхождение на кадре ${comparison.cycles.firstDiffFrame}, ` +
              `кадров с разницей ${comparison.cycles.mismatchFrames}, макс Δ ${comparison.cycles.maxDelta}, Δ на последнем ${comparison.cycles.lastDelta}`,
          );
        } else {
          console.error('  циклы на кадрах совпали.');
        }
        if (comparison.identical) {
          console.error(`✔ кадры и RAM совпали на ${comparison.comparedFrames} кадрах.`);
        } else {
          const first = comparison.mismatches[0];
          console.error(
            `✘ первое расхождение кадров: ${comparison.firstMismatchFrame} ` +
              `(jsnes ${first.jsnes.slice(0, 16)}… / ours ${first.ours.slice(0, 16)}…)`,
          );
          console.error(
            `  всего расхождений: ${comparison.mismatchCount}/${comparison.comparedFrames}` +
              (comparison.firstRamMismatchFrame ? `; первое расхождение RAM: кадр ${comparison.firstRamMismatchFrame}` : ''),
          );
          if (comparison.ramDiffAtFirstRamMismatch) {
            const diff = comparison.ramDiffAtFirstRamMismatch;
            console.error(
              `  RAM впервые разошлась на кадре ${comparison.firstRamMismatchFrame}: ${diff.count} байт, ` +
                `первый $${diff.firstOffset.toString(16).padStart(4, '0')} ` +
                `(jsnes $${diff.diffs[0]?.a?.toString(16)}, ours $${diff.diffs[0]?.b?.toString(16)})`,
            );
          }
          if (comparison.ramDiffAtFirstMismatch) {
            const diff = comparison.ramDiffAtFirstMismatch;
            console.error(
              `  RAM на кадре ${comparison.firstMismatchFrame}: ${diff.count} байт, первый $${diff.firstOffset.toString(16).padStart(4, '0')}` +
                ` (jsnes ${diff.diffs[0]?.a?.toString(16)} / ours ${diff.diffs[0]?.b?.toString(16)})`,
            );
          }
          if (comparison.audioDiff) {
            console.error(
              `  аудио: сэмплы ${comparison.audioDiff.jsnesSamples}/${comparison.audioDiff.oursSamples}, ` +
                `первое расхождение ${comparison.audioDiff.firstDiffSample}, max|Δ| ${comparison.audioDiff.maxAbsDiff}, RMS ${comparison.audioDiff.rmsDiff}`,
            );
          }
        }
      }
    }

    const json = JSON.stringify(report, null, 2);
    if (args.json) await writeFile(String(args.json), json + '\n');
    else process.stdout.write(json + '\n');
    if (args.json && !quiet) console.error(`Отчёт: ${args.json}`);

  } catch (error) {
    if (error instanceof NotReadyError) {
      console.error(`\nДвижок не готов: ${error.message}`);
      process.exit(2);
    }
    console.error(`Ошибка сравнения: ${formatError(error)}`);
    process.exit(2);
  }

  if (report.comparison && !report.comparison.identical) process.exit(1);
}

if (isMain(import.meta.url)) {
  await main();
}
