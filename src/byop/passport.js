// «Паспорт дампа»: что за ROM принёс игрок и что ему доступно.
// Каталог известных дампов — data/dumps.json (только имена, SHA-256 и
// метаданные; самих ROM-файлов в репозитории нет). Ошибки описываем кодом,
// а человеческий текст берёт UI из locale.js — так всё сразу на RU и EN.

import { parseRom, sha256Hex, RomError } from '../nes/rom.js';
import { formatText } from '../../locale.js';

export const MODE_FULL = 'full';
export const MODE_COMPATIBLE = 'compatible';

/** Больше этого NES-ROM не бывает; защита от случайного «не того файла». */
export const MAX_ROM_SIZE = 16 * 1024 * 1024;

const CATALOG_URL = new URL('../../data/dumps.json', import.meta.url);
const SUPPORTED_MAPPERS_TEXT = '0, 3, 148';

/** Ошибка загрузки/разбора каталога дампов. */
export class PassportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassportError';
    this.code = code;
  }
}

let catalogPromise = null;

/**
 * Загружает data/dumps.json (один раз, с повтором при ошибке).
 * @returns {Promise<{dumps: Array<object>, updated: string|null}>}
 */
export function loadDumpCatalog({ reload = false } = {}) {
  if (catalogPromise && !reload) return catalogPromise;
  catalogPromise = (async () => {
    let response;
    try {
      response = await fetch(CATALOG_URL);
    } catch (error) {
      throw new PassportError('catalog', `catalog fetch failed: ${error?.message ?? error}`);
    }
    if (!response.ok) throw new PassportError('catalog', `catalog HTTP ${response.status}`);
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new PassportError('catalog', `catalog JSON invalid: ${error?.message ?? error}`);
    }
    const dumps = Array.isArray(data?.dumps) ? data.dumps.filter(validDump) : [];
    return { dumps, updated: typeof data?.updated === 'string' ? data.updated : null };
  })();
  catalogPromise.catch(() => { catalogPromise = null; });
  return catalogPromise;
}

function validDump(entry) {
  return entry && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256) &&
    typeof entry.name === 'string';
}

/** Ищет дамп по SHA-256 (регистр не важен). */
export function findDump(catalog, sha256) {
  if (!catalog?.dumps || !sha256) return null;
  const needle = String(sha256).toLowerCase();
  return catalog.dumps.find(dump => dump.sha256.toLowerCase() === needle) ?? null;
}

/** Проверка файла до чтения байтов (имя/размер). NULL — файл выглядит разумно. */
export function checkRomFileMeta(fileName, size) {
  if (!Number.isFinite(size) || size <= 0) return refusal('empty');
  if (size > MAX_ROM_SIZE) return refusal('too-large');
  if (fileName && !/\.nes$/i.test(fileName)) {
    // Не отказ: некоторые браузеры/файловые менеджеры теряют расширение,
    // решает содержимое. Просто подсказываем в подробностях.
    return null;
  }
  return null;
}

function refusal(code, params = {}, detail = null) {
  return { ok: false, code, params, detail };
}

function parseRefusal(error) {
  if (error instanceof RomError) {
    switch (error.code) {
      case 'type': return refusal('type', {}, error.message);
      case 'short': return refusal('short', {}, error.message);
      case 'magic': return refusal('magic', {}, error.message);
      case 'prg': return refusal('prg', {}, error.message);
      case 'truncated': return refusal('truncated', {}, error.message);
      default: return refusal('unknown', {}, error.message);
    }
  }
  return refusal('unknown', {}, error?.message ?? String(error ?? ''));
}

/** Разбор причины отказа: маппер, PRG-банки или отсутствие CHR. */
function unsupportedRefusal(parsed) {
  const mappers = SUPPORTED_MAPPERS_TEXT.split(', ').map(Number);
  if (!mappers.includes(parsed.mapper)) {
    return refusal('unsupported-mapper', { mapper: parsed.mapper });
  }
  if (parsed.mapper === 148 && parsed.prgBanks > 2) return refusal('unsupported-prg');
  return refusal('unsupported-chr');
}

/**
 * Полная проверка файла игрока: размер → iNES → SHA-256 → паспорт.
 * @param {{fileName?: string, bytes: Uint8Array, catalog?: object|null}} input
 * @returns {Promise<{ok: true, sha256: string, passport: object} | {ok: false, code: string, params?: object, detail?: string|null}>}
 */
export async function inspectRomFile({ fileName = '', bytes, catalog = null } = {}) {
  if (!(bytes instanceof Uint8Array)) return refusal('read');
  const meta = checkRomFileMeta(fileName, bytes.byteLength);
  if (meta) return meta;

  let parsed;
  try {
    parsed = parseRom(bytes);
  } catch (error) {
    return parseRefusal(error);
  }

  let sha256;
  try {
    sha256 = await sha256Hex(bytes);
  } catch (error) {
    return refusal('read', {}, error?.message ?? String(error));
  }

  if (!parsed.supported) return unsupportedRefusal(parsed);

  const known = findDump(catalog, sha256);
  const passport = buildPassport({ parsed, sha256, known, fileName, fileSize: bytes.byteLength });
  return { ok: true, sha256, passport, parsed };
}

/**
 * Собирает паспорт дампа. Чистая функция: каталог уже загружен вызывающим.
 */
export function buildPassport({ parsed, sha256, known = null, fileName = '', fileSize = 0 }) {
  const mode = known?.full === true ? MODE_FULL : MODE_COMPATIBLE;
  return {
    version: 1,
    sha256,
    mode,
    catalogMatched: Boolean(known),
    name: known?.name ?? fileName ?? '',
    fileName: fileName ?? '',
    fileSize: fileSize || parsed?.fileSize || 0,
    region: known?.region ?? null,
    language: known?.language === 'ru' ? 'ru' : 'en',
    mapper: parsed?.mapper ?? null,
    mirroring: parsed?.mirroring ?? null,
    prgSize: parsed?.prgSize ?? 0,
    chrSize: parsed?.chrSize ?? 0,
    prgBanks: parsed?.prgBanks ?? 0,
    chrBanks: parsed?.chrBanks ?? 0,
    format: parsed?.format ?? null,
    features: Array.isArray(known?.features) ? [...known.features] : [],
    warnings: Array.isArray(parsed?.warnings) ? [...parsed.warnings] : []
  };
}

/** Ключ текста для режима. */
export function modeTextKey(mode) {
  return mode === MODE_FULL ? 'modeFullExplain' : 'modeCompatExplain';
}

/** Строка размера, локализованная через t (translations текущего языка). */
export function formatBytes(bytes, t) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 ' + t.unitBytes;
  if (bytes >= 1024 * 1024) {
    const value = bytes / (1024 * 1024);
    return (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + t.unitMB;
  }
  if (bytes >= 1024) {
    const value = bytes / 1024;
    return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + t.unitKB;
  }
  return bytes + ' ' + t.unitBytes;
}

/** SHA-256 в коротком виде для паспорта: первые 16 символов. */
export function shortSha(sha256) {
  return typeof sha256 === 'string' ? sha256.slice(0, 16) : '';
}

/**
 * Строки паспорта для таблицы на карточке.
 * @returns {Array<[key: string, value: string, params?: object]>}
 */
export function passportRows(passport, t) {
  if (!passport) return [];
  const size = formatBytes(passport.fileSize, t);
  const rows = [
    ['passportFile', passport.fileName || passport.name],
    ['passportSize', size],
    ['passportCatalog', passport.catalogMatched ? passport.name : t.passportNotListed],
    ['passportMapper', String(passport.mapper ?? '—')],
    ['passportPrg', formatBytes(passport.prgSize, t)],
    ['passportChr', formatBytes(passport.chrSize, t)]
  ];
  if (passport.region) rows.push(['passportRegion', passport.region]);
  rows.push(['passportLanguage', passport.language === 'ru' ? t.langRussian : t.langEnglish]);
  if (passport.mirroring) {
    const key = { vertical: 'mirroringVertical', horizontal: 'mirroringHorizontal', four: 'mirroringFour' }[passport.mirroring];
    if (key) rows.push(['passportMirroring', t[key]]);
  }
  rows.push(['passportMode', passport.mode === MODE_FULL ? t.passportModeFull : t.passportModeCompatible]);
  rows.push(['passportSha', shortSha(passport.sha256) + '…']);
  return rows;
}

/**
 * Человеческий текст отказа по коду. UI передаёт translations текущего языка.
 * @param {{code: string, params?: object}} result
 * @param {object} t
 */
export function refusalText(result, t) {
  const key = {
    type: 'errRead',
    read: 'errRead',
    short: 'errShort',
    magic: 'errNotNes',
    prg: 'errNoPrg',
    truncated: 'errTruncated',
    empty: 'errEmpty',
    'too-large': 'errTooLarge',
    'unsupported-mapper': 'errUnsupportedMapper',
    'unsupported-prg': 'errUnsupportedPrg',
    'unsupported-chr': 'errUnsupportedChr',
    unsupported: 'errUnsupportedMapper',
    unknown: 'errUnknown'
  }[result?.code] ?? 'errUnknown';
  const params = { ...(result?.params ?? {}) };
  if (params.mapper === undefined) params.mapper = '?';
  return formatText(t[key] ?? t.errUnknown, params);
}

/** Ожидаемый хвост: поддерживается ли маппер (для текста подсказки). */
export function supportedMappersLabel() {
  return SUPPORTED_MAPPERS_TEXT;
}
