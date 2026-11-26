#!/usr/bin/env node
// Снятие состояния PPU JSNES 2.1.0 в JSON — dev-эталон для дифф-тестов PPU.
//
// API:
//   import { capturePpuState, runPpuStates } from './tools/reference/ppu-state.mjs';
//   const result = await runPpuStates({ romPath, frames: [1, 30, 60] });
//
// CLI:
//   node tools/reference/ppu-state.mjs --rom /path/game.nes --frames 1,60,200 \
//        --scenario gameplay --out /tmp/ppu-states.json [--to-json] [--tiles] [--buffer]
//
// Формат состояния — компактный (hex-строки вместо массивов байт), чтобы
// JSON оставался диффопригодным. `--to-json` добавляет полный JSNES
// ppu.toJSON() (для ppu.fromJSON у нашего PPU).

import { readFile, writeFile } from 'node:fs/promises';
import { runJsnes } from './jsnes-runner.mjs';
import { sha256Hex, hexDump } from './hashing.mjs';
import { normalizeScenario, SCENARIOS } from './scenario.mjs';
import { isMain, parseArgs, intListOption, intOption, formatError } from './cli.mjs';

const MIRRORING_NAMES = {
  0: 'vertical',
  1: 'horizontal',
  2: 'four',
  3: 'single0',
  4: 'single1',
  5: 'single2',
  6: 'single3',
};

/**
 * Снимает состояние PPU JSNES в JSON-совместимый объект.
 * @param {any} ppu
 * @param {{includeTiles?: boolean, includeBuffer?: boolean, includeJsnesJson?: boolean}} [options]
 */
export function capturePpuState(ppu, options = {}) {
  const { includeTiles = false, includeBuffer = false, includeJsnesJson = false } = options;
  const vramMem = ppu.vramMem;
  const state = {
    registers: {
      f_nmiOnVblank: ppu.f_nmiOnVblank,
      f_spriteSize: ppu.f_spriteSize,
      f_bgPatternTable: ppu.f_bgPatternTable,
      f_spPatternTable: ppu.f_spPatternTable,
      f_addrInc: ppu.f_addrInc,
      f_nTblAddress: ppu.f_nTblAddress,
      f_color: ppu.f_color,
      f_spVisibility: ppu.f_spVisibility,
      f_bgVisibility: ppu.f_bgVisibility,
      f_spClipping: ppu.f_spClipping,
      f_bgClipping: ppu.f_bgClipping,
      f_dispType: ppu.f_dispType,
    },
    // loopy-скролл: регистры (запись $2005/$2006) и счётчики (текущая позиция).
    scroll: {
      regFV: ppu.regFV,
      regV: ppu.regV,
      regH: ppu.regH,
      regVT: ppu.regVT,
      regHT: ppu.regHT,
      regFH: ppu.regFH,
      regS: ppu.regS,
      cntFV: ppu.cntFV,
      cntV: ppu.cntV,
      cntH: ppu.cntH,
      cntVT: ppu.cntVT,
      cntHT: ppu.cntHT,
      vramAddress: ppu.vramAddress,
      vramTmpAddress: ppu.vramTmpAddress,
      firstWrite: ppu.firstWrite ? 1 : 0,
      sramAddress: ppu.sramAddress,
    },
    memory: {
      // vramMem: 0x0000-0x1FFF — текущее окно CHR; 0x2000-0x2FFF — nametables;
      // 0x3F00-0x3F1F — палитровая RAM (как в JSNES/нашем PPU-фасаде).
      vramMem: hexDump(vramMem),
      chrWindow: hexDump(vramMem.subarray(0x0000, 0x2000)),
      nameTables: hexDump(vramMem.subarray(0x2000, 0x3000)),
      paletteRam: hexDump(vramMem.subarray(0x3f00, 0x3f20)),
      spriteMem: hexDump(ppu.spriteMem),
    },
    palettes: {
      imgPalette: Array.from(ppu.imgPalette),
      sprPalette: Array.from(ppu.sprPalette),
    },
    mirroring: {
      current: ppu.currentMirroring,
      name: MIRRORING_NAMES[ppu.currentMirroring] ?? 'unknown',
      ntable1: Array.from(ppu.ntable1 ?? []),
    },
    timing: {
      scanline: ppu.scanline,
      curX: ppu.curX,
      lastRenderedScanline: ppu.lastRenderedScanline,
      frameEnded: Boolean(ppu.frameEnded),
      vblankPending: Boolean(ppu.vblankPending),
      nmiOutput: Boolean(ppu.nmiOutput),
      nmiSuppressed: Boolean(ppu.nmiSuppressed),
      hitSpr0: Boolean(ppu.hitSpr0),
      spr0HitX: ppu.spr0HitX,
      spr0HitY: ppu.spr0HitY,
      spriteCount: ppu.spriteCount ?? 0,
      scanlineSpriteCount: ppu.scanlineSpriteCount ? Array.from(ppu.scanlineSpriteCount.subarray(0, 240)) : null,
    },
    openBus: { latch: ppu.openBusLatch, decayFrames: ppu.openBusDecayFrames },
    buffer: {
      sha256: sha256Hex(new Uint8Array(ppu.buffer.buffer, ppu.buffer.byteOffset, ppu.buffer.byteLength)),
    },
  };
  if (includeBuffer) {
    const bytes = new Uint8Array(ppu.buffer.length * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < ppu.buffer.length; i++) view.setUint32(i * 4, ppu.buffer[i] >>> 0, true);
    state.buffer.pixels = hexDump(bytes);
  }
  if (includeTiles) {
    state.ptTile = ppu.ptTile.map(tile => hexDump(tile.pix));
  }
  if (includeJsnesJson) {
    state.jsnesToJSON = ppu.toJSON();
  }
  return state;
}

/**
 * Прогон JSNES и снятие состояния PPU на заданных кадрах.
 * @param {{
 *   romPath?: string, romBytes?: Uint8Array, frames: number[],
 *   scenario?: any, sampleRate?: number, clipToTvSize?: boolean,
 *   includeTiles?: boolean, includeBuffer?: boolean, includeJsnesJson?: boolean,
 * }} options
 */
export async function runPpuStates(options) {
  const {
    romPath,
    romBytes,
    frames,
    scenario = [],
    sampleRate = 48000,
    clipToTvSize = false,
    includeTiles = false,
    includeBuffer = false,
    includeJsnesJson = false,
  } = options;
  let bytes = romBytes;
  if (!bytes) {
    if (!romPath) throw new Error('runPpuStates: нужен romPath или romBytes.');
    bytes = new Uint8Array(await readFile(romPath));
  }
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('runPpuStates: нужен непустой список frames.');
  const capture = ppu =>
    capturePpuState(ppu, { includeTiles, includeBuffer, includeJsnesJson });
  const maxFrame = Math.max(...frames);
  const result = await runJsnes({
    romBytes: bytes,
    frames: maxFrame,
    scenario: normalizeScenario(scenario),
    sampleRate,
    captureAudio: false,
    clipToTvSize,
    ramAt: [],
    ppuAt: frames,
    capturePpuState: capture,
  });
  result.rom.path = romPath ?? null;
  result.ppuStates = result.ppuStates; // [{frame, state}]
  return result;
}

const HELP = `
Снятие состояния PPU JSNES (dev-only).

Использование:
  node tools/reference/ppu-state.mjs --rom <path.nes> --frames 1,60,200 [опции]

Опции:
  --frames <список>       кадры, на которых снять состояние (1-based; по умолчанию 1)
  --scenario <name>       none | menu | gameplay
  --press <spec>          сценарий DSL: "start@100+4"
  --input <file.json>     файл со списком событий ввода
  --to-json               добавить полный JSNES ppu.toJSON() в каждое состояние
  --tiles                 добавить декодированные 8x8 тайлы (ptTile, hex)
  --buffer                добавить полный буфер кадра (hex)
  --clip-to-tv            снимать с включённой обрезкой JSNES (по умолчанию выключена)
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
    const result = await runPpuStates({
      romPath: String(args.rom),
      frames: intListOption(args.frames, [1]),
      scenario,
      clipToTvSize: args['clip-to-tv'] === true,
      includeTiles: args.tiles === true,
      includeBuffer: args.buffer === true,
      includeJsnesJson: args['to-json'] === true,
    });
    const json = JSON.stringify(result, null, 2);
    if (args.out) await writeFile(String(args.out), json + '\n');
    else process.stdout.write(json + '\n');
    if (!args.quiet) {
      console.error(
        `JSNES ${result.engineVersion}: PPU-состояния на кадрах ${result.ppuStates.map(s => s.frame).join(', ')} ` +
          `(ROM ${result.rom.sha256.slice(0, 12)}…${result.rom.jsnesHeaderPatched ? ', dev-патч 148→NROM' : ''})`,
      );
      if (args.out) console.error(`  JSON: ${args.out}`);
    }
  } catch (error) {
    console.error(`Ошибка ppu-state: ${formatError(error)}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
