// Мини-распаковщик ZIP без внешних зависимостей: достаём .nes из архива.
// Поддерживаются stored (0) и deflate (8) через DecompressionStream.

export function looksLikeZip(bytes) {
  return Boolean(bytes) && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('ZIP: браузер не умеет распаковывать (нет DecompressionStream)');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Возвращает [{ name, bytes }] для всех .nes в архиве. */
export async function extractNesFromZip(bytes) {
  if (!looksLikeZip(bytes)) throw new Error('ZIP: неверная сигнатура');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: не найден каталог');
  const count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);
  const entries = [];
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (u32(view, offset) !== 0x02014b50) break;
    const method = u16(view, offset + 10);
    const compressed = u32(view, offset + 20);
    const uncompressed = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.nes$/i.test(name) || uncompressed === 0 || uncompressed > 16 * 1024 * 1024) continue;
    if (u32(view, localOffset) !== 0x04034b50) continue;
    const localName = u16(view, localOffset + 26);
    const localExtra = u16(view, localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const packed = bytes.subarray(start, start + compressed);
    let data;
    if (method === 0) data = packed;
    else if (method === 8) data = await inflateRaw(packed);
    else continue;
    if (data.length !== uncompressed) continue;
    entries.push({ name, bytes: data });
  }
  return entries;
}
