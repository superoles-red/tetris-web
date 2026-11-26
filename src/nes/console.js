// Консоль: шина, тактирование CPU, прерывания, контроллеры, снапшоты.
// Связывает скомпилированный WASM-код игры с моделями PPU/APU и маппером.

import { createMapper } from './mapper.js';
import { compileRom } from './compile.js';
import { parseRom } from './rom.js';
import {
  CPU_A, CPU_P, CPU_SP, CPU_STATE, CPU_X, CPU_Y,
  FLAG_I, FLAG_U, PRG_WINDOW, VECTOR_IRQ, VECTOR_NMI, VECTOR_RESET,
} from './constants.js';
const BUTTON_COUNT = 8;

export class ConsoleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
  }
}

/** Класс консоли: публичный фасад для движка, тестов и сравнения с эталоном. */
export class Console {
  /**
   * @param {ReturnType<import('./rom.js').parseRom>} romInfo
   * @param {{
   *   wasmModule?: WebAssembly.Module, wasmBytes?: Uint8Array,
   *   ppu?: any, apu?: any, sampleRate?: number,
   *   onAudioSample?: (left: number, right: number) => void,
   * }} [options]
   */
  constructor(romInfo, options = {}) {
    this.romInfo = romInfo;
    this.mirroring = romInfo.mirroring;
    this.sampleRate = options.sampleRate ?? 48000;
    this.ppu = options.ppu ?? null;
    this.apu = options.apu ?? null;
    this.mapper = createMapper(romInfo, {
      onPrgWindow: bytes => this.#writePrgWindow(bytes),
      onChrWindow: bytes => this.ppu.setChrWindow(bytes),
    });
    this.buttons = [new Uint8Array(BUTTON_COUNT), new Uint8Array(BUTTON_COUNT)];
    this.strobe = 0;
    this.buttonShift = [0, 0];
    this.dmaCycles = 0;
    this.cycles = 0;
    this.frameCount = 0;
    this.pc = 0;
    this.memory = null;
    this.view = null;
    this.instance = null;
    this.moduleBytes = options.wasmBytes ?? null;
    this.wasmModule = options.wasmModule ?? null;
    this.ready = false;
  }

  static async create(romInfo, options = {}) {
    let wasmBytes = options.wasmBytes ?? null;
    let wasmModule = options.wasmModule ?? null;
    const ppu = options.ppu ?? new (await import('./ppu.js')).PPU();
    const apu = options.apu ?? new (await import('./apu.js')).APU({
      sampleRate: options.sampleRate ?? 48000,
      onSample: (left, right) => options.onAudioSample?.(left, right),
    });
    if (!wasmModule) {
      if (!wasmBytes) wasmBytes = compileRom(romInfo).wasm;
      wasmModule = await WebAssembly.compile(wasmBytes);
    }
    const console = new Console(romInfo, { ...options, ppu, apu, wasmModule, wasmBytes });
    await console.#instantiate(wasmModule);
    return console;
  }

  async #instantiate(wasmModule) {
    const imports = {
      env: {
        read: address => this.readBus(address),
        write: (address, value) => this.writeBus(address, value),
        illegal: pc => {
          throw new ConsoleError('illegal-opcode', `Игра остановилась: недокументированная или неверная инструкция 6502 по адресу $${pc.toString(16)}.`);
        },
      },
    };
    this.instance = await WebAssembly.instantiate(wasmModule, imports);
    this.memory = this.instance.exports.memory;
    this.view = new Uint8Array(this.memory.buffer);
    this.ready = true;
    this.reset();
  }

  // --- память и шина ---------------------------------------------------------
  #writePrgWindow(bytes) {
    if (!this.view) return;
    this.view.set(bytes, PRG_WINDOW);
  }

  /** Чтение CPU-шины (используется импортом read и тестами). */
  readBus(address) {
    address &= 0xffff;
    if (address < 0x2000) return this.view[address & 0x7ff];
    if (address < 0x4000) return this.ppu.readReg(address & 0x7);
    if (address < 0x4018) return this.#readIo(address);
    if (address < 0x6000) return 0; // открытая шина/расширение
    if (address < 0x8000) return this.wram ? this.wram[address - 0x6000] : 0;
    return this.view[address];
  }

  /** Запись в CPU-шину. */
  writeBus(address, value) {
    address &= 0xffff;
    value &= 0xff;
    if (address < 0x2000) {
      this.view[address & 0x7ff] = value;
      return;
    }
    if (address < 0x4000) {
      this.ppu.writeReg(address & 0x7, value);
      return;
    }
    if (address < 0x4018) {
      this.#writeIo(address, value);
      return;
    }
    if (address < 0x6000) return;
    if (address < 0x8000) {
      if (this.wram) this.wram[address - 0x6000] = value;
      return;
    }
    this.mapper.writeRegister(address, value);
  }

  #readIo(address) {
    switch (address) {
      case 0x4014: return 0;
      case 0x4015: return this.apu.readReg(0x4015);
      case 0x4016: return this.#readController(0);
      case 0x4017: return this.#readController(1);
      default:
        return this.apu.readReg(address);
    }
  }

  #writeIo(address, value) {
    switch (address) {
      case 0x4014: {
        const page = value << 8;
        // DMA читает страницу CPU-памяти; для RAM это зеркала 0x0000-0x07FF.
        for (let i = 0; i < 256; i++) {
          this.ppu.spriteMem[i] = this.view[(page + i) & 0x7ff];
        }
        this.dmaCycles += 513;
        return;
      }
      case 0x4016: {
        this.strobe = value & 1;
        if (this.strobe) {
          for (let i = 0; i < 2; i++) {
            let bits = 0;
            for (let b = 0; b < BUTTON_COUNT; b++) bits |= this.buttons[i][b] << b;
            this.buttonShift[i] = bits;
          }
        }
        return;
      }
      case 0x4017:
        this.apu.writeReg(0x4017, value);
        return;
      default:
        this.apu.writeReg(address, value);
    }
  }

  #readController(player) {
    const shift = this.buttonShift[player];
    const value = (this.strobe ? (this.buttons[player][0] & 1) : (shift & 1)) | 0x40;
    if (!this.strobe) this.buttonShift[player] = shift >> 1;
    return value;
  }

  // --- управление ------------------------------------------------------------
  buttonDown(player, code) {
    const pad = this.buttons[player - 1];
    if (pad && code >= 0 && code < BUTTON_COUNT) pad[code] = 1;
  }

  buttonUp(player, code) {
    const pad = this.buttons[player - 1];
    if (pad && code >= 0 && code < BUTTON_COUNT) pad[code] = 0;
  }

  clearButtons() {
    this.buttons[0].fill(0);
    this.buttons[1].fill(0);
  }

  get cpuMem() {
    return this.view ? this.view.subarray(0, 0x10000) : null;
  }

  // --- состояние CPU ---------------------------------------------------------
  get a() { return this.view[CPU_A]; }
  get x() { return this.view[CPU_X]; }
  get y() { return this.view[CPU_Y]; }
  get sp() { return this.view[CPU_SP]; }
  get p() { return this.view[CPU_P]; }
  get resetVector() { return this.view[VECTOR_RESET] | (this.view[VECTOR_RESET + 1] << 8); }

  reset() {
    if (!this.ready) return;
    this.view.fill(0, 0, 0x10000);
    // Эталон JSNES заполняет ОЗУ 0xFF при включении и ставит «power-on»
    // паттерн в первых байтах зеркал. Повторяем для совпадения кадров.
    this.view.fill(0xff, 0, 0x2000);
    for (let page = 0; page < 4; page++) {
      const base = page * 0x800;
      this.view[base + 0x08] = 0xf7;
      this.view[base + 0x09] = 0xef;
      this.view[base + 0x0a] = 0xdf;
      this.view[base + 0x0f] = 0xbf;
    }
    this.wram = this.romInfo.battery ? new Uint8Array(0x2000) : null;
    this.mapper.reset();
    this.view[CPU_A] = 0;
    this.view[CPU_X] = 0;
    this.view[CPU_Y] = 0;
    this.view[CPU_SP] = 0xfd;
    this.view[CPU_P] = FLAG_U | FLAG_I;
    this.cycles = 0;
    this.frameCount = 0;
    this.dmaCycles = 0;
    this.pc = this.resetVector;
    this.buttons[0].fill(0);
    this.buttons[1].fill(0);
    this.buttonShift[0] = 0;
    this.buttonShift[1] = 0;
    this.ppu.reset?.(this.romInfo.mirroring);
    this.ppu.setMirroring?.(this.romInfo.mirroring);
    this.apu.reset?.();
  }

  /** Одна инструкция 6502 (для отладки и дифференциальных тестов). */
  stepInstruction() {
    const result = this.instance.exports.step(this.pc);
    this.pc = result & 0xffff;
    const cycles = (result >>> 16) & 0xff;
    this.cycles += cycles;
    return cycles;
  }

  #takeInterrupt(vector, cycles) {
    const view = this.view;
    let sp = view[CPU_SP];
    const pushByte = value => {
      view[0x100 + sp] = value;
      sp = (sp - 1) & 0xff;
    };
    pushByte((this.pc >> 8) & 0xff);
    pushByte(this.pc & 0xff);
    pushByte((view[CPU_P] | FLAG_U) & ~0x10);
    view[CPU_SP] = sp;
    view[CPU_P] |= FLAG_I;
    this.pc = view[vector] | (view[vector + 1] << 8);
    this.cycles += cycles;
    this.ppu.advanceDots(cycles * 3);
    this.apu.advance(cycles);
  }

  /** Выполняет один кадр; возвращает true, если кадр завершён. */
  frame() {
    if (!this.ready) throw new ConsoleError('not-ready', 'Консоль не инициализирована.');
    this.ppu.startFrame?.();
    let guard = 0;
    const maxInstructions = 400000;
    while (true) {
      if (++guard > maxInstructions) {
        throw new ConsoleError('hang', 'Игра не доходит до конца кадра: возможно, зависла или зависла музыка.');
      }
      const result = this.instance.exports.step(this.pc);
      this.pc = result & 0xffff;
      const cycles = (result >>> 16) & 0xff;
      this.cycles += cycles;
      this.ppu.advanceDots(cycles * 3);
      this.apu.advance(cycles);
      if (this.dmaCycles) {
        this.ppu.advanceDots(this.dmaCycles * 3);
        this.apu.advance(this.dmaCycles);
        this.cycles += this.dmaCycles;
        this.dmaCycles = 0;
      }
      if (this.ppu.nmiPending && !(this.view[CPU_P] & FLAG_I)) {
        this.ppu.nmiPending = false;
        this.#takeInterrupt(VECTOR_NMI, 7);
      } else if (this.apu.irqPending && !(this.view[CPU_P] & FLAG_I)) {
        this.apu.acknowledgeIrq?.();
        this.#takeInterrupt(VECTOR_IRQ, 7);
      }
      if (this.ppu.frameEnded) {
        this.ppu.frameEnded = false;
        this.frameCount++;
        return true;
      }
    }
  }

  /** Снапшот полного состояния (для сохранений и сравнения). */
  toJSON() {
    const ram = new Array(0x800);
    for (let i = 0; i < 0x800; i++) ram[i] = this.view[i];
    return {
      version: 1,
      cycles: this.cycles,
      frameCount: this.frameCount,
      pc: this.pc,
      cpu: { a: this.view[CPU_A], x: this.view[CPU_X], y: this.view[CPU_Y], sp: this.view[CPU_SP], p: this.view[CPU_P], ram },
      mapper: this.mapper.snapshot(),
      ppu: this.ppu.toJSON(),
      apu: this.apu.toJSON(),
      buttons: [Array.from(this.buttons[0]), Array.from(this.buttons[1])],
      wram: this.wram ? Array.from(this.wram) : null,
    };
  }

  fromJSON(state) {
    if (!state || state.version !== 1) throw new ConsoleError('state', 'Несовместимый формат сохранения.');
    this.view.fill(0, 0, 0x10000);
    for (let i = 0; i < 0x800; i++) this.view[i] = state.cpu.ram[i];
    this.view[CPU_A] = state.cpu.a;
    this.view[CPU_X] = state.cpu.x;
    this.view[CPU_Y] = state.cpu.y;
    this.view[CPU_SP] = state.cpu.sp;
    this.view[CPU_P] = state.cpu.p;
    this.pc = state.pc;
    this.cycles = state.cycles;
    this.frameCount = state.frameCount;
    this.wram = state.wram ? Uint8Array.from(state.wram) : null;
    this.mapper.restore(state.mapper);
    this.ppu.fromJSON(state.ppu);
    this.apu.fromJSON(state.apu);
    if (state.buttons) {
      this.buttons[0].set(state.buttons[0]);
      this.buttons[1].set(state.buttons[1]);
    }
  }
}

/**
 * Удобный конструктор: разбирает ROM и создаёт консоль.
 * @param {Uint8Array} romBytes
 * @param {object} [options]
 */
export async function createConsole(romBytes, options = {}) {
  const romInfo = parseRom(romBytes);
  if (!romInfo.supported) throw new ConsoleError('rom', romInfo.reason ?? 'Этот ROM не поддерживается.');
  return Console.create(romInfo, options);
}

export { CPU_STATE };
