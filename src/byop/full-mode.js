// Надстройки «полного режима» для известных дампов Tengen Tetris.
// Здесь только логика поверх RAM картриджа: выбор экрана, готовность
// Game Over, автозапуск одиночной партии. Адреса и значения — из старого
// рабочего порта; применяются ТОЛЬКО когда паспорт дампа совпал с каталогом.
// Для незнакомых ROM (совместимый режим) этот модуль не используется.

/** Экраны, которые картридж держит в $29. */
const SCENES = new Map([
  [0xfa, 'title'],
  [0xfb, 'demo'],
  [0xfc, 'mode'],
  [0xfd, 'level'],
  [0xfe, 'handicap'],
  [0xff, 'music'],
  [0x00, 'play'],
  [0x01, 'pause'],
  [0x03, 'dance'],
  [0xf9, 'gameover'],
  [0xf8, 'scores']
]);

/** Экраны меню, с которых можно снимать menu-checkpoint. */
export function opponentFromRam(value) {
  // В 0x4f0 картридж держит выбранный пункт меню режима: 0 — 1 игрок,
  // 3 — VS COMPUTER, 4 — WITH COMPUTER. Это источник правды при Continue.
  return value === 3 ? 'vs' : value === 4 ? 'with' : 'solo';
}

export const MENU_SCENES = new Set(['title', 'demo', 'mode', 'level', 'handicap', 'music']);

/** Экраны, где идёт партия (для сохранений). */
export const RUN_SCENES = new Set(['play', 'dance']);

export function isMenuScene(scene) {
  return MENU_SCENES.has(scene);
}

export function isRunScene(scene) {
  return RUN_SCENES.has(scene);
}

/** Текущий экран картриджа по RAM. `boot` — пока память не инициализирована. */
export function readScene(nes) {
  const ram = nes?.cpu?.mem;
  if (!ram) return 'boot';
  // RAM может быть неинициализирована, пока PPU прогревается.
  if (ram[0x49] !== 1 || (ram[0x29] === 0 && ram[0x4a] === 0)) return 'boot';
  return SCENES.get(ram[0x29]) ?? 'boot';
}

/** Игрок вводит инициалы на экране рекордов. */
export function enteringInitials(nes) {
  return readScene(nes) === 'scores' && nes.cpu.mem[0x74] !== 0;
}

/** Game Over доигран: можно показать кнопку и пустить картридж к таблице. */
export function gameOverReady(nes) {
  if (readScene(nes) !== 'gameover') return false;
  const ram = nes.cpu.mem;
  // Джингл заканчивается примерно на тике 173; даём буферу аудио догореть.
  if (ram[0x6a] > 168) return false;
  for (let i = 0; i < 11; i++) {
    if (ram[0x020e + i] === 5 && ram[0x0292 + i]) return false;
  }
  return true;
}

/** Отпускает картридж на собственный переход Game Over → рекорды. */
export function endGameWait(nes) {
  if (gameOverReady(nes)) nes.cpu.mem[0x6a] = 1;
}

const START = 3, UP = 4, DOWN = 5;
const MENU_SIZES = { mode: 5, level: 10, handicap: 5, music: 5 };
const CURSOR_ADDRESS = { mode: 0x4f0, level: 0x4f1, handicap: 0x4f3, music: 0x4f5 };

function clampIndex(value, max, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : fallback;
}

/**
 * Автозапуск одиночной партии через родные меню картриджа.
 * Вызывать раз в эмулированный кадр; `true` — картридж уже в игре.
 * Все выборы идут через контроллер 1: так нативный код сам инициализирует
 * RNG, сетку столкновений и счёт.
 * @param {{level?: number, handicap?: number, music?: number, mode?: number}} options
 *   mode — пункт меню игры: 0 «1 PLAYER», 3 «VERSUS COMPUTER».
 */
export function createSoloStart({ level = 0, handicap = 0, music = 1, mode = 0 } = {}) {
  const selections = {
    mode: clampIndex(mode, 4, 0),
    level: clampIndex(level, 9, 0),
    handicap: clampIndex(handicap / 3, 4, 0),
    music: clampIndex(music, 4, 1)
  };

  // Даже при ускоренном проходе меню тайминг нажатия влияет на RNG картриджа,
  // как и на настоящей NES.
  let wait = Math.floor(performance.now() * 10) % 32;
  let held = null;

  return function advanceMenu(nes) {
    if (held !== null) {
      nes.buttonUp(1, held);
      held = null;
      wait = 2;
    }
    const scene = readScene(nes);
    if (scene === 'play') return true;
    if (wait > 0) {
      wait--;
      return false;
    }

    let button = START;
    if (scene in selections) {
      const current = nes.cpu.mem[CURSOR_ADDRESS[scene]];
      const target = selections[scene];
      if (target !== current) {
        const size = MENU_SIZES[scene];
        const downSteps = (target + size - current) % size;
        button = downSteps <= size / 2 ? DOWN : UP;
      }
    } else if (!['title', 'demo', 'gameover', 'scores'].includes(scene) || enteringInitials(nes)) {
      return false;
    }
    nes.buttonDown(1, button);
    held = button;
    return false;
  };
}

/** Меню настроек новой партии для полного режима. */
export const SETUP_LEVELS = Array.from({ length: 10 }, (_, n) => n);
export const SETUP_HANDICAPS = [0, 3, 6, 9, 12];
