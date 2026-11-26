// Service worker оболочки BYOP. Кэширует ТОЛЬКО наш код и наши ассеты.
// ROM игрока в service worker не попадает: он живёт в IndexedDB.
// Версию подставляет tools/build-site.mjs вместо __BUILD_VERSION__.
const BUILD = '__BUILD_VERSION__';
const CACHE_PREFIX = 'tetris-web-shell:';
const CACHE = CACHE_PREFIX + BUILD;
const scope = new URL('./', self.location).href;

// Ядро оболочки (без src/nes/engine.js и его зависимостей: они подхватятся
// runtime-кэшем при первой загрузке, даже если движок добавили позже).
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app.js',
  'locale.js',
  'install.js',
  'compositor.js',
  'controls.js',
  'controls.css',
  'install.css',
  'rankings.js',
  'saved-run.js',
  'viewport.js',
  'style.css',
  'src/nes/rom.js',
  'src/nes/constants.js',
  'src/nes/mapper.js',
  'src/byop/store.js',
  'src/byop/passport.js',
  'src/byop/full-mode.js',
  'src/byop/menu-checkpoint.js',
  'src/byop/cover.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable.png',
  'assets/icons/apple-touch.png'
];

const SHELL_EXTENSIONS = /\.(?:html|js|mjs|css|json|webmanifest|png|svg|woff2?|ttf|wasm)$/i;
const GAME_DATA = /\.(?:nes|zip|flac|wav)$/i;

function shellUrl(path) {
  return new URL(path, scope).href;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Пофайлово: отсутствующий необязательный файл не ломает установку.
    await Promise.allSettled(SHELL.map((path) => cache.add(new Request(shellUrl(path), { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Свежий документ кладём как новую оболочку для офлайн-запуска.
      cache.put(shellUrl('index.html'), response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(shellUrl('index.html')) || await cache.match(shellUrl('./'));
    if (cached) return cached;
    throw new Error('offline and no shell cached');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  if (cached) {
    // Обновление в фоне, игроку сразу отдаём закэшированное.
    return cached;
  }
  const response = await network;
  if (response) return response;
  return new Response('offline', { status: 503, statusText: 'offline' });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(scope)) return;
  // ROM/архивы/записи звука не кэшируем и не отдаём из кэша.
  if (GAME_DATA.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (!SHELL_EXTENSIONS.test(url.pathname) && url.pathname !== new URL(scope).pathname) return;
  event.respondWith(staleWhileRevalidate(request));
});
