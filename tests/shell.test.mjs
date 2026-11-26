// Статический smoke-тест оболочки: без браузера и без игровых ROM.
// Проверяет, что index.html содержит все id, которые ищет app.js, что локали
// RU/EN совпадают по набору ключей, что ассеты на месте и что в репозитории
// нет игровых данных/производной графики.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFile(join(root, name), 'utf8');
const SKIP_DIRS = new Set(['node_modules', '.git', '_site']);

async function walk(relativePath = '.') {
  const directory = join(root, relativePath);
  const entries = await readdir(directory);
  const files = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = relativePath === '.' ? name : join(relativePath, name);
    const info = await stat(join(root, rel));
    if (info.isDirectory()) files.push(...await walk(rel));
    else files.push(rel.split(sep).join('/'));
  }
  return files;
}

function extractIds(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
}

function referencedIds(source) {
  const ids = new Set();
  for (const match of source.matchAll(/(?:byId|getElementById)\(\s*['"]([\w-]+)['"]\s*\)/g)) ids.add(match[1]);
  for (const match of source.matchAll(/querySelector\(\s*['"]#([\w-]+)['"]\s*\)/g)) ids.add(match[1]);
  return ids;
}

function pngSize(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, 'PNG signature');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

let html;
let app;
let files;
test.before(async () => {
  html = await read('index.html');
  app = await read('app.js');
  files = await walk();
});

test('index.html содержит все id, на которые ссылается app.js', () => {
  const ids = extractIds(html);
  const used = referencedIds(app);
  assert.ok(used.size > 20, `найдено слишком мало ссылок на id: ${used.size}`);
  const missing = [...used].filter(id => !ids.has(id)).sort();
  assert.deepEqual(missing, [], `app.js ссылается на отсутствующие id: ${missing.join(', ')}`);
});

test('index.html подключает оболочку и PWA-манифест', () => {
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon"[^>]*href="\.\/assets\/icons\/apple-touch\.png"/);
  assert.match(html, /<meta name="theme-color"/);
  const ids = extractIds(html);
  for (const required of ['rom-file', 'step-rom', 'step-install', 'passport', 'home-menu', 'settings-menu', 'picture']) {
    assert.ok(ids.has(required), `нет обязательного id="${required}"`);
  }
});

test('все data-i18n ключи существуют в обеих локалях', async () => {
  const { translations } = await import('../locale.js');
  const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]));
  assert.ok(keys.size > 20, 'в index.html слишком мало data-i18n');
  for (const language of ['en', 'ru']) {
    for (const key of keys) {
      assert.equal(typeof translations[language][key], 'string', `нет ключа ${language}.${key}`);
    }
  }
});

test('локали RU/EN имеют одинаковый набор ключей и непустые строки', async () => {
  const { translations, preferredLanguage } = await import('../locale.js');
  const en = Object.keys(translations.en).sort();
  const ru = Object.keys(translations.ru).sort();
  assert.deepEqual(ru, en, 'наборы ключей RU и EN различаются');
  for (const language of ['en', 'ru']) {
    for (const [key, value] of Object.entries(translations[language])) {
      assert.equal(typeof value, 'string', `${language}.${key} должен быть строкой`);
      assert.ok(value.length > 0, `${language}.${key} пустой`);
    }
  }
  assert.ok(['en', 'ru'].includes(preferredLanguage()));
});

test('в репозитории нет игровых данных и производной графики/звука', async () => {
  const forbidden = [
    /\.nes$/i, /\.zip$/i, /\.flac$/i, /\.wav$/i,
    /\.(?:ttf|otf|woff2?)$/i,
    /(^|\/)screenshots?\//i,
    /(^|\/)assets\/music\//i,
    /(^|\/)assets\/(?:title|well|block|frame|arrow)[^/]*\.(?:png|gif|webp|jpg)$/i
  ];
  const offenders = [];
  for (const file of files) {
    const base = file.split('/').pop();
    if (forbidden.some(pattern => pattern.test(file))) { offenders.push(file); continue; }
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(base) && !file.startsWith('assets/icons/')) {
      offenders.push(file + ' (растровый ассет вне assets/icons)');
    }
  }
  assert.deepEqual(offenders, [], `в репозитории недопустимые файлы: ${offenders.join(', ')}`);

  const shellFiles = ['index.html', 'app.js', 'style.css', 'controls.css', 'install.css', 'sw.js', 'manifest.webmanifest', 'locale.js', 'compositor.js'];
  for (const file of shellFiles) {
    const text = await read(file);
    assert.doesNotMatch(text, /game(?:-ru)?\.nes/i, `${file} ссылается на game.nes`);
    assert.doesNotMatch(text, /assets\/(?:title|well|block|frame|arrow)[^"')]*\.png/i, `${file} ссылается на вырезанную из ROM графику`);
    assert.doesNotMatch(text, /assets\/(?:music|tengen\.ttf)/i, `${file} ссылается на музыку/шрифт игры`);
  }
});

test('CSS не тянет внешних и несуществующих файлов', async () => {
  for (const file of ['style.css', 'controls.css', 'install.css']) {
    const text = await read(file);
    const urls = [...text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(match => match[2].trim());
    for (const url of urls) {
      if (url.startsWith('data:') || url.startsWith('#')) continue;
      const path = join(root, url.replace(/^\.\//, ''));
      assert.ok(existsSync(path), `${file}: не найден url(${url})`);
    }
    assert.doesNotMatch(text, /@font-face/i, `${file}: в CSS не должно быть шрифта из ROM`);
  }
});

test('manifest и sw.js ссылаются на существующие ассеты', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'нужны иконки 192/512/maskable');
  const expected = new Map([
    ['assets/icons/icon-192.png', 192],
    ['assets/icons/icon-512.png', 512],
    ['assets/icons/maskable.png', 512]
  ]);
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(root, icon.src)), `manifest: нет файла ${icon.src}`);
    const size = pngSize(await readFile(join(root, icon.src)));
    const wanted = expected.get(icon.src);
    assert.equal(size.width, wanted, `${icon.src}: ширина`);
    assert.equal(size.height, wanted, `${icon.src}: высота`);
  }
  const apple = pngSize(await readFile(join(root, 'assets/icons/apple-touch.png')));
  assert.deepEqual({ width: apple.width, height: apple.height }, { width: 180, height: 180 });

  const sw = await read('sw.js');
  assert.ok(sw.includes('__BUILD_VERSION__'), 'sw.js должен содержать метку __BUILD_VERSION__');
  assert.doesNotMatch(sw, /\.(?:nes|zip)\b/i, 'sw.js не должен кэшировать ROM');
  const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellMatch, 'в sw.js должен быть список SHELL');
  const shellFiles = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(shellFiles.length >= 10, 'список SHELL слишком короткий');
  for (const path of shellFiles) {
    if (path === './') continue;
    assert.ok(existsSync(join(root, path)), `sw.js SHELL: нет файла ${path}`);
  }
  assert.ok(shellFiles.includes('index.html'));
  assert.ok(shellFiles.includes('app.js'));
});

test('app.js импортирует только существующие локальные модули', async () => {
  const specs = [...app.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specs.length >= 8, 'слишком мало импортов в app.js');
  const missing = [];
  for (const spec of specs) {
    if (spec === './src/nes/engine.js') continue; // зона движка, может появиться позже
    if (!existsSync(join(root, spec))) missing.push(spec);
  }
  assert.deepEqual(missing, [], `нет модулей: ${missing.join(', ')}`);
  if (!existsSync(join(root, 'src/nes/engine.js'))) {
    test.diagnostic?.('src/nes/engine.js ещё не готов — страница заработает после интеграции движка');
  }
});

test('нет незакоммиченных игровых ассетов в assets/', async () => {
  const entries = await readdir(join(root, 'assets'));
  assert.deepEqual(entries.sort(), ['icons'], 'в assets/ допустимы только наши иконки');
  const icons = (await readdir(join(root, 'assets/icons'))).sort();
  for (const icon of icons) {
    assert.match(icon, /^(?:icon-(?:192|512)|maskable|apple-touch)\.png$/, `лишняя иконка: ${icon}`);
  }
});

test('сборка сайта собирается и в артефакте нет .nes/.zip', async () => {
  const output = await mkdtemp(join(tmpdir(), 'tetris-web-site-'));
  try {
    await run(process.execPath, ['tools/build-site.mjs', '--output', output], { cwd: root });
    const buildVersion = (await readFile(join(output, 'BUILD'), 'utf8')).trim();
    assert.match(buildVersion, /^[0-9a-f]{12}$/, 'BUILD должен содержать версию сборки');
    const builtSw = await readFile(join(output, 'sw.js'), 'utf8');
    assert.ok(!builtSw.includes('__BUILD_VERSION__'), 'версия в sw.js не подставлена');
    assert.ok(builtSw.includes(buildVersion), 'sw.js не получил версию сборки');
    assert.ok(existsSync(join(output, 'index.html')), 'в артефакте нет index.html');
    assert.ok(existsSync(join(output, 'data/dumps.json')), 'в артефакте нет каталога дампов');
    assert.ok(existsSync(join(output, 'assets/icons/icon-192.png')), 'в артефакте нет иконок');

    const artifacts = [];
    async function scan(directory) {
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        if ((await stat(path)).isDirectory()) await scan(path);
        else artifacts.push(relative(output, path).split(sep).join('/'));
      }
    }
    await scan(output);
    const offenders = artifacts.filter(file => /\.(?:nes|zip)$/i.test(file));
    assert.deepEqual(offenders, [], `в сборке игровые данные: ${offenders.join(', ')}`);
    // Никакой производной графики/звука в артефакте.
    const media = artifacts.filter(file => /\.(?:flac|wav|ttf)$/i.test(file));
    assert.deepEqual(media, [], `в сборке производные ассеты: ${media.join(', ')}`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('tools/make-icons.mjs существует и не требует внешних зависимостей', async () => {
  const source = await read('tools/make-icons.mjs');
  assert.match(source, /node:zlib/);
  assert.doesNotMatch(source, /from ['"](?!node:)/, 'иконки должны рисоваться без npm-зависимостей');
  for (const icon of ['icon-192.png', 'icon-512.png', 'maskable.png', 'apple-touch.png']) {
    assert.ok(existsSync(join(root, 'assets/icons', icon)), `нет ${icon}`);
  }
  assert.equal(extname('icon-192.png'), '.png');
  assert.ok(root.length > 0);
});
