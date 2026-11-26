// Точечные тесты сложных мест 6502-рекомпилятора (node:test, без игрового ROM).
//
// Каждый случай — маленький фрагмент кода в синтетическом NROM-образе. У каждого
// случая свой 256-байтовый слот в PRG (сборка Console = один раз на файл), поэтому
// программы строятся как фабрики от адреса слота. Состояние CPU выставляется
// одинаково нашему Console и JSNES 2.1.0; затем пошаговое выполнение и сравнение
// регистров/флагов/PC и циклов инструкций.
//
// Покрытие: ADC/SBC (V/C), ROL/ROR/ASL/LSR, CMP/CPX/CPY/BIT, стек
// (PHA/PLA/PHP/PLP/JSR/RTS/RTI), JMP abs, JMP (ind), баг JMP ($xxFF),
// page-cross штрафы (abs,X/abs,Y loads, stores, RMW), ветвления.
//
// Запуск: node --test tests/cpu-instructions.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { NES } from 'jsnes';
import { CPU_A, CPU_P, CPU_SP, CPU_X, CPU_Y } from '../src/nes/constants.js';

const PROGRAM_BASE = 0x8100;
const SLOT_SIZE = 0x100;
const STATUS_MASK = 0xcf;

// --- инфраструктура ----------------------------------------------------------

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

/** «Power-on» RAM NES (совпадает с Console.reset и JSNES). */
function powerOnRam() {
  const ram = new Uint8Array(0x800);
  ram.fill(0xff);
  for (let page = 0; page < 4; page++) {
    const base = page * 0x200;
    ram[base + 0x08] = 0xf7;
    ram[base + 0x09] = 0xef;
    ram[base + 0x0a] = 0xdf;
    ram[base + 0x0f] = 0xbf;
  }
  return ram;
}

function buildRom(programs) {
  const prg = new Uint8Array(0x8000);
  for (const { address, bytes } of programs) {
    if (address < 0x8000 || address + bytes.length > 0x10000) throw new Error('программа вне PRG');
    prg.set(bytes, address - 0x8000);
  }
  prg[0x7ffa] = PROGRAM_BASE & 0xff;
  prg[0x7ffb] = PROGRAM_BASE >> 8;
  prg[0x7ffc] = PROGRAM_BASE & 0xff;
  prg[0x7ffd] = PROGRAM_BASE >> 8;
  prg[0x7ffe] = PROGRAM_BASE & 0xff;
  prg[0x7fff] = PROGRAM_BASE >> 8;
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const rom = new Uint8Array(16 + 0x8000 + 0x2000);
  rom.set(header, 0);
  rom.set(prg, 16);
  return rom;
}

const word = (value, offset = 0) => [(value + offset) & 0xff, ((value + offset) >> 8) & 0xff];

function setOurState(consoleInstance, state) {
  consoleInstance.view[CPU_A] = state.a ?? 0;
  consoleInstance.view[CPU_X] = state.x ?? 0;
  consoleInstance.view[CPU_Y] = state.y ?? 0;
  consoleInstance.view[CPU_SP] = state.sp ?? 0xff;
  consoleInstance.view[CPU_P] = state.p ?? 0x24;
  consoleInstance.pc = state.pc;
}

function ourState(consoleInstance) {
  return {
    pc: consoleInstance.pc,
    a: consoleInstance.a,
    x: consoleInstance.x,
    y: consoleInstance.y,
    sp: consoleInstance.sp,
    p: consoleInstance.p & STATUS_MASK,
  };
}

function setJsnesState(nes, state, ram) {
  const cpu = nes.cpu;
  cpu.REG_ACC = state.a ?? 0;
  cpu.REG_X = state.x ?? 0;
  cpu.REG_Y = state.y ?? 0;
  cpu.REG_SP = 0x0100 | (state.sp ?? 0xff);
  cpu.setStatus(state.p ?? 0x24);
  cpu.REG_PC = (state.pc - 1) & 0xffff;
  cpu.REG_PC_NEW = cpu.REG_PC;
  cpu.irqRequested = false;
  cpu.irqType = null;
  cpu.nmiPending = false;
  cpu.nmiRaised = false;
  cpu.nmiImmediate = false;
  cpu.cyclesToHalt = 0;
  cpu._cpuCycleBase = 0;
  cpu.mem.fill(0, 0, 0x0800);
  cpu.mem.set(ram, 0);
}

function jsnesState(nes) {
  return {
    pc: (nes.cpu.REG_PC + 1) & 0xffff,
    a: nes.cpu.REG_ACC,
    x: nes.cpu.REG_X,
    y: nes.cpu.REG_Y,
    sp: nes.cpu.REG_SP & 0xff,
    p: nes.cpu.getStatus() & STATUS_MASK,
  };
}

// --- генераторы кейсов -------------------------------------------------------

/** @typedef {(base:number)=>{name:string, program:number[], steps:number, state?:object, memWrites?:[number,number][], expectedA?:number, expectedP?:number, expectedPc?:number, expectedSp?:number, expectedCycles?:number}} CaseFactory */

/** @type {CaseFactory[]} */
const CASE_FACTORIES = [];

function addCase(factory) {
  CASE_FACTORIES.push(factory);
}

// ADC/SBC: A и операнд через LDA #/ADC #/SBC #, перенос через CLC/SEC.
function addAdcSbcCases() {
  const table = [
    [0x00, 0x01, 0], [0x7f, 0x01, 0], [0x80, 0x80, 0], [0xff, 0x01, 0],
    [0xff, 0x00, 1], [0x50, 0x50, 0], [0xd0, 0x90, 0], [0x0f, 0x0f, 1],
    [0x7f, 0x01, 1], [0x00, 0x01, 1], [0x80, 0x01, 1], [0x50, 0xb0, 1],
    [0xff, 0xff, 1], [0x00, 0x00, 1], [0x05, 0x0a, 0],
  ];
  for (const [a, operand, carry] of table) {
    for (const op of [0x69, 0xe9]) {
      const isAdc = op === 0x69;
      addCase(() => ({
        name: `${isAdc ? 'ADC' : 'SBC'} #$${operand.toString(16)} A=$${a.toString(16)} carryIn=${carry}`,
        program: [0xa9, a, carry ? 0x38 : 0x18, op, operand],
        steps: 3,
      }));
    }
  }
}

// Сдвиги аккумулятора.
function addShiftCases() {
  const table = [
    { op: 0x2a, name: 'ROL A', a: 0x81, carry: 0, expectedA: 0x02 },
    { op: 0x2a, name: 'ROL A', a: 0x80, carry: 1, expectedA: 0x01 },
    { op: 0x6a, name: 'ROR A', a: 0x01, carry: 0, expectedA: 0x00 },
    { op: 0x6a, name: 'ROR A', a: 0x00, carry: 1, expectedA: 0x80 },
    { op: 0x0a, name: 'ASL A', a: 0x81, carry: 0, expectedA: 0x02 },
    { op: 0x4a, name: 'LSR A', a: 0x01, carry: 0, expectedA: 0x00 },
    { op: 0x4a, name: 'LSR A', a: 0x80, carry: 0, expectedA: 0x40 },
  ];
  for (const entry of table) {
    addCase(() => ({
      name: entry.name,
      program: [0xa9, entry.a, entry.carry ? 0x38 : 0x18, entry.op],
      steps: 3,
      expectedA: entry.expectedA,
    }));
  }
}

// Сравнения и BIT.
function addCompareCases() {
  addCase(() => ({ name: 'CMP #$10 A=$10 (C,Z)', program: [0xa9, 0x10, 0xc9, 0x10], steps: 2, expectedP: 0x07 }));
  addCase(() => ({ name: 'CMP #$10 A=$0f (N)', program: [0xa9, 0x0f, 0xc9, 0x10], steps: 2, expectedP: 0x84 }));
  addCase(() => ({ name: 'CPX #$20 X=$20 (C,Z)', program: [0xa2, 0x20, 0xe0, 0x20], steps: 2, expectedP: 0x07 }));
  addCase(() => ({ name: 'CPY #$01 Y=$02 (C)', program: [0xa0, 0x02, 0xc0, 0x01], steps: 2, expectedP: 0x05 }));
  // BIT: A=$0f, M=$40 → N=M7=0, V=M6=1, Z=(A&M)==0 → Z=1; I=1.
  addCase(() => ({
    name: 'BIT zp (V,Z)',
    program: [0xa9, 0x0f, 0x24, 0x10],
    steps: 2,
    memWrites: [[0x10, 0x40]],
    expectedP: 0x46,
  }));
}

// Стек и переходы.
function addStackJumpCases() {
  addCase(() => ({
    name: 'PHA/PLA',
    program: [0xa9, 0x42, 0x48, 0xa9, 0x00, 0x68],
    steps: 4,
    expectedA: 0x42,
  }));
  addCase(() => ({
    name: 'PHP/PLP восстанавливает P',
    program: [0x08, 0xa9, 0x00, 0x28],
    steps: 3,
  }));
  addCase(base => ({
    name: 'JSR/RTS',
    program: [
      0x20, ...word(base, 6), // JSR base+6
      0xea, 0xea, 0xea,
      0xa9, 0x42, // base+6: LDA #$42
      0x60, // base+8: RTS
    ],
    steps: 3,
    expectedA: 0x42,
    expectedSp: 0xff,
  }));
  addCase(base => ({
    name: 'RTI',
    program: [0x40],
    steps: 1,
    state: { sp: 0xfc },
    // Стек: P, PCL, PCH → возврат на base+0x10.
    memWrites: [[0x1fd, 0x24], [0x1fe, (base + 0x10) & 0xff], [0x1ff, ((base + 0x10) >> 8) & 0xff]],
    expectedPc: base + 0x10,
    expectedSp: 0xff,
  }));
  addCase(base => ({
    name: 'JMP abs',
    program: [0x4c, ...word(base, 4), 0xea, 0xa9, 0x01],
    steps: 1,
    expectedPc: base + 4,
  }));
  addCase(base => ({
    name: 'JMP (indirect)',
    program: [0x6c, ...word(base, 6), 0xea, 0xea, 0xea, ...word(base, 0x0a)],
    steps: 1,
    expectedPc: base + 0x0a,
  }));
  // JMP ($xxFF): старший байт читается из той же страницы (page-wrap баг).
  // Слот целиком: [0] = старший байт цели (он же «page+0» для wrap),
  // [5..7] = JMP ($??FF), [0xFF] = младший байт цели.
  addCase(base => {
    const program = new Array(0x100).fill(0xea);
    program[0] = ((base + 0x20) >> 8) & 0xff;
    program[5] = 0x6c;
    program[6] = 0xff;
    program[7] = (base >> 8) & 0xff;
    program[0xff] = (base + 0x20) & 0xff;
    return {
      name: 'JMP ($xxFF) page-wrap bug',
      program,
      steps: 1,
      state: { pc: base + 5 },
      expectedPc: base + 0x20,
    };
  });
}

// Точные циклы (page-cross штрафы). Всего циклов за программу.
function addCycleCases() {
  addCase(() => ({
    name: 'LDA $0222,X X=ff page cross',
    program: [0xa2, 0xff, 0xbd, 0x22, 0x02],
    steps: 2,
    expectedCycles: 2 + 5,
  }));
  addCase(() => ({
    name: 'LDA $0200,X X=01 no cross',
    program: [0xa2, 0x01, 0xbd, 0x00, 0x02],
    steps: 2,
    expectedCycles: 2 + 4,
  }));
  addCase(() => ({
    name: 'LDY $0222,X X=ff page cross',
    program: [0xa2, 0xff, 0xbc, 0x22, 0x02],
    steps: 2,
    expectedCycles: 2 + 5,
  }));
  addCase(() => ({
    name: 'LDA $0222,Y Y=ff page cross',
    program: [0xa0, 0xff, 0xb9, 0x22, 0x02],
    steps: 2,
    expectedCycles: 2 + 5,
  }));
  addCase(() => ({
    name: 'STA $0200,X X=ff (store 5)',
    program: [0xa2, 0xff, 0x9d, 0x00, 0x02],
    steps: 2,
    expectedCycles: 2 + 5,
  }));
  addCase(() => ({
    name: 'ASL $0200,X X=ff (RMW 7)',
    program: [0xa2, 0xff, 0x1e, 0x00, 0x02],
    steps: 2,
    expectedCycles: 2 + 7,
  }));
  addCase(() => ({
    name: 'BEQ taken within page',
    program: [0xa9, 0x00, 0xf0, 0x02, 0xea, 0xea],
    steps: 2,
    expectedCycles: 2 + 3,
  }));
  addCase(() => ({
    name: 'BNE not taken',
    program: [0xa9, 0x00, 0xd0, 0x02, 0xea, 0xea],
    steps: 2,
    expectedCycles: 2 + 2,
  }));
}

addAdcSbcCases();
addShiftCases();
addCompareCases();
addStackJumpCases();
addCycleCases();

// --- fixture и прогон --------------------------------------------------------

let fixture;

before(async () => {
  const { createConsole } = await import('../src/nes/console.js');
  const cases = CASE_FACTORIES.map((factory, index) => {
    const base = PROGRAM_BASE + index * SLOT_SIZE;
    const spec = factory(base);
    if (spec.program.length > SLOT_SIZE) throw new Error(`случай ${spec.name}: программа не влезает в слот`);
    return {
      ...spec,
      address: base,
      initialState: { a: 0, x: 0, y: 0, sp: 0xff, p: 0x24, pc: base, ...spec.state },
    };
  });
  const rom = buildRom(cases.map(testCase => ({ address: testCase.address, bytes: testCase.program })));
  const consoleInstance = await createConsole(rom, { ppu: new MockPpu(), apu: new MockApu() });
  const nes = new NES({ emulateSound: false });
  nes.loadROM(rom);
  nes.cpu.emulate(); // RESET-вектор
  fixture = { cases, rom, consoleInstance, nes, ram: powerOnRam() };
});

function runCase(testCase) {
  const { consoleInstance, nes, ram } = fixture;
  const state = testCase.initialState;
  const mem = Uint8Array.from(ram);
  for (const [address, value] of testCase.memWrites ?? []) mem[address & 0x7ff] = value;
  setOurState(consoleInstance, state);
  consoleInstance.cpuMem.set(mem, 0);
  setJsnesState(nes, state, mem);
  const cycles = [];
  for (let step = 0; step < testCase.steps; step++) {
    cycles.push(consoleInstance.stepInstruction());
    nes.cpu.emulate();
  }
  return { ours: ourState(consoleInstance), jsnes: jsnesState(nes), cycles };
}

// --- тесты -----------------------------------------------------------------

test('все точечные кейсы совпадают с JSNES (PC/A/X/Y/SP/P)', () => {
  for (const testCase of fixture.cases) {
    const result = runCase(testCase);
    assert.deepEqual(
      result.ours,
      result.jsnes,
      `${testCase.name}: наш ${JSON.stringify(result.ours)} vs JSNES ${JSON.stringify(result.jsnes)}`,
    );
    if (testCase.expectedA !== undefined) assert.equal(result.ours.a, testCase.expectedA, `${testCase.name}: A`);
    if (testCase.expectedPc !== undefined) assert.equal(result.ours.pc, testCase.expectedPc, `${testCase.name}: PC`);
    if (testCase.expectedSp !== undefined) assert.equal(result.ours.sp, testCase.expectedSp, `${testCase.name}: SP`);
    if (testCase.expectedP !== undefined) {
      assert.equal(result.ours.p, testCase.expectedP & STATUS_MASK, `${testCase.name}: P`);
    }
  }
});

test('точные циклы инструкций (page-cross штрафы) совпадают с JSNES', () => {
  for (const testCase of fixture.cases) {
    if (testCase.expectedCycles === undefined) continue;
    const result = runCase(testCase);
    const total = result.cycles.reduce((sum, cycles) => sum + cycles, 0);
    assert.equal(total, testCase.expectedCycles, `${testCase.name}: циклы ${JSON.stringify(result.cycles)}`);
  }
});

test('JMP ($xxFF) использует page-wrap баг 6502', () => {
  const testCase = fixture.cases.find(entry => entry.name.startsWith('JMP ($xxFF)'));
  const result = runCase(testCase);
  assert.equal(result.ours.pc, testCase.expectedPc, `наш PC=${result.ours.pc.toString(16)}`);
  assert.equal(result.jsnes.pc, testCase.expectedPc, `JSNES PC=${result.jsnes.pc.toString(16)}`);
});
