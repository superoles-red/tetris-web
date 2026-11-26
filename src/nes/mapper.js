// Мапперы картриджа. Поддержаны только небанкованные по PRG варианты:
// 0 (NROM), 3 (CNROM), 148 (Tengen 800008 / Sachen SA-008-A).
// Окно PRG — 32 КиБ (для 16-КиБ PRG банк зеркалится дважды), окно CHR — 8 КиБ.
// Консоль копирует эти окна в память WASM и в PPU при каждом изменении.

import { RomError } from './rom.js';

const PRG_WINDOW_SIZE = 0x8000;
const CHR_WINDOW_SIZE = 0x2000;

/**
 * @param {ReturnType<import('./rom.js').parseRom>} rom
 * @param {{ onPrgWindow?: (bytes: Uint8Array) => void, onChrWindow?: (bytes: Uint8Array) => void }} callbacks
 */
export function createMapper(rom, callbacks = {}) {
  const prg = rom.prg;
  const chr = rom.chr;
  const chrRam = chr.length === 0 ? new Uint8Array(CHR_WINDOW_SIZE) : null;
  const chrBankCount = Math.max(1, Math.floor(chr.length / CHR_WINDOW_SIZE));
  const prgWindow = new Uint8Array(PRG_WINDOW_SIZE);
  const chrWindow = new Uint8Array(CHR_WINDOW_SIZE);
  let chrBank = 0;

  function fillPrgWindow() {
    if (prg.length >= PRG_WINDOW_SIZE) {
      prgWindow.set(prg.subarray(0, PRG_WINDOW_SIZE));
    } else {
      // NROM-128: 16 КиБ зеркалятся в оба окна.
      prgWindow.set(prg, 0);
      prgWindow.set(prg, prg.length);
    }
  }

  function fillChrWindow() {
    if (chrRam) {
      chrWindow.set(chrRam);
      return;
    }
    const start = (chrBank % chrBankCount) * CHR_WINDOW_SIZE;
    chrWindow.set(chr.subarray(start, start + CHR_WINDOW_SIZE));
  }

  function publishPrg() {
    callbacks.onPrgWindow?.(prgWindow);
  }

  function publishChr() {
    callbacks.onChrWindow?.(chrWindow);
  }

  const mapper = {
    type: rom.mapper,
    mirroring: rom.mirroring,
    prgWindow,
    chrWindow,
    /** CHR-RAM картриджи: запись в $2007 меняет графику. */
    get chrWritable() {
      return chrRam !== null;
    },
    /** Текущий 8-КиБ CHR-банк (для паспорта/снапшотов). */
    get chrBank() {
      return chrBank;
    },
    reset() {
      chrBank = 0;
      if (chrRam) chrRam.fill(0);
      fillPrgWindow();
      fillChrWindow();
      publishPrg();
      publishChr();
    },
    /** Чтение из окна PRG ($8000-$FFFF). */
    readPrg(address) {
      return prgWindow[address & (PRG_WINDOW_SIZE - 1)];
    },
    /** Байт-конфликт для маппера 148: ROM в точке записи. */
    busConflictByte(address) {
      return prgWindow[address & (PRG_WINDOW_SIZE - 1)];
    },
    /** Запись в регистры картриджа ($8000-$FFFF). */
    writeRegister(address, value) {
      if (address < 0x8000) return;
      switch (rom.mapper) {
        case 0:
          // NROM: ROM не записывается.
          break;
        case 3: {
          // CNROM: младшие биты выбирают 8-КиБ CHR-банк.
          const next = (value & 0xff) % chrBankCount;
          if (next !== chrBank) {
            chrBank = next;
            fillChrWindow();
            publishChr();
          }
          break;
        }
        case 148: {
          // Tengen 800008: значение конфликтует с шиной, затем младшие
          // 3 бита выбирают CHR-банк; бит 3 — PRG-банк (не поддерживаем).
          const latch = value & prgWindow[address & (PRG_WINDOW_SIZE - 1)];
          const next = (latch & 7) % chrBankCount;
          if (next !== chrBank) {
            chrBank = next;
            fillChrWindow();
            publishChr();
          }
          break;
        }
        default:
          throw new RomError('mapper', `Маппер ${rom.mapper} не поддерживается.`);
      }
    },
    /** Запись в CHR RAM через $2007 (для мапперов без CHR-ROM). */
    writeChr(address, value) {
      if (!chrRam) return;
      address &= CHR_WINDOW_SIZE - 1;
      chrRam[address] = value;
      chrWindow[address] = value;
    },
    snapshot() {
      return { chrBank, chrRam: chrRam ? Array.from(chrRam) : null };
    },
    restore(state) {
      chrBank = state.chrBank;
      if (chrRam && state.chrRam) chrRam.set(state.chrRam);
      fillPrgWindow();
      fillChrWindow();
      publishPrg();
      publishChr();
    },
  };

  mapper.reset();
  return mapper;
}
