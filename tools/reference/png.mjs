// Минимальный PNG-энкодер для кадров 256×240 (dev-only, /tmp).
// Кадр — Uint32Array(256*240) в формате JSNES/нашего PPU: 0x00BBGGRR.

import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

const WIDTH = 256;
const HEIGHT = 240;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

/**
 * Рендерит кадр PPU в PNG (RGB, 8 бит).
 * @param {Uint32Array} buffer кадр 256×240, цвет 0x00BBGGRR
 * @returns {Buffer}
 */
export function encodePng(buffer) {
  if (buffer.length !== WIDTH * HEIGHT) {
    throw new Error(`encodePng: ожидался кадр ${WIDTH}×${HEIGHT}, пришло ${buffer.length} пикселей.`);
  }
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  let offset = 0;
  for (let y = 0; y < HEIGHT; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < WIDTH; x++) {
      const color = buffer[y * WIDTH + x];
      raw[offset++] = color & 0xff; // R
      raw[offset++] = (color >>> 8) & 0xff; // G
      raw[offset++] = (color >>> 16) & 0xff; // B
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Пишет кадр в PNG-файл (обычно в /tmp). */
export async function writePng(path, buffer) {
  const png = encodePng(buffer);
  await writeFile(path, png);
  return { path, bytes: png.length };
}

/** Путь кадра: `<prefix>-frame000123.png`. */
export function framePngPath(prefix, frame) {
  return `${prefix}-frame${String(frame).padStart(6, '0')}.png`;
}
