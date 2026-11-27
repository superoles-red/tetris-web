// Шрифт интерфейса из алфавита самой игры.
//
// В CHR-банке картриджа Tengen Tetris буквы и цифры лежат 8×8-тайлами
// (в старом порте индекс тайла = ASCII-код). Здесь мы вырезаем эти глифы
// и собираем из них TTF прямо в браузере: шрифт никуда не сохраняется и
// не распространяется — он рендерится из ROM игрока.
//
// Метрики повторяют старый Cart-шрифт: unitsPerEm=1024, ascent=1024,
// descent=0, advance=1024, каждый пиксель глифа = 128 юнитов.

const PIXEL = 128;
const UNITS = 1024;

import { BUILTIN_GLYPHS, BUILTIN_PUNCTUATION } from './pixel-font.js';

const LATIN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Строки-картинки '#/.' → байты (MSB слева), как у CHR-тайла. */
function rowsFromStrings(rows) {
  const bytes = new Uint8Array(rows.length);
  for (let y = 0; y < rows.length; y++) {
    let bits = 0;
    for (let x = 0; x < 8; x++) if (rows[y][x] === '#') bits |= 0x80 >> x;
    bytes[y] = bits;
  }
  return bytes;
}


class Writer {
  constructor(capacity = 1024) { this.bytes = new Uint8Array(capacity); this.length = 0; }
  ensure(n) {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }
  u8(v) { this.ensure(1); this.bytes[this.length++] = v & 0xff; }
  u16(v) { this.ensure(2); this.bytes[this.length++] = (v >> 8) & 0xff; this.bytes[this.length++] = v & 0xff; }
  i16(v) { this.u16(v < 0 ? (v + 0x10000) & 0xffff : v); }
  u32(v) { this.ensure(4); this.bytes[this.length++] = (v >>> 24) & 0xff; this.bytes[this.length++] = (v >>> 16) & 0xff; this.bytes[this.length++] = (v >>> 8) & 0xff; this.bytes[this.length++] = v & 0xff; }
  tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 0x20); }
  raw(array) { this.ensure(array.length); this.bytes.set(array, this.length); this.length += array.length; }
  align4() { while (this.length % 4) this.u8(0); }
  take() { return this.bytes.slice(0, this.length); }
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | (bytes[i + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum >>> 0;
}


/** 8 строк по 8 бит из plane 0 CHR-тайла. */
export function glyphFromChr(chr, tileIndex) {
  const base = tileIndex * 16;
  const rows = new Uint8Array(8);
  for (let y = 0; y < 8; y++) rows[y] = chr[base + y] ?? 0;
  return rows;
}

function hasInk(rows) { for (const row of rows) if (row) return true; return false; }

function buildGlyf(rowsList) {
  const writer = new Writer(16384);
  const offsets = [];
  for (const rows of rowsList) {
    offsets.push(writer.length);
    if (!hasInk(rows)) continue;
    const pixels = [];
    for (let y = 0; y < rows.length; y++) for (let x = 0; x < 8; x++) if (rows[y] & (0x80 >> x)) pixels.push([x, y]);
    const xMin = Math.min(...pixels.map(([x]) => x * PIXEL));
    const xMax = Math.max(...pixels.map(([x]) => (x + 1) * PIXEL));
    const yMin = Math.min(...pixels.map(([, y]) => (7 - y) * PIXEL));
    const yMax = Math.max(...pixels.map(([, y]) => (8 - y) * PIXEL));
    writer.i16(pixels.length);
    writer.i16(xMin); writer.i16(yMin); writer.i16(xMax); writer.i16(yMax);
    for (let i = 0; i < pixels.length; i++) writer.u16(i * 4 + 3);
    writer.u16(0);
    for (let i = 0; i < pixels.length * 4; i++) writer.u8(0x01);
    // Координаты точек — дельты от предыдущей точки (через все контуры).
    let prevX = 0;
    for (const [x] of pixels) {
      const left = x * PIXEL;
      const deltas = [left - prevX, 0, PIXEL, 0];
      for (const delta of deltas) { writer.i16(delta); prevX += delta; }
    }
    let prevY = 0;
    for (const [, y] of pixels) {
      const bottom = (8 - y - 1) * PIXEL;
      const deltas = [bottom - prevY, PIXEL, 0, -PIXEL];
      for (const delta of deltas) { writer.i16(delta); prevY += delta; }
    }
  }
  offsets.push(writer.length);
  return { glyf: writer.take(), offsets };
}

function buildName(family) {
  const strings = [family, 'Regular', family, `${family}-Regular`];
  const ids = [1, 2, 4, 6];
  const w = new Writer(512);
  w.u16(0); w.u16(4); w.u16(6 + 12 * 4);
  for (let i = 0; i < 4; i++) {
    w.u16(3); w.u16(1); w.u16(0x0409); w.u16(ids[i]); w.u16(strings[i].length * 2); w.u16(0);
  }
  for (const s of strings) for (const ch of s) w.u16(ch.charCodeAt(0));
  return w.take();
}

/**
 * Собирает TTF из карты char → 8×8 bitmap.
 * @param {Map<string, Uint8Array>} glyphs
 * @param {string} family
 */
export function buildTtf(glyphs, family = 'TengenCart', { advance = UNITS } = {}) {
  const chars = [...glyphs.keys()].filter(ch => ch !== ' ' && ch !== '\u0000');
  chars.sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const entries = [['\u0000', new Uint8Array(9)], [' ', glyphs.get(' ') ?? new Uint8Array(9)], ...chars.map(ch => [ch, glyphs.get(ch)])];
  const { glyf, offsets } = buildGlyf(entries.map(([, rows]) => rows));
  const numGlyphs = entries.length;

  const head = new Writer(54);
  head.u32(0x00010000); head.u32(0x00010000); head.u32(0); head.u32(0x5f0f3cf5);
  head.u16(0x000b); head.u16(UNITS); head.u32(0); head.u32(0); head.u32(0); head.u32(0);
  head.i16(-2 * PIXEL); head.i16(-PIXEL); head.i16(8 * PIXEL); head.i16(9 * PIXEL);
  head.u16(0); head.u16(8); head.i16(2); head.i16(0); head.i16(0);

  const hhea = new Writer(36);
  hhea.u32(0x00010000); hhea.i16(UNITS); hhea.i16(-PIXEL); hhea.i16(0);
  hhea.u16(UNITS); hhea.i16(0); hhea.i16(0); hhea.i16(8 * PIXEL);
  hhea.i16(1); hhea.i16(0); hhea.i16(0);
  for (let i = 0; i < 4; i++) hhea.i16(0);
  hhea.i16(0); hhea.u16(numGlyphs);

  const maxp = new Writer(32);
  maxp.u32(0x00010000); maxp.u16(numGlyphs);
  maxp.u16(4 * 128); maxp.u16(128); // maxPoints, maxContours
  maxp.u16(0); maxp.u16(0); // composite
  maxp.u16(2); // maxZones
  maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0); maxp.u16(0);
  maxp.u16(0); maxp.u16(0); maxp.u16(0);

  const hmtx = new Writer(numGlyphs * 4);
  for (let i = 0; i < numGlyphs; i++) { hmtx.u16(advance); hmtx.i16(0); }

  const loca = new Writer(numGlyphs * 2 + 2);
  if (offsets[offsets.length - 1] / 2 > 0xffff) throw new Error('ttf too large');
  for (const offset of offsets) loca.u16(offset / 2);

  // cmap format 4
  const segments = [{ start: 0x20, end: 0x20, glyph: 1 }];
  chars.forEach((ch, index) => {
    const code = ch.codePointAt(0);
    segments.push({ start: code, end: code, glyph: index + 2 });
  });
  segments.push({ start: 0xffff, end: 0xffff, glyph: 0 });
  segments.sort((a, b) => a.start - b.start);
  const segCount = segments.length;
  const segX2 = segCount * 2;
  let cmapPower = 1;
  let cmapSelect = 0;
  while (cmapPower * 2 <= segCount) { cmapPower *= 2; cmapSelect++; }
  const cmapSearch = cmapPower * 2;
  const cmapRangeShift = segX2 - cmapSearch;
  const cmapSub = new Writer(64 + segCount * 8);
  cmapSub.u16(4); cmapSub.u16(16 + segX2 * 4);
  cmapSub.u16(0); cmapSub.u16(segX2); cmapSub.u16(cmapSearch); cmapSub.u16(cmapSelect); cmapSub.u16(cmapRangeShift);
  for (const seg of segments) cmapSub.u16(seg.end);
  cmapSub.u16(0);
  for (const seg of segments) cmapSub.u16(seg.start);
  for (const seg of segments) cmapSub.i16((seg.glyph - seg.start) & 0xffff);
  for (let i = 0; i < segCount; i++) cmapSub.u16(0);
  const sub = cmapSub.take();
  const cmap = new Writer(12 + sub.length);
  cmap.u16(0); cmap.u16(1); cmap.u16(3); cmap.u16(1); cmap.u32(12); cmap.raw(sub);

  // OS/2 версии 1 (78 байт)
  const os2 = new Writer(78);
  os2.u16(1); // version
  os2.i16(UNITS); // xAvgCharWidth
  os2.u16(400); // usWeightClass
  os2.u16(5); // usWidthClass
  os2.u16(0); // fsType
  for (let i = 0; i < 10; i++) os2.i16(0); // sub/superscript, strikeout
  os2.i16(0); // sFamilyClass
  for (let i = 0; i < 10; i++) os2.u8(0); // panose
  for (let i = 0; i < 4; i++) os2.u32(0); // unicode ranges
  os2.tag('GEN1'); // achVendID
  os2.u16(0x0040); // fsSelection: regular
  os2.u16(0x0020); // usFirstCharIndex
  os2.u16(0x005a); // usLastCharIndex
  os2.i16(UNITS); // sTypoAscender
  os2.i16(0); // sTypoDescender
  os2.i16(0); // sTypoLineGap
  os2.u16(UNITS); // usWinAscent
  os2.u16(PIXEL); // usWinDescent
  os2.u32(1); // ulCodePageRange1: Latin
  os2.u32(0);

  const post = new Writer(32);
  post.u32(0x00030000); post.u32(0); post.i16(-100); post.i16(50);
  for (let i = 0; i < 5; i++) post.u32(0);

  const tables = {
    'OS/2': os2.take(), cmap: cmap.take(), glyf, head: head.take(),
    hhea: hhea.take(), hmtx: hmtx.take(), loca: loca.take(),
    maxp: maxp.take(), name: buildName(family), post: post.take(),
  };
  const names = Object.keys(tables).sort();
  const numTables = names.length;
  let power = 1;
  let entrySelector = 0;
  while (power * 2 <= numTables) { power *= 2; entrySelector++; }
  const searchRange = power * 16;
  const out = new Writer(65536);
  out.u32(0x00010000); out.u16(numTables); out.u16(searchRange); out.u16(entrySelector); out.u16(numTables * 16 - searchRange);
  const headerSize = 12 + 16 * numTables;
  let dataOffset = headerSize;
  const payload = new Writer(65536);
  for (const name of names) {
    const data = tables[name];
    out.tag(name);
    out.u32(checksum(data));
    out.u32(dataOffset);
    out.u32(data.length);
    payload.raw(data);
    payload.align4();
    dataOffset = headerSize + payload.length;
  }
  out.raw(payload.take());
  return out.take().buffer;
}

/**
 * Строит карту символов из CHR-данных ROM.
 * @param {Uint8Array} chr полный CHR-ROM (8 КиБ-банки подряд)
 * @param {'en'|'ru'} language
 */
export function glyphsFromRom(chr, language = 'en') {
  const glyphs = new Map();
  glyphs.set(' ', new Uint8Array(9));
  if (language === 'ru') {
    // Буквы — наш шрифт, собранный из английских глифов; цифры берём из ROM
    // (они одинаковые во всех языках и раньше выглядели нормально).
    const bank = chr.subarray(0, 8192);
    for (const [ch, rows] of BUILTIN_GLYPHS) {
      if (/[0-9]/.test(ch)) continue;
      glyphs.set(ch, rowsFromStrings(rows));
    }
    const digitRows = [1, 2, 3, 4, 4, 5, 6];
    for (const ch of '0123456789') {
      const src = glyphFromChr(bank, ch.charCodeAt(0));
      const rows = new Uint8Array(9);
      for (let y = 0; y < 7; y++) rows[y + 1] = src[digitRows[y]] ?? 0;
      glyphs.set(ch, rows);
    }
  } else {
    const bank = chr.subarray(0, 8192);
    for (const ch of LATIN) {
      const rows = glyphFromChr(bank, ch.charCodeAt(0));
      glyphs.set(ch, rows);
    }
  }
  for (const [ch, rows] of BUILTIN_PUNCTUATION) glyphs.set(ch, rowsFromStrings(rows));
  return glyphs;
}

/**
 * Готовит FontFace из ROM и добавляет его в документ.
 * @param {Uint8Array} chr
 * @param {'en'|'ru'} language
 * @param {string} family
 * @returns {Promise<string|null>}
 */
export async function installGameFont(chr, language, family, { advance = UNITS } = {}) {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return null;
  try {
    const glyphs = glyphsFromRom(chr, language);
    const ttf = buildTtf(glyphs, family, { advance });
    const face = new FontFace(family, ttf);
    await face.load();
    document.fonts.add(face);
    return family;
  } catch (error) {
    console.warn('game font failed', error);
    return null;
  }
}
