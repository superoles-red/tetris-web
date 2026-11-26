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

const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'src', 'assets', 'data'];
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
