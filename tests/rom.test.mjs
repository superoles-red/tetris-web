// Тесты разбора iNES-образов: ошибки, поля, NES 2.0, зеркалирование, SHA-256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRom, sha256Hex, RomError } from '../src/nes/rom.js';

const MAGIC = [0x4e, 0x45, 0x53, 0x1a];

/**
 * Собирает синтетический iNES-образ.
 * @param {{prgBanks?: number, chrBanks?: number, mapper?: number, mirroring?: 'horizontal'|'vertical',
 *   fourScreen?: boolean, battery?: boolean, trainer?: boolean, prgFill?: number, chrFill?: number,
 *   extra?: number, nes2?: boolean, prgHigh?: number, chrHigh?: number, mapperHigh?: number}} [options]
 */
function makeInes(options = {}) {
  const {
    prgBanks = 2,
    chrBanks = 1,
    mapper = 0,
    mirroring = 'horizontal',
    fourScreen = false,
    battery = false,
    trainer = false,
    prgFill = 0xea,
    chrFill = 0x00,
    extra = 0,
    nes2 = false,
    prgHigh = 0,
    chrHigh = 0,
    mapperHigh = 0,
  } = options;
  const header = new Uint8Array(16);
  header.set(MAGIC, 0);
  header[4] = prgBanks & 0xff;
  header[5] = chrBanks & 0xff;
  header[6] = ((mapper & 0x0f) << 4) | (fourScreen ? 0x08 : 0) | (trainer ? 0x04 : 0) | (battery ? 0x02 : 0) | (mirroring === 'vertical' ? 0x01 : 0);
  header[7] = (mapper & 0xf0) | (nes2 ? 0x08 : 0);
  if (nes2) {
    header[8] = mapperHigh & 0x0f;
    header[9] = ((chrHigh & 0x0f) << 4) | (prgHigh & 0x0f);
  }
  const effectivePrgBanks = nes2 ? prgBanks + prgHigh * 256 : prgBanks;
  const effectiveChrBanks = nes2 ? chrBanks + chrHigh * 256 : chrBanks;
  const prgSize = effectivePrgBanks * 16384;
  const chrSize = effectiveChrBanks * 8192;
  const trainerSize = trainer ? 512 : 0;
  const bytes = new Uint8Array(16 + trainerSize + prgSize + chrSize + extra);
  bytes.set(header, 0);
  bytes.fill(prgFill, 16 + trainerSize, 16 + trainerSize + prgSize);
  bytes.fill(chrFill, 16 + trainerSize + prgSize, 16 + trainerSize + prgSize + chrSize);
  return bytes;
}

test('sha256Hex считает hex-SHA-256', async () => {
  assert.equal(
    await sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('parseRom: ошибки входа', () => {
  assert.throws(() => parseRom('NES'), error => error instanceof RomError && error.code === 'type');
  assert.throws(() => parseRom(new Uint8Array(8)), error => error.code === 'short');
  const badMagic = makeInes();
  badMagic[0] = 0x00;
  assert.throws(() => parseRom(badMagic), error => error.code === 'magic');
  assert.throws(() => parseRom(makeInes({ prgBanks: 0 })), error => error.code === 'prg');
  const truncated = makeInes({ prgBanks: 2, chrBanks: 1 }).subarray(0, 40);
  assert.throws(() => parseRom(truncated), error => error.code === 'truncated');
});

test('parseRom: NROM-128 и NROM-256', () => {
  const nrom128 = parseRom(makeInes({ prgBanks: 1, chrBanks: 1 }));
  assert.equal(nrom128.format, 'iNES');
  assert.equal(nrom128.mapper, 0);
  assert.equal(nrom128.prgSize, 16384);
  assert.equal(nrom128.prgBanks, 1);
  assert.equal(nrom128.chrSize, 8192);
  assert.equal(nrom128.chrBanks, 1);
  assert.equal(nrom128.supported, true);
  assert.equal(nrom128.hasChrRam, false);
  assert.equal(nrom128.reason, null);

  const nrom256 = parseRom(makeInes({ prgBanks: 2, chrBanks: 2 }));
  assert.equal(nrom256.prgSize, 32768);
  assert.equal(nrom256.chrSize, 16384);
  assert.equal(nrom256.supported, true);

  // NROM с CHR RAM: поддерживается, но с предупреждением.
  const chrRam = parseRom(makeInes({ prgBanks: 2, chrBanks: 0 }));
  assert.equal(chrRam.supported, true);
  assert.equal(chrRam.hasChrRam, true);
  assert.match(chrRam.warnings.join(' '), /CHR RAM/);
});

test('parseRom: зеркалирование и флаги', () => {
  assert.equal(parseRom(makeInes({ mirroring: 'vertical' })).mirroring, 'vertical');
  assert.equal(parseRom(makeInes({ mirroring: 'horizontal' })).mirroring, 'horizontal');
  assert.equal(parseRom(makeInes({ fourScreen: true })).mirroring, 'four');
  const flags = parseRom(makeInes({ battery: true, trainer: true }));
  assert.equal(flags.battery, true);
  assert.equal(flags.trainer, true);
  // Тренер сдвигает начало PRG на 512 байт.
  const withTrainer = makeInes({ prgBanks: 1, chrBanks: 0, trainer: true, prgFill: 0x11 });
  const parsed = parseRom(withTrainer);
  assert.equal(parsed.prg[0], 0x11);
  assert.equal(parsed.prgSize, 16384);
});

test('parseRom: неподдерживаемые мапперы', () => {
  const mmc1 = parseRom(makeInes({ mapper: 1, prgBanks: 2, chrBanks: 1 }));
  assert.equal(mmc1.supported, false);
  assert.match(mmc1.reason, /Маппер 1/);

  const mmc3 = parseRom(makeInes({ mapper: 4, prgBanks: 2, chrBanks: 1 }));
  assert.equal(mmc3.supported, false);

  // 148 с >32 КиБ PRG (переключение банков) пока не поддерживается.
  const tengenBanks = parseRom(makeInes({ mapper: 148, prgBanks: 4, chrBanks: 2 }));
  assert.equal(tengenBanks.mapper, 148);
  assert.equal(tengenBanks.supported, false);
  assert.match(tengenBanks.reason, /PRG-банков/);

  const cnromNoChr = parseRom(makeInes({ mapper: 3, prgBanks: 2, chrBanks: 0 }));
  assert.equal(cnromNoChr.supported, false);
  assert.match(cnromNoChr.reason, /CHR/);

  const cnrom = parseRom(makeInes({ mapper: 3, prgBanks: 2, chrBanks: 2 }));
  assert.equal(cnrom.supported, true);
});

test('parseRom: NES 2.0', () => {
  const nes2 = parseRom(makeInes({ nes2: true, prgBanks: 2, chrBanks: 1 }));
  assert.equal(nes2.format, 'NES2.0');
  assert.equal(nes2.mapper, 0);
  assert.equal(nes2.prgSize, 32768);

  // Расширенные размеры: PRG = 256 + 16 банков, CHR = 16 банков.
  const big = parseRom(makeInes({ nes2: true, prgBanks: 16, chrBanks: 0, prgHigh: 1, chrHigh: 1 }));
  assert.equal(big.prgBanks, 272);
  assert.equal(big.chrBanks, 256);

  // Расширенный маппер: 0x100 + 4 = 260 (не поддерживается, но номер верный).
  const extended = parseRom(makeInes({ nes2: true, mapper: 4, mapperHigh: 1 }));
  assert.equal(extended.mapper, 260);
  assert.equal(extended.supported, false);
});

test('parseRom: лишние байты — предупреждение, не ошибка', () => {
  const parsed = parseRom(makeInes({ extra: 100 }));
  assert.equal(parsed.supported, true);
  assert.match(parsed.warnings.join(' '), /лишних байт/);
  assert.equal(parseRom(makeInes({ extra: 10 })).warnings.length, 0);
});

test('parseRom: возвращает срез байтов и копию заголовка', () => {
  const bytes = makeInes({ prgBanks: 1, chrBanks: 1, prgFill: 0x42, chrFill: 0x77 });
  const parsed = parseRom(bytes);
  assert.equal(parsed.prg[0], 0x42);
  assert.equal(parsed.chr[0], 0x77);
  assert.equal(parsed.header.length, 16);
  assert.notEqual(parsed.header, bytes.subarray(0, 16)); // копия, а не view
  assert.equal(parsed.fileSize, bytes.length);
  assert.equal(parsed.mirroring, 'horizontal');
});
