// Эталонный прогон JSNES 2.1.0 (npm devDependency, Apache-2.0).
// Модуль НЕ входит в сайт: он нужен только dev-сравнению и тестам.
//
// Основные ограничения JSNES как эталона:
//  - маппер 148 (Tetris Tengen) не поддерживается. Для эталона объявляем
//    копию ROM как NROM (32 КиБ PRG фиксированы; отличается только
//    переключение CHR-банков, для кадрового эталона это допустимо). ПОМЕТКА:
//    это dev-обход, оригинальный ROM и его SHA не меняются — патчится только
//    копия байтов в памяти. Оригинальный маппер фиксируется в отчёте;
//  - `ppu.clipToTvSize` по умолчанию выключаем, чтобы сравнивать полный
//    кадр 256×240 (наш PPU не обрезает «телевизор»);
//  - на кадре 1 первый `frame()` обслуживает RESET-вектор, как и в Console.

import { NES } from 'jsnes';
import { normalizeScenario, applyScenarioAtFrame, scenarioToJson, SCENARIOS } from './scenario.mjs';
import { hashFrameBuffer, hashSamples, ramDump, sha256Hex } from './hashing.mjs';
import { writeWav } from './wav.mjs';
import { writePng, framePngPath } from './png.mjs';

export const JSNES_VERSION = '2.1.0';

/** Мапперы, которые JSNES 2.1.0 умеет загружать (см. node_modules/jsnes/src/mappers). */
export const JSNES_MAPPERS = Object.freeze([
  0, 1, 2, 3, 4, 5, 7, 9, 11, 34, 38, 66, 71, 79, 94, 118, 119, 140, 180, 240, 241,
]);

/** Читает iNES-заголовок без полного разбора (нужен до patch). */
export function readInesHeader(romBytes) {
  if (!(romBytes instanceof Uint8Array) || romBytes.length < 16) {
    throw new Error('ROM: ожидался непустой Uint8Array с iNES-заголовком.');
  }
  if (romBytes[0] !== 0x4e || romBytes[1] !== 0x45 || romBytes[2] !== 0x53 || romBytes[3] !== 0x1a) {
    throw new Error('ROM: файл не начинается с подписи NES\\x1a.');
  }
  const prgBanks = romBytes[4];
  const chrBanks = romBytes[5];
  const mapper = (romBytes[6] >> 4) | (romBytes[7] & 0xf0);
  return { mapper, prgBanks, chrBanks, mirroring: romBytes[6] & 1 ? 'vertical' : 'horizontal' };
}

/**
 * Готовит копию ROM для JSNES. Маппер 148 объявляется как NROM: у Tetris
 * фиксированные 32 КиБ PRG, так что код/данные читаются верно; CHR-банки
 * для кадрового эталона не переключаются.
 * @param {Uint8Array} romBytes
 * @returns {{bytes: Uint8Array, patched: boolean, mapper: number, jsnesMapper: number, note: string|null}}
 */
export function prepareRomForJsnes(romBytes) {
  const header = readInesHeader(romBytes);
  if (header.mapper === 148) {
    const bytes = Uint8Array.from(romBytes);
    bytes[6] = bytes[6] & 0x0f; // mapper low nibble → 0, флаги (зеркалирование) сохраняем
    bytes[7] = bytes[7] & 0x0f; // mapper high nibble → 0
    return {
      bytes,
      patched: true,
      mapper: 148,
      jsnesMapper: 0,
      note: 'маппер 148 объявлен как NROM для эталона JSNES (dev-обход, PRG-окно фиксировано)',
    };
  }
  if (!JSNES_MAPPERS.includes(header.mapper)) {
    throw new Error(
      `JSNES ${JSNES_VERSION} не поддерживает маппер ${header.mapper}. ` +
        `Поддержаны: ${JSNES_MAPPERS.join(', ')}. Для сравнения нужен ROM с поддерживаемым маппером.`,
    );
  }
  return {
    bytes: romBytes,
    patched: false,
    mapper: header.mapper,
    jsnesMapper: header.mapper,
    note: null,
  };
}

/**
 * Создаёт JSNES и загружает ROM. Аудио-сэмплы складываются в массивы
 * (если captureAudio).
 * @param {{romBytes: Uint8Array, sampleRate?: number, captureAudio?: boolean, clipToTvSize?: boolean}} options
 */
export function createJsnes(options) {
  const {
    romBytes,
    sampleRate = 48000,
    captureAudio = true,
    clipToTvSize = false,
  } = options;
  const prepared = prepareRomForJsnes(romBytes);
  const state = {
    buffer: null,
    left: [],
    right: [],
  };
  const nes = new NES({
    sampleRate,
    onFrame: buffer => {
      state.buffer = buffer;
    },
    onAudioSample: captureAudio
      ? (leftValue, rightValue) => {
          state.left.push(leftValue);
          state.right.push(rightValue);
        }
      : null,
  });
  try {
    nes.loadROM(prepared.bytes);
  } catch (error) {
    throw new Error(
      `JSNES не смог загрузить ROM: ${error.message}. ` +
        `Маппер ${prepared.mapper}${prepared.patched ? ' (пропатчен до NROM)' : ''}.`,
    );
  }
  // Полный кадр 256×240 без «телевизионной» обрезки — формат сравниваемых буферов.
  nes.ppu.clipToTvSize = clipToTvSize;
  return { nes, prepared, state };
}

/**
 * Прогон JSNES на N кадров со сценарием ввода.
 *
 * @param {{
 *   romBytes: Uint8Array,
 *   frames?: number,
 *   scenario?: any,
 *   sampleRate?: number,
 *   captureAudio?: boolean,
 *   clipToTvSize?: boolean,
 *   ramAt?: number[],
 *   ramStart?: number,
 *   ramEnd?: number,
 *   ramHex?: boolean,
 *   ppuAt?: number[],
 *   capturePpuState?: (ppu: any) => any,
 *   pngAt?: number[],
 *   pngPrefix?: string,
 *   wavPath?: string,
 *   returnSamples?: boolean,
 *   onReady?: (nes: any, info: {prepared: any}) => void,
 *   onFrameStart?: (frame: number, nes: any) => void,
 *   onFrameEnd?: (frame: number, nes: any, frameInfo: any) => void,
 * }} options
 */
export async function runJsnes(options) {
  const {
    romBytes,
    frames = 600,
    scenario: rawScenario = [],
    sampleRate = 48000,
    captureAudio = true,
    clipToTvSize = false,
    ramAt = [],
    ramStart = 0x0000,
    ramEnd = 0x0800,
    ramHex = true,
    ppuAt = [],
    capturePpuState = null,
    returnSamples = false,
    pngAt = [],
    pngPrefix = null,
    wavPath = null,
    onReady = null,
    onFrameStart = null,
    onFrameEnd = null,
  } = options;

  if (!Number.isInteger(frames) || frames < 0 || frames > 100000) {
    throw new Error(`frames должен быть целым 0..100000, пришло: ${frames}`);
  }
  if (pngAt.length && !pngPrefix) throw new Error('pngAt передан, но не задан pngPrefix (префикс путей в /tmp).');
  // Строка-пресет ('gameplay') или DSL; массивы событий — как есть.
  const scenarioInput =
    typeof rawScenario === 'string' && rawScenario in SCENARIOS ? SCENARIOS[rawScenario] : rawScenario;
  const scenario = normalizeScenario(scenarioInput);
  const frameSet = new Set(ramAt);
  const ppuFrameSet = new Set(ppuAt);
  const pngFrameSet = new Set(pngAt);
  const { nes, prepared, state } = createJsnes({ romBytes, sampleRate, captureAudio, clipToTvSize });

  const romSha256 = sha256Hex(romBytes);
  const header = readInesHeader(romBytes);
  if (onReady) onReady(nes, { prepared });

  const result = {
    engine: 'jsnes',
    engineVersion: JSNES_VERSION,
    rom: {
      sha256: romSha256,
      size: romBytes.length,
      mapper: header.mapper,
      jsnesMapper: prepared.jsnesMapper,
      jsnesHeaderPatched: prepared.patched,
      note: prepared.note,
    },
    sampleRate,
    clipToTvSize,
    frames,
    scenario: scenarioToJson(scenario),
    frameHashes: [],
    ramDumps: [],
    ppuStates: [],
    pngFiles: [],
    audio: null,
  };

  const startedAt = Date.now();
  for (let frame = 1; frame <= frames; frame++) {
    if (onFrameStart) onFrameStart(frame, nes);
    applyScenarioAtFrame(
      scenario,
      frame,
      code => nes.buttonDown(1, code),
      code => nes.buttonUp(1, code),
    );
    nes.frame();
    const buffer = state.buffer ?? nes.ppu.buffer;
    const frameHash = hashFrameBuffer(buffer);
    const cycles = nes.cpu._cpuCycleBase ?? 0;
    const pc = ((nes.cpu.REG_PC + 1) & 0xffff);
    const frameInfo = { frame, sha256: frameHash, cycles, pc };
    result.frameHashes.push(frameInfo);
    if (frameSet.has(frame)) {
      result.ramDumps.push({ frame, ...ramDump(nes.cpu.mem, { start: ramStart, end: ramEnd, hex: ramHex }) });
    }
    if (ppuFrameSet.has(frame)) {
      if (!capturePpuState) throw new Error('ppuAt передан, но не задан capturePpuState.');
      result.ppuStates.push({ frame, state: capturePpuState(nes.ppu) });
    }
    if (pngFrameSet.has(frame)) {
      const path = framePngPath(pngPrefix, frame);
      result.pngFiles.push(await writePng(path, buffer));
    }
    if (onFrameEnd) onFrameEnd(frame, nes, frameInfo);
  }
  result.elapsedMs = Date.now() - startedAt;

  if (captureAudio) {
    const audio = {
      sampleRate,
      sampleCount: Math.min(state.left.length, state.right.length),
      sha256: hashSamples(state.left, state.right),
    };
    if (wavPath) audio.wav = await writeWav(wavPath, { sampleRate, left: state.left, right: state.right });
    if (returnSamples) audio.samples = { left: state.left, right: state.right };
    result.audio = audio;
  }
  return result;
}

export { hashFrameBuffer, hashSamples, sha256Hex, ramDump };
