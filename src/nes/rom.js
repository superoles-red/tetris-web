// Разбор iNES/NES 2.0 образа и профиль дампа.
// Никакие игровые данные здесь не хранятся: модуль работает с байтами,
// которые игрок передал из браузера.

const MAGIC = [0x4e, 0x45, 0x53, 0x1a];

export class RomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RomError';
    this.code = code;
  }
}

/** SHA-256 как hex-строка (crypto.subtle или node:crypto). */
export async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Проверяет и разбирает ROM.
 * @param {Uint8Array} bytes
 * @returns {{
 *   format: 'iNES'|'NES2.0', fileSize: number, mapper: number,
 *   mirroring: 'horizontal'|'vertical'|'four',
 *   prg: Uint8Array, chr: Uint8Array, prgSize: number, chrSize: number,
 *   prgBanks: number, chrBanks: number, battery: boolean, trainer: boolean,
 *   hasChrRam: boolean, supported: boolean, reason: string|null,
 *   header: Uint8Array, warnings: string[]
 * }}
 */
export function parseRom(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new RomError('type', 'Ожидался файл ROM (Uint8Array).');
  if (bytes.length < 16) throw new RomError('short', 'Файл слишком короткий для NES-ROM (нужен заголовок 16 байт).');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new RomError('magic', 'Это не NES-ROM: файл не начинается с подписи NES.');
  }
  const header = bytes.subarray(0, 16);
  const isNES2 = (header[7] & 0x0c) === 0x08;
  let prgBanks, chrBanks, mapper, fourScreen;
  if (isNES2) {
    prgBanks = (header[9] & 0x0f) << 8 | header[4];
    chrBanks = (header[9] >> 4) << 8 | header[5];
    mapper = (header[6] >> 4) | (header[7] & 0xf0) | ((header[8] & 0x0f) << 8);
    fourScreen = Boolean(header[6] & 0x08);
  } else {
    prgBanks = header[4];
    chrBanks = header[5];
    mapper = (header[6] >> 4) | (header[7] & 0xf0);
    fourScreen = Boolean(header[6] & 0x08);
  }
  const trainer = Boolean(header[6] & 0x04);
  const battery = Boolean(header[6] & 0x02);
  const warnings = [];
  if (isNES2 && (header[8] & 0x0f) !== 0) warnings.push('NES 2.0: расширенный номер маппера.');
  const offset = 16 + (trainer ? 512 : 0);
  const prgSize = prgBanks * 16384;
  const chrSize = chrBanks * 8192;
  const expected = offset + prgSize + chrSize;
  if (prgSize === 0) throw new RomError('prg', 'В ROM нет программы (PRG): такой файл не запустить.');
  if (bytes.length < expected) {
    throw new RomError('truncated', `Файл обрезан: ожидалось ${expected} байт, пришло ${bytes.length}.`);
  }
  if (bytes.length > expected + 64) warnings.push(`В файле ${bytes.length - expected} лишних байт.`);
  const prg = bytes.subarray(offset, offset + prgSize);
  const chr = bytes.subarray(offset + prgSize, offset + prgSize + chrSize);
  const mirroring = fourScreen ? 'four' : (header[6] & 0x01) ? 'vertical' : 'horizontal';
  const supportedMappers = [0, 3, 148];
  let supported = supportedMappers.includes(mapper);
  let reason = null;
  if (!supported) {
    reason = `Маппер ${mapper} пока не поддерживается: нужен небанкованный дамп (0, 3 или 148).`;
  } else if (mapper === 148 && prgBanks > 2) {
    supported = false;
    reason = 'Дамп с переключением PRG-банков пока не поддерживается: нужен 32-КиБ PRG.';
  } else if (mapper === 3 && chrBanks === 0) {
    supported = false;
    reason = 'В дампе нет CHR-данных (только CHR RAM) — пока не поддерживается.';
  } else if (mapper === 0 && chrBanks === 0) {
    // NROM с CHR RAM технически возможен, но для Тетриса не встречается.
    supported = true;
    warnings.push('NROM с CHR RAM: графика будет пустой.');
  }
  return {
    format: isNES2 ? 'NES2.0' : 'iNES',
    fileSize: bytes.length,
    mapper,
    mirroring,
    prg,
    chr,
    prgSize,
    chrSize,
    prgBanks,
    chrBanks,
    battery,
    trainer,
    hasChrRam: chrSize === 0,
    supported,
    reason,
    header: Uint8Array.from(header),
    warnings,
  };
}
