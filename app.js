// BYOP-оболочка: карточка игры → шаг 1 «Добавить ROM» → паспорт дампа →
// шаг 2 «Установить игру» → главное меню → игра. Движок (src/nes/engine.js)
// компилирует код из ROM игрока; здесь ни байта игровых данных.
import { Engine } from './src/nes/engine.js';
import { Compositor } from './compositor.js';
import { bindControls } from './controls.js';
import { initInstall } from './install.js';
import { translations, preferredLanguage, formatText } from './locale.js';
import { bindPhoneInsets } from './viewport.js';
import { openSavedRun, saveOnExit } from './saved-run.js';
import {
  loadRecords, addRecord, clearRecords, recordName, limitRecordName,
  seedRanking, editingRecord, readRankedResult, recordsKey
} from './rankings.js';
import { openStore } from './src/byop/store.js';
import {
  loadDumpCatalog, inspectRomFile, checkRomFileMeta, refusalText,
  formatBytes, modeTextKey, MODE_FULL
} from './src/byop/passport.js';
import {
  readScene, enteringInitials, gameOverReady, endGameWait, createSoloStart,
  isMenuScene, isRunScene, SETUP_LEVELS, SETUP_HANDICAPS
} from './src/byop/full-mode.js';
import { saveMenuCheckpoint, restoreMenuCheckpoint } from './src/byop/menu-checkpoint.js';
import { frameToDataUrl, isUsableCoverFrame, coverDataUrlIsUsable } from './src/byop/cover.js';
import { applyGameSkin } from './src/byop/game-skin.js';

bindPhoneInsets();

const byId = (id) => document.getElementById(id);
const SETTINGS_KEY = 'tetris-web:settings';
const INSTALL_CHOICE_KEY = 'tetris-web:install-choice';
const SAVE_INTERVAL = 6000;
const SHUFFLE = 'shuffle';
const TRACKS = [1, 2, 3, 4];
const VOLUMES = [0, 10, 25, 50, 100];
const MENU_MUSIC_VIEWS = new Set(['cover', 'install-help', 'home', 'setup', 'confirm', 'records']);
const VIEW_ELEMENTS = {
  cover: 'cover-screen',
  'install-help': 'install-help',
  home: 'home-menu',
  setup: 'setup-menu',
  pause: 'pause-menu',
  settings: 'settings-menu',
  records: 'records-menu',
  'record-edit': 'record-edit-menu',
  'record-confirm': 'record-confirm-menu',
  confirm: 'confirm-menu',
  legal: 'legal-screen'
};
const FOCUS_ORDER = {
  cover: 'step-rom', 'install-help': 'install-help-continue',
  home: 'play', setup: 'start', pause: 'resume', settings: 'settings-back',
  records: 'records-back', 'record-edit': 'record-edit-title', 'record-confirm': 'record-confirm-no',
  confirm: 'confirm-no', legal: 'legal-back'
};
const BUTTON_LABELS = { left: 'ariaLeft', right: 'ariaRight', down: 'ariaDown', a: 'ariaA', b: 'ariaB' };
const PLATFORM_KEYS = {
  ios: 'installHelpIos', chrome: 'installHelpChrome', samsung: 'installHelpSamsung',
  safari: 'installHelpSafari', desktop: 'installHelpDesktop'
};
const BINDINGS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down',
  ArrowUp: 'a', KeyX: 'a', KeyZ: 'b'
};
const MAX_ROM_BYTES = 16 * 1024 * 1024;
const runId = () => globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random();

// --- состояние -------------------------------------------------------------
const settings = {
  opponent: 'solo',
  language: preferredLanguage(),
  level: 0,
  handicap: 0,
  track: SHUFFLE,
  sound: 100,
  musicVolume: 100
};
let t = translations[settings.language];
let view = 'cover';
let settingsReturn = 'home';
let legalReturn = 'cover';
let store = null;
let storeError = null;
let installer = null;
let engine = null;
let engineState = 'idle'; // idle | loading | ready | error
let engineError = null;
let loaded = false;
let rom = null; // { sha, name, size, bytes, profile }
let mode = null; // 'full' | 'compatible'
let coverDataUrl = null;
let coverBusy = false;
let storageWarning = null;
let romError = null;
let cardBusyText = null;
let pendingRecord = null;
let recordsAfterGame = false;
let activeScene = 'boot';
let runStart = null;
let menuBase = null;
let menuCheckpointSaved = false;
let observedEnd = false;
let records = [];
let savedInfo = null;
let confirmIntent = null;
let runStore = null;
let activeRun = null;
let nextSaveAt = 0;
let savePending = 0;
let saveRevision = 0;
let pageLeaving = false;
let menuMusicUnlocked = false;
let rawFrames = 0;
let coverScene = null;
let coverSceneFrames = 0;
let coverStreak = 0;
let skinApplied = false;
let titleFrame = null;
let playFrame = null;
let titleArtUrl = null;
const owner = runId();
const heldInputs = new Map();
const refreshChoices = [];
const padButtons = new Map([...document.querySelectorAll('[data-button]')].map(node => [node.dataset.button, node]));
const game = byId('game');
const overlay = byId('overlay');
const notice = byId('notice');
const afterGame = byId('after-game');
const gameOverNext = byId('game-over-next');
const resultBar = byId('result-bar');
const recordInput = byId('record-input');
const recordsTable = byId('records-table');
const renderer = new Compositor(byId('picture'), resultBar);
const controls = bindControls({ pad: document.querySelector('.pad'), setInput, pause });

// --- настройки -------------------------------------------------------------
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { /* опционально */ }
  if (!saved || typeof saved !== 'object') return;
  if (saved.language === 'ru' || saved.language === 'en') settings.language = saved.language;
  if (SETUP_LEVELS.includes(saved.level)) settings.level = saved.level;
  if (SETUP_HANDICAPS.includes(saved.handicap)) settings.handicap = saved.handicap;
  if (saved.track === SHUFFLE || TRACKS.includes(saved.track)) settings.track = saved.track;
  if (VOLUMES.includes(saved.sound)) settings.sound = saved.sound;
  if (VOLUMES.includes(saved.musicVolume)) settings.musicVolume = saved.musicVolume;
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      language: settings.language, level: settings.level, handicap: settings.handicap,
      track: settings.track, sound: settings.sound, musicVolume: settings.musicVolume
    }));
  } catch { /* приватный режим */ }
}

function installChoice() {
  try { return localStorage.getItem(INSTALL_CHOICE_KEY); } catch { return null; }
}
function setInstallChoice(value) {
  try { localStorage.setItem(INSTALL_CHOICE_KEY, value); } catch { /* не страшно */ }
}
function installResolved() {
  if (installer?.installed || installer?.standalone) return true;
  const choice = installChoice();
  return choice === 'browser' || choice === 'installed';
}

// --- локализация и общие помощники -----------------------------------------
function localize() {
  t = translations[settings.language];
  document.documentElement.lang = settings.language;
  document.title = t.pageTitle;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (typeof t[key] === 'string') node.textContent = t[key];
  }
  byId('machine').setAttribute('aria-label', t.ariaMachine);
  game.setAttribute('aria-label', t.ariaGame);
  overlay.setAttribute('aria-label', t.ariaOverlay);
  byId('picture').setAttribute('aria-label', t.ariaField);
  document.querySelector('.pad').setAttribute('aria-label', t.ariaControls);
  byId('pause-key').setAttribute('aria-label', t.ariaPause);
  byId('home-settings').setAttribute('aria-label', t.ariaSettings);
  byId('home-settings').title = t.ariaSettings;
  const shortcuts = { left: '←', right: '→', down: '↓', a: 'X / ↑', b: 'Z' };
  for (const [key, node] of padButtons) {
    node.setAttribute('aria-label', t[BUTTON_LABELS[key]]);
    node.title = t[BUTTON_LABELS[key]] + ' · ' + shortcuts[key];
  }
  for (const button of byId('settings-languages').querySelectorAll('button')) {
    const code = button.dataset.language;
    button.textContent = code === 'ru' ? 'РУС' : 'ENG';
    button.setAttribute('aria-label', code === 'ru' ? t.langRussian : t.langEnglish);
    button.setAttribute('aria-pressed', String(code === settings.language));
  }
  for (const refresh of refreshChoices) refresh();
}

function applyLanguage(language, { persist = true } = {}) {
  settings.language = language === 'ru' ? 'ru' : 'en';
  if (persist) persistSettings();
  localize();
  renderAll();
  if (engine && engineState === 'ready' && view === 'game') {
    // Игровые подписи берутся из ROM, интерфейс двигается сразу.
    renderer.resize();
  }
}

function setCardStatus(text) {
  cardBusyText = text || null;
  if (view === 'cover') renderCard();
}

function formatErrorDetail(error) {
  const detail = error?.detail ?? error?.message ?? (error === null || error === undefined ? '' : String(error));
  return detail.length > 140 ? detail.slice(0, 137) + '…' : detail;
}

function romErrorText(result) {
  if (!result) return '';
  switch (result.code) {
    case 'storage-quota': return t.errStorageQuota;
    case 'storage-blocked': return t.errStorageBlocked;
    case 'storage': return formatText(t.errStorage, { detail: formatErrorDetail(result) });
    default: return refusalText(result, t);
  }
}

function storageRefusal(error) {
  const code = error?.code === 'quota' ? 'storage-quota' : error?.code === 'blocked' ? 'storage-blocked' : 'storage';
  return { ok: false, code, detail: error?.detail ?? error?.message ?? '' };
}

// --- установка -------------------------------------------------------------
function renderInstallHelp() {
  const text = byId('install-help-text');
  const status = byId('install-help-status');
  const continueButton = byId('install-help-continue');
  continueButton.textContent = t.installContinue;
  byId('install-help-title').textContent = t.installTitle;
  if (!installer) {
    text.textContent = t.installUnavailable;
    status.hidden = true;
    return;
  }
  const hintKey = PLATFORM_KEYS[installer.platformHint()] ?? 'installHelpDesktop';
  text.textContent = t[hintKey] ?? t.installHelpDesktop;
  if (!installer.eligible) {
    status.hidden = true;
    return;
  }
  const state = installer.offline;
  status.hidden = false;
  status.className = 'card-status ' + (state === 'ready' ? 'ready' : state === 'failed' ? 'failed' : '');
  status.textContent = state === 'ready' ? t.installReady : state === 'failed' ? t.installFailed : t.installSaving;
}

function renderSettingsInstall() {
  const container = byId('settings-install');
  container.replaceChildren();
  if (!installer) return;
  if (installer.installed || installer.standalone) {
    const note = document.createElement('p');
    note.className = 'installed-note';
    note.textContent = t.installInstalled;
    container.append(note);
    return;
  }
  if (!installer.eligible) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action';
  button.textContent = t.installBtn;
  button.onclick = () => { void installFlow(); };
  container.append(button);
}

function renderInstallStatus() {
  if (view === 'cover') renderCard();
  if (view === 'install-help') renderInstallHelp();
  if (view === 'settings') renderSettingsInstall();
  if (view === 'home') renderHome();
}

async function installFlow() {
  if (!rom || !installer) return;
  if (installer.installed || installer.standalone) {
    setInstallChoice('installed');
    goHome();
    return;
  }
  if (installer.promptAvailable) {
    const outcome = await installer.prompt();
    if (outcome === 'accepted' || outcome === 'installed') {
      setInstallChoice('installed');
      goHome();
      return;
    }
    menu('install-help');
    renderInstallHelp();
    return;
  }
  menu('install-help');
  renderInstallHelp();
}

function goHome() {
  setInstallChoice('browser');
  unlockMenuMusic();
  menu('home');
}

// --- карточка / главное меню ----------------------------------------------
function gameDisplayName() {
  return rom?.profile?.catalogMatched ? rom.profile.name : rom?.name || '';
}

function renderCard() {
  const hasRom = Boolean(rom);
  byId('game-title').textContent = t.gameTitle;
  byId('game-subtitle').textContent = t.gameSubtitle;

  // До ROM показываем только «шаги»: никакого паспорта и лишних надписей.
  const stepRom = byId('step-rom');
  stepRom.classList.toggle('on', !hasRom && !cardBusyText);
  stepRom.classList.toggle('done', hasRom);
  byId('step-rom-title').textContent = t.stepAddTitle;

  const errorBox = byId('rom-error');
  errorBox.hidden = !romError;
  if (romError) {
    byId('rom-error-title').textContent = t.errTitle;
    byId('rom-error-text').textContent = romErrorText(romError);
    byId('rom-error-retry').textContent = t.retryOtherRom;
  }

  const status = byId('card-status');
  let statusText = '';
  let isError = false;
  if (cardBusyText) statusText = cardBusyText;
  else if (!hasRom && storeError) { statusText = t.errStorageBlocked; isError = true; }
  else if (storageWarning) { statusText = storageWarning; isError = true; }
  status.hidden = !statusText;
  status.textContent = statusText;
  status.className = 'card-status' + (isError ? ' error' : '');

  byId('cover-note').textContent = !hasRom ? t.coverNoteNoRom : t.coverNoteRom;
}

function renderHome() {
  const hasRom = Boolean(rom);
  const continueRun = byId('continue-run');
  continueRun.hidden = !(hasRom && savedInfo);
  continueRun.textContent = t.homeContinue;
  const play = byId('play');
  play.textContent = mode === MODE_FULL ? t.homeNewGame : t.homePlayAsIs;
  play.classList.toggle('primary', true);
  play.disabled = !hasRom || engineState === 'loading' || engineState === 'error';
  const recordsButton = byId('records');
  recordsButton.hidden = mode !== MODE_FULL;

  const modeNote = byId('home-mode-note');
  modeNote.hidden = !hasRom || mode === MODE_FULL;
  modeNote.textContent = hasRom && mode !== MODE_FULL ? t.modeCompatExplain : '';
}

function renderAll() {
  renderCard();
  renderHome();
  renderSavedMenu();
  renderSettingsInstall();
  renderRecordEditor();
  renderPause();
  if (view === 'install-help') renderInstallHelp();
  if (view === 'records') renderRecords();
  if (view === 'settings') renderSettings();
}

function renderPause() {
  byId('restart').hidden = mode !== MODE_FULL || !runStart;
  byId('resume').textContent = t.resume;
  byId('main-menu').textContent = t.mainMenu;
}

// --- меню ------------------------------------------------------------------
function applyArtVisibility() {
  const show = view === 'home' ? Boolean(titleArtUrl) : view === 'cover';
  byId('art').hidden = !show;
}

function menu(name, { focus = true } = {}) {
  if (!Object.hasOwn(VIEW_ELEMENTS, name)) throw new Error('Unknown view ' + name);
  view = name;
  const inGame = name === 'pause' || (name === 'settings' && settingsReturn === 'pause');
  overlay.dataset.menu = name;
  overlay.hidden = false;
  overlay.classList.toggle('in-game', inGame);
  game.hidden = !inGame;
  game.inert = true;
  const panel = byId('panel');
  panel.className = (name === 'cover' || name === 'home') ? 'panel cover' : 'panel dialog';
  applyArtVisibility();
  byId('home-settings').hidden = name !== 'home';
  for (const [key, id] of Object.entries(VIEW_ELEMENTS)) byId(id).hidden = key !== name;
  notice.hidden = true;
  if (name === 'cover') renderCard();
  if (name === 'home') renderHome();
  if (name === 'install-help') renderInstallHelp();
  if (name === 'settings') renderSettings();
  if (name === 'records') renderRecords();
  if (name === 'pause') renderPause();
  syncMenuMusic();
  if (focus) {
    const target = byId(FOCUS_ORDER[name]);
    try { target.focus({ preventScroll: true }); } catch { /* не фокусируется */ }
  }
}

function showNotice(message) {
  view = 'starting';
  overlay.dataset.menu = 'notice';
  overlay.hidden = false;
  overlay.classList.remove('in-game');
  game.hidden = true;
  game.inert = true;
  byId('panel').className = 'panel dialog';
  byId('art').hidden = true;
  for (const id of Object.values(VIEW_ELEMENTS)) byId(id).hidden = true;
  notice.hidden = false;
  notice.textContent = message;
}

function isFrontMenu() {
  return MENU_MUSIC_VIEWS.has(view) || (view === 'settings' && settingsReturn !== 'pause');
}

function syncMenuMusic() {
  if (!engine || engineState !== 'ready') return;
  if (menuMusicUnlocked && !document.hidden && isFrontMenu() && settings.musicVolume > 0 && loaded) {
    engine.playMenuMusic(settings.musicVolume);
  }
}

function unlockMenuMusic() {
  if (!isFrontMenu()) return;
  menuMusicUnlocked = true;
  syncMenuMusic();
}

function applyMix() {
  if (!engine || engineState !== 'ready') return;
  engine.setMix({ sound: settings.sound, music: settings.musicVolume, track: settings.track });
}

function settingsChanged() {
  persistSettings();
  applyMix();
  for (const refresh of refreshChoices) refresh();
}

// --- игровой ввод ----------------------------------------------------------
function setInput(source, button, down) {
  if (down) {
    if (view !== 'game' || heldInputs.has(source)) return;
    heldInputs.set(source, button);
    engine?.wakeAudio();
    engine?.setButton(button, true);
    padButtons.get(button)?.classList.add('held');
  } else {
    const held = heldInputs.get(source);
    heldInputs.delete(source);
    if (held && ![...heldInputs.values()].includes(held)) {
      engine?.setButton(held, false);
      padButtons.get(held)?.classList.remove('held');
    }
  }
}

function releaseAll() {
  controls.clear();
  heldInputs.clear();
  for (const node of padButtons.values()) node.classList.remove('held');
  engine?.clearButtons();
}

function tapCartridge(button) {
  setInput('tap-' + button, button, true);
  setInput('tap-' + button, button, false);
}

// --- движок ----------------------------------------------------------------
function disposeEngine() {
  if (engine) {
    try { engine.setPaused(true); } catch { /* мог не загрузиться */ }
    engine = null;
  }
  engineState = 'idle';
  engineError = null;
  loaded = false;
  menuBase = null;
  menuCheckpointSaved = false;
  runStart = null;
  activeRun = null;
  observedEnd = false;
  resetCoverCaptureState();
}

function engineFailed(error) {
  engineState = 'error';
  engineError = error;
  console.error(error);
  renderCard();
  renderHome();
}

function setEngineProgress(phase) {
  if (phase === 'compile' || phase === 'instantiate') {
    engineState = 'loading';
    if (view === 'cover') renderCard();
    if (view === 'home') renderHome();
  }
}

async function loadEngine() {
  if (!rom || engineState === 'loading' || engineState === 'ready') return;
  disposeEngine();
  engineState = 'loading';
  if (view === 'cover') renderCard();
  if (view === 'home') renderHome();
  try {
    engine = new Engine({ onFrame, onError: engineFailed });
    engine.onProgress = setEngineProgress;
    let cached = null;
    if (store) {
      try { cached = await store.getCachedProgram(rom.sha); } catch { cached = null; }
    }
    await engine.load(rom.bytes, cached ? { cachedProgram: cached } : undefined);
    applyRomLanguage();
    if (engine.nes?.ppu && 'clipToTvSize' in engine.nes.ppu) engine.nes.ppu.clipToTvSize = false;
    if (store && engine.compiledProgram?.wasm instanceof Uint8Array) {
      store.putCachedProgram(rom.sha, engine.compiledProgram).catch(() => {});
    }
    engine.setPaused(true);
    // Готовым считаемся только после подготовки меню/чекпоинта: иначе игрок
    // успел бы нажать «Играть» раньше, чем картридж дошёл до своего меню.
    if (mode === MODE_FULL) await prepareFullMode();
    else prepareCompatibleMode();
    loaded = true;
    engineState = 'ready';
    captureTitleFrame();
    void refreshSkin();
    renderCard();
    renderHome();
    if (view === 'cover') menu('home');
    syncMenuMusic();
  } catch (error) {
    engineFailed(error);
  }
}

// Прогон картриджа до собственного меню: так снимается menu-checkpoint и
// обложка, а игрок не видит copyright-экран в следующий раз.
async function runToMenu(maxFrames = 1800) {
  let frames = 0;
  let seeded = false;
  while (frames < maxFrames) {
    await new Promise(requestAnimationFrame);
    const deadline = performance.now() + 12;
    do {
      if (!engine) return false;
      engine.nes.frame();
      frames++;
      const scene = readScene(engine.nes);
      if (!seeded && (scene === 'title' || scene === 'scores')) {
        seedRanking(engine.nes, records);
        seeded = true;
      }
      if (isMenuScene(scene) && frames > 2) return true;
    } while (performance.now() < deadline);
  }
  throw new Error('ROM did not reach its menu');
}

function applyRomLanguage() {
  if (!engine) return;
  const language = rom?.profile?.language === 'ru' ? 'ru' : 'en';
  if (typeof engine.setRomLanguage === 'function') engine.setRomLanguage(language);
  else if (engine.nes) engine.nes.cartridgeLanguage = language;
}

async function prepareFullMode() {
  engine.setPaused(true);
  let restored = false;
  if (store) {
    try { restored = await restoreMenuCheckpoint(engine, store, rom.sha); } catch { restored = false; }
  }
  if (restored) {
    applyRomLanguage();
    seedRanking(engine.nes, records);
    engine.setPaused(true);
    // Если обложки ещё нет (старый чекпоинт/чистый кэш), даём картриджу
    // несколько обычных кадров меню: переходный серый кадр не попадёт в кэш.
    if (!coverDataUrl) {
      for (let i = 0; i < 45 && !coverDataUrl; i++) {
        engine.nes.frame();
        await new Promise(requestAnimationFrame);
      }
    }
    menuBase = engine.captureStart();
    menuCheckpointSaved = true;
    return;
  }
  engine.setPaused(true);
  engine.reset();
  engine.setPaused(true);
  await runToMenu();
  engine.setPaused(true);
  // Даём картриджу дорисовать титульный экран: иначе обложкой станет
  // переходный серый кадр, а menu-checkpoint застынет на недорисованном меню.
  if (!coverDataUrl) {
    for (let i = 0; i < 60 && !coverDataUrl; i++) {
      engine.nes.frame();
      await new Promise(requestAnimationFrame);
    }
  }
  menuBase = engine.captureStart();
  menuCheckpointSaved = false;
}

function prepareCompatibleMode() {
  engine.setPaused(true);
}

// --- скин оболочки из оригинальной графики ---------------------------------
function romChrBytes() {
  if (!rom?.bytes) return null;
  const bytes = rom.bytes;
  const flags = bytes[6] ?? 0;
  const prg = bytes[4] ?? 0;
  const chr = bytes[5] ?? 0;
  const start = 16 + ((flags & 4) ? 512 : 0) + prg * 16384;
  const length = Math.min(chr * 8192, bytes.length - start);
  return length > 0 ? bytes.subarray(start, start + length) : null;
}

function captureTitleFrame() {
  const buffer = engine?.nes?.ppu?.buffer;
  if (!buffer) return;
  titleFrame = new Uint32Array(buffer.length);
  titleFrame.set(buffer);
}

function capturePlayFrame() {
  const buffer = engine?.nes?.ppu?.buffer;
  if (!buffer) return;
  playFrame = new Uint32Array(buffer.length);
  playFrame.set(buffer);
}

async function refreshSkin() {
  if (!rom || mode !== MODE_FULL) return;
  const chr = romChrBytes();
  if (!chr) return;
  try {
    if (!skinApplied) {
      const result = await applyGameSkin({
        chr,
        language: rom.profile?.language === 'ru' ? 'ru' : 'en',
        titleBuffer: titleFrame
      });
      titleArtUrl = result.assets.title;
      const image = byId('art-image');
      if (titleArtUrl) {
        image.src = titleArtUrl;
        image.hidden = false;
        byId('art-placeholder').hidden = true;
      }
      skinApplied = true;
      renderer.setFrameImage?.(result.assets.frame);
      applyArtVisibility();
    }
    renderCard();
    renderHome();
  } catch (error) {
    console.warn('game skin failed', error);
  }
}

// --- обложка из ROM --------------------------------------------------------
function resetCoverCaptureState() {
  coverScene = null;
  coverSceneFrames = 0;
  coverStreak = 0;
}

async function readUsableCover(sha) {
  if (!store || !sha) return null;
  let dataUrl = null;
  try { dataUrl = await store.getCover(sha); } catch { return null; }
  if (!dataUrl) return null;
  // Кэш мог остаться от старой версии с серым переходным кадром.
  if (!(await coverDataUrlIsUsable(dataUrl))) {
    store.deleteCover(sha).catch(() => {});
    return null;
  }
  return dataUrl;
}

async function maybeCaptureCover(buffer, nes) {
  if (!rom || coverDataUrl || coverBusy) return;
  if (mode === MODE_FULL) {
    const scene = readScene(nes);
    if (!isMenuScene(scene)) {
      coverScene = null;
      coverStreak = 0;
      return;
    }
    if (scene !== coverScene) {
      coverScene = scene;
      coverSceneFrames = 0;
      coverStreak = 0;
    }
    // Первые кадры меню — переход с серым фоном copyright-экрана:
    // ждём, пока картридж дорисует титульный экран, и только потом снимаем.
    if (++coverSceneFrames < 8) return;
  } else if (rawFrames < 20) return;
  if (!isUsableCoverFrame(buffer)) {
    coverStreak = 0;
    return;
  }
  if (mode === MODE_FULL && ++coverStreak < 3) return;
  coverBusy = true;
  try {
    const dataUrl = frameToDataUrl(buffer);
    if (!dataUrl) return;
    coverDataUrl = dataUrl;
    resetCoverCaptureState();
    if (store) store.saveCover(rom.sha, dataUrl).catch(() => {});
    if (view === 'cover') renderCard();
    if (view === 'home') renderHome();
  } finally {
    coverBusy = false;
  }
}

// --- кадры движка ----------------------------------------------------------
function onFrame(buffer, nes, present = true) {
  if (!rom || !engine) return;
  void maybeCaptureCover(buffer, nes);
  if (view !== 'game') return;
  if (engineState !== 'ready') return;

  if (mode !== MODE_FULL) {
    // Совместимый режим: картридж показывается как есть, без наших надстроек.
    rawFrames++;
    if (present) renderer.draw(buffer, 'raw', nes);
    return;
  }

  let scene = readScene(nes);
  if (scene === 'boot') scene = activeScene;
  // Картридж гасит PPU, пока пишет таблицу рекордов: оставляем последний кадр.
  if (scene === 'scores' && !nes.ppu.f_bgVisibility) return;
  if (scene !== activeScene) {
    releaseAll();
    activeScene = scene;
    game.dataset.scene = scene;
    if (scene === 'play') schedulePadMetrics();
  }
  if (!observedEnd && (scene === 'gameover' || scene === 'scores')) {
    observedEnd = true;
    void finishCurrentRun();
  }
  if (observedEnd && ['title', 'demo', 'mode', 'level', 'music', 'handicap'].includes(scene)) {
    home();
    return;
  }
  const canAdvance = scene === 'gameover' && gameOverReady(nes);
  if (gameOverNext.hidden === canAdvance) gameOverNext.hidden = !canAdvance;
  const showResults = scene === 'scores';
  if (resultBar.hidden === showResults) {
    resultBar.hidden = !showResults;
    game.classList.toggle('scores', showResults);
  }
  if (showResults) {
    if (enteringInitials(nes) && openRecordEditor(nes)) return;
    afterGame.hidden = false;
  }
  if (present) {
    renderer.draw(buffer, scene, nes);
    if (runStore && activeRun && isRunScene(scene) && performance.now() >= nextSaveAt) {
      nextSaveAt = performance.now() + SAVE_INTERVAL;
      // PPU зовёт onFrame до конца кадра: читаем RAM чуть позже.
      const run = activeRun;
      setTimeout(() => { if (activeRun === run) void saveCurrentRun(); }, 0);
    }
  }
}

/**
 * Подгоняет зарезервированные области под реальный размер кнопок:
 * так колодец никогда не заезжает под тач-управление на разных телефонах.
 */
function syncPadMetrics() {
  if (!window.matchMedia('(orientation: portrait)').matches) {
    game.style.removeProperty('--portrait-controls-height');
    game.style.removeProperty('--portrait-drop-width');
    game.style.removeProperty('--portrait-drop-height');
    game.style.removeProperty('--portrait-drop-top');
    return;
  }
  const moves = document.querySelector('.pad .moves');
  const down = document.querySelector('.pad > .down');
  if (!moves || !down) return;
  const gameBox = game.getBoundingClientRect();
  const movesBox = moves.getBoundingClientRect();
  const downBox = down.getBoundingClientRect();
  if (!gameBox.height || !movesBox.height || !downBox.height) return;
  const controls = Math.round(gameBox.bottom - movesBox.top + 12);
  const dropWidth = Math.round(gameBox.right - downBox.left + 8);
  game.style.setProperty('--portrait-controls-height', controls + 'px');
  game.style.setProperty('--portrait-drop-width', dropWidth + 'px');
  game.style.setProperty('--portrait-drop-height', Math.round(downBox.height) + 'px');
  game.style.setProperty('--portrait-drop-top',
    (((downBox.top + downBox.height / 2) - gameBox.top) / gameBox.height * 100).toFixed(2) + '%');
  renderer.resize();
}

function schedulePadMetrics() {
  requestAnimationFrame(() => {
    try { syncPadMetrics(); } catch (error) { console.warn('pad metrics', error); }
  });
}

function enterGameScreen() {
  view = 'game';
  game.hidden = false;
  game.inert = false;
  overlay.hidden = true;
  overlay.classList.remove('in-game');
  renderer.resize();
  schedulePadMetrics();
  if (engine && engineState === 'ready') {
    engine.wakeAudio();
    engine.start();
  }
  if (document.hidden) pause();
}

function resume() {
  if (!engine || engineState !== 'ready') return;
  engine.stopMenuMusic?.();
  enterGameScreen();
}

function pause(save = true) {
  if (view !== 'game') return;
  releaseAll();
  engine?.setPaused(true);
  if (save) void saveCurrentRun();
  menu('pause');
}

function home() {
  releaseAll();
  engine?.setPaused(true);
  runStart = null;
  activeRun = null;
  menu('home');
}

// --- полный режим: автозапуск партии ---------------------------------------
function enterRun(scene = 'play') {
  nextSaveAt = 0;
  observedEnd = false;
  pendingRecord = null;
  afterGame.hidden = true;
  gameOverNext.hidden = true;
  resultBar.hidden = true;
  game.classList.remove('scores');
  activeScene = scene;
  game.dataset.scene = scene;
  renderer.setGameMode?.(mode === MODE_FULL ? (settings.opponent ?? 'solo') : 'solo');
  applyMix();
  engine?.setMuted(false);
  resume();
}

async function beginFull() {
  if (!engine || engineState !== 'ready' || !loaded || view === 'starting') return;
  showNotice(t.starting);
  releaseAll();
  engine.setPaused(true);
  engine.wakeAudio();
  engine.setMuted(true);
  try {
    const startScene = readScene(engine.nes);
    if (isMenuScene(startScene) || startScene === 'scores') {
      if (menuBase && !isMenuScene(startScene)) engine.restoreStart(menuBase);
      else if (!menuBase) menuBase = engine.captureStart();
    } else if (startScene !== 'boot') {
      if (menuBase) engine.restoreStart(menuBase);
      else {
        engine.reset();
        engine.setPaused(true);
        await runToMenu();
        menuBase = engine.captureStart();
      }
    }
    seedRanking(engine.nes, records);
    const advance = createSoloStart({
      level: settings.level,
      handicap: settings.handicap,
      music: engine.startMusic(settings.track),
      mode: settings.opponent === 'vs' ? 3 : settings.opponent === 'with' ? 4 : 0
    });
    let frames = 0;
    let rankingSeeded = false;
    while (true) {
      await new Promise(requestAnimationFrame);
      const deadline = performance.now() + 12;
      do {
        if (!rankingSeeded && ['title', 'scores'].includes(readScene(engine.nes))) {
          seedRanking(engine.nes, records);
          rankingSeeded = true;
        }
        if (advance(engine.nes)) {
          if (!rankingSeeded) seedRanking(engine.nes, records);
          applyMix();
          runStart = engine.captureStart();
          capturePlayFrame();
          void refreshSkin();
          activeRun = { id: runId(), owner, fresh: true };
          // «Сразу в меню»: сохраняем состояние меню только после первого
          // успешного автозапуска партии.
          if (menuBase && !menuCheckpointSaved && store) {
            menuCheckpointSaved = await saveMenuCheckpoint(store, rom.sha, menuBase);
          }
          enterRun('play');
          return;
        }
        engine.nes.frame();
        if (++frames > 900) throw new Error('The cartridge did not start a solo game');
      } while (performance.now() < deadline);
    }
  } catch (error) {
    console.error(error);
    engine?.setMuted(false);
    engineFailed(error);
    menu('home');
  }
}

function playAsIs() {
  if (!engine || engineState !== 'ready') return;
  rawFrames = 0;
  activeScene = 'raw';
  game.dataset.scene = 'play';
  engine.setPaused(true);
  engine.stopMenuMusic?.();
  resume();
}

function restart() {
  if (mode !== MODE_FULL || !runStart || !engine) return;
  releaseAll();
  engine.restoreStart(runStart);
  seedRanking(engine.nes, records);
  enterRun('play');
}

// --- сохранения полного режима --------------------------------------------
function observeSave(operation) {
  const revision = ++saveRevision;
  savePending++;
  return Promise.resolve(operation)
    .then((info) => {
      if (revision === saveRevision) {
        savedInfo = info ?? null;
        renderHome();
      }
      return info;
    })
    .finally(() => {
      savePending--;
    });
}

function readShownLevel(nes) {
  const level = nes?.ppu?.vramMem?.subarray(0x20cb, 0x20cd);
  if (!level) return settings.level;
  const digits = Array.from(level).filter(tile => tile >= 0x30 && tile <= 0x39);
  return digits.length ? Number(String.fromCharCode(...digits)) : settings.level;
}

function saveCurrentRun(exiting = false) {
  if (mode !== MODE_FULL || !runStore || !activeRun || !runStart || !engine) return;
  const nes = engine.nes;
  if (!isRunScene(readScene(nes))) return;
  const info = {
    id: activeRun.id,
    owner,
    savedAt: Date.now(),
    level: readShownLevel(nes),
    thumbnail: renderer.thumbnail()
  };
  const initial = activeRun.fresh ? runStart : undefined;
  const checkpoint = engine.captureProgress();
  if (exiting) saveOnExit(rom.sha, info, checkpoint);
  const operation = runStore.save(info, checkpoint, initial);
  activeRun.fresh = false;
  nextSaveAt = performance.now() + SAVE_INTERVAL;
  observeSave(operation).catch(() => {
    if (initial && activeRun) activeRun.fresh = true;
  });
}

async function finishCurrentRun() {
  if (mode !== MODE_FULL || !runStore || !activeRun) return;
  const id = activeRun.id;
  activeRun = null;
  if (savedInfo?.id === id) {
    savedInfo = null;
    renderHome();
  }
  try { await observeSave(runStore.finish(id, owner)); } catch { /* слот мог исчезнуть */ }
}

async function continueSavedRun() {
  if (mode !== MODE_FULL || !savedInfo || !runStore || !engine) return;
  const yes = byId('confirm-yes');
  yes.disabled = true;
  try {
    const slot = await runStore.take(savedInfo.id, owner);
    if (view !== 'confirm' || confirmIntent !== 'continue') return;
    if (!slot) {
      savedInfo = await runStore.read();
      renderHome();
      menu('home');
      return;
    }
    engine.setPaused(true);
    engine.restoreProgress(slot.checkpoint);
    seedRanking(engine.nes, records);
    runStart = slot.initial;
    activeRun = { id: slot.info.id, owner, fresh: false };
    enterRun(readScene(engine.nes));
  } catch (error) {
    console.warn('continue failed', error);
    menu('home');
  } finally {
    yes.disabled = false;
  }
}

// --- смена ROM -------------------------------------------------------------
function forgetRunData(sha) {
  if (!sha) return;
  if (store) store.resetDerivedData(sha).catch(() => {});
  clearRecords(sha);
  if (runStore) {
    const old = runStore;
    runStore = null;
    old.clear?.().catch?.(() => {});
  }
}

function beginChangeRom() {
  const oldSha = rom?.sha;
  forgetRunData(oldSha);
  records = [];
  savedInfo = null;
  coverDataUrl = null;
  menuCheckpointSaved = false;
  storageWarning = null;
  romError = null;
  engine?.setPaused(true);
  menu('cover');
  renderCard();
  // Открываем выбор файла синхронно из жеста пользователя.
  openFilePicker();
}

function openFilePicker() {
  const input = byId('rom-file');
  try { input.value = ''; } catch { /* не страшно */ }
  input.click();
}

// --- импорт ROM ------------------------------------------------------------
function clearRomError() {
  romError = null;
}

function showRomError(result) {
  romError = result;
  cardBusyText = null;
  if (view !== 'cover') menu('cover');
  renderCard();
}

async function importRomFile(file) {
  if (!file) return;
  clearRomError();
  storageWarning = null;
  setCardStatus(t.romReading);
  try {
    const metaProblem = checkRomFileMeta(file.name, file.size);
    if (metaProblem) {
      showRomError(metaProblem);
      return;
    }
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      showRomError({ ok: false, code: 'read', detail: error?.message ?? '' });
      return;
    }
    setCardStatus(t.romChecking);
    let catalog = null;
    try { catalog = await loadDumpCatalog(); } catch { catalog = null; }
    const result = await inspectRomFile({ fileName: file.name, bytes, catalog });
    if (!result.ok) {
      showRomError(result);
      return;
    }
    setCardStatus(t.romSaving);
    let persisted = false;
    if (store) {
      try {
        await store.saveRom({
          sha: result.sha256,
          name: file.name,
          size: file.size,
          profile: result.passport,
          bytes
        });
        await store.requestPersist();
        persisted = true;
      } catch (error) {
        console.warn('ROM was not persisted', error);
        storageWarning = romErrorText(storageRefusal(error));
      }
    } else {
      storageWarning = t.errStorageBlocked;
    }
    const oldSha = rom?.sha;
    const changed = oldSha && oldSha !== result.sha256;
    if (changed && store) await store.deleteRomData(oldSha).catch(() => {});
    if (changed) forgetRunData(oldSha);

    rom = {
      sha: result.sha256,
      name: file.name,
      size: file.size,
      bytes,
      profile: result.passport
    };
    mode = result.passport.mode;
    const romLanguage = result.passport.language === 'ru' ? 'ru' : 'en';
    if (settings.language !== romLanguage) {
      settings.language = romLanguage;
      persistSettings();
      localize();
    }
    records = mode === MODE_FULL ? loadRecords(rom.sha) : [];
    savedInfo = null;
    if (mode === MODE_FULL) {
      runStore = await openSavedRun(rom.sha);
      if (runStore) {
        try {
          savedInfo = await runStore.read();
        } catch { savedInfo = null; }
      }
    } else {
      runStore = null;
    }
    coverDataUrl = store ? await readUsableCover(rom.sha) : null;
    menuCheckpointSaved = false;
    disposeEngine();
    if (view !== 'cover') menu('cover');
    renderCard();
    renderHome();
    // Движок грузим сразу: паспорт уже показан, шаг 2 «Установить игру» активен.
    void loadEngine();
    void persisted;
  } catch (error) {
    console.error(error);
    showRomError({ ok: false, code: 'unknown', detail: error?.message ?? '' });
  } finally {
    cardBusyText = null;
    renderCard();
  }
}

// --- рекорды ---------------------------------------------------------------
function fitRecordNames() {
  if (recordsTable.hidden || view !== 'records') return;
  for (const slot of recordsTable.querySelectorAll('.record-name-slot')) {
    const name = slot.firstElementChild;
    if (!name) continue;
    name.style.fontSize = '';
    const width = name.getBoundingClientRect().width;
    if (width > slot.clientWidth && width > 0) {
      const size = parseFloat(getComputedStyle(name).fontSize);
      name.style.fontSize = (size * slot.clientWidth / width) + 'px';
    }
  }
}
new ResizeObserver(() => requestAnimationFrame(fitRecordNames)).observe(recordsTable);
if (document.fonts?.ready) document.fonts.ready.then(fitRecordNames).catch(() => {});

function renderRecords() {
  const tbody = byId('record-rows');
  tbody.replaceChildren();
  records.forEach((entry, index) => {
    const row = tbody.insertRow();
    row.insertCell().textContent = index + 1;
    const slot = document.createElement('span');
    slot.className = 'record-name-slot';
    const name = document.createElement('bdi');
    name.textContent = recordName(entry);
    slot.append(name);
    row.insertCell().append(slot);
    row.insertCell().textContent = entry.score;
    row.insertCell().textContent = entry.lines;
  });
  recordsTable.hidden = records.length === 0;
  byId('records-empty').hidden = records.length > 0;
  byId('records-replay').hidden = !recordsAfterGame;
  byId('records-name').textContent = t.recordName;
  byId('records-score').textContent = t.recordScore;
  byId('records-lines').textContent = t.recordLines;
  byId('records-back').textContent = t.back;
  fitRecordNames();
}

function openRecordEditor(nes) {
  const row = editingRecord(nes);
  if (row === null) return false;
  pendingRecord = readRankedResult(nes, row, rom?.profile?.language);
  if (!pendingRecord) return false;
  releaseAll();
  engine.setPaused(true);
  recordInput.value = '';
  byId('record-submit').disabled = true;
  menu('record-edit');
  renderRecordEditor();
  return true;
}

function renderRecordEditor() {
  byId('record-edit-title').textContent = t.newRecord;
  byId('record-label').textContent = t.recordName;
  byId('record-submit').textContent = t.saveRecord;
  byId('record-confirm-title').textContent = t.saveRecordPrompt;
  byId('record-confirm-yes').textContent = t.yes;
  byId('record-confirm-no').textContent = t.no;
}

function updateRecordInput(event) {
  if (event.isComposing) return;
  const limited = limitRecordName(recordInput.value);
  if (limited !== recordInput.value) recordInput.value = limited;
  byId('record-submit').disabled = limited.trim().length === 0;
}
recordInput.addEventListener('input', updateRecordInput);
recordInput.addEventListener('compositionend', updateRecordInput);

byId('record-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (view !== 'record-edit' || !pendingRecord) return;
  const name = limitRecordName(recordInput.value);
  if (!name.trim()) return;
  pendingRecord.name = name;
  byId('record-confirm-name').firstElementChild.textContent = name;
  menu('record-confirm');
});

byId('record-confirm-no').onclick = () => {
  menu('record-edit');
  recordInput.focus();
};
byId('record-confirm-yes').onclick = () => {
  if (view !== 'record-confirm' || !pendingRecord?.name || !rom) return;
  records = addRecord(rom.sha, pendingRecord, records);
  pendingRecord = null;
  recordsAfterGame = true;
  menu('records');
};

// --- подтверждения ---------------------------------------------------------
function renderSavedMenu() {
  const change = confirmIntent === 'change-rom';
  byId('confirm-title').textContent = change ? t.changeRomPrompt
    : confirmIntent === 'replace' ? t.replacePrompt : t.resumePrompt;
  const note = change ? t.changeRomNote : confirmIntent === 'replace' ? t.replaceNote : '';
  byId('confirm-note').textContent = note;
  byId('confirm-note').hidden = !note;
  byId('confirm-no').textContent = t.no;
  byId('confirm-yes').textContent = t.yes;
  const preview = document.querySelector('.saved-preview');
  const showPreview = !change && Boolean(savedInfo);
  preview.hidden = !showPreview;
  byId('confirm-no').classList.toggle('danger', change);
  byId('confirm-yes').classList.toggle('danger', change);
  byId('saved-level').textContent = showPreview && savedInfo
    ? formatText(t.savedLevel, { level: savedInfo.level ?? 0 }) : '';
  const thumbnail = byId('saved-thumbnail');
  const url = showPreview ? savedInfo?.thumbnail : null;
  thumbnail.hidden = !url;
  if (url) thumbnail.src = url;
  else thumbnail.removeAttribute('src');
}

function confirmRun(intent) {
  confirmIntent = intent;
  renderSavedMenu();
  menu('confirm');
}

// Правовой экран: доступен с карточки, из меню, паузы и настроек.
function openLegal() {
  const from = ['cover', 'home', 'settings', 'pause', 'legal'].includes(view) ? view : 'cover';
  legalReturn = from === 'legal' ? legalReturn : from;
  menu('legal');
}

// --- экран настроек --------------------------------------------------------
function renderChrome() {
  renderSettingsInstall();
  byId('settings-change-rom').textContent = t.cardChangeRom;
  byId('settings-change-rom').hidden = !rom;
}

function renderSettings() {
  renderChrome();
  byId('settings-languages').querySelectorAll('button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.language === settings.language));
  });
}

// --- построение выпадающих опций ------------------------------------------
function addChoice(containerId, key, values, read, change, format = String) {
  const row = document.createElement('div');
  row.className = 'choice-row';
  const heading = document.createElement('small');
  heading.className = 'choice-label';
  const output = document.createElement('output');
  output.className = 'choice-value';
  function arrow(direction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-arrow ' + (direction < 0 ? 'prev' : 'next');
    button.onclick = () => {
      change(values[(values.indexOf(read()) + direction + values.length) % values.length]);
      settingsChanged();
    };
    return button;
  }
  const previous = arrow(-1), next = arrow(1);
  function refresh() {
    const label = t[key] ?? key;
    heading.textContent = label;
    output.setAttribute('aria-label', label);
    output.textContent = format(read(), t);
    previous.setAttribute('aria-label', t.previous + ' ' + String(label).toLowerCase());
    next.setAttribute('aria-label', t.next + ' ' + String(label).toLowerCase());
  }
  refresh();
  refreshChoices.push(refresh);
  row.append(heading, previous, output, next);
  byId(containerId).append(row);
}

function buildSettingsChoices() {
  addChoice('setup-choices', 'opponent', ['solo', 'vs', 'with'], () => settings.opponent,
    (value) => { settings.opponent = value; },
    (value) => value === 'vs' ? t.opponentVs : value === 'with' ? t.opponentWith : t.opponentSolo);
  addChoice('setup-choices', 'level', SETUP_LEVELS, () => settings.level, (n) => { settings.level = n; });
  addChoice('setup-choices', 'rows', SETUP_HANDICAPS, () => settings.handicap, (n) => { settings.handicap = n; });
  addChoice('settings-choices', 'effects', VOLUMES, () => settings.sound, (n) => { settings.sound = n; },
    (value) => value ? value + '%' : t.off);
  addChoice('settings-choices', 'music', VOLUMES, () => settings.musicVolume, (n) => { settings.musicVolume = n; },
    (value) => value ? value + '%' : t.off);
  addChoice('settings-choices', 'track', [SHUFFLE, ...TRACKS], () => settings.track, (n) => { settings.track = n; },
    (value) => value === SHUFFLE ? t.shuffle : (t.trackNames.split('|')[value - 1] ?? String(value)));
}

// --- обработчики интерфейса ------------------------------------------------
function openSettings(from) {
  settingsReturn = from;
  menu('settings');
}

function closeSettings() {
  menu(settingsReturn);
  byId(settingsReturn === 'pause' ? 'pause-settings' : 'home-settings')
    .focus({ preventScroll: true });
}

byId('home-settings').onclick = () => openSettings('home');
byId('pause-settings').onclick = () => openSettings('pause');
byId('settings-back').onclick = closeSettings;
byId('settings-change-rom').onclick = () => confirmRun('change-rom');

for (const button of byId('settings-languages').querySelectorAll('button')) {
  button.onclick = () => {
    if (button.dataset.language !== settings.language) applyLanguage(button.dataset.language);
  };
}

byId('step-rom').onclick = () => {
  if (cardBusyText) return;
  if (rom) confirmRun('change-rom');
  else openFilePicker();
};
byId('install-help-continue').onclick = goHome;
byId('install-help-back').onclick = () => goHome();
byId('rom-error-retry').onclick = () => openFilePicker();
byId('cover-legal').onclick = openLegal;
byId('home-legal').onclick = openLegal;
byId('pause-legal').onclick = openLegal;
byId('legal-back').onclick = () => menu(legalReturn);

byId('confirm-no').onclick = () => menu('home');
byId('confirm-yes').onclick = () => {
  if (confirmIntent === 'change-rom') { beginChangeRom(); return; }
  if (confirmIntent === 'replace') { menu('setup'); return; }
  void continueSavedRun();
};

byId('play').onclick = () => {
  if (!rom || engineState !== 'ready') return;
  unlockMenuMusic();
  if (mode === MODE_FULL) {
    if (savedInfo) confirmRun('replace');
    else menu('setup');
  } else {
    playAsIs();
  }
};
byId('continue-run').onclick = () => confirmRun('continue');
byId('records').onclick = () => { recordsAfterGame = false; menu('records'); };
byId('setup-back').onclick = home;
byId('start').onclick = () => { void beginFull(); };
byId('resume').onclick = resume;
byId('restart').onclick = restart;
byId('main-menu').onclick = home;
afterGame.onclick = byId('records-replay').onclick = () => {
  releaseAll();
  engine?.setPaused(true);
  if (mode === MODE_FULL) menu('setup');
  else menu('home');
};
byId('records-back').onclick = () => menu('home');

byId('rom-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  try { event.target.value = ''; } catch { /* не страшно */ }
  if (file) void importRomFile(file);
});

// --- drag&drop ROM ---------------------------------------------------------
let dragDepth = 0;
function isDropView() {
  return view === 'cover';
}
overlay.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (!isDropView()) return;
  dragDepth++;
  overlay.classList.add('dragging');
});
overlay.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
overlay.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.classList.remove('dragging');
});
overlay.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  overlay.classList.remove('dragging');
  if (!isDropView()) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) void importRomFile(file);
});

// --- игровые кнопки картриджа ---------------------------------------------
function advanceGameOver() {
  if (view === 'game' && mode === MODE_FULL) endGameWait(engine.nes);
}
gameOverNext.onclick = advanceGameOver;
byId('screen').addEventListener('click', () => {
  if (view !== 'game' || mode !== MODE_FULL) return;
  if (activeScene === 'dance') tapCartridge('a');
  if (activeScene === 'gameover') advanceGameOver();
});

// --- глобальные запреты ----------------------------------------------------
for (const type of ['contextmenu', 'selectstart', 'dragstart', 'dblclick', 'gesturestart', 'gesturechange']) {
  document.addEventListener(type, (event) => {
    if (event.target === recordInput && ['contextmenu', 'selectstart', 'dblclick'].includes(type)) return;
    event.preventDefault();
  }, { passive: false });
}
document.addEventListener('wheel', (event) => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false });

// --- клавиатура ------------------------------------------------------------
function isGameView() { return view === 'game'; }

window.addEventListener('keydown', (event) => {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target === recordInput) return;
  const code = event.code;
  if (event.isTrusted) unlockMenuMusic();
  if (isGameView()) {
    if (mode === MODE_FULL && activeScene === 'gameover' && (code === 'Enter' || code === 'Space')) {
      event.preventDefault();
      if (!event.repeat) advanceGameOver();
    } else if (BINDINGS[code]) {
      event.preventDefault();
      setInput(code, BINDINGS[code], true);
    } else if (['Escape', 'KeyP', 'Space', 'Enter'].includes(code)) {
      event.preventDefault();
      if (!event.repeat) {
        if (code === 'Enter' && !resultBar.hidden && !afterGame.hidden) afterGame.click();
        else pause();
      }
    }
    return;
  }
  if (code === 'Escape' || (code === 'KeyP' && view === 'pause')) {
    if (view === 'record-confirm' && code === 'Escape') {
      event.preventDefault();
      byId('record-confirm-no').click();
      return;
    }
    if (!['settings', 'pause', 'setup', 'confirm', 'records', 'cover', 'install-help', 'home', 'legal'].includes(view)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (view === 'legal') menu(legalReturn);
    else if (view === 'settings') closeSettings();
    else if (view === 'pause') resume();
    else if (view === 'home' || view === 'cover') return;
    else home();
    return;
  }
  if (view === 'home' && code === 'Enter' && !event.target.closest('button')) {
    event.preventDefault();
    if (!event.repeat && loaded) byId(savedInfo ? 'continue-run' : 'play').click();
  }
});
window.addEventListener('keyup', (event) => setInput(event.code, BINDINGS[event.code], false));
window.addEventListener('pointerup', (event) => {
  if (!event.isTrusted) return;
  if (view === 'game') engine?.wakeAudio();
  else unlockMenuMusic();
}, { capture: true });

// --- страница/аудио --------------------------------------------------------
function suspend(save = true) {
  pause(save);
}
window.addEventListener('blur', () => suspend(true));

function hidePage() {
  if (!pageLeaving && (view === 'game' || view === 'pause' || (view === 'settings' && settingsReturn === 'pause'))) {
    saveCurrentRun(true);
  }
  pageLeaving = true;
  engine?.stopMenuMusic?.();
  suspend(false);
  engine?.setAudioPageActive?.(false);
}

function showPage() {
  if (document.hidden) return;
  pageLeaving = false;
  engine?.setAudioPageActive?.(true);
  syncMenuMusic();
}
window.addEventListener('resize', schedulePadMetrics);
window.addEventListener('orientationchange', schedulePadMetrics);
window.addEventListener('pagehide', hidePage);
window.addEventListener('pageshow', showPage);
window.addEventListener('focus', showPage);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hidePage();
  else showPage();
});

window.addEventListener('storage', (event) => {
  if (!rom) return;
  if (event.key === recordsKey(rom.sha) || event.key === null) {
    records = loadRecords(rom.sha);
    if (view === 'records') renderRecords();
  }
});

// --- запуск ----------------------------------------------------------------
async function boot() {
  loadSettings();
  buildSettingsChoices();
  localize();
  renderAll();
  menu('cover', { focus: false });

  try {
    store = await openStore();
  } catch (error) {
    store = null;
    storeError = error;
    console.warn('IndexedDB unavailable', error);
  }

  installer = initInstall({
    canReload: () => view === 'home' || view === 'cover',
    onStateChange: () => renderInstallStatus()
  });

  if (store) {
    let active = null;
    try {
      active = await store.getActiveRom();
    } catch (error) {
      console.warn('active ROM read failed', error);
    }
    if (active?.sha) {
      try {
        const bytes = await store.getActiveRomBytes();
        if (!bytes?.length) throw new Error('stored ROM is empty');
        rom = { ...active, bytes, profile: active.profile ?? null };
        mode = rom.profile?.mode === MODE_FULL ? MODE_FULL : 'compatible';
        const storedLanguage = rom.profile?.language === 'ru' ? 'ru' : 'en';
        if (settings.language !== storedLanguage) {
          settings.language = storedLanguage;
          persistSettings();
        }
        coverDataUrl = await readUsableCover(active.sha);
        if (mode === MODE_FULL) {
          records = loadRecords(active.sha);
          runStore = await openSavedRun(active.sha);
          if (runStore) {
            try { savedInfo = await runStore.read(); } catch { savedInfo = null; }
          }
        }
      } catch (error) {
        console.warn('stored ROM is unusable', error);
        rom = null;
        await store.deleteRomData(active.sha).catch(() => {});
      }
    }
  }

  renderAll();
  if (!rom) {
    menu('cover');
  } else if (!installResolved()) {
    menu('cover');
  } else {
    menu('home');
  }
  if (rom) void loadEngine();
}

// Начальный экран нужен сразу, даже пока IndexedDB открывается.
try {
  await boot();
} catch (error) {
  console.error(error);
  try { showNotice(translations[settings.language].errEngine); } catch { /* страница пустая */ }
}
