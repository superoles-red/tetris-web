#!/usr/bin/env node
// Дифференциальный тест CPU: наш перекомпилированный WASM-6502 против JSNES
// 2.1.0 (devDependency, эталон). Синтетический ROM генерируется в тесте —
// игровой ROM не нужен, поэтому тест работает в CI.
//
// Идея: случайная корректная программа из документированных инструкций
// 6502 (без BRK/RTI/RTS/JAM и недокументированных), выполняемая шаг за шагом
// обоими движками. Сравниваем PC, A, X, Y, SP, P (маска 0xCF), число циклов
// инструкции и RAM $0000-$07FF. Первое расхождение = шаг, адрес, байты
// инструкции, состояния до/после, дифф RAM; ROM и отчёт пишутся в /tmp.
//
// Ограничения программы (по постановке lead):
//  - операнды — RAM $0000-$07FF и PRG $8000-$FFFF;
//  - записи только в RAM; I/O ($2000-$5FFF) не трогаем;
//  - ветвления/JMP/JSR — только на границы уже сгенерированных инструкций
//    внутри $8100-$FE00; RTS/RTI не генерируются (стек может заворачиваться,
//    сравниваем побайтово — это детерминированно);
//  - JMP (indirect) по умолчанию исключён: известный баг compile.js
//    (двойная косвенность, сообщён lead). Включить: --include-jmp-indirect.
//
// Запуск:
//   node tests/cpu-differential.mjs [--seeds 5] [--steps 3000] [--json /tmp/report.json]
//   node tests/cpu-differential.test.mjs   // короткая версия для node --test
//
// Код выхода: 0 — всё совпало, 1 — есть расхождения, 2 — ошибка.

import { writeFile, mkdir } from 'node:fs/promises';
import { NES } from 'jsnes';
import { isMain, parseArgs, intOption, formatError, NotReadyError } from '../tools/reference/cli.mjs';

// --- таблица официальных инструкций NMOS 6502 ---------------------------------

const M = {
  imp: 'imp', acc: 'acc', imm: 'imm', zp: 'zp', zpx: 'zpx', zpy: 'zpy', abs: 'abs',
  absx: 'absx', absy: 'absy', indx: 'indx', indy: 'indy', rel: 'rel', ind: 'ind',
};

/** opcode → { mnemonic, mode } только для документированных инструкций. */
export const OFFICIAL_OPCODES = (() => {
  const groups = {
    ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, indx: 0x61, indy: 0x71 },
    AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, indx: 0x21, indy: 0x31 },
    ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e },
    BCC: { rel: 0x90 }, BCS: { rel: 0xb0 }, BEQ: { rel: 0xf0 }, BMI: { rel: 0x30 },
    BNE: { rel: 0xd0 }, BPL: { rel: 0x10 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
    BIT: { zp: 0x24, abs: 0x2c },
    CLC: { imp: 0x18 }, CLD: { imp: 0xd8 }, CLI: { imp: 0x58 }, CLV: { imp: 0xb8 },
    CMP: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, indx: 0xc1, indy: 0xd1 },
    CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec },
    CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
    DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde },
    DEX: { imp: 0xca }, DEY: { imp: 0x88 },
    EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, indx: 0x41, indy: 0x51 },
    INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe },
    INX: { imp: 0xe8 }, INY: { imp: 0xc8 },
    JMP: { abs: 0x4c, ind: 0x6c },
    JSR: { abs: 0x20 },
    LDA: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, indx: 0xa1, indy: 0xb1 },
    LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe },
    LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc },
    LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e },
    NOP: { imp: 0xea },
    ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, indx: 0x01, indy: 0x11 },
    PHA: { imp: 0x48 }, PHP: { imp: 0x08 }, PLA: { imp: 0x68 }, PLP: { imp: 0x28 },
    ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e },
    ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e },
    SBC: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, indx: 0xe1, indy: 0xf1 },
    SEC: { imp: 0x38 }, SED: { imp: 0xf8 }, SEI: { imp: 0x78 },
    STA: { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, indx: 0x81, indy: 0x91 },
    STX: { zp: 0x86, zpy: 0x96, abs: 0x8e },
    STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
    TAX: { imp: 0xaa }, TAY: { imp: 0xa8 }, TSX: { imp: 0xba },
    TXA: { imp: 0x8a }, TXS: { imp: 0x9a }, TYA: { imp: 0x98 },
  };
  const table = new Array(256).fill(null);
  for (const [mnemonic, modes] of Object.entries(groups)) {
    for (const [mode, opcode] of Object.entries(modes)) table[opcode] = { mnemonic, mode };
  }
  return table;
})();

/** Длина инструкции по режиму адресации. */
export function instructionLength(mode) {
  switch (mode) {
    case M.imp: case M.acc: return 1;
    case M.imm: case M.zp: case M.zpx: case M.zpy: case M.indx: case M.indy: case M.rel: return 2;
    default: return 3;
  }
}

/** Множители для генератора: какие инструкции и в какой пропорции. */
const READ_ALU = ['LDA', 'LDX', 'LDY', 'AND', 'ORA', 'EOR', 'ADC', 'SBC', 'CMP', 'CPX', 'CPY', 'BIT'];
const RMW = ['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC'];
const STORES = ['STA', 'STX', 'STY'];
const IMPLIED = [
  'CLC', 'SEC', 'CLI', 'SEI', 'CLV', 'CLD', 'SED', 'TAX', 'TAY', 'TXA', 'TYA', 'TSX', 'TXS',
  'INX', 'INY', 'DEX', 'DEY', 'PHA', 'PHP', 'PLA', 'PLP', 'NOP',
];
const BRANCHES = ['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS'];

/** PRNG (mulberry32): детерминированные программы по номеру seed. */
function makeRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = max => Math.floor(next() * max);
  const pick = list => list[int(list.length)];
  const byte = () => int(256);
  const word = (min, max) => min + int(max - min + 1);
  return { next, int, pick, byte, word };
}

/**
 * Генерирует синтетический NROM-образ со случайной программой.
 * @param {{seed?: number, steps?: number, includeJmpIndirect?: boolean}} [options]
 */
export function generateSyntheticRom(options = {}) {
  const { seed = 1, steps = 3000, includeJmpIndirect = false } = options;
  const random = makeRandom(seed);
  const PROGRAM_START = 0x8100;
  const MAX_PROGRAM_END = 0xfc00;
  const rom = new Uint8Array(16 + 0x8000 + 0x2000); // iNES: 2×16K PRG, 8K CHR
  rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  const prg = rom.subarray(16, 16 + 0x8000);
  const records = []; // {address, length, bytes:number[], control: null|{kind, operandIndex}}
  let address = PROGRAM_START;

  const emit = (opcode, operands, control = null) => {
    const bytes = [opcode, ...operands];
    const record = {
      address,
      length: bytes.length,
      bytes,
      control: control ? { ...control, operandIndex: 1 } : null,
    };
    records.push(record);
    address += bytes.length;
    return record;
  };

  const randomPointerAddress = () => random.word(0x0200, 0x07ff);
  const randomPrgAddress = () => {
    // Ссылки на инструкции программы; правим после генерации по границам.
    return random.word(PROGRAM_START, Math.min(address, MAX_PROGRAM_END - 3));
  };
  const randomReadAddress = () =>
    random.next() < 0.5 ? randomPointerAddress() : randomPrgAddress();

  for (let index = 0; index < steps; index++) {
    const category = random.int(100);
    if (category < 55) {
      // ALU/загрузка/сравнение с разными режимами.
      const mnemonic = random.pick(READ_ALU);
      const modes = [];
      for (const [opcode, info] of OFFICIAL_OPCODES.entries()) {
        if (info && info.mnemonic === mnemonic && info.mode !== M.ind) modes.push([opcode, info.mode]);
      }
      const [opcode, mode] = random.pick(modes);
      switch (mode) {
        case M.imm: emit(opcode, [random.byte()]); break;
        // (zp,X) не генерируем: X случаен, указатель может выйти из защищённой
        // зоны zero page и попасть в I/O — тогда сравнение читало бы регистры.
        case M.zp: emit(opcode, [random.word(0x10, 0x7f)]); break;
        case M.zpx: emit(opcode, [random.word(0x10, 0x7f)]); break;
        case M.zpy: emit(opcode, [random.word(0x10, 0x7f)]); break;
        case M.abs: {
          const target = randomReadAddress();
          emit(opcode, [target & 0xff, target >> 8]);
          break;
        }
        case M.absx: {
          const base = random.next() < 0.5 ? random.word(0x0200, 0x0600) : random.word(0x8100, 0xb000);
          emit(opcode, [base & 0xff, base >> 8]);
          break;
        }
        case M.absy: {
          const base = random.next() < 0.5 ? random.word(0x0200, 0x0600) : random.word(0x8100, 0xb000);
          emit(opcode, [base & 0xff, base >> 8]);
          break;
        }
        case M.indy: {
          // Указатель из защищённой зоны zero page $00-$0E (её программа не пишет).
          emit(opcode, [random.int(8) * 2]);
          break;
        }
        default:
          emit(0xea, []);
      }
    } else if (category < 68) {
      // Read-modify-write и записи — только в RAM ($0200-$07FF) и только
      // absolute-режимы: zp-запись с индексом может завернуться в защищённую
      // зону указателей $00-$0F и сломать (zp),Y. INDY пишет по указателю из
      // защищённой зоны (RAM/PRG + Y), в I/O не попадает.
      const mnemonic = random.pick([...RMW, ...STORES]);
      const allowed = new Set([M.abs, M.absx, M.absy, M.indy]);
      const modes = [];
      for (const [opcode, info] of OFFICIAL_OPCODES.entries()) {
        if (info && info.mnemonic === mnemonic && allowed.has(info.mode)) modes.push([opcode, info.mode]);
      }
      const [opcode, mode] = random.pick(modes);
      switch (mode) {
        case M.abs: {
          const target = randomPointerAddress();
          emit(opcode, [target & 0xff, target >> 8]);
          break;
        }
        case M.absx: {
          const target = random.word(0x0200, 0x0600);
          emit(opcode, [target & 0xff, target >> 8]);
          break;
        }
        case M.absy: {
          const target = random.word(0x0200, 0x0600);
          emit(opcode, [target & 0xff, target >> 8]);
          break;
        }
        case M.indy: {
          emit(opcode, [random.int(8) * 2]);
          break;
        }
        default:
          emit(0xea, []);
      }
    } else if (category < 82) {
      // Implied/accumulator.
      const mnemonic = random.pick(IMPLIED);
      const modes = [];
      for (const [opcode, info] of OFFICIAL_OPCODES.entries()) {
        if (info && info.mnemonic === mnemonic) modes.push([opcode, info.mode]);
      }
      const [opcode] = random.pick(modes);
      emit(opcode, []);
    } else if (category < 90) {
      if (address > MAX_PROGRAM_END - 0x400) continue;
      // Branches: цель будет выбрана по границам после генерации.
      const mnemonic = random.pick(BRANCHES);
      let opcode = null;
      for (const [candidate, info] of OFFICIAL_OPCODES.entries()) {
        if (info && info.mnemonic === mnemonic) opcode = candidate;
      }
      emit(opcode, [0], { kind: 'branch' });
    } else if (category < 95) {
      emit(0x4c, [0, 0], { kind: 'jmp' }); // JMP absolute
    } else if (category < 98) {
      emit(0x20, [0, 0], { kind: 'jsr' }); // JSR, без RTS (стек детерминирован)
    } else if (includeJmpIndirect) {
      emit(0x6c, [0, 0], { kind: 'jmp-indirect' }); // JMP (indirect) — известный баг
    } else {
      emit(0xea, []);
    }
    if (address > MAX_PROGRAM_END) break;
  }

  // Границы инструкций — цели переходов.
  const boundaries = records.map(record => record.address);
  const randomBoundary = () => boundaries[random.int(boundaries.length)];

  for (const record of records) {
    if (!record.control) continue;
    const nextAddress = record.address + record.length;
    if (record.control.kind === 'branch') {
      const candidates = boundaries.filter(target => {
        const offset = target - nextAddress;
        return offset >= -128 && offset <= 127 && target !== record.address;
      });
      const target = candidates.length ? random.pick(candidates) : nextAddress;
      record.bytes[1] = (target - nextAddress) & 0xff;
    } else if (record.control.kind === 'jmp' || record.control.kind === 'jsr') {
      // Цель в [$8100, $FE00] и на границе инструкции.
      const candidates = boundaries.filter(target => target >= PROGRAM_START && target <= 0xfe00);
      const target = random.pick(candidates);
      record.bytes[1] = target & 0xff;
      record.bytes[2] = target >> 8;
    } else if (record.control.kind === 'jmp-indirect') {
      // Указатель в PRG (данные программы): пишем в конец программы.
      const pointerAddress = MAX_PROGRAM_END - 2; // $FBFE: зона данных программы
      const target = random.pick(boundaries);
      prg[pointerAddress - 0x8000] = target & 0xff;
      prg[pointerAddress - 0x8000 + 1] = target >> 8;
      record.bytes[1] = pointerAddress & 0xff;
      record.bytes[2] = pointerAddress >> 8;
    }
  }

  // Записываем программу в PRG.
  for (const record of records) prg.set(record.bytes, record.address - 0x8000);
  // Векторы: reset = старт программы; NMI/IRQ туда же (не должны срабатывать).
  prg[0x7ffa] = PROGRAM_START & 0xff; prg[0x7ffb] = PROGRAM_START >> 8;
  prg[0x7ffc] = PROGRAM_START & 0xff; prg[0x7ffd] = PROGRAM_START >> 8;
  prg[0x7ffe] = PROGRAM_START & 0xff; prg[0x7fff] = PROGRAM_START >> 8;

  return {
    rom,
    ram: null, // заполняется в runDifferentialSeed после инициализации RAM
    seed,
    steps: records.length,
    programStart: PROGRAM_START,
    programEnd: records.length ? records.at(-1).address + records.at(-1).length : PROGRAM_START,
    instructionCount: records.length,
  };
}

// --- синхронизация JSNES с начальным состоянием нашего Console ----------------

class MockPpu {
  constructor() {
    this.buffer = new Uint32Array(256 * 240);
    this.vramMem = new Uint8Array(0x8000);
    this.spriteMem = new Uint8Array(0x100);
    this.sprPalette = new Uint32Array(16);
    this.imgPalette = new Uint32Array(16);
    this.ptTile = Array.from({ length: 512 }, () => ({ pix: new Uint8Array(64) }));
    this.frameEnded = false;
    this.nmiPending = false;
  }
  setMirroring() {}
  setChrWindow(bytes) {
    this.vramMem.set(bytes.subarray(0, 0x2000), 0);
  }
  reset() {}
  startFrame() {}
  advanceDots() {}
  renderFullFrame() {}
  toJSON() { return {}; }
  fromJSON() {}
}

class MockApu {
  constructor() {
    this.irqPending = false;
    this.channels = { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 };
  }
  reset() {}
  advance() {}
  writeReg() {}
  readReg() { return 0; }
  acknowledgeIrq() {}
  toJSON() { return {}; }
  fromJSON() {}
}

async function createOurConsole(rom, consoleUrl = null) {
  let module;
  try {
    module = await import(consoleUrl ?? new URL('../src/nes/console.js', import.meta.url));
  } catch (error) {
    throw new NotReadyError(`Наш движок не загружается: ${formatError(error)}`);
  }
  let consoleInstance;
  try {
    consoleInstance = await module.createConsole(rom, { ppu: new MockPpu(), apu: new MockApu() });
  } catch (error) {
    throw new NotReadyError(`Console не создался: ${formatError(error)}`);
  }
  if (typeof consoleInstance.stepInstruction !== 'function') {
    throw new NotReadyError('У Console нет stepInstruction().');
  }
  return consoleInstance;
}

function createReferenceNes(rom) {
  const nes = new NES({ emulateSound: false });
  nes.loadROM(rom);
  // Первый emulate() обслуживает RESET-вектор (7 циклов).
  nes.cpu.emulate();
  return nes;
}

const STATUS_MASK = 0xcf; // C, Z, I, D, V, N; B/U игнорируем

function snapshotConsole(consoleInstance) {
  return {
    pc: consoleInstance.pc,
    a: consoleInstance.a,
    x: consoleInstance.x,
    y: consoleInstance.y,
    sp: consoleInstance.sp,
    p: consoleInstance.p & STATUS_MASK,
    cycles: consoleInstance.cycles,
  };
}

/** Полный P (с B/U) — только для синхронизации JSNES: PHP/PLP учитывают эти биты. */
function fullStatus(consoleInstance) {
  return consoleInstance.p;
}

function snapshotJsnes(nes) {
  return {
    pc: (nes.cpu.REG_PC + 1) & 0xffff,
    a: nes.cpu.REG_ACC,
    x: nes.cpu.REG_X,
    y: nes.cpu.REG_Y,
    sp: nes.cpu.REG_SP & 0xff,
    p: nes.cpu.getStatus() & STATUS_MASK,
    cycles: nes.cpu._cpuCycleBase,
  };
}

function syncJsnesState(nes, state, ram) {
  const cpu = nes.cpu;
  cpu.REG_ACC = state.a;
  cpu.REG_X = state.x;
  cpu.REG_Y = state.y;
  cpu.REG_SP = 0x0100 | state.sp;
  cpu.setStatus(state.p);
  cpu.REG_PC = (state.pc - 1) & 0xffff;
  cpu.REG_PC_NEW = cpu.REG_PC;
  cpu.irqRequested = false;
  cpu.irqType = null;
  cpu.nmiPending = false;
  cpu.nmiRaised = false;
  cpu.nmiImmediate = false;
  cpu.cyclesToHalt = 0;
  cpu._cpuCycleBase = 0;
  for (let i = 0; i < ram.length && i < cpu.mem.length; i++) cpu.mem[i] = ram[i];
}

/** Грубый дизасм инструкции по PRG-образу и RAM (для отчёта о расхождении). */
function describeInstruction(generated, address) {
  const prg = generated.rom.subarray(16, 16 + 0x8000);
  const readByte = position => (position >= 0x8000 ? prg[position - 0x8000] : generated.ram?.[position] ?? 0);
  const opcode = readByte(address) ?? 0;
  const info = OFFICIAL_OPCODES[opcode];
  const length = info ? instructionLength(info.mode) : 1;
  const bytes = [];
  for (let i = 0; i < Math.max(length, 1); i++) bytes.push(readByte((address + i) & 0xffff));
  return {
    address,
    opcode,
    bytes: bytes.map(byte => `$${Number(byte ?? 0).toString(16).padStart(2, '0')}`),
    mnemonic: info ? `${info.mnemonic} (${info.mode})` : 'неизвестная',
  };
}

// --- прогон одного seed -------------------------------------------------------

/**
 * Прогоняет одну случайную программу на обоих движках шаг за шагом.
 * @param {{seed?: number, steps?: number, includeJmpIndirect?: boolean, saveFailure?: boolean}} [options]
 */
export async function runDifferentialSeed(options = {}) {
  const {
    seed = 1,
    steps = 3000,
    includeJmpIndirect = false,
    consoleUrl = null,
    checkCycles = true,
  } = options;
  const generated = generateSyntheticRom({ seed, steps, includeJmpIndirect });
  const consoleInstance = await createOurConsole(generated.rom, consoleUrl);
  const nes = createReferenceNes(generated.rom);

  // Одинаковая «power-on» RAM и указатели для (zp),Y.
  const ram = consoleInstance.cpuMem;
  const random = makeRandom((seed ^ 0x9e3779b9) >>> 0);
  for (let pointer = 0; pointer < 8; pointer++) {
    const zp = pointer * 2;
    const target = random.next() < 0.5 ? random.word(0x0200, 0x07ff) : generated.programStart + random.int(generated.instructionCount) * 3;
    ram[zp] = target & 0xff;
    ram[zp + 1] = (target >> 8) & 0xff;
  }
  const ramImage = ram.slice(0, 0x0800);
  generated.ram = ramImage;
  nes.cpu.mem.set(ramImage, 0);

  const initialState = snapshotConsole(consoleInstance);
  const initialFullP = fullStatus(consoleInstance);
  syncJsnesState(nes, { ...initialState, p: initialFullP }, ramImage);

  const startedAt = Date.now();
  for (let step = 1; step <= steps; step++) {
    const before = snapshotConsole(consoleInstance);
    const beforeJs = snapshotJsnes(nes);
    const jsnesStateBefore = { ...beforeJs };

    let ourCycles;
    let jsnesStepCycles;
    let oursAfter;
    let jsnesAfter;
    try {
      ourCycles = consoleInstance.stepInstruction();
      oursAfter = snapshotConsole(consoleInstance);
    } catch (error) {
      return {
        seed,
        steps,
        passed: false,
        reason: 'our-exception',
        step,
        instruction: describeInstruction(generated, before.pc),
        error: formatError(error),
      };
    }
    try {
      jsnesStepCycles = nes.cpu.emulate();
      jsnesAfter = snapshotJsnes(nes);
    } catch (error) {
      return {
        seed,
        steps,
        passed: false,
        reason: 'jsnes-exception',
        step,
        instruction: describeInstruction(generated, before.pc),
        error: formatError(error),
      };
    }

    const expectedCycles = 0xff & ourCycles;
    const stateMismatch =
      oursAfter.pc !== jsnesAfter.pc ||
      oursAfter.a !== jsnesAfter.a ||
      oursAfter.x !== jsnesAfter.x ||
      oursAfter.y !== jsnesAfter.y ||
      oursAfter.sp !== jsnesAfter.sp ||
      oursAfter.p !== jsnesAfter.p;
    const cycleMismatch = checkCycles && expectedCycles !== jsnesStepCycles;

    let ramMismatch = null;
    if (!stateMismatch) {
      for (let i = 0; i < 0x0800; i++) {
        if (ram[i] !== nes.cpu.mem[i]) {
          ramMismatch = { offset: i, ours: ram[i], jsnes: nes.cpu.mem[i] };
          break;
        }
      }
    }

    if (stateMismatch || cycleMismatch || ramMismatch) {
      return {
        seed,
        steps,
        passed: false,
        reason: stateMismatch ? 'state' : cycleMismatch ? 'cycles' : 'ram',
        step,
        instruction: describeInstruction(generated, before.pc),
        before: { ours: before, jsnes: jsnesStateBefore },
        after: { ours: oursAfter, jsnes: jsnesAfter },
        cycles: { ours: expectedCycles, jsnes: jsnesStepCycles },
        ramMismatch,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  return {
    seed,
    steps,
    passed: true,
    instructions: steps,
    programEnd: generated.programEnd,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Прогоняет несколько seed'ов.
 * @param {{seeds?: number[], steps?: number, includeJmpIndirect?: boolean, saveFailure?: boolean}} [options]
 */
export async function runDifferential(options = {}) {
  const {
    seeds = [1, 2, 3, 4, 5],
    steps = 3000,
    includeJmpIndirect = false,
    saveFailure = false,
    consoleUrl = null,
    checkCycles = true,
  } = options;
  const results = [];
  for (const seed of seeds) {
    const result = await runDifferentialSeed({ seed, steps, includeJmpIndirect, consoleUrl, checkCycles });
    results.push(result);
    if (!result.passed) {
      if (saveFailure) {
        const generated = generateSyntheticRom({ seed, steps, includeJmpIndirect });
        await mkdir('/tmp', { recursive: true });
        const path = `/tmp/cpu-diff-fail-seed${seed}.nes`;
        await writeFile(path, generated.rom);
        result.romPath = path;
        result.romSha256 = undefined;
      }
      break;
    }
  }
  return {
    tool: 'cpu-differential',
    engine: 'ours vs jsnes 2.1.0',
    steps,
    seeds,
    includeJmpIndirect,
    checkCycles,
    results,
    passed: results.every(result => result.passed),
  };
}

const HELP = `
Дифференциальный тест CPU: наш WASM-6502 против JSNES (dev-only, без игрового ROM).

Использование:
  node tests/cpu-differential.mjs [опции]

Опции:
  --seeds <список>        seed'ы программ: "1,2,3" (по умолчанию 1..5)
  --steps <N>             инструкций на seed (по умолчанию 3000)
  --include-jmp-indirect  включить JMP (indirect) — известный баг compile.js
  --ignore-cycles         не сравнивать число циклов (только состояние и RAM)
  --json <path>           отчёт (по умолчанию /tmp/cpu-differential-report.json)
  --quiet                 без прогресса
  --help                  эта справка

Код выхода: 0 — всё совпало, 1 — расхождение, 2 — ошибка/движок не готов.
`;

async function main() {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(HELP.trimStart() + '\n');
    return;
  }
  const quiet = args.quiet === true;
  const seeds = args.seeds
    ? String(args.seeds).split(',').map(value => Number(value.trim())).filter(Number.isFinite)
    : [1, 2, 3, 4, 5];
  try {
    const report = await runDifferential({
      seeds,
      steps: intOption(args.steps, 3000),
      includeJmpIndirect: args['include-jmp-indirect'] === true,
      checkCycles: args['ignore-cycles'] !== true,
      saveFailure: true,
    });
    const outPath = args.json ? String(args.json) : '/tmp/cpu-differential-report.json';
    await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
    for (const result of report.results) {
      if (result.passed) {
        if (!quiet) console.error(`✔ seed ${result.seed}: ${result.instructions} инструкций совпали (${result.elapsedMs} мс)`);
        continue;
      }
      console.error(`✘ seed ${result.seed}, шаг ${result.step}: ${result.reason}`);
      console.error(`  инструкция: $${result.instruction.address.toString(16)} ${result.instruction.mnemonic} ${result.instruction.bytes.join(' ')}`);
      if (result.error) console.error(`  ошибка: ${result.error}`);
      if (result.before) {
        console.error(`  до:     ours ${JSON.stringify(result.before.ours)}`);
        console.error(`          jsnes ${JSON.stringify(result.before.jsnes)}`);
        console.error(`  после:  ours ${JSON.stringify(result.after.ours)}`);
        console.error(`          jsnes ${JSON.stringify(result.after.jsnes)}`);
        console.error(`  циклы:  ours ${result.cycles.ours}, jsnes ${result.cycles.jsnes}`);
      }
      if (result.ramMismatch) {
        console.error(
          `  RAM $${result.ramMismatch.offset.toString(16).padStart(4, '0')}: ` +
            `ours $${result.ramMismatch.ours.toString(16)}, jsnes $${result.ramMismatch.jsnes.toString(16)}`,
        );
      }
      if (result.romPath) console.error(`  ROM для отладки: ${result.romPath}`);
    }
    console.error(`  отчёт: ${outPath}`);
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    if (error instanceof NotReadyError) {
      console.error(`\nДвижок не готов: ${error.message}`);
      process.exit(2);
    }
    console.error(`Ошибка cpu-differential: ${formatError(error)}`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
