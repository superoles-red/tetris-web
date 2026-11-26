// Запись эталонного аудио в WAV (PCM16 stereo). Только dev-инструменты:
// файлы пишутся в /tmp и в репозиторий не попадают.

import { writeFile } from 'node:fs/promises';

export const WAV_BITS = 16;
export const WAV_CHANNELS = 2;

function clamp16(sample) {
  const value = Math.max(-1, Math.min(1, Number(sample) || 0));
  return Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
}

/**
 * Кодирует стерео-сэмплы в WAV-буфер.
 * @param {{sampleRate:number, left:ArrayLike<number>, right:ArrayLike<number>}} audio
 * @returns {Buffer}
 */
export function encodeWav({ sampleRate = 48000, left, right }) {
  const count = Math.min(left.length, right.length);
  const dataSize = count * WAV_CHANNELS * (WAV_BITS / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // размер fmt-чанка
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(WAV_CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * WAV_CHANNELS * (WAV_BITS / 8), 28); // byte rate
  buffer.writeUInt16LE(WAV_CHANNELS * (WAV_BITS / 8), 32); // block align
  buffer.writeUInt16LE(WAV_BITS, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (let i = 0; i < count; i++) {
    buffer.writeInt16LE(clamp16(left[i]), offset);
    buffer.writeInt16LE(clamp16(right[i]), offset + 2);
    offset += 4;
  }
  return buffer;
}

/**
 * Пишет WAV на диск (обычно в /tmp).
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function writeWav(path, audio) {
  const buffer = encodeWav(audio);
  await writeFile(path, buffer);
  return { path, bytes: buffer.length };
}

/** Размер WAV по числу сэмплов — для отчётов/проверок. */
export function wavBytesFor(sampleCount) {
  return 44 + sampleCount * WAV_CHANNELS * (WAV_BITS / 8);
}
