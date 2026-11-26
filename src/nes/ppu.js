// PPU NES (2C02) — собственная модель видеопроцессора для веб-порта Tetris.
//
// Это НЕ код JSNES и не порт vNES: реализация написана заново по описанию
// железа (NESdev wiki) и контракту docs/ARCHITECTURE.md §3.3. JSNES 2.1.0
// (npm devDependency) используется только как поведенческий эталон в тестах
// и инструментах; в рантайм-сборку он не попадает.
//
// Что здесь есть:
//   * память PPU: vramMem(0x8000) — окно CHR 8 КиБ + nametables + палитры,
//     spriteMem(256) — OAM, ptTile(512) — декодированные 2-битные тайлы;
//   * регистры $2000-$2007 с зеркалами ($2000-$3FFF), loopy-регистры скролла
//     (regFV/regV/regH/regVT/regHT/regFH/regS) и их счётчики для рендера;
//   * OAMADDR/OAMDATA, $2002 (vblank/sprite0/overflow/open bus), $2007
//     (буферизация чтения, инкремент адреса, зеркала палитр);
//   * построчный рендер BG (nametable + attribute + scroll) и спрайтов
//     (8x8/8x16, приоритет, flips, левый кроп, sprite 0 hit, overflow);
//   * NTSC-тайминги: 341 dot × 262 строки, vblank на строке 241,
//     pre-render на 261, frameEnded на границе кадра;
//   * JSNES-совместимый фасад для compositor.js: buffer Uint32Array(256*240)
//     со значениями 0x00BBGGRR, imgPalette/sprPalette, флаги f_*, toJSON/fromJSON.
//
// Формат кадра сознательно повторяет JSNES, потому что compositor.js старого
// порта (а с ним вся раскладка HUD) написан под него. Совместимость проверяется
// дифференциальным тестом: снимаем состояние PPU у JSNES на границе кадра,
// применяем его через fromJSON и сравниваем buffer побайтово.
//
// Для byte-for-byte совпадения с эталоном воспроизводятся и странности JSNES
// (см. tools/ppu/README.md): зануление непрозрачных пикселей строки 0 на
// vblank, правый край при fine X > 0, пропуск верхних строк при fine Y > 0,
// пост-рендерный кроп 8 px.
//
// Документированные упрощения/отклонения от JSNES 2.1.0 (для Tetris не
// наблюдаются, см. тесты и tools/ppu/README.md):
//   1) Рендер строки мы делаем в момент её начала (как требует контракт §3.3),
//      а JSNES откладывает композицию (bgbuffer → buffer) до записи регистров
//      или vblank. При неизменных посреди кадра палитрах/скролле результат
//      идентичен; Tetris меняет их только в vblank.
//   2) Спрайты вычисляются из актуальной OAM в начале строки; JSNES использует
//      secondary OAM, подготовленную строкой раньше (и «залипшие» спрайты на
//      строке 0/1). Для Tetris на строках 0-1 спрайтов нет, результат совпадает.
//   3) Sprite overflow определяется честным перебором 64 записей OAM с начала
//      OAMADDR (до 8 спрайтов в secondary OAM). Аппаратный баг «диагонального»
//      чтения при переполнении не воспроизводится — флаг выставляется по факту
//      9-го спрайта в строке. На буфер это не влияет.
//   4) Запись в OAM во время рендера не подавляется и OAM corruption (баг
//      $2003 во время кадра) не эмулируется: игры пишут OAM в vblank/DMA.
//   5) $2006 использует только младшие 2 бита fine Y из старшего байта — так же,
//      как vNES/JSNES (для адресов $0000-$3FFF это эквивалентно железу).
//   6) Sprite 0 hit выставляется в момент рендера строки (а не на конкретном
//      dot, как на железе); для Tetris достаточно, т.к. она не синхронизирует
//      кадр по hit. Точное совпадение буфера не зависит от флага.
//   7) Открытая шина PPU не «затухает» по кадрам (хранится последнее значение).
//
// ВАЖНО для engine.js: по умолчанию clipToTvSize = true (как в JSNES). Игровой
// движок обязан выставить ppu.clipToTvSize = false после создания/сброса
// консоли (старый порт делал именно так) — иначе buffer обрезан по 8 px и
// раскладка compositor.js поедет.

import {
  NTSC_PALETTE_BGR,
  PPU_DOTS_PER_SCANLINE,
  PPU_SCANLINES,
  PPU_VBLANK_SCANLINE,
  PPU_VISIBLE_SCANLINES,
  PPU_PRERENDER_SCANLINE,
} from './constants.js';

/** Размер экрана PPU. */
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 240;
/** Размер окна CHR (8 КиБ) и полного адресного пространства PPU. */
export const CHR_WINDOW_SIZE = 0x2000;
export const PPU_MEM_SIZE = 0x8000;
/** Начало палитр в vramMem. */
export const PALETTE_BASE = 0x3f00;

/** Коды зеркалирования в нотации JSNES (для совместимости состояний). */
export const MIRROR_VERTICAL = 0;
export const MIRROR_HORIZONTAL = 1;
export const MIRROR_FOUR_SCREEN = 2;
export const MIRROR_SINGLE_SCREEN_0 = 3;
export const MIRROR_SINGLE_SCREEN_1 = 4;

/** Формат сериализованного состояния, чтобы не путать с чужими снапшотами. */
export const PPU_STATE_FORMAT = 'tetris-web/ppu/1';

/** Бит vblank в $2002. */
const STATUS_VBLANK = 0x80;
/** Бит sprite 0 hit в $2002. */
const STATUS_SPRITE0_HIT = 0x40;
/** Бит sprite overflow в $2002. */
const STATUS_SPRITE_OVERFLOW = 0x20;

/** Имена зеркалирования из rom.js -> внутренние коды. */
const MIRROR_BY_NAME = {
  vertical: MIRROR_VERTICAL,
  horizontal: MIRROR_HORIZONTAL,
  four: MIRROR_FOUR_SCREEN,
  single0: MIRROR_SINGLE_SCREEN_0,
  single1: MIRROR_SINGLE_SCREEN_1,
};

/**
 * Считает таблицы палитры с учётом emphasis, как это делает 2C02.
 * Возвращает массив из 8 таблиц по 64 цвета (0x00BBGGRR — численно совпадает
 * с JSNES; раскладка битов трактуется ровно как в JSNES, чтобы совпадали
 * значения buffer).
 * @returns {Uint32Array[]}
 */
function buildEmphasisTables() {
  const tables = new Array(8);
  for (let emph = 0; emph < 8; emph++) {
    let rFactor = 1;
    let gFactor = 1;
    let bFactor = 1;
    if (emph & 1) {
      // Бит 5 $2001: акцент на красный — гасим зелёный и синий.
      gFactor = 0.75;
      bFactor = 0.75;
    }
    if (emph & 2) {
      rFactor = 0.75;
      bFactor = 0.75;
    }
    if (emph & 4) {
      rFactor = 0.75;
      gFactor = 0.75;
    }
    const table = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      const color = NTSC_PALETTE_BGR[i];
      const r = Math.floor(((color >> 16) & 0xff) * rFactor);
      const g = Math.floor(((color >> 8) & 0xff) * gFactor);
      const b = Math.floor((color & 0xff) * bFactor);
      table[i] = (r << 16) | (g << 8) | b;
    }
    tables[emph] = table;
  }
  return tables;
}

/** Одна таблица на модуль: она не меняется и нужна всем PPU. */
const EMPHASIS_TABLES = buildEmphasisTables();

/** Приводит тип зеркалирования (строка rom.js или числовой код JSNES) к коду. */
function normalizeMirroring(type) {
  if (typeof type === 'string') {
    const code = MIRROR_BY_NAME[type.toLowerCase()];
    if (code === undefined) throw new Error(`Неизвестное зеркалирование: ${type}`);
    return code;
  }
  if (Number.isInteger(type) && type >= 0 && type <= 6) return type;
  throw new Error(`Неизвестное зеркалирование: ${type}`);
}

/**
 * Модель PPU. Все поля/методы с именами f_*, imgPalette, sprPalette, buffer,
 * vramMem, spriteMem, ptTile, writeMem, readMem, readReg, writeReg,
 * setMirroring, setChrWindow, startFrame, advanceDots, renderFullFrame,
 * frameEnded, nmiPending, sprite0Hit — часть контракта §3.3.
 */
export class PPU {
  constructor() {
    // ---- Память -------------------------------------------------------
    /** @type {Uint8Array} 0x0000-0x1FFF — окно CHR, 0x2000-0x3EFF — nametables, 0x3F00+ — палитры. */
    this.vramMem = new Uint8Array(PPU_MEM_SIZE);
    /** @type {Uint8Array} OAM (256 байт: 64 спрайта × 4). */
    this.spriteMem = new Uint8Array(256);
    /** @type {Uint32Array} Кадр 256×240 в формате 0x00BBGGRR (как у JSNES). */
    this.buffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    /** @type {Uint32Array} Палитра фона (16 значений 0x00BBGGRR). */
    this.imgPalette = new Uint32Array(16);
    /** @type {Uint32Array} Палитра спрайтов (16 значений 0x00BBGGRR). */
    this.sprPalette = new Uint32Array(16);

    /**
     * Декодированные тайлы: 512 записей { pix: Uint8Array(64) } с цветовыми
     * индексами 0..3 (построчно слева направо). Это публичный формат JSNES —
     * compositor.js читает ptTile[...].pix напрямую.
     * @type {{pix: Uint8Array}[]}
     */
    this.ptTile = new Array(512);
    for (let i = 0; i < 512; i++) this.ptTile[i] = { pix: new Uint8Array(64) };

    // ---- Флаги регистра $2000 (PPUCTRL) ------------------------------
    this.f_nmiOnVblank = 0;
    this.f_spriteSize = 0;
    this.f_bgPatternTable = 0;
    this.f_spPatternTable = 0;
    this.f_addrInc = 0;
    this.f_nTblAddress = 0;

    // ---- Флаги регистра $2001 (PPUMASK) ------------------------------
    this.f_color = 0;
    this.f_spVisibility = 0;
    this.f_bgVisibility = 0;
    this.f_spClipping = 0;
    this.f_bgClipping = 0;
    this.f_dispType = 0;

    // ---- loopy-регистры (t) и счётчики рендера (v) --------------------
    this.regFV = 0;
    this.regV = 0;
    this.regH = 0;
    this.regVT = 0;
    this.regHT = 0;
    this.regFH = 0;
    this.regS = 0;
    this.cntFV = 0;
    this.cntV = 0;
    this.cntH = 0;
    this.cntVT = 0;
    this.cntHT = 0;

    // ---- VRAM I/O ------------------------------------------------------
    this.vramAddress = 0; // v
    this.vramTmpAddress = 0; // t
    this.vramBufferedReadValue = 0;
    this.firstWrite = true; // защёлка первого/второго байта $2005/$2006
    this.sramAddress = 0; // OAMADDR
    this.openBusLatch = 0; // открытая шина PPU (последнее значение на шине данных)

    // ---- Состояние таймингов -----------------------------------------
    // Физическая нумерация NTSC: 0..239 — видимые строки, 240 — post-render,
    // 241..260 — vblank, 261 — pre-render. Строка = 341 dot.
    this.scanline = PPU_VBLANK_SCANLINE;
    this.curX = 0;
    this.frameEnded = false;
    this.nmiPending = false;
    this.vblankFlag = false;
    this.sprite0Hit = false;
    // Флаг sprite overflow ($2002 bit 5).
    this.overflowFlag = false;
    // Первый кадр после включения: vblank на строке 241 ещё «не считается»
    // (как у JSNES, где PPU стартует со scanline=0 = NES 241 и первый vblank
    // приходит только после полного круга). Нужен для совпадения границ
    // кадров и числа кадров инициализации с эталоном.
    this._firstFrame = true;

    // ---- Зеркалирование -------------------------------------------------
    this.currentMirroring = -1;
    /** Канонические индексы nametable для (cntV, cntH): 0..3. */
    this.ntable1 = new Uint8Array(4);
    /** Таблица зеркал адресного пространства PPU (0x0000-0x7FFF). */
    this.vramMirrorTable = new Uint16Array(0x8000);
    for (let i = 0; i < 0x8000; i++) this.vramMirrorTable[i] = i;

    // ---- Настройки совместимости с JSNES-фасадом ------------------------
    /** Обрезать кадр до «телевизионного» размера (по умолчанию как у JSNES). */
    this.clipToTvSize = true;
    /** Отладка: рисовать координаты sprite 0 hit (оставлено для совместимости). */
    this.showSpr0Hit = false;

    // ---- CHR RAM ---------------------------------------------------------
    /** Может ли PPU писать в CHR (CHR RAM картриджа). Ставит console.js. */
    this.chrWritable = false;
    /**
     * Колбэк для $2007-записей в CHR: (address, value) => void.
     * console.js подключает сюда mapper.writeChr, чтобы запись обновляла CHR RAM.
     * @type {null | ((address: number, value: number) => void)}
     */
    this.onChrWrite = null;

    // ---- Палитры ---------------------------------------------------------
    /** Последний emphasis, применённый в цветовом режиме ($2001 bits 5-7). */
    this._palEmphasis = 0;
    this._updatePalettes();

    // ---- Скретч-буферы рендера ------------------------------------------
    /** Непрозрачные пиксели BG в текущей строке (для приоритета спрайтов). */
    this._lineBg = new Uint8Array(SCREEN_WIDTH);
    /** Пиксели, уже занятые спрайтами с большим приоритетом. */
    this._sprClaim = new Uint8Array(SCREEN_WIDTH);
    /**
     * Маска непрозрачных пикселей BG на строке 0. Нужна для совместимости
     * с JSNES-эталоном: там строка 0 рисуется в обход bgbuffer (в сам buffer),
     * а ленивая композиция на vblank затирает её непрозрачные пиксели нулями
     * из незаполненного bgbuffer[0]. Настоящее железо показывает строку 0
     * нормально; совместимость с эталоном важнее — см. README инструментов.
     */
    this._row0Opaque = new Uint8Array(SCREEN_WIDTH);
    this._row0OpaqueValid = false;
    /** Данные до 8 спрайтов строки: [y, tile, attr, x] × 8. */
    this._sprOam = new Uint8Array(32);
    /** Сколько спрайтов найдено для текущей строки. */
    this._sprCount = 0;
    /** Индекс sprite 0 в _sprOam (0, если первая проверенная запись в строке), иначе -1. */
    this._spr0Index = -1;

    // Начальное зеркалирование: vertical. console.js всё равно вызовет
    // setMirroring из профиля ROM; дефолт нужен, чтобы PPU был самодостаточен.
    this.setMirroring(MIRROR_VERTICAL);
    // Счётчики тайлов для первой строки возьмутся из регистров на pre-render.
  }

  // ======================================================================
  // Сброс и сервисные утилиты
  // ======================================================================

  /** Сброс в состояние включения питания (как у JSNES: память и палитры нули). */
  reset() {
    this.vramMem.fill(0);
    this.spriteMem.fill(0);
    this.ptTile = this.ptTile.map(() => ({ pix: new Uint8Array(64) }));
    this.buffer.fill(0);
    this.imgPalette.fill(0);
    this.sprPalette.fill(0);

    this.f_nmiOnVblank = 0;
    this.f_spriteSize = 0;
    this.f_bgPatternTable = 0;
    this.f_spPatternTable = 0;
    this.f_addrInc = 0;
    this.f_nTblAddress = 0;
    this.f_color = 0;
    this.f_spVisibility = 0;
    this.f_bgVisibility = 0;
    this.f_spClipping = 0;
    this.f_bgClipping = 0;
    this.f_dispType = 0;

    this.regFV = 0;
    this.regV = 0;
    this.regH = 0;
    this.regVT = 0;
    this.regHT = 0;
    this.regFH = 0;
    this.regS = 0;
    this.cntFV = 0;
    this.cntV = 0;
    this.cntH = 0;
    this.cntVT = 0;
    this.cntHT = 0;

    this.vramAddress = 0;
    this.vramTmpAddress = 0;
    this.vramBufferedReadValue = 0;
    this.firstWrite = true;
    this.sramAddress = 0;
    this.openBusLatch = 0;

    this.scanline = PPU_VBLANK_SCANLINE;
    this.curX = 0;
    this.frameEnded = false;
    this.nmiPending = false;
    this.vblankFlag = false;
    this.sprite0Hit = false;
    this.overflowFlag = false;
    this._firstFrame = true;

    this._palEmphasis = 0;
    this._updatePalettes();
  }

  /**
   * Устанавливает зеркалирование nametables.
   * Принимает имена из rom.js ('horizontal'|'vertical'|'four') и числовые
   * коды JSNES (0=vertical, 1=horizontal, 2=four, 3/4=single screen).
   * @param {string|number} mirroring
   */
  setMirroring(mirroring) {
    const code = normalizeMirroring(mirroring);
    if (code === this.currentMirroring) return;
    this.currentMirroring = code;

    // Сбрасываем таблицу зеркал в тождественную.
    for (let i = 0; i < 0x8000; i++) this.vramMirrorTable[i] = i;

    // Палитры: $3F20/$3F40/$3F80/$3FC0 зеркалят $3F00-$3F1F.
    this._defineMirrorRegion(0x3f20, 0x3f00, 0x20);
    this._defineMirrorRegion(0x3f40, 0x3f00, 0x20);
    this._defineMirrorRegion(0x3f80, 0x3f00, 0x20);
    this._defineMirrorRegion(0x3fc0, 0x3f00, 0x20);
    // Nametables $3000-$3EFF зеркалят $2000-$2EFF.
    this._defineMirrorRegion(0x3000, 0x2000, 0xf00);
    // $4000-$7FFF зеркалят $0000-$3FFF.
    this._defineMirrorRegion(0x4000, 0x0000, 0x4000);

    if (code === MIRROR_HORIZONTAL) {
      // Горизонтальное: NT0/NT1 — одна страница, NT2/NT3 — другая.
      this.ntable1[0] = 0;
      this.ntable1[1] = 0;
      this.ntable1[2] = 1;
      this.ntable1[3] = 1;
      this._defineMirrorRegion(0x2400, 0x2000, 0x400);
      this._defineMirrorRegion(0x2c00, 0x2800, 0x400);
    } else if (code === MIRROR_VERTICAL) {
      this.ntable1[0] = 0;
      this.ntable1[1] = 1;
      this.ntable1[2] = 0;
      this.ntable1[3] = 1;
      this._defineMirrorRegion(0x2800, 0x2000, 0x400);
      this._defineMirrorRegion(0x2c00, 0x2400, 0x400);
    } else if (code === MIRROR_SINGLE_SCREEN_0 || code === MIRROR_SINGLE_SCREEN_1) {
      const page = code === MIRROR_SINGLE_SCREEN_0 ? 0 : 1;
      const target = 0x2000 + page * 0x400;
      this.ntable1[0] = page;
      this.ntable1[1] = page;
      this.ntable1[2] = page;
      this.ntable1[3] = page;
      this._defineMirrorRegion(0x2400, target, 0x400);
      this._defineMirrorRegion(0x2800, target, 0x400);
      this._defineMirrorRegion(0x2c00, target, 0x400);
    } else {
      // Four-screen: все четыре страницы физически разные.
      this.ntable1[0] = 0;
      this.ntable1[1] = 1;
      this.ntable1[2] = 2;
      this.ntable1[3] = 3;
    }
  }

  /** Заполняет область таблицы зеркал: адреса fromStart+ смещают на toStart+. */
  _defineMirrorRegion(fromStart, toStart, size) {
    for (let i = 0; i < size; i++) this.vramMirrorTable[fromStart + i] = toStart + i;
  }

  /**
   * Копирует текущее 8-КиБ окно CHR в vramMem и передекодирует ptTile(0..511).
   * Вызывается console.js при смене CHR-банка маппером (mapper 3/148, CHR RAM).
   * @param {Uint8Array} bytes8k
   */
  setChrWindow(bytes8k) {
    if (!(bytes8k instanceof Uint8Array) || bytes8k.length < CHR_WINDOW_SIZE) {
      throw new Error(`setChrWindow: ожидалось ${CHR_WINDOW_SIZE} байт CHR`);
    }
    this.vramMem.set(bytes8k.subarray(0, CHR_WINDOW_SIZE), 0);
    this._decodeAllTiles();
  }

  /** Декодирует все 512 тайлов из vramMem[0..0x1FFF]. */
  _decodeAllTiles() {
    for (let i = 0; i < 512; i++) this._decodeTile(i);
  }

  /** Декодирует один тайл (16 байт: 8 байт plane 0, 8 байт plane 1). */
  _decodeTile(tileIndex) {
    const base = tileIndex << 4;
    const pix = this.ptTile[tileIndex].pix;
    for (let y = 0; y < 8; y++) {
      const low = this.vramMem[base + y];
      const high = this.vramMem[base + y + 8];
      const row = y << 3;
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        pix[row + x] = ((low >> bit) & 1) | (((high >> bit) & 1) << 1);
      }
    }
  }

  // ======================================================================
  // Доступ к видеопамяти ($2007) и палитрам
  // ======================================================================

  /**
   * «Сырая» запись в память PPU с побочными эффектами (декодирование тайлов,
   * обновление палитр). Адрес — канонический (как в JSNES): nametable-зеркала
   * разрешает вызывающий. Используется путём $2007 и снапшотами.
   * @param {number} address
   * @param {number} value
   */
  writeMem(address, value) {
    address &= 0x7fff;
    this.vramMem[address] = value;
    if (address < 0x2000) {
      this._patternWrite(address);
    } else if (address >= PALETTE_BASE && address < PALETTE_BASE + 0x20) {
      this._updatePalettes();
    }
  }

  /**
   * «Сырое» чтение памяти PPU с учётом зеркал (без буферизации $2007).
   * Для адресов канонической раскладки возвращает значение как есть.
   * @param {number} address
   * @returns {number}
   */
  readMem(address) {
    return this.vramMem[this.vramMirrorTable[address & 0x7fff]];
  }

  /** Переиндексирует декодированный тайл после записи байта в CHR. */
  _patternWrite(address) {
    const tileIndex = address >> 4;
    const offset = address & 15;
    if (offset < 8) {
      this._decodeTileRow(tileIndex, offset);
    } else {
      this._decodeTileRow(tileIndex, offset - 8);
    }
  }

  /** Передекодирует одну строку тайла (нужны оба байта плоскости). */
  _decodeTileRow(tileIndex, row) {
    const base = (tileIndex << 4) + row;
    const low = this.vramMem[base];
    const high = this.vramMem[base + 8];
    const pix = this.ptTile[tileIndex].pix;
    const rowBase = row << 3;
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      pix[rowBase + x] = ((low >> bit) & 1) | (((high >> bit) & 1) << 1);
    }
  }

  /** Пересчитывает imgPalette/sprPalette из vramMem с учётом emphasis. */
  _updatePalettes() {
    const table = EMPHASIS_TABLES[this._palEmphasis];
    if (this.f_dispType === 0) {
      for (let i = 0; i < 16; i++) {
        this.imgPalette[i] = table[this.vramMem[PALETTE_BASE + i] & 63];
        this.sprPalette[i] = table[this.vramMem[PALETTE_BASE + 0x10 + i] & 63];
      }
    } else {
      // Монохромный режим: младшие 4 бита цвета игнорируются, старшие два
      // бита выбирают один из четырёх серых уровней.
      for (let i = 0; i < 16; i++) {
        this.imgPalette[i] = table[this.vramMem[PALETTE_BASE + i] & 0x30];
        this.sprPalette[i] = table[this.vramMem[PALETTE_BASE + 0x10 + i] & 0x30];
      }
    }
  }

  // ======================================================================
  // loopy-регистры: t/v и счётчики рендера
  // ======================================================================

  /** t (regs) -> vramTmpAddress. */
  _regsToAddress() {
    let b1 = (this.regFV & 7) << 4;
    b1 |= (this.regV & 1) << 3;
    b1 |= (this.regH & 1) << 2;
    b1 |= (this.regVT >> 3) & 3;
    let b2 = (this.regVT & 7) << 5;
    b2 |= this.regHT & 31;
    this.vramTmpAddress = ((b1 << 8) | b2) & 0x7fff;
  }

  /** v (счётчики) -> vramAddress. */
  _cntsToAddress() {
    let b1 = (this.cntFV & 7) << 4;
    b1 |= (this.cntV & 1) << 3;
    b1 |= (this.cntH & 1) << 2;
    b1 |= (this.cntVT >> 3) & 3;
    let b2 = (this.cntVT & 7) << 5;
    b2 |= this.cntHT & 31;
    this.vramAddress = ((b1 << 8) | b2) & 0x7fff;
  }

  /** vramAddress -> счётчики рендера. */
  _cntsFromAddress() {
    let address = (this.vramAddress >> 8) & 0xff;
    this.cntFV = (address >> 4) & 3;
    this.cntV = (address >> 3) & 1;
    this.cntH = (address >> 2) & 1;
    this.cntVT = (this.cntVT & 7) | ((address & 3) << 3);
    address = this.vramAddress & 0xff;
    this.cntVT = (this.cntVT & 24) | ((address >> 5) & 7);
    this.cntHT = address & 31;
  }

  /** vramTmpAddress -> регистры t. */
  _regsFromAddress() {
    let address = (this.vramTmpAddress >> 8) & 0xff;
    this.regFV = (address >> 4) & 7;
    this.regV = (address >> 3) & 1;
    this.regH = (address >> 2) & 1;
    this.regVT = (this.regVT & 7) | ((address & 3) << 3);
    address = this.vramTmpAddress & 0xff;
    this.regVT = (this.regVT & 24) | ((address >> 5) & 7);
    this.regHT = address & 31;
  }

  /** Идёт ли сейчас скан, во время которого v ведёт себя как рендер-счётчик. */
  _onRenderingScanline() {
    return (
      (this.scanline >= 0 && this.scanline < PPU_VISIBLE_SCANLINES) ||
      this.scanline === PPU_PRERENDER_SCANLINE
    );
  }

  /** Включён ли рендер (BG или спрайты) — общее условие «PPU рисует». */
  _renderingEnabled() {
    return this.f_bgVisibility === 1 || this.f_spVisibility === 1;
  }

  /**
   * Инкремент v после $2007. Во время рендера это не линейный +1/+32, а
   * одновременный инкремент coarse X (с переключением nametable) и fine/coarse Y
   * (с переносом) — так железо использует v как часть рендер-пайплайна.
   */
  _incrementVramAddress() {
    if (this._renderingEnabled() && this._onRenderingScanline()) {
      if ((this.vramAddress & 0x001f) === 31) {
        this.vramAddress &= ~0x001f;
        this.vramAddress ^= 0x0400;
      } else {
        this.vramAddress += 1;
      }
      if ((this.vramAddress & 0x7000) !== 0x7000) {
        this.vramAddress += 0x1000;
      } else {
        this.vramAddress &= ~0x7000;
        let coarseY = (this.vramAddress >> 5) & 0x1f;
        if (coarseY === 29) {
          coarseY = 0;
          this.vramAddress ^= 0x0800;
        } else if (coarseY === 31) {
          coarseY = 0;
        } else {
          coarseY += 1;
        }
        this.vramAddress = (this.vramAddress & ~0x03e0) | (coarseY << 5);
      }
    } else {
      this.vramAddress += this.f_addrInc === 1 ? 32 : 1;
    }
    this.vramAddress &= 0x7fff;
  }

  /** Чтение с учётом зеркал. */
  _mirroredLoad(address) {
    return this.vramMem[this.vramMirrorTable[address & 0x7fff]];
  }

  /** Запись с учётом зеркал и особых зеркал фона палитр ($3F10 -> $3F00). */
  _mirroredWrite(address, value) {
    if (address >= PALETTE_BASE && address < PALETTE_BASE + 0x20) {
      if (address === 0x3f00 || address === 0x3f10) {
        this.writeMem(0x3f00, value);
        this.writeMem(0x3f10, value);
      } else if (address === 0x3f04 || address === 0x3f14) {
        this.writeMem(0x3f04, value);
        this.writeMem(0x3f14, value);
      } else if (address === 0x3f08 || address === 0x3f18) {
        this.writeMem(0x3f08, value);
        this.writeMem(0x3f18, value);
      } else if (address === 0x3f0c || address === 0x3f1c) {
        this.writeMem(0x3f0c, value);
        this.writeMem(0x3f1c, value);
      } else {
        this.writeMem(address, value);
      }
    } else {
      this.writeMem(this.vramMirrorTable[address & 0x7fff], value);
    }
  }

  // ======================================================================
  // Регистры CPU $2000-$2007
  // ======================================================================

  /**
   * Чтение регистра PPU ($2000-$3FFF с зеркалами по младшим 3 битам адреса).
   * @param {number} address
   * @returns {number}
   */
  readReg(address) {
    switch (address & 7) {
      case 2:
        return this._readStatusRegister();
      case 4:
        return this._sramLoad();
      case 7:
        return this._vramLoad();
      default:
        // $2000/$2001/$2003/$2005/$2006 write-only: открытая шина.
        return this.openBusLatch;
    }
  }

  /**
   * Запись регистра PPU ($2000-$3FFF с зеркалами по младшим 3 битам адреса).
   * @param {number} address
   * @param {number} value
   */
  writeReg(address, value) {
    value &= 0xff;
    this.openBusLatch = value;
    switch (address & 7) {
      case 0:
        this._writeControlReg1(value);
        break;
      case 1:
        this._writeControlReg2(value);
        break;
      case 3:
        this.sramAddress = value;
        break;
      case 4:
        this._sramWrite(value);
        break;
      case 5:
        this._scrollWrite(value);
        break;
      case 6:
        this._writeVRAMAddress(value);
        break;
      case 7:
        this._vramWrite(value);
        break;
      default:
        // $2002 — read-only.
        break;
    }
  }

  /** $2002 (R): статус + открытая шина, сбрасывает защёлку адреса. */
  _readStatusRegister() {
    const status =
      (this.vblankFlag ? STATUS_VBLANK : 0) |
      (this.sprite0Hit ? STATUS_SPRITE0_HIT : 0) |
      (this.overflowFlag ? STATUS_SPRITE_OVERFLOW : 0);
    // Младшие 5 бит — открытая шина PPU.
    const result = status | (this.openBusLatch & 0x1f);
    this.firstWrite = true;
    // Чтение $2002 снимает vblank, но НЕ отменяет уже поднятый NMI: сигнал
    // /NMI на железе защёлкивается фронтом, а снимает его только обработчик.
    // console.js очищает nmiPending, когда принимает прерывание (см. §3.2).
    this.vblankFlag = false;
    this.openBusLatch = result;
    return result;
  }

  /** $2000 (W): PPUCTRL. */
  _writeControlReg1(value) {
    const wasNmiEnabled = this.f_nmiOnVblank;
    this.f_nmiOnVblank = (value >> 7) & 1;
    this.f_spriteSize = (value >> 5) & 1;
    this.f_bgPatternTable = (value >> 4) & 1;
    this.f_spPatternTable = (value >> 3) & 1;
    this.f_addrInc = (value >> 2) & 1;
    this.f_nTblAddress = value & 3;

    // t: bits 10-11 (nametable) и bit 12 (fine Y bit 0).
    this.regV = (value >> 1) & 1;
    this.regH = value & 1;
    this.regS = (value >> 4) & 1;

    // Включение NMI при уже установленном vblank даёт фронт — NMI срабатывает.
    if (!wasNmiEnabled && this.f_nmiOnVblank && this.vblankFlag) {
      this.nmiPending = true;
    }
  }

  /** $2001 (W): PPUMASK. */
  _writeControlReg2(value) {
    this.f_color = (value >> 5) & 7;
    this.f_spVisibility = (value >> 4) & 1;
    this.f_bgVisibility = (value >> 3) & 1;
    this.f_spClipping = (value >> 2) & 1;
    this.f_bgClipping = (value >> 1) & 1;
    this.f_dispType = value & 1;

    if (this.f_dispType === 0) {
      this._palEmphasis = this.f_color;
    }
    this._updatePalettes();
  }

  /** $2003 (W): OAMADDR. */
  // (обрабатывается прямо в writeReg: sramAddress = value)

  /** $2004 (R): OAMDATA. */
  _sramLoad() {
    let value = this.spriteMem[this.sramAddress & 0xff];
    // Биты 2-4 байта атрибутов не реализованы, читаются как 0.
    if ((this.sramAddress & 3) === 2) value &= 0xe3;
    return value;
  }

  /** $2004 (W): OAMDATA. Пишет байт в OAM и инкрементирует OAMADDR. */
  _sramWrite(value) {
    this.spriteMem[this.sramAddress & 0xff] = value;
    this.sramAddress = (this.sramAddress + 1) & 0xff;
  }

  /** $2005 (W): scroll. Первая запись — X, вторая — Y. */
  _scrollWrite(value) {
    if (this.firstWrite) {
      this.regHT = (value >> 3) & 31;
      this.regFH = value & 7;
    } else {
      this.regFV = value & 7;
      this.regVT = (value >> 3) & 31;
    }
    this.firstWrite = !this.firstWrite;
  }

  /** $2006 (W): адрес VRAM. Первая запись — старший байт, вторая — младший. */
  _writeVRAMAddress(value) {
    if (this.firstWrite) {
      // Старший байт: fine Y (2 бита из t), nametable V/H, coarse Y bits 3-4.
      this.regFV = (value >> 4) & 3;
      this.regV = (value >> 3) & 1;
      this.regH = (value >> 2) & 1;
      this.regVT = (this.regVT & 7) | ((value & 3) << 3);
    } else {
      // Младший байт: coarse Y bits 0-2, coarse X.
      this.regVT = (this.regVT & 24) | ((value >> 5) & 7);
      this.regHT = value & 31;
      // Вторая запись копирует t -> v (и счётчики рендера).
      this.cntFV = this.regFV;
      this.cntV = this.regV;
      this.cntH = this.regH;
      this.cntVT = this.regVT;
      this.cntHT = this.regHT;
    }
    this.firstWrite = !this.firstWrite;
    this._cntsToAddress();
  }

  /** $2007 (R): чтение VRAM (с буферизацией; палитры — без задержки). */
  _vramLoad() {
    this._cntsToAddress();
    this._regsToAddress();

    let result;
    if (this.vramAddress <= 0x3eff) {
      // $0000-$3EFF: возвращается прошлое буферизованное значение.
      result = this.vramBufferedReadValue;
      if (this.vramAddress < 0x2000) {
        this.vramBufferedReadValue = this.vramMem[this.vramAddress];
      } else {
        this.vramBufferedReadValue = this._mirroredLoad(this.vramAddress);
      }
      this._incrementVramAddress();
      this._cntsFromAddress();
      this._regsFromAddress();
      return result;
    }

    // Палитры ($3F00-$3FFF): значение возвращается сразу, а буфер заполняется
    // данными nametable «под» палитрой. Фон палитр ($3F10/$3F14/...) зеркалит
    // $3F00/$3F04/...; старшие 2 бита — открытая шина.
    let palIdx = this.vramAddress & 0x1f;
    if ((palIdx & 0x13) === 0x10) palIdx &= 0x0f;
    result = (this.vramMem[PALETTE_BASE + palIdx] & 0x3f) | (this.openBusLatch & 0xc0);
    this.vramBufferedReadValue = this._mirroredLoad(this.vramAddress & 0x2fff);
    this._incrementVramAddress();
    this._cntsFromAddress();
    this._regsFromAddress();
    return result;
  }

  /** $2007 (W): запись VRAM. */
  _vramWrite(value) {
    this._cntsToAddress();
    this._regsToAddress();

    if (this.vramAddress >= 0x2000) {
      this._mirroredWrite(this.vramAddress, value);
    } else if (this.chrWritable || this.onChrWrite !== null) {
      // CHR RAM: пишем в окно CHR и сообщаем мапперу.
      this.writeMem(this.vramAddress, value);
      if (this.onChrWrite !== null) this.onChrWrite(this.vramAddress, value);
    }

    this._incrementVramAddress();
    this._regsFromAddress();
    this._cntsFromAddress();
  }

  /**
   * OAM DMA: копирует 256 байт из CPU-памяти в OAM начиная с OAMADDR.
   * console.js может звать это для $4014 (или скопировать spriteMem сам).
   * @param {Uint8Array} source вся CPU-память (0x10000 байт)
   * @param {number} page номер страницы $XX00 >> 8
   */
  oamDma(source, page) {
    const base = (page & 0xff) << 8;
    for (let i = 0; i < 256; i++) {
      this.spriteMem[(this.sramAddress + i) & 0xff] = source[base + i] & 0xff;
    }
  }

  // ======================================================================
  // Кадр: startFrame / advanceDots / renderFullFrame
  // ======================================================================

  /** Подготавливает буфер кадра: заливает цветом фона (backdrop). */
  _fillBackdrop() {
    let bgColor;
    if (this.f_dispType === 0) {
      bgColor = this.imgPalette[0];
    } else {
      // Монохромный режим: цвет фона задаётся битами 5-7 $2001.
      switch (this.f_color) {
        case 1:
          bgColor = 0x00ff00;
          break;
        case 2:
          bgColor = 0x0000ff;
          break;
        case 4:
          bgColor = 0xff0000;
          break;
        default:
          bgColor = 0;
      }
    }
    this.buffer.fill(bgColor);
  }

  /**
   * Начало кадра: очищает буфер под новый кадр. Вызывается console.js перед
   * циклом advanceDots. Не трогает позицию scanline/curX.
   */
  startFrame() {
    this._fillBackdrop();
    this._row0OpaqueValid = false;
    this.frameEnded = false;
  }

  /**
   * Продвигает PPU на `dots` точек (3 точки = 1 цикл CPU). По мере продвижения
   * рендерит строки (в начале каждой видимой), ставит vblank/NMI на строке 241
   * и frameEnded на границе кадра.
   * @param {number} dots
   */
  advanceDots(dots) {
    let remaining = dots;
    while (remaining > 0) {
      const room = PPU_DOTS_PER_SCANLINE - this.curX; // точек до конца строки
      // На строках 241 и 261 есть событие на dot 1 (vblank set / clear flags).
      const isEventLine =
        this.scanline === PPU_VBLANK_SCANLINE || this.scanline === PPU_PRERENDER_SCANLINE;
      const eventDot = isEventLine && this.curX <= 1 ? 1 : -1;
      if (eventDot >= 0 && eventDot - this.curX < remaining && eventDot - this.curX < room) {
        // Дойти до события, обработать его, затем продолжить.
        const skip = eventDot - this.curX;
        this.curX = eventDot;
        remaining -= skip;
        this._fireDotEvent();
        this.curX += 1;
        remaining -= 1;
        continue;
      }
      if (remaining < room) {
        this.curX += remaining;
        remaining = 0;
      } else {
        remaining -= room;
        this.curX = 0;
        this._endScanline();
      }
    }
  }

  /** События, привязанные к dot 1 строк 241/261. */
  _fireDotEvent() {
    if (this.scanline === PPU_VBLANK_SCANLINE) {
      if (this._firstFrame) {
        // Первый кадр после включения: vblank ещё «не наступил» (см. _firstFrame).
        this._firstFrame = false;
        return;
      }
      this._startVblank();
    } else {
      // Pre-render: на dot 1 снимаются vblank, sprite 0 hit и overflow.
      // Защёлку $2005/$2006 не трогаем: её сбрасывает только чтение $2002
      // (как в JSNES и на железе).
      this.vblankFlag = false;
      this.sprite0Hit = false;
      this.overflowFlag = false;
    }
  }

  /** Конец строки: переход к следующей и рендер её начала для видимых строк. */
  _endScanline() {
    const finished = this.scanline;
    if (finished === PPU_PRERENDER_SCANLINE) {
      // Pre-render копирует t -> v, чтобы строка 0 начиналась с заданного скролла.
      if (this._renderingEnabled()) {
        this.cntFV = this.regFV;
        this.cntV = this.regV;
        this.cntH = this.regH;
        this.cntVT = this.regVT;
        this.cntHT = this.regHT;
      }
    }
    this.scanline = (finished + 1) % PPU_SCANLINES;
    const next = this.scanline;
    if (next < PPU_VISIBLE_SCANLINES) this._renderScanline(next);
  }

  /** vblank: ставит флаг и NMI, завершает кадр (кроп) на строке 241. */
  _startVblank() {
    this.vblankFlag = true;
    if (this.f_nmiOnVblank === 1) this.nmiPending = true;
    this._applyEndFrameClipping();
    this.frameEnded = true;
  }

  /**
   * Рендерит одну видимую строку (BG + спрайты) в момент её начала.
   * Если рендер выключен, счётчики скролла не двигаются — как на железе:
   * пайплайн BG/спрайтов не работает, пока оба слоя выключены.
   * @param {number} scan строка 0..239
   */
  _renderScanline(scan) {
    if (!this._renderingEnabled()) return;

    // Строка всегда начинается с coarse X и nametable H из t.
    this.cntHT = this.regHT;
    this.cntH = this.regH;

    if (this.f_bgVisibility === 1) {
      this._renderBgLine(scan);
    } else {
      this._lineBg.fill(0);
    }
    if (this.f_spVisibility === 1) {
      this._evaluateSprites(scan);
      this._renderSpriteLine(scan);
    } else {
      this._sprCount = 0;
    }

    // Инкремент вертикального счётчика (fine Y -> coarse Y -> nametable V).
    this.cntFV++;
    if (this.cntFV === 8) {
      this.cntFV = 0;
      this.cntVT++;
      if (this.cntVT === 30) {
        this.cntVT = 0;
        this.cntV ^= 1;
      } else if (this.cntVT === 32) {
        this.cntVT = 0;
      }
    }
  }

  /** Рендерит фон одной строки. Заполняет buffer и _lineBg. */
  _renderBgLine(scan) {
    this._lineBg.fill(0);
    // JSNES-совместимая деталь: пока fine Y больше номера строки, верхняя
    // «неполная» строка тайла не рисуется (буфер остаётся фоном). Для Tetris
    // fine Y почти всегда 0, поведение совпадает с железом.
    if (scan < this.cntFV) return;

    const bgTable = this.f_bgPatternTable === 1 ? 256 : 0;
    const ntIndex = this.ntable1[(this.cntV << 1) + this.cntH];
    const ntBase = 0x2000 + (ntIndex << 10);
    const rowBase = this.cntFV << 3;
    const buffer = this.buffer;
    const lineBg = this._lineBg;
    const rowOffset = scan * SCREEN_WIDTH;

    for (let tile = 0; tile < 32; tile++) {
      const tileIndex = this.vramMem[ntBase + (this.cntVT << 5) + this.cntHT];
      const pix = this.ptTile[bgTable + tileIndex].pix;
      // Атрибут: 2 бита палитры для 16×16 области, к которой относится тайл.
      const attrAddress = ntBase + 0x3c0 + (((this.cntVT >> 2) & 7) << 3) + (this.cntHT >> 2);
      const shift = ((this.cntVT & 2) << 1) | (this.cntHT & 2);
      const palAdd = (((this.vramMem[attrAddress] >> shift) & 3) << 2);
      const xBase = (tile << 3) - this.regFH;

      for (let sx = 0; sx < 8; sx++) {
        const colorIndex = pix[rowBase + sx];
        if (colorIndex === 0) continue;
        const x = xBase + sx;
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        buffer[rowOffset + x] = this.imgPalette[colorIndex + palAdd];
        lineBg[x] = 1;
      }

      // Инкремент горизонтального счётчика: coarse X -> nametable H.
      this.cntHT++;
      if (this.cntHT === 32) {
        this.cntHT = 0;
        this.cntH ^= 1;
      }
    }

    if (scan === 0) {
      // Запоминаем непрозрачные пиксели строки 0 для эмуляции ленивой
      // композиции JSNES (см. _row0Opaque).
      this._row0Opaque.set(lineBg);
      this._row0OpaqueValid = true;
    }
  }

  /**
   * Аппаратное вычисление secondary OAM для строки: до 8 спрайтов, начиная
   * с OAMADDR/4 (записи до OAMADDR не проверяются и невидимы).
   * @param {number} scan
   */
  _evaluateSprites(scan) {
    const height = this.f_spriteSize === 1 ? 16 : 8;
    const start = (this.sramAddress >> 2) & 0x3f;
    let found = 0;
    this._spr0Index = -1;
    for (let n = start; n < 64; n++) {
      const oam = n << 2;
      const y = this.spriteMem[oam];
      // Спрайт виден на строках y+1 .. y+height (Y в OAM на 1 меньше).
      if (scan > y && scan <= y + height) {
        if (found < 8) {
          const dst = found << 2;
          this._sprOam[dst] = y;
          this._sprOam[dst + 1] = this.spriteMem[oam + 1];
          this._sprOam[dst + 2] = this.spriteMem[oam + 2];
          this._sprOam[dst + 3] = this.spriteMem[oam + 3];
          // Sprite 0 — первая проверенная запись OAM (при OAMADDR=0 — запись 0).
          if (n === start) this._spr0Index = found;
          found++;
        } else {
          // 9-й спрайт в строке: флаг переполнения, оценка прекращается.
          this.overflowFlag = true;
          break;
        }
      }
    }
    this._sprCount = found;
  }

  /** Рендерит спрайты одной строки поверх BG с учётом приоритета и flips. */
  _renderSpriteLine(scan) {
    const count = this._sprCount;
    if (count === 0) return;

    const eightBy16 = this.f_spriteSize === 1;
    const spTable = this.f_spPatternTable === 1 ? 256 : 0;
    const buffer = this.buffer;
    const lineBg = this._lineBg;
    const claim = this._sprClaim;
    claim.fill(0);
    // Условие «левый кроп» для sprite 0 hit: если хотя бы один слой скрыт
    // в первых 8 пикселях, hit там не фиксируется.
    const leftClip = this.f_spClipping === 0 || this.f_bgClipping === 0;
    const rowOffset = scan * SCREEN_WIDTH;
    const oam = this._sprOam;

    for (let i = 0; i < count; i++) {
      const base = i << 2;
      const y = oam[base];
      const tile = oam[base + 1];
      const attr = oam[base + 2];
      const x0 = oam[base + 3];

      // Строка внутри спрайта (0..7 для 8x8, 0..15 для 8x16).
      const sourceRow = scan - (y + 1);
      if (sourceRow < 0) continue;

      const vertFlip = (attr >> 7) & 1;
      const horiFlip = (attr >> 6) & 1;
      const behind = (attr >> 5) & 1;
      const palAdd = (attr & 3) << 2;

      let pix;
      let rowBase;
      if (!eightBy16) {
        if (sourceRow >= 8) continue;
        pix = this.ptTile[spTable + tile].pix;
        rowBase = (vertFlip ? 7 - sourceRow : sourceRow) << 3;
      } else {
        if (sourceRow >= 16) continue;
        // 8x16: бит 0 номера тайла выбирает таблицу, верхний тайл — чётный.
        const tableBase = (tile & 1) === 1 ? 256 : 0;
        const topTile = (tile & 0xfe) + tableBase;
        const logicalRow = vertFlip ? 15 - sourceRow : sourceRow;
        const tileIndex = topTile + (logicalRow >= 8 ? 1 : 0);
        pix = this.ptTile[tileIndex].pix;
        rowBase = (logicalRow & 7) << 3;
      }

      const isSprite0 = i === this._spr0Index;
      for (let px = 0; px < 8; px++) {
        const sx = horiFlip ? 7 - px : px;
        const colorIndex = pix[rowBase + sx];
        if (colorIndex === 0) continue;
        const x = x0 + px;
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        const index = rowOffset + x;

        if (isSprite0 && !this.sprite0Hit && x !== 255 && !(leftClip && x < 8) && lineBg[x] === 1) {
          // Непрозрачные пиксели BG и sprite 0 совпали.
          this.sprite0Hit = true;
        }

        // Более приоритетный спрайт уже занял этот пиксель.
        if (claim[x] === 1) continue;
        if (behind === 1) {
          if (lineBg[x] === 1) {
            // Спрайт за фоном, а BG здесь непрозрачен: цвет остаётся BG,
            // но пиксель считается занятым (более приоритетным спрайтом).
            claim[x] = 1;
            continue;
          }
        }
        buffer[index] = this.sprPalette[colorIndex + palAdd];
        claim[x] = 1;
      }
    }
  }

  /** Кроп кадра в конце кадра — в точности как у JSNES (формат buffer). */
  _applyEndFrameClipping() {
    const buffer = this.buffer;
    // JSNES-совместимая деталь: непрозрачные пиксели BG строки 0 на vblank
    // затираются нулями (незаполненный bgbuffer[0] в ленивой композиции JSNES).
    // Прозрачные пиксели остаются фоном. Настоящее железо так не делает,
    // но эталон для побайтового сравнения кадров — JSNES 2.1.0.
    if (this._row0OpaqueValid) {
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        if (this._row0Opaque[x] === 1) buffer[x] = 0;
      }
      this._row0OpaqueValid = false;
    }
    // Если хотя бы один слой не рисует левые 8 пикселей, JSNES обнуляет
    // левую колонку у обоих слоёв (он делает это после рендера всего кадра).
    if (this.clipToTvSize || this.f_bgClipping === 0 || this.f_spClipping === 0) {
      for (let y = 0; y < SCREEN_HEIGHT; y++) {
        buffer.fill(0, y << 8, (y << 8) + 8);
      }
    }
    if (this.clipToTvSize) {
      for (let y = 0; y < SCREEN_HEIGHT; y++) {
        buffer.fill(0, (y << 8) + 248, (y << 8) + 256);
      }
      buffer.fill(0, 0, 8 << 8);
      buffer.fill(0, 232 << 8, 240 << 8);
    }
  }

  /**
   * Полный рендер кадра из текущего состояния без исполнения CPU.
   * Нужен для пауз/смены раскладки: engine.js берёт снапшот, применяет через
   * fromJSON и просит отрисовать кадр. Позиция scanline/curX и флаги статуса
   * не меняются (рендер — чистая функция от состояния PPU).
   */
  renderFullFrame() {
    const saved = {
      scanline: this.scanline,
      curX: this.curX,
      frameEnded: this.frameEnded,
      nmiPending: this.nmiPending,
      vblankFlag: this.vblankFlag,
      sprite0Hit: this.sprite0Hit,
      overflowFlag: this.overflowFlag,
      firstWrite: this.firstWrite,
      cntFV: this.cntFV,
      cntV: this.cntV,
      cntH: this.cntH,
      cntVT: this.cntVT,
      cntHT: this.cntHT,
      vramAddress: this.vramAddress,
      vramTmpAddress: this.vramTmpAddress,
      sramAddress: this.sramAddress,
    };

    this._fillBackdrop();
    this._row0OpaqueValid = false;
    this._lineBg.fill(0);
    this._sprClaim.fill(0);

    // Как pre-render + 240 видимых строк в одном кадре: счётчики берутся из t.
    this.cntFV = this.regFV;
    this.cntV = this.regV;
    this.cntH = this.regH;
    this.cntVT = this.regVT;
    this.cntHT = this.regHT;

    for (let scan = 0; scan < PPU_VISIBLE_SCANLINES; scan++) {
      this._renderScanline(scan);
    }
    this._applyEndFrameClipping();

    this.scanline = saved.scanline;
    this.curX = saved.curX;
    this.frameEnded = saved.frameEnded;
    this.nmiPending = saved.nmiPending;
    this.vblankFlag = saved.vblankFlag;
    this.sprite0Hit = saved.sprite0Hit;
    this.overflowFlag = saved.overflowFlag;
    this.firstWrite = saved.firstWrite;
    this.cntFV = saved.cntFV;
    this.cntV = saved.cntV;
    this.cntH = saved.cntH;
    this.cntVT = saved.cntVT;
    this.cntHT = saved.cntHT;
    this.vramAddress = saved.vramAddress;
    this.vramTmpAddress = saved.vramTmpAddress;
    this.sramAddress = saved.sramAddress;
  }

  // ======================================================================
  // Снапшоты
  // ======================================================================

  /**
   * Сериализует состояние PPU. Поля именованы как у JSNES там, где совпадает
   * смысл, чтобы снапшоты и дифф-тесты было проще сопоставлять.
   * ptTile не сохраняется — он однозначно восстанавливается из vramMem.
   * @returns {object}
   */
  toJSON() {
    return {
      format: PPU_STATE_FORMAT,
      vramMem: Array.from(this.vramMem),
      spriteMem: Array.from(this.spriteMem),
      buffer: Array.from(this.buffer),
      imgPalette: Array.from(this.imgPalette),
      sprPalette: Array.from(this.sprPalette),
      f_nmiOnVblank: this.f_nmiOnVblank,
      f_spriteSize: this.f_spriteSize,
      f_bgPatternTable: this.f_bgPatternTable,
      f_spPatternTable: this.f_spPatternTable,
      f_addrInc: this.f_addrInc,
      f_nTblAddress: this.f_nTblAddress,
      f_color: this.f_color,
      f_spVisibility: this.f_spVisibility,
      f_bgVisibility: this.f_bgVisibility,
      f_spClipping: this.f_spClipping,
      f_bgClipping: this.f_bgClipping,
      f_dispType: this.f_dispType,
      regFV: this.regFV,
      regV: this.regV,
      regH: this.regH,
      regVT: this.regVT,
      regHT: this.regHT,
      regFH: this.regFH,
      regS: this.regS,
      cntFV: this.cntFV,
      cntV: this.cntV,
      cntH: this.cntH,
      cntVT: this.cntVT,
      cntHT: this.cntHT,
      vramAddress: this.vramAddress,
      vramTmpAddress: this.vramTmpAddress,
      vramBufferedReadValue: this.vramBufferedReadValue,
      firstWrite: this.firstWrite,
      sramAddress: this.sramAddress,
      openBusLatch: this.openBusLatch,
      scanline: this.scanline,
      curX: this.curX,
      frameEnded: this.frameEnded,
      nmiPending: this.nmiPending,
      vblankFlag: this.vblankFlag,
      sprite0Hit: this.sprite0Hit,
      overflowFlag: this.overflowFlag,
      firstFrame: this._firstFrame,
      currentMirroring: this.currentMirroring,
      palEmphasis: this._palEmphasis,
      clipToTvSize: this.clipToTvSize,
      showSpr0Hit: this.showSpr0Hit,
    };
  }

  /**
   * Восстанавливает состояние из снапшота toJSON(). Толерантен к отсутствию
   * отдельных полей (для чужих/старых снапшотов). ptTile передекодируется из
   * vramMem, палитры пересчитываются, если их нет в снапшоте.
   * @param {object} state
   */
  fromJSON(state) {
    if (!state || typeof state !== 'object') throw new Error('PPU.fromJSON: ожидался объект состояния');

    if (Array.isArray(state.vramMem) || state.vramMem instanceof Uint8Array) {
      this.vramMem.set(state.vramMem.subarray ? state.vramMem.subarray(0, PPU_MEM_SIZE) : state.vramMem);
    }
    if (Array.isArray(state.spriteMem) || state.spriteMem instanceof Uint8Array) {
      this.spriteMem.set(state.spriteMem.subarray ? state.spriteMem : state.spriteMem);
    }
    if (Array.isArray(state.buffer)) {
      this.buffer.set(state.buffer);
    }

    this.f_nmiOnVblank = state.f_nmiOnVblank ?? this.f_nmiOnVblank;
    this.f_spriteSize = state.f_spriteSize ?? this.f_spriteSize;
    this.f_bgPatternTable = state.f_bgPatternTable ?? this.f_bgPatternTable;
    this.f_spPatternTable = state.f_spPatternTable ?? this.f_spPatternTable;
    this.f_addrInc = state.f_addrInc ?? this.f_addrInc;
    this.f_nTblAddress = state.f_nTblAddress ?? this.f_nTblAddress;
    this.f_color = state.f_color ?? this.f_color;
    this.f_spVisibility = state.f_spVisibility ?? this.f_spVisibility;
    this.f_bgVisibility = state.f_bgVisibility ?? this.f_bgVisibility;
    this.f_spClipping = state.f_spClipping ?? this.f_spClipping;
    this.f_bgClipping = state.f_bgClipping ?? this.f_bgClipping;
    this.f_dispType = state.f_dispType ?? this.f_dispType;

    this.regFV = state.regFV ?? this.regFV;
    this.regV = state.regV ?? this.regV;
    this.regH = state.regH ?? this.regH;
    this.regVT = state.regVT ?? this.regVT;
    this.regHT = state.regHT ?? this.regHT;
    this.regFH = state.regFH ?? this.regFH;
    this.regS = state.regS ?? this.regS;
    this.cntFV = state.cntFV ?? this.cntFV;
    this.cntV = state.cntV ?? this.cntV;
    this.cntH = state.cntH ?? this.cntH;
    this.cntVT = state.cntVT ?? this.cntVT;
    this.cntHT = state.cntHT ?? this.cntHT;

    this.vramAddress = state.vramAddress ?? this.vramAddress;
    this.vramTmpAddress = state.vramTmpAddress ?? this.vramTmpAddress;
    this.vramBufferedReadValue = state.vramBufferedReadValue ?? this.vramBufferedReadValue;
    this.firstWrite = state.firstWrite ?? this.firstWrite;
    this.sramAddress = state.sramAddress ?? this.sramAddress;
    this.openBusLatch = state.openBusLatch ?? this.openBusLatch;

    this.scanline = state.scanline ?? this.scanline;
    this.curX = state.curX ?? this.curX;
    this.frameEnded = state.frameEnded ?? this.frameEnded;
    this.nmiPending = state.nmiPending ?? this.nmiPending;
    this.vblankFlag = state.vblankFlag ?? this.vblankFlag;
    this.sprite0Hit = state.sprite0Hit ?? this.sprite0Hit;
    this.overflowFlag = state.overflowFlag ?? this.overflowFlag;
    if (typeof state.firstFrame === 'boolean') this._firstFrame = state.firstFrame;

    this._palEmphasis = state.palEmphasis ?? this._palEmphasis;
    if (typeof state.clipToTvSize === 'boolean') this.clipToTvSize = state.clipToTvSize;
    if (typeof state.showSpr0Hit === 'boolean') this.showSpr0Hit = state.showSpr0Hit;

    // Восстанавливаем таблицу зеркал (она выводится из currentMirroring).
    if (state.currentMirroring !== undefined && state.currentMirroring !== -1) {
      const mirroring = state.currentMirroring;
      this.currentMirroring = -1;
      this.setMirroring(mirroring);
    }

    // ptTile — производное от vramMem.
    this._decodeAllTiles();

    // Палитры: если в снапшоте нет готовых значений (чужой формат) — считаем.
    if (Array.isArray(state.imgPalette) && Array.isArray(state.sprPalette)) {
      this.imgPalette.set(state.imgPalette);
      this.sprPalette.set(state.sprPalette);
    } else {
      this._updatePalettes();
    }
  }
}

export default PPU;
