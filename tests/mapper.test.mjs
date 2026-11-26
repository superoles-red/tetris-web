// Тесты мапперов 0 (NROM), 3 (CNROM), 148 (Tengen 800008): PRG-окно,
// CHR-банки, bus-conflict, CHR-RAM, снапшоты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRom } from '../src/nes/rom.js';
import { createMapper } from '../src/nes/mapper.js';

const MAGIC = [0x4e, 0x45, 0x53, 0x1a];

/**
 * Синтетический ROM; PRG заполняется по шаблону, чтобы адреса/байты были
 * узнаваемы (prg[i] = (i * 7 + 1) & 0xff), CHR — по банкам.
 */
function makeRom({ prgBanks = 2, chrBanks = 1, mapper = 0, prg } = {}) {
  const header = new Uint8Array(16);
  header.set(MAGIC, 0);
  header[4] = prgBanks;
  header[5] = chrBanks;
  header[6] = (mapper & 0x0f) << 4;
  header[7] = mapper & 0xf0;
  const prgSize = prgBanks * 16384;
  const chrSize = chrBanks * 8192;
  const bytes = new Uint8Array(16 + prgSize + chrSize);
  bytes.set(header, 0);
  for (let i = 0; i < prgSize; i++) {
    bytes[16 + i] = prg ? prg[i] : (i * 7 + 1) & 0xff;
  }
  for (let bank = 0; bank < chrBanks; bank++) {
    for (let i = 0; i < 8192; i++) {
      bytes[16 + prgSize + bank * 8192 + i] = (bank * 16 + (i & 0x0f)) & 0xff;
    }
  }
  return parseRom(bytes);
}

/** Фиксирует окна, которые маппер публикует через колбэки. */
function collector() {
  const state = { prg: null, chr: null, prgCalls: 0, chrCalls: 0 };
  const callbacks = {
    onPrgWindow: bytes => {
      state.prg = Uint8Array.from(bytes);
      state.prgCalls++;
    },
    onChrWindow: bytes => {
      state.chr = Uint8Array.from(bytes);
      state.chrCalls++;
    },
  };
  return { state, callbacks };
}

test('NROM-256: 32 КиБ PRG публикуются как окно, запись в ROM ничего не меняет', () => {
  const rom = makeRom({ prgBanks: 2, chrBanks: 1, mapper: 0 });
  const { state, callbacks } = collector();
  const mapper = createMapper(rom, callbacks);
  assert.equal(mapper.type, 0);
  assert.equal(mapper.mirroring, 'horizontal');
  assert.equal(state.prgCalls, 1); // reset() публикует окно
  assert.equal(state.prg.length, 0x8000);
  assert.equal(state.chr.length, 0x2000);
  assert.equal(mapper.readPrg(0x8000), rom.prg[0]);
  assert.equal(mapper.readPrg(0xffff), rom.prg[0x7fff]);
  // Запись в $8000+ для NROM — no-op.
  const before = mapper.readPrg(0x8000);
  mapper.writeRegister(0x8000, 0x55);
  assert.equal(mapper.readPrg(0x8000), before);
  // Запись ниже $8000 игнорируется.
  mapper.writeRegister(0x4000, 0x55);
});

test('NROM-128: 16 КиБ PRG зеркалятся в оба 16-КиБ окна', () => {
  const rom = makeRom({ prgBanks: 1, chrBanks: 0, mapper: 0 });
  const { state, callbacks } = collector();
  const mapper = createMapper(rom, callbacks);
  assert.equal(state.prg.length, 0x8000);
  assert.deepEqual(state.prg.subarray(0, 0x4000), state.prg.subarray(0x4000));
  assert.equal(mapper.readPrg(0x8000), mapper.readPrg(0xc000));
  assert.equal(mapper.readPrg(0x8000 + 0x2000), rom.prg[0x2000]);
});

test('CNROM: запись выбирает 8-КиБ CHR-банк (с заворотом по модулю)', () => {
  const rom = makeRom({ prgBanks: 2, chrBanks: 2, mapper: 3 });
  const { state, callbacks } = collector();
  const mapper = createMapper(rom, callbacks);
  assert.equal(mapper.type, 3);
  assert.equal(mapper.chrBank, 0);
  const bank0 = state.chr;

  mapper.writeRegister(0x8000, 1);
  assert.equal(mapper.chrBank, 1);
  assert.notDeepEqual(state.chr, bank0);
  assert.equal(state.chr[0], rom.chr[8192]); // первый байт второго банка
  assert.equal(state.chrCalls, 2);

  mapper.writeRegister(0x9000, 3); // 3 % 2 = 1
  assert.equal(mapper.chrBank, 1);
  mapper.writeRegister(0x9000, 2); // 2 % 2 = 0
  assert.equal(mapper.chrBank, 0);
  assert.deepEqual(state.chr, bank0);

  // reset возвращает банк 0.
  mapper.writeRegister(0x8000, 1);
  mapper.reset();
  assert.equal(mapper.chrBank, 0);
  assert.deepEqual(state.chr, bank0);
});

test('CNROM: PRG не меняется, bus-conflict-байт = ROM в точке записи', () => {
  const prg = new Uint8Array(0x8000);
  prg[0] = 0x0f;
  prg[0x1234] = 0xa5;
  const rom = makeRom({ prgBanks: 2, chrBanks: 2, mapper: 3, prg });
  const mapper = createMapper(rom, collector().callbacks);
  mapper.writeRegister(0x8000, 0xff);
  assert.equal(mapper.readPrg(0x8000), 0x0f); // PRG не переключился
  assert.equal(mapper.busConflictByte(0x8000), 0x0f);
  assert.equal(mapper.busConflictByte(0x9234), 0xa5);
});

test('mapper 148 (Tengen): CHR-банк = (value & prg[addr]) & 7', () => {
  const prg = new Uint8Array(0x8000);
  prg[0] = 0b101; // $8000
  prg[0x1000] = 0b011; // $9000
  prg[0x100] = 0b110; // $8100
  const rom = makeRom({ prgBanks: 2, chrBanks: 8, mapper: 148, prg });
  const { state, callbacks } = collector();
  const mapper = createMapper(rom, callbacks);
  assert.equal(mapper.type, 148);

  // value=0xFF, ROM[$8000]=5 → latch 5 → банк 5.
  mapper.writeRegister(0x8000, 0xff);
  assert.equal(mapper.chrBank, 5);
  assert.equal(state.chr[0], (5 * 16) & 0xff);

  // value=0xF8, ROM[$9000]=3 → latch 0 → банк 0.
  mapper.writeRegister(0x9000, 0xf8);
  assert.equal(mapper.chrBank, 0);

  // value=0xFF, ROM[$8100]=6 → банк 6.
  mapper.writeRegister(0x8100, 0xff);
  assert.equal(mapper.chrBank, 6);

  // Банк всегда в пределах 0..7 (маска 7).
  mapper.writeRegister(0x8000, 0b111);
  assert.equal(mapper.chrBank, 0b101); // 0b111 & 0b101 = 5
});

test('mapper 148: bus conflict влияет на выбор банка', () => {
  const prg = new Uint8Array(0x8000);
  prg[0] = 0b010;
  const rom = makeRom({ prgBanks: 2, chrBanks: 8, mapper: 148, prg });
  const mapper = createMapper(rom, collector().callbacks);
  // value 0b111 & ROM 0b010 = 0b010 → банк 2.
  mapper.writeRegister(0x8000, 0b111);
  assert.equal(mapper.chrBank, 2);
  assert.equal(mapper.busConflictByte(0x8000), 0b010);
});

test('CHR-RAM (NROM без CHR): запись через $2007 меняет окно', () => {
  const rom = makeRom({ prgBanks: 2, chrBanks: 0, mapper: 0 });
  const { state, callbacks } = collector();
  const mapper = createMapper(rom, callbacks);
  assert.equal(mapper.chrWritable, true);
  assert.deepEqual(state.chr, new Uint8Array(0x2000));
  mapper.writeChr(0x0010, 0xab);
  // writeChr обновляет внутреннее окно (публикация в PPU — забота Console).
  assert.equal(mapper.chrWindow[0x10], 0xab);
  assert.equal(mapper.chrWritable, true);
});

test('CHR-ROM: writeChr не пишет', () => {
  const rom = makeRom({ prgBanks: 2, chrBanks: 1, mapper: 0 });
  const mapper = createMapper(rom, collector().callbacks);
  assert.equal(mapper.chrWritable, false);
  const before = mapper.chrWindow[0];
  mapper.writeChr(0x0000, before ^ 0xff);
  assert.equal(mapper.chrWindow[0], before);
});

test('снапшот/восстановление CHR-банка и CHR-RAM', () => {
  // CNROM: банк.
  const cnrom = createMapper(makeRom({ prgBanks: 2, chrBanks: 2, mapper: 3 }), collector().callbacks);
  cnrom.writeRegister(0x8000, 1);
  const snap = cnrom.snapshot();
  assert.equal(snap.chrBank, 1);
  assert.equal(snap.chrRam, null);
  cnrom.reset();
  assert.equal(cnrom.chrBank, 0);
  cnrom.restore(snap);
  assert.equal(cnrom.chrBank, 1);

  // CHR-RAM: содержимое.
  const chrRam = createMapper(makeRom({ prgBanks: 2, chrBanks: 0, mapper: 0 }), collector().callbacks);
  chrRam.writeChr(0x0100, 0x5a);
  const ramSnap = chrRam.snapshot();
  assert.equal(ramSnap.chrRam[0x0100], 0x5a);
  chrRam.reset();
  assert.equal(chrRam.chrWindow[0x0100], 0);
  chrRam.restore(ramSnap);
  assert.equal(chrRam.chrWindow[0x0100], 0x5a);
});

test('readPrg маскирует адрес окном 32 КиБ', () => {
  const rom = makeRom({ prgBanks: 2, chrBanks: 1, mapper: 0 });
  const mapper = createMapper(rom, collector().callbacks);
  assert.equal(mapper.readPrg(0x8000), mapper.readPrg(0x0000)); // 0x0000 & 0x7fff
  assert.equal(mapper.readPrg(0xffff), mapper.readPrg(0x7fff));
});
