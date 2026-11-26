#!/usr/bin/env node
// Конформанс CPU: публичный функциональный тест Klaus Dormann (GPL-3.0)
// прогоняется через наш скомпилированный WASM 6502 (Console.stepInstruction).
//
// Тест скачивается по пину SHA-256: node tools/fetch-cpu-test.mjs
// (в репозиторий не коммитится, в CI скачивается заново).
//
// Как тест попадает в NES-адресное пространство:
//  - оригинальный образ — 64 КиБ, код с $0400, адрес успеха $3469;
//  - наш движок исполняет только $8000-$FFFF, поэтому код переносится
//    $0400→$8000 (+$7C00), абсолютные операнды и указатели в коде правятся;
//  - пропускаются блоки, которых на 2A03 быть не может:
//      * self-modifying branch-range тест ($0444..$0581) — код в ROM не пишется;
//      * decimal ADC/SBC ($336D..$345D) — у 2A03 нет BCD-арифметики;
//    (эквивалент сборки с disable_selfmod=1 и disable_decimal=1);
//  - RAM-образ $0000-$07FF (zero page, data segment, код в $0200) грузится
//    в ОЗУ консоли перед стартом — тест рассчитан на прямое отображение образа;
//  - iNES: NROM, 32 КиБ PRG (четыре 8-КиБ банка не нужны — код умещается в
//    одно 32-КиБ окно), 0 CHR (CHR RAM), зеркалирование horizontal.
//
// При успехе PC зацикливается на relocated $B069 (original $3469), а в
// $0200 (test_case) лежит 0xF0.
//
// Запуск: node tests/cpu-conformance.mjs [--timeout 300000] [--mock-peripherals]

import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { readCachedCpuTest, CPU_TEST_SHA256, CPU_TEST_CACHE_PATH } from '../tools/fetch-cpu-test.mjs';
import { isMain, parseArgs, intOption, formatError, NotReadyError } from '../tools/reference/cli.mjs';

// --- перенос теста в NROM ----------------------------------------------------

/** Старт кода в оригинальном образе. */
export const CODE_START = 0x0400;
/** Конец кода (после последней инструкции $3832 size 3); сверено с листингом. */
export const CODE_END = 0x3835;
/** Сдвиг адресов кода: $0400 → $8000. */
export const SHIFT = 0x8000 - CODE_START;
/** Успех: `jmp *` по relocated $3469. */
export const SUCCESS_PC = 0x3469 + SHIFT;
/** Оригинальный адрес успеха (для диагностики). */
export const SUCCESS_ORIGINAL = 0x3469;

/**
 * Длины инструкций официального NMOS 6502 (0 = нет такой инструкции).
 * Нужна, чтобы пройти код и поправить 16-битные операнды.
 */
const OPCODE_LENGTHS = (() => {
  const lengths = new Uint8Array(256);
  const defs = {
    1: [
      0x00, 0x08, 0x0a, 0x18, 0x28, 0x2a, 0x38, 0x40, 0x48, 0x4a, 0x58, 0x60, 0x68, 0x6a, 0x78,
      0x88, 0x8a, 0x98, 0x9a, 0xa8, 0xaa, 0xb8, 0xba, 0xc8, 0xca, 0xd8, 0xe8, 0xea, 0xf8,
    ],
    2: [
      0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0,
      0x01, 0x05, 0x06, 0x09, 0x11, 0x15, 0x16, 0x21, 0x24, 0x25, 0x26, 0x29, 0x31, 0x35, 0x36,
      0x41, 0x45, 0x46, 0x49, 0x51, 0x55, 0x56, 0x61, 0x65, 0x66, 0x69, 0x71, 0x75, 0x76,
      0x81, 0x84, 0x85, 0x86, 0x91, 0x94, 0x95, 0x96, 0xa0, 0xa1, 0xa2, 0xa4, 0xa5, 0xa6, 0xa9,
      0xb1, 0xb4, 0xb5, 0xb6, 0xc0, 0xc1, 0xc4, 0xc5, 0xc6, 0xc9, 0xd1, 0xd5, 0xd6, 0xe0, 0xe1,
      0xe4, 0xe5, 0xe6, 0xe9, 0xf1, 0xf5, 0xf6,
    ],
    3: [
      0x0d, 0x0e, 0x19, 0x1d, 0x1e, 0x20, 0x2c, 0x2d, 0x2e, 0x39, 0x3d, 0x3e, 0x4c, 0x4d, 0x4e,
      0x59, 0x5d, 0x5e, 0x6c, 0x6d, 0x6e, 0x79, 0x7d, 0x7e, 0x8c, 0x8d, 0x8e, 0x99, 0x9d,
      0xac, 0xad, 0xae, 0xb9, 0xbc, 0xbd, 0xbe, 0xcc, 0xcd, 0xce, 0xd9, 0xdd, 0xde, 0xec, 0xed,
      0xee, 0xf9, 0xfd, 0xfe,
    ],
  };
  for (const [length, opcodes] of Object.entries(defs)) {
    for (const opcode of opcodes) lengths[opcode] = Number(length);
  }
  return lengths;
})();

/** Участки данных прямо в сегменте кода: два dw-указателя (jmp indirect). */
const INLINE_DATA = [[0x371e, 0x3722]];
/** Immediate-байты, содержащие hi/lo адресов кода: [адрес инструкции, старый, новый]. */
const IMMEDIATE_PATCHES = [
  [0x343b, 0x34, 0xb0], // lda #hi bin_rti_ret ($3455 → $B055)
  [0x343e, 0x55, 0x55], // lda #lo bin_rti_ret
  [0x3443, 0x34, 0xb0], // lda #hi dec_rti_ret ($344C → $B04C)
  [0x3446, 0x4c, 0x4c], // lda #lo dec_rti_ret
  [0x3781, 0x09, 0x85], // cmp #hi(jsr_ret)  ($099A → $859A)
  [0x3788, 0x9a, 0x9a], // cmp #lo(jsr_ret)
  [0x37d8, 0x09, 0x85], // cmp #hi(brk_ret0) ($09D1 → $85D1)
  [0x37df, 0xd1, 0xd1], // cmp #lo(brk_ret0)
  [0x3818, 0x09, 0x85], // cmp #hi(brk_ret1) ($09F7 → $85F7)
  [0x381f, 0xf7, 0xf7], // cmp #lo(brk_ret1)
];
/**
 * Тест исполняет immediate-опкоды из RAM (jsr ex_andi и т.п.), а наш
 * перекомпилятор исполняет только PRG. Заменяем такие вызовы эквивалентной
 * absolute-инструкцией по адресу «операнда в RAM»: тест пишет туда байт
 * (`sta ex_andi+1`), поэтому семантика и флаги сохраняются, стек не меняется.
 * [адрес JSR, ожидаемые байты, байты замены]
 */
const RAM_EXEC_PATCHES = [
  [0x2d2d, [0x20, 0x08, 0x02], [0x2d, 0x09, 0x02]], // jsr ex_andi → and $0209
  [0x2d4f, [0x20, 0x08, 0x02], [0x2d, 0x09, 0x02]],
  [0x2f25, [0x20, 0x0b, 0x02], [0x4d, 0x0c, 0x02]], // jsr ex_eori → eor $020C
  [0x2f47, [0x20, 0x0b, 0x02], [0x4d, 0x0c, 0x02]],
  [0x311d, [0x20, 0x0e, 0x02], [0x0d, 0x0f, 0x02]], // jsr ex_orai → ora $020F
  [0x313f, [0x20, 0x0e, 0x02], [0x0d, 0x0f, 0x02]],
  [0x34c1, [0x20, 0x11, 0x02], [0x6d, 0x12, 0x02]], // jsr ex_adci → adc $0212 (decimal-блок)
  [0x34d9, [0x20, 0x14, 0x02], [0xed, 0x15, 0x02]], // jsr ex_sbci → sbc $0215
  [0x360c, [0x20, 0x11, 0x02], [0x6d, 0x12, 0x02]],
  [0x3624, [0x20, 0x14, 0x02], [0xed, 0x15, 0x02]],
];

/** Векторы relocated-кода (адреса оригинального образа). */
const VECTORS = { nmi: 0x379d, reset: 0x8000, irq: 0x37ab };
/** Self-modifying тест диапазона ветвлений: вырезается. */
const BRANCH_RANGE = { start: 0x0444, end: 0x0581 };
/** Блок decimal ADC/SBC: вырезается (у 2A03 нет BCD). */
const DECIMAL_BLOCK = { start: 0x336d, target: 0x345d, finalCheck: 0x3460, finalCheckOld: 0x2b, finalCheckNew: 0x2a };

const inCode = address => address >= CODE_START && address < CODE_END;
const relocated = address => (inCode(address) ? address + SHIFT : address);

/**
 * Собирает iNES-контейнер (NROM, 32 КиБ PRG, CHR RAM) из 64-КиБ образа
 * функционального теста.
 * @param {Uint8Array} image 64 КиБ образ (SHA-256 из fetch-cpu-test.mjs)
 * @returns {{rom: Uint8Array, prg: Uint8Array, successPc: number, info: object}}
 */
export function buildCpuTestRom(image) {
  if (!(image instanceof Uint8Array) || image.length !== 0x10000) {
    throw new Error(`buildCpuTestRom: ожидался образ 64 КиБ, пришло ${image?.length} байт.`);
  }
  const prg = new Uint8Array(0x8000);
  prg.set(image.subarray(CODE_START, CODE_END), 0);

  // 1) 16-битные операнды absolute-инструкций, указывающие внутрь кода.
  let address = CODE_START;
  let operandPatches = 0;
  const isInlineData = position => INLINE_DATA.some(([start, end]) => position >= start && position < end);
  while (address < CODE_END) {
    if (isInlineData(address)) {
      address += 2;
      continue;
    }
    const offset = address - CODE_START;
    const length = OPCODE_LENGTHS[prg[offset]];
    if (!length) {
      throw new Error(
        `buildCpuTestRom: неизвестный опкод $${prg[offset].toString(16)} по адресу $${address.toString(16)}.`,
      );
    }
    if (address + length > CODE_END) {
      throw new Error(`buildCpuTestRom: инструкция по адресу $${address.toString(16)} выходит за код.`);
    }
    if (length === 3) {
      const operand = prg[offset + 1] | (prg[offset + 2] << 8);
      if (inCode(operand)) {
        const next = operand + SHIFT;
        prg[offset + 1] = next & 0xff;
        prg[offset + 2] = next >> 8;
        operandPatches++;
      }
    }
    address += length;
  }
  if (address !== CODE_END) {
    throw new Error(`buildCpuTestRom: разбор кода дошёл до $${address.toString(16)}, ожидалось $${CODE_END.toString(16)}.`);
  }
  if (operandPatches !== 84) {
    // Страховка от незамеченных участков данных: число сверено по листингу.
    throw new Error(`buildCpuTestRom: ожидалось 84 перенесённых операнда, получено ${operandPatches}.`);
  }

  // 2) Указатели, лежащие прямо в коде (data-директивы dw).
  let dataPatches = 0;
  for (const [start, end] of INLINE_DATA) {
    for (let position = start; position < end; position += 2) {
      const offset = position - CODE_START;
      const value = prg[offset] | (prg[offset + 1] << 8);
      if (!inCode(value)) continue;
      const next = value + SHIFT;
      prg[offset] = next & 0xff;
      prg[offset + 1] = next >> 8;
      dataPatches++;
    }
  }
  if (dataPatches !== 2) throw new Error(`buildCpuTestRom: ожидалось 2 inline-указателя, получено ${dataPatches}.`);

  // 3) Immediate-байты hi/lo адресов кода (сверяем старые байты).
  for (const [instructionAddress, oldByte, newByte] of IMMEDIATE_PATCHES) {
    const offset = instructionAddress - CODE_START + 1;
    if (prg[offset] !== oldByte) {
      throw new Error(
        `buildCpuTestRom: immediate в $${instructionAddress.toString(16)}: ` +
          `$${prg[offset].toString(16)} вместо ожидаемого $${oldByte.toString(16)}.`,
      );
    }
    prg[offset] = newByte;
  }

  // 3b) Заменяем исполнение immediate-опкодов из RAM (наш перекомпилятор
  //     исполняет только PRG; см. RAM_EXEC_PATCHES).
  for (const [instructionAddress, expected, replacement] of RAM_EXEC_PATCHES) {
    const offset = instructionAddress - CODE_START;
    for (let i = 0; i < expected.length; i++) {
      if (prg[offset + i] !== expected[i]) {
        throw new Error(
          `buildCpuTestRom: RAM-exec патч в $${instructionAddress.toString(16)}: ` +
            `байт ${i} $${prg[offset + i].toString(16)}, ожидался $${expected[i].toString(16)}.`,
        );
      }
    }
    prg.set(replacement, offset);
  }

  // 4) Вырезаем блоки, несовместимые с 2A03.
  const branchOffset = BRANCH_RANGE.start - CODE_START;
  prg[branchOffset] = 0x4c; // JMP $8581
  prg[branchOffset + 1] = relocated(BRANCH_RANGE.end) & 0xff;
  prg[branchOffset + 2] = relocated(BRANCH_RANGE.end) >> 8;

  const decimalOffset = DECIMAL_BLOCK.start - CODE_START;
  prg[decimalOffset] = 0x4c; // JMP $B05D
  prg[decimalOffset + 1] = relocated(DECIMAL_BLOCK.target) & 0xff;
  prg[decimalOffset + 2] = relocated(DECIMAL_BLOCK.target) >> 8;
  const finalCheckOffset = DECIMAL_BLOCK.finalCheck - CODE_START + 1;
  if (prg[finalCheckOffset] !== DECIMAL_BLOCK.finalCheckOld) {
    throw new Error('buildCpuTestRom: не совпал immediate финальной проверки test_num.');
  }
  prg[finalCheckOffset] = DECIMAL_BLOCK.finalCheckNew;

  // 5) Векторы: NMI/IRQ ведут на relocated trap-обработчики (BRK тестируется!),
  //    RESET — на начало перенесённого кода.
  const nmi = relocated(VECTORS.nmi);
  const irq = relocated(VECTORS.irq);
  const reset = relocated(VECTORS.reset);
  prg[0x7ffa] = nmi & 0xff;
  prg[0x7ffb] = nmi >> 8;
  prg[0x7ffc] = reset & 0xff;
  prg[0x7ffd] = reset >> 8;
  prg[0x7ffe] = irq & 0xff;
  prg[0x7fff] = irq >> 8;

  // 6) iNES: NROM (маппер 0), 2×16 КиБ PRG, CHR RAM.
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const rom = new Uint8Array(16 + prg.length);
  rom.set(header, 0);
  rom.set(prg, 16);

  return {
    rom,
    prg,
    successPc: SUCCESS_PC,
    info: {
      operandPatches,
      dataPatches,
      immediatePatches: IMMEDIATE_PATCHES.length,
      ramExecPatches: RAM_EXEC_PATCHES.length,
      codeSize: CODE_END - CODE_START,
    },
  };
}

// --- запуск через наш Console -------------------------------------------------

/** Заглушка PPU: CPU-тесту рендер не нужен, но Console.create требует фасад. */
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
  toJSON() {
    return {};
  }
  fromJSON() {}
}

/** Заглушка APU: звук CPU-тесту не нужен. */
class MockApu {
  constructor() {
    this.irqPending = false;
    this.channels = { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 };
  }
  reset() {}
  advance() {}
  writeReg() {}
  readReg() {
    return 0;
  }
  acknowledgeIrq() {}
  toJSON() {
    return {};
  }
  fromJSON() {}
}

/**
 * Готовит наш Console с тестовым ROM и RAM-образом.
 * @param {Uint8Array} testImage 64-КиБ образ теста
 * @param {{mockPeripherals?: boolean}} [options]
 */
export async function createConformanceConsole(testImage, options = {}) {
  let module;
  try {
    module = await import(new URL('../src/nes/console.js', import.meta.url));
  } catch (error) {
    throw new NotReadyError(`Наш движок не загружается: ${formatError(error)}`);
  }
  if (typeof module.createConsole !== 'function') {
    throw new NotReadyError('src/nes/console.js не экспортирует createConsole().');
  }
  const { rom } = buildCpuTestRom(testImage);
  const consoleOptions = options.mockPeripherals
    ? { ppu: new MockPpu(), apu: new MockApu() }
    : {};
  let consoleInstance;
  try {
    consoleInstance = await module.createConsole(rom, consoleOptions);
  } catch (error) {
    throw new NotReadyError(
      `Console не создался: ${formatError(error)}` +
        (options.mockPeripherals ? '' : ' (для проверки только CPU используйте --mock-peripherals)'),
    );
  }
  const ram = consoleInstance.cpuMem ?? consoleInstance.cpu?.mem;
  if (!ram || ram.length < 0x10000) {
    throw new NotReadyError('У Console нет живого 64-КиБ адресного пространства (cpuMem).');
  }
  // Тест ожидает свой образ в memory map напрямую: грузим RAM-часть образа.
  ram.set(testImage.subarray(0, 0x0800), 0);
  return { console: consoleInstance, ram };
}

/**
 * Прогон теста через Console.stepInstruction до успеха/трейпа/таймаута.
 * @param {{
 *   testImage?: Uint8Array, cachePath?: string,
 *   timeoutMs?: number, maxInstructions?: number,
 *   mockPeripherals?: boolean, progress?: (state: object) => void,
 * }} [options]
 * @returns {Promise<object>} отчёт
 */
export async function runCpuConformance(options = {}) {
  const {
    timeoutMs = 300000,
    maxInstructions = 100000000,
    mockPeripherals = false,
    progress = null,
  } = options;
  const testImage = options.testImage ?? (await readCachedCpuTest({ cachePath: options.cachePath }));
  const { console: consoleInstance, ram } = await createConformanceConsole(testImage, { mockPeripherals });
  const successPc = SUCCESS_PC;
  const step = consoleInstance.stepInstruction;
  if (typeof step !== 'function') {
    throw new NotReadyError('У Console нет stepInstruction() — конформанс невозможен.');
  }
  const startedAt = Date.now();
  const history = [];
  let instructions = 0;
  let lastPc = -1;
  let stuck = 0;
  let result = 'timeout';
  let stuckPc = null;
  let cycles = 0;

  while (true) {
    const stepCycles = step.call(consoleInstance);
    cycles += stepCycles;
    instructions++;
    const pc = consoleInstance.pc;
    history.push(pc);
    if (history.length > 64) history.shift();

    if (pc === successPc) {
      result = 'success';
      break;
    }
    if (pc === lastPc) stuck++;
    else stuck = 0;
    if (stuck >= 2) {
      result = 'trap';
      stuckPc = pc;
      break;
    }
    lastPc = pc;
    if (instructions >= maxInstructions) {
      result = 'max-instructions';
      break;
    }
    if (Date.now() - startedAt > timeoutMs) {
      result = 'timeout';
      break;
    }
    if (progress && instructions % 1000000 === 0) {
      progress({ instructions, pc, cycles, elapsedMs: Date.now() - startedAt });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const pc = consoleInstance.pc;
  const originalPc = pc >= 0x8000 && pc < 0x8000 + (CODE_END - CODE_START) ? pc - SHIFT : pc;
  const report = {
    tool: 'cpu-conformance',
    test: 'Klaus2m5/6502_65C02_functional_tests 6502_functional_test.bin',
    testSha256: CPU_TEST_SHA256,
    cachePath: options.cachePath ?? CPU_TEST_CACHE_PATH,
    result,
    passed: result === 'success',
    instructions,
    cycles,
    elapsedMs,
    successPc: `$${successPc.toString(16)}`,
    successOriginal: `$${SUCCESS_ORIGINAL.toString(16)}`,
    final: {
      pc: `$${pc.toString(16)}`,
      originalPc: `$${originalPc.toString(16)}`,
      opcode: `$${(ram[pc] ?? 0).toString(16)}`,
      opcodeBytes: [ram[pc], ram[pc + 1], ram[pc + 2]].map(byte => `$${Number(byte ?? 0).toString(16).padStart(2, '0')}`),
      testCase: `$${ram[0x0200].toString(16)}`,
      stuckPc: stuckPc === null ? null : `$${stuckPc.toString(16)}`,
    },
    lastPcs: history.slice(-32).map(address => `$${address.toString(16)}`),
    mockPeripherals,
  };
  return report;
}

const HELP = `
Конформанс CPU на функциональном тесте Klaus Dormann (dev/CI).

Использование:
  node tools/fetch-cpu-test.mjs        # один раз скачать тест (проверка SHA-256)
  node tests/cpu-conformance.mjs [опции]

Опции:
  --cache <path>          путь к скачанному образу (по умолчанию tools/.cache/...)
  --timeout <мс>          таймаут прогона (по умолчанию 300000)
  --max-instructions <N>  предохранитель (по умолчанию 100000000)
  --mock-peripherals      заглушки PPU/APU (проверяем только CPU)
  --json <path>           записать отчёт (по умолчанию /tmp/cpu-conformance-report.json)
  --quiet                 без прогресса в stderr
  --help                  эта справка

Код выхода: 0 — тест пройден, 1 — провал, 2 — ошибка подготовки.
`;

async function main() {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(HELP.trimStart() + '\n');
    return;
  }
  const quiet = args.quiet === true;
  try {
    const report = await runCpuConformance({
      cachePath: args.cache ? String(args.cache) : undefined,
      timeoutMs: intOption(args.timeout, 300000),
      maxInstructions: intOption(args['max-instructions'], 100000000),
      mockPeripherals: args['mock-peripherals'] === true,
      progress: quiet
        ? null
        : state => console.error(
            `  ${state.instructions} инструкций, PC $${state.pc.toString(16)}, тест ${(state.elapsedMs / 1000).toFixed(1)} с`,
          ),
    });
    const json = JSON.stringify(report, null, 2);
    const outPath = args.json ? String(args.json) : '/tmp/cpu-conformance-report.json';
    await writeFile(outPath, json + '\n');
    if (!quiet) {
      if (report.passed) {
        console.error(
          `✔ CPU-тест Klaus пройден: ${report.instructions} инструкций, ${report.cycles} циклов, ` +
            `${(report.elapsedMs / 1000).toFixed(1)} с (test_case=${report.final.testCase}).`,
        );
      } else {
        console.error(`✘ CPU-тест Klaus: ${report.result}`);
        console.error(`  PC ${report.final.pc} (original ${report.final.originalPc}), opcode ${report.final.opcode}, test_case=${report.final.testCase}`);
        console.error(`  последние PC: ${report.lastPcs.slice(-12).join(' ')}`);
      }
      console.error(`  отчёт: ${outPath}`);
    }
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    if (error instanceof NotReadyError) {
      console.error(`\nДвижок не готов: ${error.message}`);
      process.exit(2);
    }
    console.error(`Ошибка cpu-conformance: ${formatError(error)}`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
