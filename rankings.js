// Рекорды для полного режима (известный дамп). Таблица живёт в localStorage
// отдельно для каждого SHA-256 ROM: чужой ROM не должен делить рекорды.
// Имена хранятся строкой, как их ввели; в RAM картриджа кладутся коды букв
// из его собственного алфавита — таблицу инициалов рисует сам ROM.
const MAX_RECORDS = 15;
const scoreAddress = 0x043c;
const linesAddress = 0x0496;
const nameAddress = 0x04c3;
const alphabet = {
  // Порядок символов, который картридж использует в таблице инициалов.
  en: ' ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ru: ' АБВГДЕЖЁИЙКЛМНЪПРСТУФХШЭЮЯ'
};

export function recordsKey(sha256) {
  return 'tetris-web:records:' + (sha256 || 'default');
}

export function recordName(record) {
  if (typeof record.name === 'string') return record.name;
  if (Array.isArray(record.initials)) {
    const chars = alphabet[record.language] ?? alphabet.en;
    return record.initials.map(letter => chars[letter] ?? ' ').join('');
  }
  return '';
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function limitRecordName(value) {
  const characters = segmenter
    ? Array.from(segmenter.segment(value), part => part.segment)
    : Array.from(value);
  return characters.slice(0, 10).join('');
}

export function loadRecords(sha256) {
  try {
    const entries = JSON.parse(localStorage.getItem(recordsKey(sha256)));
    if (Array.isArray(entries)) return entries.filter(validRecord).slice(0, MAX_RECORDS);
  } catch { /* Некоторые браузеры блокируют localStorage. */ }
  return [];
}

function validResult(entry) {
  return entry && (entry.language === 'ru' || entry.language === 'en') &&
    Number.isInteger(entry.score) && entry.score >= 0 && entry.score <= 999999 &&
    Number.isInteger(entry.lines) && entry.lines >= 0 && entry.lines <= 999;
}

function validRecord(entry) {
  if (!validResult(entry)) return false;
  if (typeof entry.name === 'string') {
    return entry.name.trim().length > 0 && limitRecordName(entry.name) === entry.name;
  }
  return Array.isArray(entry.initials) && entry.initials.length === 3 &&
    entry.initials.every(letter => Number.isInteger(letter) && letter >= 0 && letter < 27);
}

export function addRecord(sha256, record, current) {
  const key = recordsKey(sha256);
  const latest = loadRecords(sha256);
  const previous = latest.length ? latest : current;
  const entries = [record, ...previous].sort((a, b) => b.score - a.score).slice(0, MAX_RECORDS);
  try { localStorage.setItem(key, JSON.stringify(entries)); } catch { /* место кончилось */ }
  return entries;
}

export function clearRecords(sha256) {
  try { localStorage.removeItem(recordsKey(sha256)); } catch { /* ничего */ }
}

function writeDigits(ram, address, value, width) {
  const digits = String(value).padStart(width, '0');
  for (let i = 0; i < width; i++) ram[address + i] = digits.charCodeAt(i);
}

/** Кладёт локальные рекорды в RAM картриджа перед его таблицей рекордов. */
export function seedRanking(nes, records) {
  const ram = nes.cpu.mem;
  const chars = alphabet[nes.cartridgeLanguage === 'ru' ? 'ru' : 'en'];
  for (let row = 0; row < MAX_RECORDS; row++) {
    const entry = records[row];
    writeDigits(ram, scoreAddress + row * 6, entry?.score ?? 0, 6);
    writeDigits(ram, linesAddress + row * 3, entry?.lines ?? 0, 3);
    const letters = Array.from(entry ? recordName(entry).toUpperCase() : '');
    for (let i = 0; i < 3; i++) {
      ram[nameAddress + row * 3 + i] = entry ? Math.max(0, chars.indexOf(letters[i] ?? ' ')) : 0;
    }
  }
}

/** Строка таблицы, которую картридж сейчас редактирует, или null. */
export function editingRecord(nes) {
  const ram = nes.cpu.mem;
  for (let offset = 0; offset < MAX_RECORDS * 3; offset++) {
    if (ram[nameAddress + offset] & 0xc0) return Math.floor(offset / 3);
  }
  return null;
}

export function readRankedResult(nes, row, language) {
  const ram = nes.cpu.mem;
  const digits = (start, count) => Number(String.fromCharCode(...ram.subarray(start, start + count)));
  const result = {
    language: language === 'ru' ? 'ru' : 'en',
    score: digits(scoreAddress + row * 6, 6),
    lines: digits(linesAddress + row * 3, 3)
  };
  return validResult(result) ? result : null;
}
