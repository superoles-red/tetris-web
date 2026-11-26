#!/usr/bin/env node
// Дифференциальный тест PPU против JSNES 2.1.0 (dev-only эталон).
//
// Что делает:
//   1) загружает реальный ROM (по абсолютному пути, в репозиторий не копируется)
//      в JSNES 2.1.0 из node_modules (озвучен как devDependency, Apаche-2.0);
//   2) прогоняет сценарий ввода (START/A), чтобы игра дошла до геймплея;
//   3) на контрольных кадрах снимает состояние PPU у JSNES (toJSON) и его кадр;
//   4) применяет состояние к нашему src/nes/ppu.js через fromJSON, рендерит
//      renderFullFrame() и сравнивает buffer побайтово с эталоном;
//   5) дополнительно проверяет, что наш own advanceDots-путь (startFrame +
//      полный кадр точек) даёт тот же буфер, что и renderFullFrame.
//
// JSNES не умеет маппер 148 (Tengen) — для `game.nes` заголовок в памяти
// патчится на mapper 0 (dev-обход, ROM на диске не меняется). Для PPU-рендера
// это безопасно: PRG фиксирован, CHR-банки в тесте не переключаются.
//
// Запуск:
//   node tools/ppu/diff-jsnes.mjs [--rom <путь>] [--frames 320]
//                                 [--check 10,20,40,...] [--json]
//
// Без ROM инструмент сообщает об этом и выходит с кодом 0 (skip).

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PPU, PPU_STATE_FORMAT } from '../../src/nes/ppu.js';
import { PPU_SCANLINES } from '../../src/nes/constants.js';
import { parseRom } from '../../src/nes/rom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

export const DEFAULT_ROMS = [
  '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game.nes',
  '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game-ru.nes',
];

// Кадры, на которых состояние PPU стабильно (не середина переключения экрана):
// экран загрузки/титул/меню, включение рендера и геймплей после кадра ~192.
export const DEFAULT_CHECK_FRAMES = [10, 20, 40, 65, 73, 102, 132, 162, 193, 201, 210];
export const DEFAULT_TOTAL_FRAMES = 220;

/** FNV-1a по байтам буфера — короткий отпечаток кадра для отчёта. */
export function hashBuffer(buffer) {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Читает ROM и при необходимости правит в памяти iNES-заголовок, чтобы JSNES
 * мог его загрузить: mapper 148 он не поддерживает. Возвращает {bytes, patchedFrom}.
 */
export function loadJsnesRom(path) {
  if (!existsSync(path)) return null;
  const bytes = new Uint8Array(readFileSync(path));
  const sha256sum = sha256(bytes);
  const parsed = parseRom(bytes);
  let patchedFrom = null;
  if (parsed.mapper === 148) {
    // iNES: младший ниббл маппера в byte 6 (bits 4-7), старший — в byte 7.
    bytes[6] = (bytes[6] & 0x0f) | 0x00;
    bytes[7] = bytes[7] & 0x0f;
    patchedFrom = 148;
  }
  return { bytes, patchedFrom, mirroring: parsed.mirroring, sha256: sha256sum };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Динмаческий импорт JSNES (в CI devDependency ставится через `npm ci`). */
async function importJsnes() {
  try {
    const mod = await import('jsnes');
    return mod.default ?? mod.NES ?? mod;
  } catch (error) {
    return { error };
  }
}

/**
 * Переводит состояние PPU JSNES 2.1.0 в формат нашего fromJSON.
 * Нумерация строк: у JSNES внутренняя (0 = NES 241, 20 = pre-render 261,
 * 21..260 = видимые 0..239, 261 = NES 240). У нас физическая NTSC-нумерация,
 * поэтому scanline переводится как (internal + 241) % 262.
 * @param {object} jsnesPPU
 * @param {Uint8Array} cpuMem память CPU JSNES (флаги $2002 хранятся там)
 */
export function adaptJsnesState(jsnesPPU, cpuMem, { clipToTvSize = false } = {}) {
  const status = cpuMem ? cpuMem[0x2002] : 0;
  return {
    format: PPU_STATE_FORMAT,
    vramMem: Array.from(jsnesPPU.vramMem),
    spriteMem: Array.from(jsnesPPU.spriteMem),
    imgPalette: Array.from(jsnesPPU.imgPalette),
    sprPalette: Array.from(jsnesPPU.sprPalette),
    f_nmiOnVblank: jsnesPPU.f_nmiOnVblank,
    f_spriteSize: jsnesPPU.f_spriteSize,
    f_bgPatternTable: jsnesPPU.f_bgPatternTable,
    f_spPatternTable: jsnesPPU.f_spPatternTable,
    f_addrInc: jsnesPPU.f_addrInc,
    f_nTblAddress: jsnesPPU.f_nTblAddress,
    f_color: jsnesPPU.f_color,
    f_spVisibility: jsnesPPU.f_spVisibility,
    f_bgVisibility: jsnesPPU.f_bgVisibility,
    f_spClipping: jsnesPPU.f_spClipping,
    f_bgClipping: jsnesPPU.f_bgClipping,
    f_dispType: jsnesPPU.f_dispType,
    regFV: jsnesPPU.regFV,
    regV: jsnesPPU.regV,
    regH: jsnesPPU.regH,
    regVT: jsnesPPU.regVT,
    regHT: jsnesPPU.regHT,
    regFH: jsnesPPU.regFH,
    regS: jsnesPPU.regS,
    cntFV: jsnesPPU.cntFV,
    cntV: jsnesPPU.cntV,
    cntH: jsnesPPU.cntH,
    cntVT: jsnesPPU.cntVT,
    cntHT: jsnesPPU.cntHT,
    vramAddress: jsnesPPU.vramAddress,
    vramTmpAddress: jsnesPPU.vramTmpAddress,
    vramBufferedReadValue: jsnesPPU.vramBufferedReadValue,
    firstWrite: jsnesPPU.firstWrite,
    sramAddress: jsnesPPU.sramAddress,
    openBusLatch: jsnesPPU.openBusLatch,
    scanline: (jsnesPPU.scanline + 241) % PPU_SCANLINES,
    curX: jsnesPPU.curX,
    frameEnded: false,
    nmiPending: false,
    vblankFlag: (status & 0x80) !== 0,
    sprite0Hit: (status & 0x40) !== 0,
    overflowFlag: (status & 0x20) !== 0,
    firstFrame: false,
    currentMirroring: jsnesPPU.currentMirroring,
    palEmphasis: jsnesPPU.f_dispType === 0 ? (jsnesPPU.f_color ?? 0) : 0,
    clipToTvSize,
    showSpr0Hit: false,
  };
}

/** Сравнивает два буфера, возвращает {diff, firstIndex, firstRow, firstCol}. */
export function compareBuffers(expected, actual) {
  let diff = 0;
  let firstIndex = -1;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      diff++;
      if (firstIndex < 0) firstIndex = i;
    }
  }
  return {
    diff,
    firstIndex,
    firstRow: firstIndex >= 0 ? firstIndex >> 8 : -1,
    firstCol: firstIndex >= 0 ? firstIndex & 0xff : -1,
  };
}

/** Сценарий ввода: чередование START и A каждые 30 кадров (см. README). */
export function scenarioButtons(frame) {
  if (frame <= 60) return null;
  const phase = frame % 30;
  if (phase >= 10 && phase < 14) return 'START';
  if (phase >= 20 && phase < 24) return 'A';
  return null;
}

/**
 * Прогоняет один ROM: снимает эталонные кадры JSNES и сравнивает с нашим PPU.
 * @param {string} romPath
 * @param {{checkFrames?: number[], totalFrames?: number, jsnesNES?: any}} options
 */
export async function diffOneRom(romPath, options = {}) {
  const checkFrames = options.checkFrames ?? DEFAULT_CHECK_FRAMES;
  const totalFrames = options.totalFrames ?? DEFAULT_TOTAL_FRAMES;
  const maxFrame = Math.max(totalFrames, ...checkFrames) + 1;

  const loaded = loadJsnesRom(romPath);
  if (!loaded) return { rom: romPath, skipped: 'rom-missing' };

  const NES = options.jsnesNES ?? (await importJsnes());
  if (NES && NES.error) return { rom: romPath, skipped: 'jsnes-missing', error: String(NES.error) };
  if (typeof NES !== 'function' && typeof NES !== 'object') {
    return { rom: romPath, skipped: 'jsnes-missing' };
  }

  const nes = new NES({ sampleRate: 48000, onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(loaded.bytes);
  nes.ppu.clipToTvSize = false;

  const results = [];
  let frame = 0;
  while (frame < maxFrame) {
    const button = scenarioButtons(frame);
    for (let i = 0; i < 8; i++) nes.buttonUp(1, i);
    if (button === 'START') nes.buttonDown(1, 3);
    else if (button === 'A') nes.buttonDown(1, 0);

    nes.frame();
    frame++;

    if (!checkFrames.includes(frame)) continue;

    // --- эталон ---
    const reference = new Uint32Array(nes.ppu.buffer);
    const referenceHash = hashBuffer(reference);
    const state = adaptJsnesState(nes.ppu, nes.cpu.mem, { clipToTvSize: false });

    // --- наш PPU: состояние -> полный рендер кадра ---
    const ppu = new PPU();
    ppu.fromJSON(structuredClone(state));
    ppu.renderFullFrame();
    const rendered = new Uint32Array(ppu.buffer);
    const diffRender = compareBuffers(reference, rendered);

    // --- наш PPU: тот же кадр через advanceDots (проверка таймингов/пути рендера) ---
    const live = new PPU();
    live.fromJSON(structuredClone(state));
    live.startFrame();
    live.advanceDots(341 * 262 + 2);
    const diffLive = compareBuffers(reference, new Uint32Array(live.buffer));

    results.push({
      frame,
      hash: referenceHash,
      renderDiff: diffRender.diff,
      firstBad: diffRender.diff
        ? { row: diffRender.firstRow, col: diffRender.firstCol, expected: reference[diffRender.firstIndex], actual: rendered[diffRender.firstIndex] }
        : null,
      liveDiff: diffLive.diff,
      liveFirstBad: diffLive.diff
        ? { row: diffLive.firstRow, col: diffLive.firstCol }
        : null,
      renderHash: hashBuffer(rendered),
      liveHash: hashBuffer(live.buffer),
      displayEnabled: state.f_bgVisibility + state.f_spVisibility,
      scroll: [state.regFV, state.regVT, state.regHT, state.regFH],
    });
  }

  return {
    rom: romPath,
    romSha256: loaded.sha256,
    patchedMapperFrom: loaded.patchedFrom,
    mirroring: loaded.mirroring,
    frames: results,
    ok: results.every(r => r.renderDiff === 0 && r.liveDiff === 0),
  };
}

/** Печатает отчёт в человекочитаемом виде. */
export function printReport(reports) {
  let failed = false;
  for (const report of reports) {
    if (report.skipped) {
      console.log(`SKIP ${report.rom}: ${report.skipped}`);
      continue;
    }
    console.log(`\nROM: ${report.rom}`);
    console.log(`  sha256: ${report.romSha256}`);
    if (report.patchedMapperFrom !== null) {
      console.log(`  dev-обход: iNES-заголовок в памяти объявлен как mapper 0 (был ${report.patchedMapperFrom})`);
    }
    console.log('  frame  hash      renderDiff  liveDiff  scroll');
    for (const row of report.frames) {
      if (row.renderDiff || row.liveDiff) failed = true;
      const bad = row.firstBad
        ? `  (первый: row ${row.firstBad.row} col ${row.firstBad.col} ref ${row.firstBad.expected.toString(16)} ours ${row.firstBad.actual.toString(16)})`
        : '';
      console.log(
        `  ${String(row.frame).padStart(5)}  ${row.hash}  ${String(row.renderDiff).padStart(10)}  ${String(row.liveDiff).padStart(8)}  ${row.scroll.join(',')}${bad}`,
      );
    }
    const bad = report.frames.filter(r => r.renderDiff || r.liveDiff);
    console.log(bad.length === 0 ? '  РЕЗУЛЬТАТ: все кадры совпали побайтово' : `  РЕЗУЛЬТАТ: расхождений ${bad.length}`);
  }
  return !failed;
}

async function main() {
  const args = process.argv.slice(2);
  let roms = DEFAULT_ROMS;
  let json = false;
  let totalFrames = DEFAULT_TOTAL_FRAMES;
  let checkFrames = DEFAULT_CHECK_FRAMES;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rom') roms = [args[++i]];
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--frames') totalFrames = Number.parseInt(args[++i], 10);
    else if (args[i] === '--check') {
      checkFrames = args[++i].split(',').map(value => Number.parseInt(value.trim(), 10)).filter(Number.isFinite);
    }
  }
  const available = roms.filter(path => existsSync(path));
  if (available.length === 0) {
    console.log('ROM не найден — дифференциальный тест PPU пропущен (в CI ROM нет).');
    console.log('Пути по умолчанию:');
    for (const path of DEFAULT_ROMS) console.log('  ' + path);
    process.exit(0);
  }
  const jsnes = await importJsnes();
  if (jsnes.error) {
    console.log('jsnes не установлен — дифференциальный тест PPU пропущен.');
    console.log('Установите devDependencies: npm ci');
    process.exit(0);
  }
  const reports = [];
  for (const path of available) {
    reports.push(await diffOneRom(path, { jsnesNES: jsnes, totalFrames, checkFrames }));
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
  else printReport(reports);
  const ok = reports.every(report => report.skipped || report.ok);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
