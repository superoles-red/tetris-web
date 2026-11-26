// Тесты PPU: синтетические состояния (без ROM) + дифференциальный тест
// против JSNES 2.1.0 на реальных дампах (если ROM доступен локально).
//
// Запуск: node --test tests/
// Дифференциальная часть пропускается (skip), если ROM нет в файловой системе
// или не установлен devDependency jsnes — в CI без ROM тесты зелёные.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  PPU,
  PPU_STATE_FORMAT,
  MIRROR_VERTICAL,
  MIRROR_HORIZONTAL,
  MIRROR_FOUR_SCREEN,
} from '../src/nes/ppu.js';
import {
  NTSC_PALETTE_BGR,
  PPU_DOTS_PER_SCANLINE,
  PPU_SCANLINES,
  PPU_VBLANK_SCANLINE,
  PPU_PRERENDER_SCANLINE,
} from '../src/nes/constants.js';
import { diffOneRom, DEFAULT_CHECK_FRAMES } from '../tools/ppu/diff-jsnes.mjs';

const W = 256;
const H = 240;
/** Цвет палитры по индексу NTSC. */
const C = index => NTSC_PALETTE_BGR[index];

/** Создаёт PPU с выключенным tv-кропом (как engine.js в старом порте). */
function makePpu({ mirroring = 'vertical', clipToTvSize = false } = {}) {
  const ppu = new PPU();
  ppu.clipToTvSize = clipToTvSize;
  ppu.setMirroring(mirroring);
  return ppu;
}

/** Записывает палитры: imgPalette[i] = NTSC[i], sprPalette[i] = NTSC[i]. */
function writeIdentityPalettes(ppu, imgPalette = null, sprPalette = null) {
  for (let i = 0; i < 16; i++) {
    ppu.writeMem(0x3f00 + i, imgPalette ? imgPalette[i] : i);
    ppu.writeMem(0x3f10 + i, sprPalette ? sprPalette[i] : i);
  }
}

/** Заполняет тайл: colorIndexes — 64 значения 0..3 (построчно). */
function fillTile(ppu, tileIndex, colorIndexes) {
  for (let y = 0; y < 8; y++) {
    let low = 0;
    let high = 0;
    for (let x = 0; x < 8; x++) {
      const color = colorIndexes[y * 8 + x];
      if (color & 1) low |= 1 << (7 - x);
      if (color & 2) high |= 1 << (7 - x);
    }
    ppu.writeMem(tileIndex * 16 + y, low);
    ppu.writeMem(tileIndex * 16 + 8 + y, high);
  }
}

/** Тайл одного цвета на все 64 пикселя. */
function uniformTile(ppu, tileIndex, colorIndex) {
  fillTile(ppu, tileIndex, new Array(64).fill(colorIndex));
}

/** Устанавливает адрес VRAM через $2006 (две записи). */
function setVramAddress(ppu, address) {
  ppu.writeReg(0x2006, (address >> 8) & 0xff);
  ppu.writeReg(0x2006, address & 0xff);
}

/** Рендерит один полный кадр через advanceDots (путь console.js). */
function renderOneFrame(ppu) {
  ppu.startFrame();
  let guard = 0;
  while (!ppu.frameEnded) {
    ppu.advanceDots(PPU_DOTS_PER_SCANLINE);
    if (++guard > 400) throw new Error('PPU: кадр не закончился');
  }
}

/** Пиксель из буфера. */
function px(ppu, x, y) {
  return ppu.buffer[y * W + x];
}

/** Простой тайл, у которого только колонка 0 непрозрачна (для проверки FH). */
function columnZeroTile(ppu, tileIndex, colorIndex) {
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) pixels.push(x === 0 ? colorIndex : 0);
  }
  fillTile(ppu, tileIndex, pixels);
}

// ===========================================================================
// Контракт фасада
// ===========================================================================

test('PPU: контракт фасада (размеры, типы, флаги)', () => {
  const ppu = new PPU();
  assert.ok(ppu.vramMem instanceof Uint8Array);
  assert.equal(ppu.vramMem.length, 0x8000);
  assert.ok(ppu.spriteMem instanceof Uint8Array);
  assert.equal(ppu.spriteMem.length, 256);
  assert.ok(ppu.buffer instanceof Uint32Array);
  assert.equal(ppu.buffer.length, W * H);
  assert.ok(ppu.imgPalette instanceof Uint32Array);
  assert.equal(ppu.imgPalette.length, 16);
  assert.ok(ppu.sprPalette instanceof Uint32Array);
  assert.equal(ppu.sprPalette.length, 16);
  assert.equal(ppu.ptTile.length, 512);
  for (const tile of ppu.ptTile) assert.equal(tile.pix.length, 64);

  for (const flag of [
    'f_bgVisibility', 'f_spVisibility', 'f_bgClipping', 'f_spClipping',
    'f_spriteSize', 'f_bgPatternTable', 'f_spPatternTable', 'f_nmiOnVblank', 'f_color',
  ]) {
    assert.equal(ppu[flag], 0, `${flag} должен быть доступен`);
  }
  assert.equal(typeof ppu.writeMem, 'function');
  assert.equal(typeof ppu.readMem, 'function');
  assert.equal(typeof ppu.readReg, 'function');
  assert.equal(typeof ppu.writeReg, 'function');
  assert.equal(typeof ppu.setMirroring, 'function');
  assert.equal(typeof ppu.setChrWindow, 'function');
  assert.equal(typeof ppu.startFrame, 'function');
  assert.equal(typeof ppu.advanceDots, 'function');
  assert.equal(typeof ppu.renderFullFrame, 'function');
  assert.equal(typeof ppu.toJSON, 'function');
  assert.equal(typeof ppu.fromJSON, 'function');
  assert.equal(ppu.frameEnded, false);
  assert.equal(ppu.nmiPending, false);
  assert.equal(ppu.sprite0Hit, false);
});

test('PPU: буфер хранит цвета NTSC в формате JSNES 0x00BBGGRR', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  ppu.writeReg(0x2001, 0x0e); // BG on, левый кроп выключен
  ppu.renderFullFrame();
  assert.equal(px(ppu, 10, 10), NTSC_PALETTE_BGR[1]);
});

// ===========================================================================
// Регистры $2000-$2007, зеркала и открытая шина
// ===========================================================================

test('PPU: регистры $2000-$3FFF зеркалятся по младшим 3 битам адреса', () => {
  const ppu = makePpu();
  // $2008 — зеркало $2000: бит 3 включает sprite pattern table $1000.
  ppu.writeReg(0x2008, 0x08);
  assert.equal(ppu.f_spPatternTable, 1);
  // $3FF8 — тоже зеркало $2000.
  ppu.writeReg(0x3ff8, 0x00);
  assert.equal(ppu.f_spPatternTable, 0);
  // $2009 — зеркало $2001.
  ppu.writeReg(0x2009, 0x0e);
  assert.equal(ppu.f_bgVisibility, 1);
  // $200A — $2002 (только чтение), $200B — $2003, $200C — $2004, ...
  ppu.writeReg(0x2003, 7);
  assert.equal(ppu.sramAddress, 7);
  ppu.writeMem(0x3f00, 0x0f);
  setVramAddress(ppu, 0x3f00);
  assert.equal(ppu.readReg(0x2007) & 0x3f, 0x0f);
});

test('PPU: чтение write-only регистров и $2002 возвращает открытую шину', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2005, 0xab);
  assert.equal(ppu.readReg(0x2000), 0xab);
  assert.equal(ppu.readReg(0x2001), 0xab);
  assert.equal(ppu.readReg(0x2005), 0xab);
  // $2002: биты 7-5 — статус, биты 4-0 — открытая шина.
  ppu.writeReg(0x2005, 0xc3);
  const status = ppu.readReg(0x2002);
  assert.equal(status, 0x03);
  // Чтение $2002 сбрасывает vblank и защёлку адреса.
  ppu.vblankFlag = true;
  ppu.sprite0Hit = true;
  const status2 = ppu.readReg(0x2002);
  assert.equal(status2 & 0xc0, 0xc0);
  assert.equal(ppu.vblankFlag, false);
});

test('PPU: $2000 управляет флагами, NMI и базой nametable', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2000, 0x90); // NMI on, BG pattern table $1000
  assert.equal(ppu.f_nmiOnVblank, 1);
  assert.equal(ppu.f_bgPatternTable, 1);
  assert.equal(ppu.regV, 0);
  assert.equal(ppu.regH, 0);
  ppu.writeReg(0x2000, 0x83); // nametable 3
  assert.equal(ppu.regV, 1);
  assert.equal(ppu.regH, 1);
  ppu.writeReg(0x2000, 0x04); // increment 32
  assert.equal(ppu.f_addrInc, 1);
});

test('PPU: $2001 управляет флагами слоёв и палитрами', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  ppu.writeReg(0x2001, 0x1e);
  assert.equal(ppu.f_spVisibility, 1);
  assert.equal(ppu.f_bgVisibility, 1);
  assert.equal(ppu.f_spClipping, 1);
  assert.equal(ppu.f_bgClipping, 1);
  assert.equal(ppu.imgPalette[1], C(1));
  ppu.writeReg(0x2001, 0x08);
  assert.equal(ppu.f_spVisibility, 0);
  assert.equal(ppu.f_bgVisibility, 1);
});

test('PPU: $2003/$2004 пишут и читают OAM, $2004 маскирует биты атрибутов', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2003, 4);
  ppu.writeReg(0x2004, 0xab);
  assert.equal(ppu.spriteMem[4], 0xab);
  assert.equal(ppu.sramAddress, 5);
  ppu.writeReg(0x2003, 6);
  ppu.writeReg(0x2004, 0xff);
  // Байт атрибутов: биты 2-4 не реализованы, читаются нулём.
  ppu.writeReg(0x2003, 6);
  assert.equal(ppu.readReg(0x2004), 0xe3);
});

test('PPU: oamDma копирует страницу CPU-памяти начиная с OAMADDR с переносом', () => {
  const ppu = makePpu();
  const memory = new Uint8Array(0x10000);
  for (let i = 0; i < 256; i++) memory[0x0300 + i] = i;
  ppu.sramAddress = 0;
  ppu.oamDma(memory, 3);
  assert.equal(ppu.spriteMem[0], 0);
  assert.equal(ppu.spriteMem[255], 255);
  ppu.sramAddress = 0x80;
  ppu.oamDma(memory, 3);
  assert.equal(ppu.spriteMem[0x80], 0);
  assert.equal(ppu.spriteMem[0x7f], 0xff);
  assert.equal(ppu.spriteMem[0x00], 0x80);
});

// ===========================================================================
// loopy-скролл, $2006/$2007, инкремент адреса
// ===========================================================================

test('PPU: $2005 задаёт горизонтальный и вертикальный скролл', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2005, (21 << 3) | 3);
  assert.equal(ppu.regHT, 21);
  assert.equal(ppu.regFH, 3);
  ppu.writeReg(0x2005, (7 << 3) | 5);
  assert.equal(ppu.regVT, 7);
  assert.equal(ppu.regFV, 5);
  // Третья запись снова интерпретируется как X (защёлка из двух шагов).
  ppu.writeReg(0x2005, (1 << 3) | 2);
  assert.equal(ppu.regHT, 1);
  assert.equal(ppu.regFH, 2);
});

test('PPU: $2006 задаёт адрес VRAM (t -> v), $2007 пишет и инкрементирует', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2006, 0x21);
  ppu.writeReg(0x2006, 0x08);
  assert.equal(ppu.vramAddress, 0x2108);
  assert.equal(ppu.cntHT, 8);
  assert.equal(ppu.cntVT, 8);
  assert.equal(ppu.cntFV, 2);
  ppu.writeReg(0x2007, 0x55);
  assert.equal(ppu.readMem(0x2108), 0x55);
  assert.equal(ppu.vramAddress, 0x2109); // +1
  // $2000 bit2 -> +32.
  ppu.writeReg(0x2000, 0x04); // increment 32
  ppu.writeReg(0x2007, 0x66); // запись в 0x2109, затем +32
  assert.equal(ppu.vramAddress, 0x2109 + 32);
  setVramAddress(ppu, 0x2109);
  assert.equal(ppu.readMem(0x2109), 0x66);
});

test('PPU: $2007 чтение буферизуется для CHR/nametable и сразу отдаёт палитры', () => {
  const ppu = makePpu();
  ppu.writeMem(0x2000, 0xab);
  ppu.writeMem(0x2001, 0xcd);
  setVramAddress(ppu, 0x2000);
  assert.equal(ppu.readReg(0x2007), 0, 'первое чтение отдаёт старый буфер');
  assert.equal(ppu.readReg(0x2007), 0xab);
  assert.equal(ppu.readReg(0x2007), 0xcd);
  // Палитра читается без задержки, но подгружает буфер данными nametable.
  ppu.writeMem(0x3f00, 0x21);
  setVramAddress(ppu, 0x3f00);
  assert.equal(ppu.readReg(0x2007) & 0x3f, 0x21);
});

test('PPU: $2002 сбрасывает защёлку $2005/$2006', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2005, 0x10); // первая запись X
  ppu.readReg(0x2002);
  ppu.writeReg(0x2005, 0xff); // после $2002 это снова первая запись
  assert.equal(ppu.regHT, 31);
  assert.equal(ppu.regFH, 7);
  assert.equal(ppu.regFV, 0);

  ppu.writeReg(0x2006, 0x20); // первая запись старшего байта (будет потеряна)
  ppu.readReg(0x2002); // сбрасывает защёлку
  ppu.writeReg(0x2006, 0x21); // снова старший байт
  ppu.writeReg(0x2006, 0x00); // младший байт
  assert.equal(ppu.regHT, 0);
  assert.equal(ppu.cntVT, 8); // (0x21 & 3) << 3 = 8
  assert.equal(ppu.cntFV, 2); // (0x21 >> 4) & 3 = 2
  assert.equal(ppu.vramAddress, 0x2100);
});

// ===========================================================================
// Зеркалирование nametables и палитр
// ===========================================================================

test('PPU: вертикальное зеркалирование nametables ($2800 -> $2000)', () => {
  const ppu = makePpu({ mirroring: 'vertical' });
  assert.equal(ppu.currentMirroring, MIRROR_VERTICAL);
  setVramAddress(ppu, 0x2800);
  ppu.writeReg(0x2007, 0x5a);
  assert.equal(ppu.readMem(0x2000), 0x5a);
  assert.equal(ppu.readMem(0x2800), 0x5a);
  assert.equal(ppu.readMem(0x2000), 0x5a);
  // $2C00 ($2400) — независимая страница.
  assert.equal(ppu.readMem(0x2400), 0);
  // $3000-$3EFF зеркалят $2000-$2EFF.
  assert.equal(ppu.readMem(0x3000), 0x5a);
  // Через $2007 адрес $2C00 тоже попадает в зеркало $2400.
  setVramAddress(ppu, 0x2400);
  ppu.writeReg(0x2007, 0x77);
  setVramAddress(ppu, 0x2c00);
  ppu.writeReg(0x2007, 0x88);
  assert.equal(ppu.readMem(0x2400), 0x88);
});

test('PPU: горизонтальное и four-screen зеркалирование', () => {
  const ppu = makePpu({ mirroring: 'horizontal' });
  assert.equal(ppu.currentMirroring, MIRROR_HORIZONTAL);
  setVramAddress(ppu, 0x2400);
  ppu.writeReg(0x2007, 0x11);
  assert.equal(ppu.readMem(0x2000), 0x11);
  setVramAddress(ppu, 0x2c00);
  ppu.writeReg(0x2007, 0x22);
  assert.equal(ppu.readMem(0x2800), 0x22);
  assert.equal(ppu.readMem(0x2000), 0x11);

  const four = makePpu({ mirroring: 'four' });
  assert.equal(four.currentMirroring, MIRROR_FOUR_SCREEN);
  for (const [address, value] of [[0x2000, 1], [0x2400, 2], [0x2800, 3], [0x2c00, 4]]) {
    setVramAddress(four, address);
    four.writeReg(0x2007, value);
  }
  assert.deepEqual(
    [four.readMem(0x2000), four.readMem(0x2400), four.readMem(0x2800), four.readMem(0x2c00)],
    [1, 2, 3, 4],
  );
});

test('PPU: палитры $3F00 зеркалятся ($3F20+, фон $3F10 -> $3F00)', () => {
  const ppu = makePpu();
  ppu.writeMem(0x3f00, 0x0f);
  setVramAddress(ppu, 0x3f10);
  assert.equal(ppu.readReg(0x2007) & 0x3f, 0x0f, '$3F10 читает фон $3F00');
  setVramAddress(ppu, 0x3f20);
  assert.equal(ppu.readReg(0x2007) & 0x3f, 0x0f, '$3F20 зеркалит $3F00');
  // Запись через $2007 в $3F00 обновляет и $3F10 (поведение JSNES/железа).
  setVramAddress(ppu, 0x3f00);
  ppu.writeReg(0x2007, 0x22);
  assert.equal(ppu.readMem(0x3f00), 0x22);
  assert.equal(ppu.readMem(0x3f10), 0x22);
  assert.equal(ppu.imgPalette[0], C(0x22));
  assert.equal(ppu.sprPalette[0], C(0x22));
});

// ===========================================================================
// CHR: окно от маппера и запись через $2007
// ===========================================================================

test('PPU: setChrWindow копирует 8 КиБ и декодирует ptTile', () => {
  const ppu = makePpu();
  const chr = new Uint8Array(8192);
  for (let y = 0; y < 8; y++) {
    chr[3 * 16 + y] = 0xff; // tile 3, plane 0
    chr[3 * 16 + 8 + y] = 0xff; // tile 3, plane 1
  }
  ppu.setChrWindow(chr);
  assert.equal(ppu.readMem(0x30), 0xff);
  for (let i = 0; i < 64; i++) assert.equal(ppu.ptTile[3].pix[i], 3);
  assert.throws(() => ppu.setChrWindow(new Uint8Array(10)), /8192/);
});

test('PPU: запись в CHR через $2007 декодирует тайл и зовёт onChrWrite', () => {
  const ppu = makePpu();
  const writes = [];
  ppu.chrWritable = true;
  ppu.onChrWrite = (address, value) => writes.push([address, value]);
  setVramAddress(ppu, 0x0010); // тайл 1, строка 0, plane 0
  ppu.writeReg(0x2007, 0x80);
  assert.equal(ppu.readMem(0x10), 0x80);
  assert.equal(ppu.ptTile[1].pix[0], 1); // пиксель 0 первой строки
  assert.deepEqual(writes, [[0x10, 0x80]]);
  // Обратное чтение $2007 даёт буферизованное значение.
  setVramAddress(ppu, 0x0010);
  ppu.readReg(0x2007);
  assert.equal(ppu.readReg(0x2007), 0x80);
});

test('PPU: без CHR RAM запись в CHR через $2007 игнорируется', () => {
  const ppu = makePpu();
  setVramAddress(ppu, 0x0000);
  ppu.writeReg(0x2007, 0xff);
  assert.equal(ppu.readMem(0x0000), 0);
  assert.equal(ppu.ptTile[0].pix[0], 0);
});

// ===========================================================================
// Рендер фона: палитры, атрибуты, скролл, кроп
// ===========================================================================

test('PPU: фон рисуется из nametable и палитры', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  ppu.writeReg(0x2001, 0x0e); // BG on, без левого/тв-кропа
  ppu.renderFullFrame();
  // Вся видимая область, кроме строки 0 (см. тест JSNES row-0 quirk).
  assert.equal(px(ppu, 0, 1), C(1));
  assert.equal(px(ppu, 255, 239), C(1));
  assert.equal(px(ppu, 128, 120), C(1));
});

test('PPU: row-0 quirk JSNES-совместимости (непрозрачный BG в строке 0 обнуляется)', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  ppu.writeReg(0x2001, 0x0e);
  ppu.renderFullFrame();
  for (let x = 0; x < W; x++) assert.equal(ppu.buffer[x], 0, `строка 0, x=${x}`);
  // Прозрачный фон в строке 0 остаётся цветом backdrop.
  uniformTile(ppu, 0, 0);
  ppu.renderFullFrame();
  for (let x = 0; x < W; x++) assert.equal(ppu.buffer[x], C(0), `строка 0, x=${x}`);
});

test('PPU: атрибуты выбирают палитру для квадрантов 16x16', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  ppu.writeMem(0x23c0, 0xd9); // TL=1, TR=2, BL=1, BR=3
  ppu.writeReg(0x2001, 0x0e);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 2, 2), C(1 + 4));
  assert.equal(px(ppu, 20, 2), C(1 + 8));
  assert.equal(px(ppu, 2, 18), C(1 + 4));
  assert.equal(px(ppu, 20, 18), C(1 + 12));
  assert.equal(px(ppu, 34, 2), C(1)); // следующий атрибутный байт = палитра 0
});

test('PPU: горизонтальный скролл (coarse и fine X)', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  // Тайл 0: колонка 0 цвета 2, остальные — 1. Тайл 1: всё цвета 2.
  const columns = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) columns.push(x === 0 ? 2 : 1);
  }
  fillTile(ppu, 0, columns);
  uniformTile(ppu, 1, 2);
  for (let col = 1; col < 32; col++) ppu.writeMem(0x2000 + col, 1);
  ppu.writeReg(0x2001, 0x0e);

  // coarse X = 1: первый тайл строки — nametable column 1 (тайл 1).
  ppu.writeReg(0x2005, 1 << 3);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 0, 1), C(2));

  // fine X = 1: строка сдвинута на 1 пиксель влево.
  const ppu2 = makePpu();
  writeIdentityPalettes(ppu2);
  fillTile(ppu2, 0, columns);
  uniformTile(ppu2, 1, 2);
  for (let col = 1; col < 32; col++) ppu2.writeMem(0x2000 + col, 1);
  ppu2.writeReg(0x2001, 0x0e);
  ppu2.writeReg(0x2005, 0x01); // FH=1
  ppu2.renderFullFrame();
  assert.equal(px(ppu2, 0, 1), C(1)); // пиксель sx=1 тайла 0
  assert.equal(px(ppu2, 6, 1), C(1)); // sx=7 тайла 0
  assert.equal(px(ppu2, 7, 1), C(2)); // следующий тайл
  assert.equal(px(ppu2, 247, 1), C(2));
  // Как у JSNES: правые FH пикселей строки не заполняются (остаётся backdrop).
  assert.equal(px(ppu2, 255, 1), C(0));
});

test('PPU: вертикальный скролл (coarse Y)', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  uniformTile(ppu, 1, 2);
  for (let col = 0; col < 32; col++) ppu.writeMem(0x2020 + col, 1); // nametable row 1
  ppu.writeReg(0x2001, 0x0e);
  ppu.writeReg(0x2005, 0x00); // X = 0
  ppu.writeReg(0x2005, 8); // coarse Y = 1
  ppu.renderFullFrame();
  assert.equal(px(ppu, 10, 1), C(2)); // строки 1..7 — nametable row 1
  assert.equal(px(ppu, 10, 12), C(1)); // дальше nametable row 2 = тайл 0
});

test('PPU: pattern table выбирается битом $2000', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  uniformTile(ppu, 256, 2);
  ppu.writeReg(0x2000, 0x10); // BG pattern table = $1000
  ppu.writeReg(0x2001, 0x0e);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 10, 10), C(2));
});

test('PPU: левый кроп обнуляет 8 пикселей, если один из слоёв скрыт слева', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  // $2001: BG on, bg clipping on, sprite clipping OFF -> JSNES чистит левые 8 px.
  ppu.writeReg(0x2001, 0x0a);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 3, 10), 0);
  assert.equal(px(ppu, 8, 10), C(1));

  const ppu2 = makePpu();
  writeIdentityPalettes(ppu2);
  uniformTile(ppu2, 0, 1);
  ppu2.writeReg(0x2001, 0x0e); // оба кропа выключены
  ppu2.renderFullFrame();
  assert.equal(px(ppu2, 3, 10), C(1));
});

test('PPU: clipToTvSize обнуляет рамку 8 px по краям кадра', () => {
  const ppu = makePpu({ clipToTvSize: true });
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  ppu.writeReg(0x2001, 0x1e);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 100, 10), C(1));
  assert.equal(px(ppu, 0, 100), 0, 'левая рамка');
  assert.equal(px(ppu, 255, 100), 0, 'правая рамка');
  assert.equal(px(ppu, 100, 7), 0, 'верхняя рамка');
  assert.equal(px(ppu, 100, 232), 0, 'нижняя рамка');
  assert.equal(px(ppu, 100, 8), C(1));
});

test('PPU: выключенный рендер оставляет фон backdrop', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  ppu.writeReg(0x2001, 0x06); // BG и sprites выключены, кропы выключены
  ppu.renderFullFrame();
  for (let y = 0; y < H; y += 37) {
    for (let x = 0; x < W; x += 41) assert.equal(px(ppu, x, y), C(0), `${x},${y}`);
  }
  // Поменяли палитру фона — backdrop следующего кадра другой.
  ppu.writeMem(0x3f00, 0x0c);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 10, 10), C(0x0c));
});

// ===========================================================================
// Спрайты: 8x8, 8x16, flips, приоритет, кроп
// ===========================================================================

test('PPU: спрайт 8x8 рисуется в позиции OAM (+1 к Y) и в цветах sprPalette', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 3);
  ppu.spriteMem.set([10, 2, 0x00, 16]);
  ppu.writeReg(0x2001, 0x16); // sprites on, кропы выключены, BG off
  ppu.renderFullFrame();
  assert.equal(px(ppu, 16, 11), C(3));
  assert.equal(px(ppu, 23, 18), C(3));
  assert.equal(px(ppu, 15, 11), C(0));
  assert.equal(px(ppu, 24, 11), C(0));
  assert.equal(px(ppu, 16, 10), C(0), 'Y в OAM на 1 меньше экранной строки');
  assert.equal(px(ppu, 16, 19), C(0));
});

test('PPU: спрайтовая палитра берётся из $3F10', () => {
  const ppu = makePpu();
  // sprPalette[3] = NTSC[0x2a]; палитра спрайта 0, цвет 3 -> C(0x2a).
  writeIdentityPalettes(ppu, null, [0, 0, 0, 0x2a, 0, 0, 0, 0]);
  uniformTile(ppu, 2, 3);
  ppu.spriteMem.set([10, 2, 0x00, 16]);
  ppu.writeReg(0x2001, 0x16);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 16, 11), C(0x2a));
});

test('PPU: вертикальный и горизонтальный flip спрайта', () => {
  const rows = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rows.push(y === 0 ? 1 : 2);
  const vert = makePpu();
  writeIdentityPalettes(vert);
  fillTile(vert, 2, rows);
  vert.spriteMem.set([10, 2, 0x80, 16]); // vertical flip
  vert.writeReg(0x2001, 0x16);
  vert.renderFullFrame();
  assert.equal(px(vert, 16, 11), C(2), 'верхняя строка — низ тайла');
  assert.equal(px(vert, 16, 18), C(1), 'нижняя строка — верх тайла');

  const cols = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) cols.push(x === 0 ? 1 : 2);
  const hori = makePpu();
  writeIdentityPalettes(hori);
  fillTile(hori, 2, cols);
  hori.spriteMem.set([10, 2, 0x40, 16]); // horizontal flip
  hori.writeReg(0x2001, 0x16);
  hori.renderFullFrame();
  assert.equal(px(hori, 16, 11), C(2));
  assert.equal(px(hori, 23, 11), C(1));
});

test('PPU: приоритет спрайт/BG по биту 5 атрибута', () => {
  // BG непрозрачен везде.
  const behind = makePpu();
  writeIdentityPalettes(behind);
  uniformTile(behind, 0, 1); // BG
  uniformTile(behind, 2, 3); // sprite
  behind.spriteMem.set([10, 2, 0x20, 16]); // behind BG
  behind.writeReg(0x2001, 0x1e);
  behind.renderFullFrame();
  assert.equal(px(behind, 16, 11), C(1), 'спрайт за непрозрачным BG не виден');

  // BG прозрачен — спрайт за фоном виден.
  const transparent = makePpu();
  writeIdentityPalettes(transparent);
  uniformTile(transparent, 0, 0);
  uniformTile(transparent, 2, 3);
  transparent.spriteMem.set([10, 2, 0x20, 16]);
  transparent.writeReg(0x2001, 0x1e);
  transparent.renderFullFrame();
  assert.equal(px(transparent, 16, 11), C(3));

  // Спрайт перед BG (бит 5 = 0) виден поверх.
  const front = makePpu();
  writeIdentityPalettes(front);
  uniformTile(front, 0, 1);
  uniformTile(front, 2, 3);
  front.spriteMem.set([10, 2, 0x00, 16]);
  front.writeReg(0x2001, 0x1e);
  front.renderFullFrame();
  assert.equal(px(front, 16, 11), C(3));
});

test('PPU: приоритет между спрайтами — по индексу в OAM', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 1);
  uniformTile(ppu, 3, 2);
  ppu.spriteMem.set([10, 2, 0x00, 16]); // sprite 0
  ppu.spriteMem.set([10, 3, 0x00, 18], 4); // sprite 1
  ppu.writeReg(0x2001, 0x16);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 16, 11), C(1));
  assert.equal(px(ppu, 18, 11), C(1), 'пересечение: побеждает спрайт 0');
  assert.equal(px(ppu, 23, 11), C(1));
  assert.equal(px(ppu, 24, 11), C(2));
  assert.equal(px(ppu, 25, 11), C(2));
});

test('PPU: 8x16 спрайты (две половины, выбор pattern table битом 0 тайла)', () => {
  // Тайл чётный -> верхняя половина из table 0.
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 1);
  uniformTile(ppu, 3, 2);
  ppu.spriteMem.set([10, 2, 0x00, 16]);
  ppu.writeReg(0x2000, 0x20); // sprite size 8x16
  ppu.writeReg(0x2001, 0x16);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 16, 11), C(1));
  assert.equal(px(ppu, 16, 18), C(1));
  assert.equal(px(ppu, 16, 19), C(2));
  assert.equal(px(ppu, 16, 26), C(2));
  assert.equal(px(ppu, 16, 27), C(0));

  // Тайл нечётный -> верхняя половина из table 1 (ptTile +256).
  const odd = makePpu();
  writeIdentityPalettes(odd);
  uniformTile(odd, 258, 3);
  uniformTile(odd, 259, 1);
  odd.spriteMem.set([10, 3, 0x00, 16]);
  odd.writeReg(0x2000, 0x20);
  odd.writeReg(0x2001, 0x16);
  odd.renderFullFrame();
  assert.equal(px(odd, 16, 11), C(3));
  assert.equal(px(odd, 16, 19), C(1));
});

test('PPU: 8x16 vertical flip', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 1);
  uniformTile(ppu, 3, 2);
  ppu.spriteMem.set([10, 2, 0x80, 16]); // flip
  ppu.writeReg(0x2000, 0x20);
  ppu.writeReg(0x2001, 0x16);
  ppu.renderFullFrame();
  // Верхние 8 строк — низ спрайта (тайл 3), нижние — верх (тайл 2).
  assert.equal(px(ppu, 16, 11), C(2));
  assert.equal(px(ppu, 16, 18), C(2));
  assert.equal(px(ppu, 16, 19), C(1));
  assert.equal(px(ppu, 16, 26), C(1));
});

test('PPU: левый кроп спрайтов выполняется в конце кадра', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 3);
  ppu.spriteMem.set([10, 2, 0x00, 0]);
  ppu.writeReg(0x2001, 0x16); // оба кропа включены -> спрайт в x=0 виден
  ppu.renderFullFrame();
  assert.equal(px(ppu, 0, 11), C(3));

  const clipped = makePpu();
  writeIdentityPalettes(clipped);
  uniformTile(clipped, 2, 3);
  clipped.spriteMem.set([10, 2, 0x00, 4]); // занимает x=4..11
  clipped.writeReg(0x2001, 0x12); // sprite clipping выключен
  clipped.renderFullFrame();
  for (let x = 4; x < 8; x++) assert.equal(px(clipped, x, 11), 0);
  assert.equal(px(clipped, 8, 11), C(3));
});

test('PPU: спрайты до OAMADDR не оцениваются', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 3);
  ppu.spriteMem.set([10, 2, 0x00, 16]); // запись OAM 0
  ppu.spriteMem.set([10, 2, 0x00, 30], 4); // запись OAM 1
  ppu.writeReg(0x2003, 4); // OAMADDR -> начинать со спрайта 1
  ppu.writeReg(0x2001, 0x16);
  ppu.renderFullFrame();
  assert.equal(px(ppu, 16, 11), C(0), 'спрайт 0 скрыт OAMADDR');
  assert.equal(px(ppu, 30, 11), C(3), 'спрайт 1 виден');
});

// ===========================================================================
// Sprite 0 hit и sprite overflow
// ===========================================================================

/** PPU с непрозрачным BG (mask 0x1E) — база для тестов sprite 0. */
function spriteZeroPpu({ spriteX = 16, spriteY = 10, attr = 0x00 } = {}) {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1); // BG непрозрачен везде
  uniformTile(ppu, 2, 3);
  ppu.spriteMem.set([spriteY, 2, attr, spriteX]);
  ppu.writeReg(0x2001, 0x1e);
  return ppu;
}

/** Рендерит кадр и возвращает $2002 (позволяет проверить sprite 0 hit). */
function statusAfterFrame(ppu) {
  renderOneFrame(ppu);
  return ppu.readReg(0x2002);
}

test('PPU: sprite 0 hit выставляется при совпадении непрозрачных пикселей', () => {
  const ppu = spriteZeroPpu();
  const status = statusAfterFrame(ppu);
  assert.ok(status & 0x40, 'бит 6 $2002 должен быть выставлен');
  assert.ok(ppu.sprite0Hit);

  // BG прозрачен -> hit нет.
  const transparent = makePpu();
  writeIdentityPalettes(transparent);
  uniformTile(transparent, 0, 0);
  uniformTile(transparent, 2, 3);
  transparent.spriteMem.set([10, 2, 0x00, 16]);
  transparent.writeReg(0x2001, 0x1e);
  const status2 = statusAfterFrame(transparent);
  assert.equal(status2 & 0x40, 0);
});

test('PPU: sprite 0 hit не бывает на x=255', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 0, 1);
  // Спрайт непрозрачен только в пикселе 7, X=248 -> экранный x=255.
  const pixels = new Array(64).fill(0);
  for (let y = 0; y < 8; y++) pixels[y * 8 + 7] = 3;
  fillTile(ppu, 2, pixels);
  ppu.spriteMem.set([10, 2, 0x00, 248]);
  ppu.writeReg(0x2001, 0x1e);
  const status = statusAfterFrame(ppu);
  assert.equal(status & 0x40, 0);

  // А с X=247 (экранный x=254) hit есть.
  const ppu2 = spriteZeroPpu({ spriteX: 247 });
  const status2 = statusAfterFrame(ppu2);
  assert.ok(status2 & 0x40);
});

test('PPU: sprite 0 hit не срабатывает в левых 8 пикселях при кропе', () => {
  // sprite 0 в x=0, BG непрозрачен.
  const clipped = makePpu();
  writeIdentityPalettes(clipped);
  uniformTile(clipped, 0, 1);
  uniformTile(clipped, 2, 3);
  clipped.spriteMem.set([10, 2, 0x00, 0]);
  // $2001: sprites+BG on, sprite clipping выключен -> левые 8 px не проверяются.
  clipped.writeReg(0x2001, 0x1a);
  const status = statusAfterFrame(clipped);
  assert.equal(status & 0x40, 0);

  const visible = makePpu();
  writeIdentityPalettes(visible);
  uniformTile(visible, 0, 1);
  uniformTile(visible, 2, 3);
  visible.spriteMem.set([10, 2, 0x00, 0]);
  visible.writeReg(0x2001, 0x1e);
  const status2 = statusAfterFrame(visible);
  assert.ok(status2 & 0x40, 'при обоих включённых кропах hit в x<8 возможен');
});

test('PPU: sprite 0 hit требует обоих включённых слоёв', () => {
  const ppu = spriteZeroPpu();
  ppu.writeReg(0x2001, 0x16); // BG выключен (bit3=0), sprites on
  const status = statusAfterFrame(ppu);
  assert.equal(status & 0x40, 0);
});

test('PPU: sprite overflow выставляется при 9-м спрайте в строке и снимается pre-render', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  uniformTile(ppu, 2, 3);
  ppu.spriteMem.fill(0xf8); // остальные спрайты спрятаны вне экрана
  for (let i = 0; i < 9; i++) ppu.spriteMem.set([10, 2, 0x00, i * 8], i * 4);
  ppu.writeReg(0x2001, 0x16);
  let status = statusAfterFrame(ppu);
  assert.ok(status & 0x20, 'бит 5 $2002 (overflow)');
  assert.equal(ppu.overflowFlag, true);

  // Pre-render снимает флаг: следующий кадр без overflow (8 спрайтов).
  const ppu2 = makePpu();
  writeIdentityPalettes(ppu2);
  uniformTile(ppu2, 2, 3);
  ppu2.spriteMem.fill(0xf8);
  for (let i = 0; i < 8; i++) ppu2.spriteMem.set([10, 2, 0x00, i * 8], i * 4);
  ppu2.writeReg(0x2001, 0x16);
  status = statusAfterFrame(ppu2);
  assert.equal(status & 0x20, 0);
});

// ===========================================================================
// Тайминги: строки, vblank, NMI, граница кадра
// ===========================================================================

test('PPU: vblank и frameEnded на строке 241, кадр = 341*262 dot', () => {
  const ppu = makePpu();
  ppu.setMirroring('vertical');
  // Первый кадр после включения длиннее на стартовый vblank-хвост (как JSNES).
  let firstFrameDots = 0;
  while (!ppu.frameEnded) {
    ppu.advanceDots(1);
    firstFrameDots++;
    if (firstFrameDots > PPU_DOTS_PER_SCANLINE * (PPU_SCANLINES + 1)) {
      assert.fail('кадр не закончился');
    }
  }
  assert.equal(firstFrameDots, PPU_DOTS_PER_SCANLINE * PPU_SCANLINES + 2);
  assert.equal(ppu.scanline, PPU_VBLANK_SCANLINE);
  assert.equal(ppu.vblankFlag, true);

  // Второй кадр — ровно 341*262 точек.
  ppu.startFrame();
  assert.equal(ppu.frameEnded, false);
  let secondFrameDots = 0;
  while (!ppu.frameEnded) {
    ppu.advanceDots(1);
    secondFrameDots++;
    if (secondFrameDots > PPU_DOTS_PER_SCANLINE * (PPU_SCANLINES + 1)) {
      assert.fail('кадр не закончился');
    }
  }
  assert.equal(secondFrameDots, PPU_DOTS_PER_SCANLINE * PPU_SCANLINES);
  assert.equal(ppu.scanline, PPU_VBLANK_SCANLINE);
});

test('PPU: NMI выставляется по $2000 bit7, чтение $2002 снимает только vblank', () => {
  const ppu = makePpu();
  ppu.writeReg(0x2000, 0x80); // NMI on
  ppu.startFrame();
  ppu.advanceDots(PPU_DOTS_PER_SCANLINE * PPU_SCANLINES + 2);
  assert.equal(ppu.frameEnded, true);
  assert.equal(ppu.scanline, PPU_VBLANK_SCANLINE);
  assert.equal(ppu.nmiPending, true);
  assert.equal(ppu.vblankFlag, true);
  const status = ppu.readReg(0x2002);
  assert.ok(status & 0x80);
  // Чтение $2002 снимает vblank, но не отменяет NMI (его снимает консоль).
  assert.equal(ppu.nmiPending, true);
  assert.equal(ppu.vblankFlag, false);

  // Без бита 7 NMI не выставляется.
  const ppu2 = makePpu();
  ppu2.writeReg(0x2000, 0x00);
  ppu2.startFrame();
  while (!ppu2.frameEnded) ppu2.advanceDots(PPU_DOTS_PER_SCANLINE);
  assert.equal(ppu2.nmiPending, false);
});

test('PPU: pre-render снимает vblank, sprite0 hit и overflow', () => {
  const ppu = makePpu();
  // Досчитываем ровно до (241, dot=2) — момент сразу после vblank.
  ppu.advanceDots(PPU_DOTS_PER_SCANLINE * PPU_SCANLINES + 2);
  assert.equal(ppu.vblankFlag, true);
  ppu.sprite0Hit = true;
  ppu.overflowFlag = true;
  // От (241, dot=2) до pre-render (261) dot 1: 339 + 19*341 + 2 = 6820.
  ppu.advanceDots(6820);
  assert.equal(ppu.scanline, PPU_PRERENDER_SCANLINE);
  assert.equal(ppu.vblankFlag, false);
  assert.equal(ppu.sprite0Hit, false);
  assert.equal(ppu.overflowFlag, false);
});

test('PPU: включение NMI при активном vblank даёт NMI', () => {
  const ppu = makePpu();
  ppu.advanceDots(PPU_DOTS_PER_SCANLINE * PPU_SCANLINES + 2);
  assert.equal(ppu.vblankFlag, true);
  assert.equal(ppu.nmiPending, false);
  ppu.writeReg(0x2000, 0x80);
  assert.equal(ppu.nmiPending, true);
});

// ===========================================================================
// Grayscale/emphasis
// ===========================================================================

test('PPU: монохромный режим ($2001 bit0) берёт старшие 2 бита цвета', () => {
  const ppu = makePpu();
  ppu.writeMem(0x3f00, 0x0f);
  ppu.writeReg(0x2001, 0x09); // dispType=1, BG on
  assert.equal(ppu.f_dispType, 1);
  assert.equal(ppu.imgPalette[0], C(0));
  ppu.writeMem(0x3f00, 0x36); // & 0x30 = 0x30
  assert.equal(ppu.imgPalette[0], C(0x30));
  ppu.writeMem(0x3f10, 0x2a); // & 0x30 = 0x20
  assert.equal(ppu.sprPalette[0], C(0x20));
});

test('PPU: emphasis цветов ($2001 bits 5-7) применяется к палитре', () => {
  // NTSC[0] = 0x525252: при акценте на красный зелёный и синий * 0.75.
  const ppu = makePpu();
  ppu.writeMem(0x3f00, 0);
  ppu.writeReg(0x2001, 0x2e); // f_color=1, BG on, dispType=0
  assert.equal(ppu.f_color, 1);
  assert.equal(ppu.imgPalette[0], 0x523d3d);
  ppu.writeReg(0x2001, 0x4e); // f_color=2 -> красный и синий
  assert.equal(ppu.imgPalette[0], 0x3d523d);
  ppu.writeReg(0x2001, 0x8e); // f_color=4 -> красный и зелёный
  assert.equal(ppu.imgPalette[0], 0x3d3d52);
  ppu.writeReg(0x2001, 0x0e); // f_color=0 -> исходный цвет
  assert.equal(ppu.imgPalette[0], 0x525252);
});

// ===========================================================================
// renderFullFrame и снапшоты
// ===========================================================================

/** Готовит «богатое» состояние: фон, спрайты, палитры, скролл. */
function richPpu() {
  const ppu = makePpu();
  writeIdentityPalettes(ppu, [0x0f, 0x01, 0x12, 0x21], [0x30, 0x1a, 0x27, 0x2c]);
  uniformTile(ppu, 0, 1);
  uniformTile(ppu, 1, 2);
  fillTile(ppu, 2, new Array(64).fill(3));
  for (let col = 0; col < 32; col++) ppu.writeMem(0x2020 + col, 1);
  ppu.writeMem(0x23c0, 0x24);
  ppu.spriteMem.set([20, 2, 0x00, 40]);
  ppu.spriteMem.set([60, 1, 0x40, 100], 4);
  ppu.writeReg(0x2005, 0x03);
  ppu.writeReg(0x2005, 0x10);
  ppu.writeReg(0x2001, 0x1e);
  return ppu;
}

test('PPU: renderFullFrame даёт детерминированный кадр из состояния', () => {
  const ppu = richPpu();
  ppu.renderFullFrame();
  const first = new Uint32Array(ppu.buffer);
  ppu.renderFullFrame();
  assert.deepEqual(Array.from(ppu.buffer), Array.from(first));
  // В кадре есть и фон, и спрайты.
  const colors = new Set(Array.from(first));
  assert.ok(colors.size > 3, 'ожидались разные цвета BG/спрайтов');
});

test('PPU: буфер кадра не зависит от размера порций advanceDots (как cycles*3)', () => {
  const reference = richPpu();
  reference.renderFullFrame();
  const expected = Array.from(reference.buffer);

  for (const chunkPattern of [[3], [7], [2, 3, 4, 5, 6, 7, 8, 9], [341], [1000]]) {
    const ppu = richPpu();
    ppu.startFrame();
    let guard = 0;
    let chunkIndex = 0;
    while (!ppu.frameEnded) {
      const chunk = chunkPattern[chunkIndex % chunkPattern.length];
      chunkIndex++;
      ppu.advanceDots(chunk);
      if (++guard > 200000) assert.fail('кадр не закончился');
    }
    assert.deepEqual(Array.from(ppu.buffer), expected, `порции ${chunkPattern.join(',')}`);
  }
});

test('PPU: renderFullFrame не меняет тайминги и регистры состояния', () => {
  const ppu = richPpu();
  ppu.advanceDots(PPU_DOTS_PER_SCANLINE * PPU_SCANLINES + 2);
  const before = ppu.toJSON();
  ppu.renderFullFrame();
  const after = ppu.toJSON();
  // Буфер — результат рендера, остальное состояние не должно измениться.
  before.buffer = null;
  after.buffer = null;
  assert.deepEqual(after, before);
});

test('PPU: toJSON/fromJSON полностью восстанавливают состояние и кадр', () => {
  const ppu = richPpu();
  ppu.renderFullFrame();
  const state = ppu.toJSON();
  assert.equal(state.format, PPU_STATE_FORMAT);
  assert.equal(state.ptTile, undefined, 'ptTile не сохраняется — он выводится из vramMem');

  const restored = new PPU();
  restored.setMirroring('four'); // другое зеркалирование — должно перезаписаться
  restored.fromJSON(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.toJSON(), state);
  assert.deepEqual(Array.from(restored.buffer), Array.from(ppu.buffer));
  restored.renderFullFrame();
  assert.deepEqual(Array.from(restored.buffer), Array.from(ppu.buffer));
});

test('PPU: fromJSON передекодирует ptTile из vramMem', () => {
  const ppu = makePpu();
  uniformTile(ppu, 7, 2);
  const state = JSON.parse(JSON.stringify(ppu.toJSON()));
  state.ptTile = undefined;
  const restored = new PPU();
  restored.fromJSON(state);
  assert.deepEqual(Array.from(restored.ptTile[7].pix), Array.from(ppu.ptTile[7].pix));
  for (let i = 0; i < 64; i++) assert.equal(restored.ptTile[7].pix[i], 2);
});

test('PPU: fromJSON без палитр пересчитывает их из vramMem', () => {
  const ppu = makePpu();
  writeIdentityPalettes(ppu);
  ppu.writeReg(0x2001, 0x0e);
  const state = JSON.parse(JSON.stringify(ppu.toJSON()));
  delete state.imgPalette;
  delete state.sprPalette;
  const restored = new PPU();
  restored.fromJSON(state);
  assert.deepEqual(Array.from(restored.imgPalette), Array.from(ppu.imgPalette));
  assert.deepEqual(Array.from(restored.sprPalette), Array.from(ppu.sprPalette));
});

test('PPU: fromJSON устойчив к отсутствию необязательных полей', () => {
  const ppu = makePpu();
  const state = ppu.toJSON();
  const restored = new PPU();
  restored.fromJSON({ vramMem: state.vramMem, spriteMem: state.spriteMem });
  assert.equal(restored.vramMem.length, 0x8000);
  assert.equal(restored.buffer.length, W * H);
  assert.equal(restored.imgPalette.length, 16);
});

test('PPU: reset возвращает состояние включения питания', () => {
  const ppu = richPpu();
  ppu.renderFullFrame();
  ppu.reset();
  assert.equal(ppu.f_bgVisibility, 0);
  assert.equal(ppu.f_spVisibility, 0);
  assert.equal(ppu.vramMem.every(byte => byte === 0), true);
  assert.equal(ppu.spriteMem.every(byte => byte === 0), true);
  assert.equal(ppu.scanline, PPU_VBLANK_SCANLINE);
  assert.equal(ppu.frameEnded, false);
});

// ===========================================================================
// Дифференциальный тест против JSNES 2.1.0 (пропускается без ROM)
// ===========================================================================

const ROM_EN = process.env.TETRIS_ROM_EN
  || '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game.nes';
const ROM_RU = process.env.TETRIS_ROM_RU
  || '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game-ru.nes';

test('PPU: дифференциальный тест с JSNES на реальных дампах (ROM нужен локально)', async t => {
  const roms = [ROM_EN, ROM_RU].filter(path => existsSync(path));
  if (roms.length === 0) {
    return t.skip('ROM недоступен: в CI игровых ROM нет, дифференциальный тест пропущен');
  }
  let jsnes;
  try {
    jsnes = await import('jsnes');
  } catch {
    return t.skip('jsnes не установлен (devDependency) — дифференциальный тест пропущен');
  }
  for (const rom of roms) {
    const report = await diffOneRom(rom, { jsnesNES: jsnes.NES ?? jsnes.default ?? jsnes });
    assert.equal(report.skipped, undefined, `не удалось прогнать ${rom}`);
    assert.equal(report.frames.length, DEFAULT_CHECK_FRAMES.length);
    for (const frame of report.frames) {
      assert.equal(
        frame.renderDiff,
        0,
        `${rom}: кадр ${frame.frame} (renderFullFrame) расходится в ${frame.renderDiff} px; `
          + `первый ${JSON.stringify(frame.firstBad)}`,
      );
      assert.equal(
        frame.liveDiff,
        0,
        `${rom}: кадр ${frame.frame} (advanceDots) расходится в ${frame.liveDiff} px; `
          + `первый ${JSON.stringify(frame.liveFirstBad)}`,
      );
    }
    // Эталонные отпечатки кадров фиксируем в отчёте (без игровых данных).
    assert.ok(report.frames.every(frame => /^[0-9a-f]{8}$/.test(frame.hash)));
  }
});
