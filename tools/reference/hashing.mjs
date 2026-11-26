// Хэширование и дампы для сравнения движков с эталоном.
// Формат кадра у JSNES и нашего PPU общий: Uint32Array(256*240), цвет
// 0x00BBGGRR. Для переносимых SHA-256 кадр кодируется как байты little-endian
// (DataView.setUint32), чтобы хэши не зависели от порядка байтов хоста.

import { createHash } from 'node:crypto';

/** SHA-256 как hex. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

let scratchFrame = null;
let scratchView = null;

/**
 * Каноническое байтовое представление кадра (LE uint32).
 * Возвращает переиспользуемый буфер — хэшируйте сразу, не храните.
 * @param {Uint32Array} buffer
 * @returns {Uint8Array}
 */
export function frameBufferBytes(buffer) {
  const length = buffer.length * 4;
  if (!scratchFrame || scratchFrame.length !== length) {
    scratchFrame = new Uint8Array(length);
    scratchView = new DataView(scratchFrame.buffer);
  }
  for (let i = 0; i < buffer.length; i++) scratchView.setUint32(i * 4, buffer[i] >>> 0, true);
  return scratchFrame;
}

/** SHA-256 кадра. */
export function hashFrameBuffer(buffer) {
  if (!(buffer instanceof Uint32Array)) throw new Error('hashFrameBuffer: ожидался Uint32Array.');
  return sha256Hex(frameBufferBytes(buffer));
}

/** Hex-дамп байтов (одной строкой). */
export function hexDump(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/**
 * RAM-дамп диапазона CPU-памяти (по умолчанию 2 КиБ внутренней RAM NES).
 * @param {Uint8Array} mem 64 КиБ адресного пространства
 * @param {{start?:number, end?:number, hex?:boolean}} [options]
 */
export function ramDump(mem, options = {}) {
  const start = options.start ?? 0x0000;
  const end = options.end ?? 0x0800;
  if (end <= start) throw new Error('ramDump: пустой диапазон.');
  const slice = mem.subarray(start, end);
  const result = {
    start,
    end,
    length: slice.length,
    sha256: sha256Hex(slice),
  };
  if (options.hex !== false) result.hex = hexDump(slice);
  return result;
}

/** Сравнение двух RAM-дампов: смещения и пары байт (без полного дампа). */
export function diffRam(a, b, { maxDiffs = 64 } = {}) {
  const length = Math.min(a.length, b.length);
  const diffs = [];
  let count = 0;
  let first = -1;
  for (let i = 0; i < length; i++) {
    if (a[i] === b[i]) continue;
    count++;
    if (first === -1) first = i;
    if (diffs.length < maxDiffs) diffs.push({ offset: i, a: a[i], b: b[i] });
  }
  return { count, firstOffset: first, diffs, compared: length, sa: sha256Hex(a.subarray(0, length)), sb: sha256Hex(b.subarray(0, length)) };
}

/** SHA-256 массива float-сэмплов (interleaved L,R) в LE float32. */
export function hashSamples(left, right) {
  const count = Math.min(left.length, right.length);
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    data[i * 2] = left[i];
    data[i * 2 + 1] = right[i];
  }
  return sha256Hex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}
