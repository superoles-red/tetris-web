// Установка PWA и офлайн-оболочка. ROM в service worker не попадает:
// он живёт в IndexedDB (src/byop/store.js), SW кэширует только наш код.
//
// Шаг 2 карточки вызывает prompt() — это должно происходить внутри
// пользовательского жеста (как и нативный beforeinstallprompt).

const SW_URL = new URL('./sw.js', import.meta.url);

const standaloneQuery = typeof matchMedia === 'function'
  ? matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)')
  : null;

/**
 * @param {{onStateChange?: (state: object) => void, canReload?: () => boolean}} options
 */
export function initInstall({ onStateChange = () => {}, canReload = () => true } = {}) {
  let deferredPrompt = null;
  let installed = false;
  let offline = 'saving';
  let registration = null;
  let updateReady = false;
  let reloading = false;

  const standalone = () => Boolean(installed || standaloneQuery?.matches || navigator.standalone === true);

  const state = {
    get installed() { return installed; },
    get standalone() { return standalone(); },
    get promptAvailable() { return Boolean(deferredPrompt) && !standalone(); },
    get eligible() { return Boolean(window.isSecureContext && 'serviceWorker' in navigator); },
    get offline() { return offline; },
    get updateReady() { return updateReady; },
    get canPrompt() { return Boolean(deferredPrompt); }
  };

  function notify() {
    try { onStateChange(state); } catch (error) { console.warn('install state handler failed', error); }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installed = false;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    notify();
  });
  standaloneQuery?.addEventListener?.('change', notify);

  // --- service worker: только оболочка --------------------------------------
  function prepareOffline() {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
      offline = 'failed';
      notify();
      return;
    }
    navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' }).then((reg) => {
      registration = reg;
      const watch = () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          // Офлайн-оболочка готова, когда воркер активировался.
          if (worker.state === 'activated') {
            offline = 'ready';
            notify();
          } else if (worker.state === 'redundant') {
            offline = 'failed';
            notify();
          }
        });
      };
      watch();
      reg.addEventListener('updatefound', watch);
      navigator.serviceWorker.ready.then(() => {
        offline = 'ready';
        // Первый запуск: воркер уже контролирует страницу.
        notify();
      }).catch(() => {
        offline = 'failed';
        notify();
      });
      checkForUpdate();
      window.addEventListener('online', checkForUpdate);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForUpdate();
      });
    }).catch(() => {
      offline = 'failed';
      notify();
    });
  }

  function checkForUpdate() {
    if (!registration || !navigator.onLine || document.hidden) return;
    registration.update().catch(() => {});
  }

  navigator.serviceWorker?.addEventListener?.('controllerchange', () => {
    // Новая версия оболочки вступила в силу. Если игрок в меню и мы ещё
    // не перезагружались — обновляем страницу, чтобы показать свежий UI.
    if (reloading || !canReload()) {
      updateReady = true;
      notify();
      return;
    }
    reloading = true;
    updateReady = true;
    notify();
    try { location.reload(); } catch { /* окно уже закрывается */ }
  });

  // --- нативная установка ---------------------------------------------------
  async function prompt() {
    if (standalone()) {
      installed = true;
      notify();
      return 'installed';
    }
    if (!deferredPrompt) return 'unavailable';
    const request = deferredPrompt;
    deferredPrompt = null;
    try {
      // .prompt() вызываем синхронно в обработчике жеста.
      const promptResult = request.prompt();
      notify();
      const choice = (await promptResult) || await request.userChoice;
      if (choice?.outcome === 'accepted') {
        installed = true;
        notify();
        return 'accepted';
      }
      return 'dismissed';
    } catch {
      return 'error';
    }
  }

  /** Подсказка для платформ без beforeinstallprompt (iOS/Safari/Firefox). */
  function platformHint() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/SamsungBrowser/i.test(ua)) return 'samsung';
    if (/Android/i.test(ua)) return 'chrome';
    if (/Macintosh.*Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) return 'safari';
    return 'desktop';
  }

  prepareOffline();
  notify();

  // Возвращаем объект с живыми getter'ами, а не копию значений.
  Object.assign(state, {
    prompt,
    platformHint,
    checkReady: prepareOffline,
    /** Сбросить кэш обновления, если игрок сам согласился. */
    applyUpdate() {
      if (registration?.waiting) registration.waiting.postMessage({ type: 'skip-waiting' });
    }
  });
  return state;
}
