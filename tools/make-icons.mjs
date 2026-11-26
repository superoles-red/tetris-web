#!/usr/bin/env node
// Генерирует наши иконки PWA без внешних зависимостей и без игровой графики:
// простая геометрия (тёмный фон, сетка, фигура из четырёх блоков) рисуется
// в RGBA-буфер и кодируется в PNG через node:zlib.
//
//   node tools/make-icons.mjs
//
// Результат (коммитится в репозиторий, это наш собственный арт):
//   assets/icons/icon-192.png
//   assets/icons/icon-512.png
//   assets/icons/maskable.png   (512, безопасная зона)
//   assets/icons/apple-touch.png (180)
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets', 'icons');

const COLORS = {
  bgTop: [16, 26, 42, 255],
  bgBottom: [5, 8, 14, 255],
  grid: [90, 169, 255, 24],
  block: [255, 183, 3, 255],
  blockLight: [255, 215, 92, 255],
  blockDark: [196, 138, 0, 255],
  base: [90, 169, 255, 255]
};

const targets = [
  { file: 'icon-192.png', size: 192, cells: 0.165, grid: true },
  { file: 'icon-512.png', size: 512, cells: 0.165, grid: true },
  // maskable: мотив в безопасной зоне (не меньше 40% от центра).
  { file: 'maskable.png', size: 512, cells: 0.105, grid: false },
  { file: 'apple-touch.png', size: 180, cells: 0.155, grid: true }
];

function createCanvas(size) {
  const pixels = new Uint8Array(size * size * 4);
  return {
    size,
    pixels,
    set(x, y, color) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const index = (y * size + x) * 4;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = color[3];
    },
    blend(x, y, color) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const index = (y * size + x) * 4;
      const alpha = color[3] / 255;
      pixels[index] = Math.round(pixels[index] * (1 - alpha) + color[0] * alpha);
      pixels[index + 1] = Math.round(pixels[index + 1] * (1 - alpha) + color[1] * alpha);
      pixels[index + 2] = Math.round(pixels[index + 2] * (1 - alpha) + color[2] * alpha);
      pixels[index + 3] = Math.max(pixels[index + 3], color[3]);
    }
  };
}

function verticalGradient(canvas, top, bottom) {
  for (let y = 0; y < canvas.size; y++) {
    const k = y / (canvas.size - 1);
    const color = top.map((value, index) => Math.round(value * (1 - k) + bottom[index] * k));
    for (let x = 0; x < canvas.size; x++) canvas.set(x, y, color);
  }
}

function grid(canvas) {
  const step = canvas.size / 8;
  const width = Math.max(1, Math.round(canvas.size / 256));
  for (let i = 1; i < 8; i++) {
    for (let p = 0; p < canvas.size; p++) {
      for (let w = 0; w < width; w++) {
        canvas.blend(Math.round(i * step) + w, p, COLORS.grid);
        canvas.blend(p, Math.round(i * step) + w, COLORS.grid);
      }
    }
  }
}

function roundRect(canvas, x, y, w, h, radius, color, alpha = 1) {
  const r = Math.min(radius, w / 2, h / 2);
  const fill = [color[0], color[1], color[2], Math.round(255 * alpha)];
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // Скругление только по углам.
      const dx = px < r ? r - px : px >= w - r ? px - (w - r - 1) : 0;
      const dy = py < r ? r - py : py >= h - r ? py - (h - r - 1) : 0;
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > r * r) continue;
      canvas.blend(x + px, y + py, fill);
    }
  }
}

// Фигура «T» из четырёх блоков — наша простая геометрия, не графика игры.
function drawMark(canvas, cellRatio, withBase) {
  const size = canvas.size;
  const cell = Math.round(size * cellRatio);
  const gap = Math.round(cell * 0.10);
  const width = cell * 3 + gap * 2;
  const height = cell * 2 + gap;
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - height) / 2);
  const radius = Math.round(cell * 0.16);
  const cells = [
    [0, 0], [1, 0], [2, 0], [1, 1]
  ];
  for (const [col, row] of cells) {
    const x = left + col * (cell + gap);
    const y = top + row * (cell + gap);
    roundRect(canvas, x, y, cell, cell, radius, COLORS.block);
    // Объём блока: светлая грань сверху, тёмная снизу — наша «пиксельная» манера.
    roundRect(canvas, x, y, cell, Math.max(2, Math.round(cell * 0.12)), radius, COLORS.blockLight, 0.9);
    roundRect(canvas, x, y + cell - Math.max(2, Math.round(cell * 0.12)), cell,
      Math.max(2, Math.round(cell * 0.12)), radius, COLORS.blockDark, 0.9);
  }
  if (withBase) {
    const barHeight = Math.max(2, Math.round(size * 0.012));
    const barWidth = Math.round(width * 0.9);
    roundRect(canvas, Math.round((size - barWidth) / 2), Math.round(top + height + size * 0.055),
      barWidth, barHeight, barHeight, COLORS.base, 0.85);
  }
}

// --- PNG ---------------------------------------------------------------
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const target of targets) {
    const canvas = createCanvas(target.size);
    verticalGradient(canvas, COLORS.bgTop, COLORS.bgBottom);
    if (target.grid) grid(canvas);
    drawMark(canvas, target.cells, true);
    const png = encodePng(target.size, target.size, canvas.pixels);
    await writeFile(join(outDir, target.file), png);
    console.log(`icons → assets/icons/${target.file} (${png.length} bytes, ${target.size}×${target.size})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
