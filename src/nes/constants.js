// Общие константы движка: раскладка памяти WASM, коды кнопок, палитра NES.
// Цвета хранятся в формате JSNES/BGR: 0x00BBGGRR. Это важно: compositor.js
// ожидает именно такие значения в ppu.buffer и ppu.sprPalette.

/** Адресное пространство CPU: 64 КиБ, RAM в начале, окно PRG в конце. */
export const CPU_SPACE_SIZE = 0x10000;

/** Состояние регистров CPU в linear memory: A, X, Y, SP, P (байты). */
export const CPU_STATE = 0x010000;
export const CPU_A = CPU_STATE + 0;
export const CPU_X = CPU_STATE + 1;
export const CPU_Y = CPU_STATE + 2;
export const CPU_SP = CPU_STATE + 3;
export const CPU_P = CPU_STATE + 4;

/** Минимальный размер памяти WASM-модуля: 2 страницы по 64 КиБ. */
export const WASM_MEMORY_PAGES = 2;

/** Начало окна PRG в адресном пространстве CPU. */
export const PRG_WINDOW = 0x8000;

/** Битовая упаковка результата блока: nextPC | (cycles << 16). */
export const RESULT_PC_MASK = 0xffff;
export const RESULT_CYCLES_SHIFT = 16;

/** Флаги регистра P (6502). */
export const FLAG_C = 0x01;
export const FLAG_Z = 0x02;
export const FLAG_I = 0x04;
export const FLAG_D = 0x08;
export const FLAG_B = 0x10;
export const FLAG_U = 0x20;
export const FLAG_V = 0x40;
export const FLAG_N = 0x80;
export const FLAG_INIT = FLAG_U | FLAG_I;

/** Векторы прерываний. */
export const VECTOR_NMI = 0xfffa;
export const VECTOR_RESET = 0xfffc;
export const VECTOR_IRQ = 0xfffe;

/** Коды кнопок совпадают с JSNES Controller: удобно для старого app.js. */
export const BUTTON_A = 0;
export const BUTTON_B = 1;
export const BUTTON_SELECT = 2;
export const BUTTON_START = 3;
export const BUTTON_UP = 4;
export const BUTTON_DOWN = 5;
export const BUTTON_LEFT = 6;
export const BUTTON_RIGHT = 7;

/** Палитра NES (NTSC) в BGR-порядке — значения из публичной таблицы JSNES. */
export const NTSC_PALETTE_BGR = [
  0x525252, 0xb40000, 0xa00000, 0xb1003d, 0x740069, 0x00005b, 0x00005f, 0x001840,
  0x002f10, 0x084a08, 0x006700, 0x124200, 0x6d2800, 0x000000, 0x000000, 0x000000,
  0xc4d5e7, 0xff4000, 0xdc0e22, 0xff476b, 0xd7009f, 0x680ad7, 0x0019bc, 0x0054b1,
  0x006a5b, 0x008c03, 0x00ab00, 0x2c8800, 0xa47200, 0x000000, 0x000000, 0x000000,
  0xf8f8f8, 0xffab3c, 0xff7981, 0xff5bc5, 0xff48f2, 0xdf49ff, 0x476dff, 0x00b4f7,
  0x00e0ff, 0x00e375, 0x03f42b, 0x78b82e, 0xe5e218, 0x787878, 0x000000, 0x000000,
  0xffffff, 0xfff2be, 0xf8b8b8, 0xf8b8d8, 0xffb6ff, 0xffc3ff, 0xc7d1ff, 0x9adaff,
  0x88edf8, 0x83ffdd, 0xb8f8b8, 0xf5f8ac, 0xffffb0, 0xf8d8f8, 0x000000, 0x000000,
];

/** Тайминги PPU NTSC. */
export const PPU_DOTS_PER_SCANLINE = 341;
export const PPU_SCANLINES = 262;
export const PPU_VBLANK_SCANLINE = 241;
export const PPU_VISIBLE_SCANLINES = 240;
export const PPU_PRERENDER_SCANLINE = 261;

/** Индекс таблицы блоков WASM для адреса CPU. */
export const BLOCK_INDEX = pc => pc - PRG_WINDOW;
