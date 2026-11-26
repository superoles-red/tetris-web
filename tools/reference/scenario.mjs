// Сценарий ввода для эталонных прогонов: одинаковые нажатия для JSNES и
// нашего движка. Формат — простой JSON или строка DSL, номера кадров 1-based
// (кадр 1 — первый выполненный кадр).
//
// События применяются ПЕРЕД запуском указанного кадра. Поддерживаются формы:
//   { "frame": 100, "buttons": ["start"], "hold": 4 }  // нажать на 4 кадра
//   { "frame": 100, "down": ["start"], "up": ["a"] }   // явные фронты
//   { "frame": 100, "press": ["start"], "release": [] }// синонимы
//   { "from": 100, "until": 104, "buttons": ["start"] }// удержание
//   { "frame": 100, "buttons": ["start"] }             // нажать на 1 кадр
//
// Кнопки: a, b, select, start, up, down, left, right (коды JSNES 0..7) или
// числа 0..7. Строка DSL: "start@100+4,a@140+4" (кнопка@кадр[+удержание]).

/** Коды кнопок JSNES Controller: совпадают с src/nes/constants.js. */
export const BUTTON_CODES = Object.freeze({
  a: 0,
  b: 1,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
});

export const BUTTON_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(BUTTON_CODES).map(([name, code]) => [code, name])),
);

/** Готовые сценарии, проверенные на Tengen Tetris (см. tests/reference.test.mjs). */
export const SCENARIOS = Object.freeze({
  none: [],
  menu: [
    { frame: 100, buttons: ['start'], hold: 4 },
  ],
  // Доводит Tengen Tetris до сцены игры ($29=0, геймплей с ~340 кадра) и
  // двигает фигуру в игре. Проверено на обоих известных дампах.
  gameplay: [
    { frame: 100, buttons: ['start'], hold: 4 },
    { frame: 160, buttons: ['start'], hold: 4 },
    { frame: 220, buttons: ['start'], hold: 4 },
    { frame: 280, buttons: ['start'], hold: 4 },
    { frame: 340, buttons: ['start'], hold: 4 },
    { frame: 480, buttons: ['down'], hold: 2 },
    { frame: 520, buttons: ['left'], hold: 2 },
    { frame: 560, buttons: ['a'], hold: 2 },
  ],
});

/**
 * Приводит одну кнопку к коду JSNES.
 * @param {string|number} button
 * @returns {number}
 */
export function buttonCode(button) {
  if (typeof button === 'number') {
    if (!Number.isInteger(button) || button < 0 || button > 7) {
      throw new Error(`Неверный код кнопки: ${button}`);
    }
    return button;
  }
  const name = String(button).trim().toLowerCase();
  if (name in BUTTON_CODES) return BUTTON_CODES[name];
  throw new Error(`Неизвестная кнопка: ${button}. Доступно: ${Object.keys(BUTTON_CODES).join(', ')}`);
}

function buttonList(value, where) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') {
    // "start+a" / "start,a" / "start" — допустимые разделители.
    return value.split(/[+,]/).map(part => buttonCode(part.trim())).filter(() => true);
  }
  if (!Array.isArray(value)) throw new Error(`${where}: ожидался массив кнопок или строка.`);
  return value.map(buttonCode);
}

function requireFrame(value, where) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${where}: frame должен быть целым неотрицательным числом, пришло: ${value}`);
  }
  return value;
}

/**
 * Разворачивает сценарий в список атомарных событий
 * `{frame, down: number[], up: number[]}` по возрастанию кадра.
 * @param {any} input
 * @returns {{frame: number, down: number[], up: number[]}[]}
 */
export function normalizeScenario(input) {
  if (input === undefined || input === null || input === '') return [];
  let events = input;
  if (typeof input === 'string') {
    // Имя готового пресета ('gameplay') или DSL ('start@100+4').
    events = input in SCENARIOS ? SCENARIOS[input] : parseScenarioText(input);
  }
  if (events && !Array.isArray(events) && Array.isArray(events.events)) events = events.events;
  if (!Array.isArray(events)) throw new Error('Сценарий ввода: ожидался массив событий или строка DSL.');

  const atomic = [];
  events.forEach((event, index) => {
    const where = `сценарий[${index}]`;
    if (!event || typeof event !== 'object') throw new Error(`${where}: ожидался объект.`);
    const down = [
      ...buttonList(event.down, where),
      ...buttonList(event.press, where),
      ...buttonList(event.buttons, where),
    ];
    const up = [...buttonList(event.up, where), ...buttonList(event.release, where)];
    // Явные down/up — это фронты: down держится, пока не будет up. Авто-отпуск
    // после кадра применяется только к форме buttons/press (+hold/until).
    const hasPressForm =
      event.buttons !== undefined ||
      event.press !== undefined ||
      event.release !== undefined ||
      event.hold !== undefined ||
      event.until !== undefined;

    let start = event.frame;
    if (start === undefined) start = event.from;
    if (start === undefined) throw new Error(`${where}: нужен frame (или from).`);
    start = requireFrame(start, where);

    let holdEnd = null;
    const hold = event.hold;
    if (event.until !== undefined) holdEnd = requireFrame(event.until, where);
    else if (hold !== undefined) {
      const length = Number(hold);
      if (!Number.isInteger(length) || length < 1) throw new Error(`${where}: hold должен быть >= 1.`);
      holdEnd = start + length;
    } else if (down.length && hasPressForm) {
      holdEnd = start + 1; // форма buttons/press без hold держится ровно один кадр
    }

    atomic.push({ frame: start, down: [...new Set(down)], up: [...new Set(up)] });
    if (holdEnd !== null && down.length) {
      atomic.push({ frame: holdEnd, down: [], up: [...new Set(down)] });
    }
  });

  // Слияние событий одного кадра: сохраняем порядок down/up, как задан.
  atomic.sort((a, b) => a.frame - b.frame);
  const merged = [];
  for (const event of atomic) {
    const last = merged[merged.length - 1];
    if (last && last.frame === event.frame) {
      last.down.push(...event.down);
      last.up.push(...event.up);
    } else {
      merged.push({ frame: event.frame, down: [...event.down], up: [...event.up] });
    }
  }
  return merged;
}

/**
 * DSL: "start@100+4,a@140" → массив событий формы {frame,buttons,hold}.
 * @param {string} text
 */
export function parseScenarioText(text) {
  const events = [];
  for (const part of String(text).split(',')) {
    const item = part.trim();
    if (!item) continue;
    if (item.startsWith('[') || item.startsWith('{')) throw new Error('Похоже на JSON: передайте его файлом через --input.');
    const match = /^([a-z0-9+]+)@(\d+)(?:\+(\d+))?$/i.exec(item);
    if (!match) {
      throw new Error(
        `Неверный элемент сценария "${item}". Формат: кнопка@кадр[+удержание], например start@100+4`,
      );
    }
    const event = { frame: Number(match[2]), buttons: match[1].split('+') };
    if (match[3] !== undefined) event.hold = Number(match[3]);
    events.push(event);
  }
  return events;
}

/**
 * Применяет события указанного кадра (1-based) через колбэки движка.
 * @param {{frame:number, down:number[], up:number[]}[]} scenario
 * @param {number} frame 1-based номер кадра
 * @param {(code:number)=>void} buttonDown
 * @param {(code:number)=>void} buttonUp
 * @returns {{down:number[], up:number[]}|null}
 */
export function applyScenarioAtFrame(scenario, frame, buttonDown, buttonUp) {
  let applied = null;
  for (const event of scenario) {
    if (event.frame !== frame) continue;
    for (const code of event.down) buttonDown(code);
    for (const code of event.up) buttonUp(code);
    applied ??= { down: [], up: [] };
    applied.down.push(...event.down);
    applied.up.push(...event.up);
  }
  return applied;
}

/** Сценарий в виде, пригодном для JSON-отчёта (без служебных множеств). */
export function scenarioToJson(scenario) {
  return scenario.map(event => ({
    frame: event.frame,
    down: event.down.map(code => BUTTON_NAMES[code]),
    up: event.up.map(code => BUTTON_NAMES[code]),
  }));
}
