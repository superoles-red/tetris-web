#!/usr/bin/env node
// Собирает статический сайт для GitHub Pages: только публичная оболочка.
// Игровые данные и dev-инструменты в артефакт не попадают.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outIndex = process.argv.indexOf('--output');
const out = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join(root, '_site'));

// Публичная часть: оболочка (корневые html/css/js/иконки), src/, assets/, data/,
// лицензии. Dev-инструменты, тесты, node_modules и настройки в артефакт не идут.
const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'src', 'assets', 'data', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const SKIP = new Set(['node_modules', '.git', 'tools', 'tests', 'docs', '_site']);

async function copyRecursive(from, to) {
  const info = await stat(from);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) await copyRecursive(join(from, name), join(to, name));
  } else {
    await cp(from, to);
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const entry of PUBLIC) {
  try {
    await copyRecursive(join(root, entry), join(out, entry));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
// Корневые файлы оболочки (app.js, compositor.js, стили и т.д.): копируем всё,
// что лежит в корне и имеет расширение публичной статики.
const ROOT_STATIC = /\.(html|css|js|webmanifest|png|svg|ico|txt)$/i;
for (const name of await readdir(root)) {
  if (SKIP.has(name) || name.startsWith('.') || name !== 'index.html' && !ROOT_STATIC.test(name)) continue;
  if (PUBLIC.includes(name)) continue;
  await cp(join(root, name), join(out, name));
}
// Проверка целостности: локальные ссылки из index.html должны существовать.
{
  const html = await readFile(join(out, 'index.html'), 'utf8');
  const missing = [];
  for (const match of html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) {
    const target = match[1].split('?')[0];
    try { await stat(join(out, target)); } catch { missing.push(target); }
  }
  if (missing.length) {
    console.error('Отказ: в артефакте нет файлов, на которые ссылается index.html:', [...new Set(missing)].join(', '));
    process.exit(1);
  }
}

// Запрет на игровые данные в артефакте: никаких .nes/.zip.
const offenders = [];
async function scan(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) await scan(path);
    else if (/\.(nes|zip)$/i.test(name)) offenders.push(relative(out, path));
  }
}
await scan(out);
if (offenders.length) {
  console.error('Отказ: в артефакте игровые данные:', offenders.join(', '));
  process.exit(1);
}
// Версия кэша SW = хэш публичного содержимого.
const hash = createHash('sha256');
async function digest(dir) {
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) await digest(path);
    else hash.update(relative(out, path)).update(await readFile(path));
  }
}
await digest(out);
const version = hash.digest('hex').slice(0, 12);
const swPath = join(out, 'sw.js');
try {
  const sw = await readFile(swPath, 'utf8');
  await writeFile(swPath, sw.replaceAll('__BUILD_VERSION__', version));
} catch {}
// служебный маркер
await writeFile(join(out, 'BUILD'), version + '\n');
console.log('site →', out, 'версия', version);
