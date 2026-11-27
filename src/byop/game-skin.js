// «Скин» оболочки из оригинальной графики игры.
//
// Все картинки интерфейса (рамка панелей, узор фона, стрелка, титульная
// картинка, рамка колодца) собираются в браузере из ROM игрока и кадров,
// которые отрисовал наш PPU. В репозитории нет ни одного игрового пикселя:
// это производные данные, которые живут только в памяти устройства.

import { NTSC_PALETTE_BGR } from '../nes/constants.js';
import { installGameFont } from './game-font.js';

const ARROW_TILE = 62; // стрелка меню игры (plane 0 CHR)
const TITLE_CROP = [32, 32, 192, 176];
const BLOCK_CROP = [240, 0, 16, 16];
const WELL_CROP = [8, 40, 96, 176];
const WELL_BORDER = 8;

// 5×5 тайлов старой рамки (frame.png) и перестановки палитры для каждого.
// Источник — тайлы банка 0 CHR картриджа Tengen; повороты/отражения повторяют
// оригинальную construction старого порта.
const FRAME_TILES = [
  [[100, 0, true, [0, 3, 2, 0]], [99, 0, true, [0, 3, 2, 1]], [98, 0, false, [0, 3, 2, 1]], [99, 0, false, [0, 3, 2, 1]], [100, 0, false, [0, 3, 2, 0]]],
  [[105, 0, true, [0, 3, 2, 1]], [104, 0, true, [0, 3, 2, 1]], [103, 0, false, [0, 3, 2, 1]], [104, 0, false, [0, 3, 2, 1]], [105, 0, false, [0, 3, 2, 1]]],
  [[116, 0, true, [0, 3, 2, 1]], [115, 0, true, [0, 3, 2, 1]], [0, 0, false, [0, 0, 0, 0]], [115, 0, false, [0, 3, 2, 1]], [116, 0, false, [0, 3, 2, 1]]],
  [[139, 0, true, [0, 3, 2, 0]], [138, 0, true, [0, 3, 2, 1]], [137, 0, false, [0, 3, 2, 1]], [138, 0, false, [0, 3, 2, 1]], [139, 0, false, [0, 3, 2, 0]]],
  [[144, 0, true, [0, 3, 2, 1]], [139, 3, false, [0, 1, 2, 0]], [142, 0, false, [0, 3, 2, 1]], [139, 3, true, [0, 1, 2, 0]], [144, 0, false, [0, 3, 2, 1]]],
];

// Индексы NES-палитры для 4 цветов рамки: чёрный, синий, небесный, ледяной.
const FRAME_PALETTE = [0x0f, 0x01, 0x21, 0x31];

/** BGR → RGBA little-endian для ImageData. */
function rgbaFromBgr(value) {
  const r = value & 0xff;
  const g = (value >> 8) & 0xff;
  const b = (value >> 16) & 0xff;
  return 0xff000000 | (b << 16) | (g << 8) | r;
}

function makeCanvas(width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toDataUrl(canvas) {
  try { return canvas.toDataURL('image/png'); } catch { return null; }
}

function rotateTile(tile, rotation, flip) {
  let rows = tile.map(row => row.slice());
  for (let r = 0; r < rotation; r++) rows = rotateLeft(rows);
  if (flip) rows = rows.map(row => row.slice().reverse());
  return rows;
}

// np.rot90: против часовой стрелки.
function rotateLeft(rows) {
  const next = Array.from({ length: 8 }, () => new Uint8Array(8));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) next[7 - x][y] = rows[y][x];
  return next;
}

/** 40×40 канвас игровой рамки (frame.png старого порта). */
export function buildFrameImage(chr) {
  if (!chr || chr.length < 8192 || typeof document === 'undefined') return null;
  const bank = chr.subarray(0, 8192);
  const colors = FRAME_PALETTE.map(index => rgbaFromBgr(NTSC_PALETTE_BGR[index]));
  const canvas = makeCanvas(40, 40);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  const image = context.createImageData(40, 40);
  const pixels = new Uint32Array(image.data.buffer);
  for (let ty = 0; ty < 5; ty++) {
    for (let tx = 0; tx < 5; tx++) {
      const [tileIndex, rotation, flip, map] = FRAME_TILES[ty][tx];
      const rows = rotateTile(tile2bpp(bank, tileIndex), rotation, flip);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const color = colors[map[rows[y][x]] ?? 0];
          pixels[(ty * 8 + y) * 40 + tx * 8 + x] = color;
        }
      }
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Рамка 48×48 (углы/кромки по 16 px) прямо из синей рамки титульного экрана:
 * нативный масштаб, без сжатия — как в самой игре.
 */
export function buildBraidFrameUrl(titleBuffer) {
  if (!titleBuffer || titleBuffer.length < 256 * 240) return null;
  const boxes = {
    tl: [16, 16], tr: [224, 16], bl: [16, 208], br: [224, 208],
    t: [48, 16], b: [48, 208], l: [16, 48], r: [224, 48]
  };
  const canvas = makeCanvas(48, 48);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, 48, 48);
  context.imageSmoothingEnabled = false;
  const put = ([x, y], dx, dy) => {
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const value = titleBuffer[(y + row) * 256 + x + col];
        context.fillStyle = `rgb(${value & 0xff}, ${(value >> 8) & 0xff}, ${(value >> 16) & 0xff})`;
        context.fillRect(dx + col, dy + row, 1, 1);
      }
    }
  };
  put(boxes.tl, 0, 0);
  put(boxes.tr, 32, 0);
  put(boxes.bl, 0, 32);
  put(boxes.br, 32, 32);
  put(boxes.t, 16, 0);
  put(boxes.b, 16, 32);
  put(boxes.l, 0, 16);
  put(boxes.r, 32, 16);
  // центр — чёрный
  context.fillStyle = '#000';
  context.fillRect(16, 16, 16, 16);
  return toDataUrl(canvas);
}

/** 40×40 рамка как data URL. */
export function buildFrameUrl(chr) {
  const canvas = buildFrameImage(chr);
  return canvas ? toDataUrl(canvas) : null;
}

/** 8×8 значения 2bpp (0..3) из CHR-тайла — для рамки. */
function tile2bpp(chr, tileIndex) {
  const base = tileIndex * 16;
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      const low = (chr[base + y] >> bit) & 1;
      const high = (chr[base + y + 8] >> bit) & 1;
      row.push(low | (high << 1));
    }
    rows.push(row);
  }
  return rows;
}

/** 8×8 белая стрелка из CHR-тайла 62. */
export function buildArrowUrl(chr) {
  if (!chr || chr.length < 8192) return null;
  const base = ARROW_TILE * 16;
  const rows = Array.from({ length: 8 }, (_, y) => chr[base + y] ?? 0);
  const canvas = makeCanvas(8, 8);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  const image = context.createImageData(8, 8);
  const pixels = new Uint32Array(image.data.buffer);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      pixels[y * 8 + x] = rows[y] & (0x80 >> x) ? 0xffffffff : 0x00000000;
    }
  }
  context.putImageData(image, 0, 0);
  return toDataUrl(canvas);
}

function cropBufferUrl(buffer, [x, y, width, height]) {
  if (!buffer || buffer.length < 256 * 240) return null;
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  const pixels = new Uint32Array(image.data.buffer);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      pixels[row * width + col] = rgbaFromBgr(buffer[(y + row) * 256 + x + col]);
    }
  }
  context.putImageData(image, 0, 0);
  return toDataUrl(canvas);
}

/** Титульная картинка (как title.png старого порта) из кадра игры. */
export function buildTitleArtUrl(titleBuffer) {
  return cropBufferUrl(titleBuffer, TITLE_CROP);
}

/** Узор фона из титульного экрана (как block.png старого порта). */
export function buildBlockPatternUrl(titleBuffer) {
  return cropBufferUrl(titleBuffer, BLOCK_CROP);
}

/**
 * Рамка колодца: 9-slice из игровой рамки (того же арта, что панели),
 * сжатая до 4 px — как well.png старого порта. Внутренность чёрная;
 * блоки и HUD композитор рисует из кадра сам.
 */
export function buildWellFrameUrl(chr) {
  const frame = buildFrameImage(chr);
  if (!frame) return null;
  const width = 88;
  const height = 184;
  const border = 4;
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = false;
  const s = frame.width; // 40
  const slice = 16;
  const middle = s - slice * 2; // 8
  const draw = (sx, sy, sw, sh, dx, dy, dw, dh) => context.drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh);
  // углы
  draw(0, 0, slice, slice, 0, 0, border, border);
  draw(s - slice, 0, slice, slice, width - border, 0, border, border);
  draw(0, s - slice, slice, slice, 0, height - border, border, border);
  draw(s - slice, s - slice, slice, slice, width - border, height - border, border, border);
  // кромки
  for (let x = 0; x < width - border * 2; x += border) {
    draw(slice, 0, middle, slice, border + x, 0, Math.min(border, width - border * 2 - x), border);
    draw(slice, s - slice, middle, slice, border + x, height - border, Math.min(border, width - border * 2 - x), border);
  }
  for (let y = 0; y < height - border * 2; y += border) {
    draw(0, slice, slice, middle, 0, border + y, border, Math.min(border, height - border * 2 - y));
    draw(s - slice, slice, slice, middle, width - border, border + y, border, Math.min(border, height - border * 2 - y));
  }
  return toDataUrl(canvas);
}

/** Числовые метрики титульного кадра: нужен ли скин (титул отрисован). */
export function hasTitleFrame(titleBuffer) {
  if (!titleBuffer || titleBuffer.length < 256 * 240) return false;
  let ink = 0;
  const colors = new Set();
  for (let i = 0; i < 256 * 240; i++) {
    const value = titleBuffer[i] & 0xffffff;
    if (value) ink++;
    if (colors.size < 32) colors.add(value);
  }
  return ink > 256 * 240 * 0.2 && colors.size >= 8;
}

const SKIN_VARS = {
  font: '--game-font',
  arrow: '--icon-arrow',
  block: '--bg-block',
  frame: '--frame-image',
  title: '--title-art',
  well: '--well-image',
};

/**
 * Готовит и применяет скин к документу.
 * @param {{
 *   chr?: Uint8Array, language?: 'en'|'ru',
 *   titleBuffer?: Uint32Array, playBuffer?: Uint32Array,
 *   root?: HTMLElement,
 * }} options
 * @returns {Promise<{applied: boolean, font: string|null, assets: object}>}
 */
export async function applyGameSkin(options = {}) {
  const root = options.root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const language = options.language === 'ru' ? 'ru' : 'en';
  const assets = {
    font: null,
    arrow: options.chr ? buildArrowUrl(options.chr) : null,
    block: buildBlockPatternUrl(options.titleBuffer),
    frame: buildBraidFrameUrl(options.titleBuffer) ?? (options.chr ? buildFrameUrl(options.chr) : null),
    title: buildTitleArtUrl(options.titleBuffer),
    well: buildWellFrameUrl(options.chr),
  };
  const family = `TengenTap-${language}-${Math.random().toString(36).slice(2, 8)}`;
  // Кириллица чуть шире английских глифов: даём ей 9 px на знак,
  // чтобы буквы не слипались и читались так же легко.
  const advance = language === 'ru' ? 1152 : 1024;
  // Кириллица — наш встроенный шрифт (не зависит от ROM). Английский берём
  // из английского картриджа; на русском ROM английских глифов нет, поэтому
  // для ENG-интерфейса оставляем системный шрифт.
  const romLanguage = options.romLanguage ?? language;
  const canBuildFont = language === 'ru' || romLanguage === 'en';
  const font = options.chr && canBuildFont
    ? await installGameFont(options.chr, language, family, { advance })
    : null;
  assets.font = font;
  if (!root) return { applied: false, font, assets };
  if (font) root.style.setProperty(SKIN_VARS.font, `"${font}", "Courier New", monospace`);
  for (const key of ['arrow', 'block', 'frame', 'title', 'well']) {
    if (assets[key]) root.style.setProperty(SKIN_VARS[key], `url("${assets[key]}")`);
  }
  root.dataset.skin = font || assets.frame ? 'game' : 'fallback';
  return { applied: true, font, assets };
}

export { ARROW_TILE, TITLE_CROP, BLOCK_CROP, WELL_CROP };
