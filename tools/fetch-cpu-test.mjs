#!/usr/bin/env node
// Скачивание публичного 6502-теста Klaus Dormann (GPL-3.0) с пином SHA-256.
// ROM-файл в репозиторий НЕ коммитится (tools/.cache/ в .gitignore);
// в CI скачивается заново по пину.
//
// Источник: https://github.com/Klaus2m5/6502_65C02_functional_tests
// Файл:    bin_files/6502_functional_test.bin (64 КиБ образ, код с $0400,
//          адрес успеха $3469, векторы в $FFFA).
//
// CLI:
//   node tools/fetch-cpu-test.mjs            # скачать/проверить в tools/.cache/
//   node tools/fetch-cpu-test.mjs --force    # скачать заново
//   node tools/fetch-cpu-test.mjs --out /tmp/test.bin
//
// API:
//   import { fetchCpuTest, readCachedCpuTest, CPU_TEST_SHA256 } from './tools/fetch-cpu-test.mjs';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './reference/hashing.mjs';
import { isMain, parseArgs, formatError } from './reference/cli.mjs';

export const CPU_TEST_URL =
  'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin';
/** Пин SHA-256 скачанного файла (65536 байт). */
export const CPU_TEST_SHA256 = 'fa12bfc761e6f9057e4cc01a665a7b800ff01ae91f598af1e39a1201d01953fd';
export const CPU_TEST_SIZE = 65536;

/** Путь кэша по умолчанию: tools/.cache/6502_functional_test.bin. */
export const CPU_TEST_CACHE_PATH = fileURLToPath(
  new URL('./.cache/6502_functional_test.bin', import.meta.url),
);

function verify(bytes) {
  if (bytes.length !== CPU_TEST_SIZE) {
    throw new Error(`Размер CPU-теста ${bytes.length} байт, ожидался ${CPU_TEST_SIZE}.`);
  }
  const digest = sha256Hex(bytes);
  if (digest !== CPU_TEST_SHA256) {
    throw new Error(
      `SHA-256 CPU-теста не совпал с пином: ${digest} (ожидался ${CPU_TEST_SHA256}). ` +
        'Файл обновился в апстриме? Обновите пин и протестируйте обёртку в tests/cpu-conformance.mjs.',
    );
  }
  return digest;
}

/**
 * Скачивает тест (или берёт из кэша) и проверяет пин SHA-256.
 * @param {{outPath?: string, force?: boolean, log?: (message: string) => void}} [options]
 * @returns {Promise<{path: string, bytes: number, sha256: string, fromCache: boolean}>}
 */
export async function fetchCpuTest(options = {}) {
  const outPath = resolve(options.outPath ?? CPU_TEST_CACHE_PATH);
  const log = options.log ?? (() => {});
  if (!options.force) {
    try {
      const cached = new Uint8Array(await readFile(outPath));
      const digest = verify(cached);
      log(`CPU-тест уже в кэше: ${outPath} (sha256 ${digest.slice(0, 16)}…)`);
      return { path: outPath, bytes: cached.length, sha256: digest, fromCache: true };
    } catch (error) {
      if (error.code !== 'ENOENT' && !/Размер CPU-теста/.test(error.message)) throw error;
      if (error.code !== 'ENOENT') log(`Кэш ${outPath} не прошёл проверку: ${error.message}. Скачиваю заново.`);
    }
  }

  log(`Скачиваю ${CPU_TEST_URL}`);
  let response;
  try {
    response = await fetch(CPU_TEST_URL, { redirect: 'follow' });
  } catch (error) {
    throw new Error(
      `Не удалось скачать CPU-тест (${CPU_TEST_URL}): ${error.message}. ` +
        'Проверьте сеть; в оффлайне используйте заранее скачанный файл через --out/кэш.',
    );
  }
  if (!response.ok) {
    throw new Error(
      `Не удалось скачать CPU-тест: HTTP ${response.status} ${response.statusText} (${CPU_TEST_URL}).`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = verify(bytes);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);
  log(`Сохранено: ${outPath} (${bytes.length} байт, sha256 ${digest.slice(0, 16)}…)`);
  return { path: outPath, bytes: bytes.length, sha256: digest, fromCache: false };
}

/**
 * Читает уже скачанный тест из кэша и проверяет пин.
 * @param {{cachePath?: string}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function readCachedCpuTest(options = {}) {
  const cachePath = options.cachePath ?? CPU_TEST_CACHE_PATH;
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(cachePath));
  } catch (error) {
    throw new Error(
      `CPU-тест не найден: ${cachePath}. Сначала выполните: node tools/fetch-cpu-test.mjs`,
    );
  }
  verify(bytes);
  return bytes;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(
      [
        'Скачивание CPU-теста Klaus Dormann с пином SHA-256 (dev/CI, без коммита).',
        'Использование: node tools/fetch-cpu-test.mjs [--force] [--out <path>] [--quiet]',
      ].join('\n'),
    );
    return;
  }
  try {
    const result = await fetchCpuTest({
      outPath: args.out ? String(args.out) : undefined,
      force: args.force === true,
      log: args.quiet === true ? () => {} : message => console.error(message),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Ошибка fetch-cpu-test: ${formatError(error)}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
