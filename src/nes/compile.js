// Статическая перекомпиляция 6502 → WebAssembly.
//
// Идея: для каждого адреса ПЗУ $8000..$FFFF генерируется отдельная WASM-функция,
// которая выполняет ровно одну инструкцию 6502 и возвращает упакованный
// результат `nextPC | (cycles << 16)`. Таблица функций экспортируется наружу,
// а JS-консоль вызывает их по одной, тактируя PPU/APU и обрабатывая прерывания
// на границах инструкций. В рантайме нет fetch/decode: каждая инструкция —
// нативный WASM-код со своими константами и адресами.
//
// Регистры и флаги живут в linear memory (CPU_STATE, см. constants.js).
// Память: 0..$FFFF — адресное пространство CPU (RAM $0000-$07FF, окно ПЗУ
// $8000-$FFFF); чтения/записи устройств и маппера идут через импорты
// `env.read`/`env.write`.

import { WasmModule, Code, TYPE_I32, KIND_FUNC, KIND_MEMORY } from './wasm.js';
import {
  CPU_A, CPU_X, CPU_Y, CPU_SP, CPU_P, WASM_MEMORY_PAGES, VECTOR_IRQ,
} from './constants.js';

const PRG_SIZE = 0x8000;
const ACC = 1;
const IMM = 2;
const ZP = 3;
const ZPX = 4;
const ZPY = 5;
const ABS = 6;
const ABSX = 7;
const ABSY = 8;
const IND = 9;
const INDX = 10;
const INDY = 11;
const REL = 12;
const IMP = 13;

// Локальные переменные блока (i32):
// 0 — значение/операнд, 1..3 — временные, 4 — эффективный адрес,
// 5 — указатель/стек, 6 — старое значение, 7 — биты флагов,
// 8 — page-cross штраф, 9 — резерв.
const LV = 0;
const LT = 1;
const LT2 = 2;
const LT3 = 3;
const LA = 4;
const LP = 5;
const LOLD = 6;
const LBITS = 7;
const LCROSS = 8;
const LSPARE = 9;
const LOCAL_COUNT = 10;

const OPCODES = new Array(256).fill(null);
function def(opcode, mnemonic, mode, cycles, pageCross = false) {
  OPCODES[opcode] = { mnemonic, mode, cycles, pageCross };
}

// --- Документированные инструкции 6502 ---------------------------------------
def(0x00, 'BRK', IMP, 7);
def(0x01, 'ORA', INDX, 6);
def(0x05, 'ORA', ZP, 3);
def(0x06, 'ASL', ZP, 5);
def(0x08, 'PHP', IMP, 3);
def(0x09, 'ORA', IMM, 2);
def(0x0a, 'ASL', ACC, 2);
def(0x0d, 'ORA', ABS, 4);
def(0x0e, 'ASL', ABS, 6);
def(0x10, 'BPL', REL, 2);
def(0x11, 'ORA', INDY, 5, true);
def(0x15, 'ORA', ZPX, 4);
def(0x16, 'ASL', ZPX, 6);
def(0x18, 'CLC', IMP, 2);
def(0x19, 'ORA', ABSY, 4, true);
def(0x1d, 'ORA', ABSX, 4, true);
def(0x1e, 'ASL', ABSX, 7);
def(0x20, 'JSR', ABS, 6);
def(0x21, 'AND', INDX, 6);
def(0x24, 'BIT', ZP, 3);
def(0x25, 'AND', ZP, 3);
def(0x26, 'ROL', ZP, 5);
def(0x28, 'PLP', IMP, 4);
def(0x29, 'AND', IMM, 2);
def(0x2a, 'ROL', ACC, 2);
def(0x2c, 'BIT', ABS, 4);
def(0x2d, 'AND', ABS, 4);
def(0x2e, 'ROL', ABS, 6);
def(0x30, 'BMI', REL, 2);
def(0x31, 'AND', INDY, 5, true);
def(0x35, 'AND', ZPX, 4);
def(0x36, 'ROL', ZPX, 6);
def(0x38, 'SEC', IMP, 2);
def(0x39, 'AND', ABSY, 4, true);
def(0x3d, 'AND', ABSX, 4, true);
def(0x3e, 'ROL', ABSX, 7);
def(0x40, 'RTI', IMP, 6);
def(0x41, 'EOR', INDX, 6);
def(0x45, 'EOR', ZP, 3);
def(0x46, 'LSR', ZP, 5);
def(0x48, 'PHA', IMP, 3);
def(0x49, 'EOR', IMM, 2);
def(0x4a, 'LSR', ACC, 2);
def(0x4c, 'JMP', ABS, 3);
def(0x4d, 'EOR', ABS, 4);
def(0x4e, 'LSR', ABS, 6);
def(0x50, 'BVC', REL, 2);
def(0x51, 'EOR', INDY, 5, true);
def(0x55, 'EOR', ZPX, 4);
def(0x56, 'LSR', ZPX, 6);
def(0x58, 'CLI', IMP, 2);
def(0x59, 'EOR', ABSY, 4, true);
def(0x5d, 'EOR', ABSX, 4, true);
def(0x5e, 'LSR', ABSX, 7);
def(0x60, 'RTS', IMP, 6);
def(0x61, 'ADC', INDX, 6);
def(0x65, 'ADC', ZP, 3);
def(0x66, 'ROR', ZP, 5);
def(0x68, 'PLA', IMP, 4);
def(0x69, 'ADC', IMM, 2);
def(0x6a, 'ROR', ACC, 2);
def(0x6c, 'JMP', IND, 5);
def(0x6d, 'ADC', ABS, 4);
def(0x6e, 'ROR', ABS, 6);
def(0x70, 'BVS', REL, 2);
def(0x71, 'ADC', INDY, 5, true);
def(0x75, 'ADC', ZPX, 4);
def(0x76, 'ROR', ZPX, 6);
def(0x78, 'SEI', IMP, 2);
def(0x79, 'ADC', ABSY, 4, true);
def(0x7d, 'ADC', ABSX, 4, true);
def(0x7e, 'ROR', ABSX, 7);
def(0x81, 'STA', INDX, 6);
def(0x84, 'STY', ZP, 3);
def(0x85, 'STA', ZP, 3);
def(0x86, 'STX', ZP, 3);
def(0x88, 'DEY', IMP, 2);
def(0x8a, 'TXA', IMP, 2);
def(0x8c, 'STY', ABS, 4);
def(0x8d, 'STA', ABS, 4);
def(0x8e, 'STX', ABS, 4);
def(0x90, 'BCC', REL, 2);
def(0x91, 'STA', INDY, 6);
def(0x94, 'STY', ZPX, 4);
def(0x95, 'STA', ZPX, 4);
def(0x96, 'STX', ZPY, 4);
def(0x98, 'TYA', IMP, 2);
def(0x99, 'STA', ABSY, 5);
def(0x9a, 'TXS', IMP, 2);
def(0x9d, 'STA', ABSX, 5);
def(0xa0, 'LDY', IMM, 2);
def(0xa1, 'LDA', INDX, 6);
def(0xa2, 'LDX', IMM, 2);
def(0xa4, 'LDY', ZP, 3);
def(0xa5, 'LDA', ZP, 3);
def(0xa6, 'LDX', ZP, 3);
def(0xa8, 'TAY', IMP, 2);
def(0xa9, 'LDA', IMM, 2);
def(0xaa, 'TAX', IMP, 2);
def(0xac, 'LDY', ABS, 4);
def(0xad, 'LDA', ABS, 4);
def(0xae, 'LDX', ABS, 4);
def(0xb0, 'BCS', REL, 2);
def(0xb1, 'LDA', INDY, 5, true);
def(0xb4, 'LDY', ZPX, 4);
def(0xb5, 'LDA', ZPX, 4);
def(0xb6, 'LDX', ZPY, 4);
def(0xb8, 'CLV', IMP, 2);
def(0xb9, 'LDA', ABSY, 4, true);
def(0xba, 'TSX', IMP, 2);
def(0xbc, 'LDY', ABSX, 4, true);
def(0xbd, 'LDA', ABSX, 4, true);
def(0xbe, 'LDX', ABSY, 4, true);
def(0xc0, 'CPY', IMM, 2);
def(0xc1, 'CMP', INDX, 6);
def(0xc4, 'CPY', ZP, 3);
def(0xc5, 'CMP', ZP, 3);
def(0xc6, 'DEC', ZP, 5);
def(0xc8, 'INY', IMP, 2);
def(0xc9, 'CMP', IMM, 2);
def(0xca, 'DEX', IMP, 2);
def(0xcc, 'CPY', ABS, 4);
def(0xcd, 'CMP', ABS, 4);
def(0xce, 'DEC', ABS, 6);
def(0xd0, 'BNE', REL, 2);
def(0xd1, 'CMP', INDY, 5, true);
def(0xd5, 'CMP', ZPX, 4);
def(0xd6, 'DEC', ZPX, 6);
def(0xd8, 'CLD', IMP, 2);
def(0xd9, 'CMP', ABSY, 4, true);
def(0xdd, 'CMP', ABSX, 4, true);
def(0xde, 'DEC', ABSX, 7);
def(0xe0, 'CPX', IMM, 2);
def(0xe1, 'SBC', INDX, 6);
def(0xe4, 'CPX', ZP, 3);
def(0xe5, 'SBC', ZP, 3);
def(0xe6, 'INC', ZP, 5);
def(0xe8, 'INX', IMP, 2);
def(0xe9, 'SBC', IMM, 2);
def(0xea, 'NOP', IMP, 2);
def(0xec, 'CPX', ABS, 4);
def(0xed, 'SBC', ABS, 4);
def(0xee, 'INC', ABS, 6);
def(0xf0, 'BEQ', REL, 2);
def(0xf1, 'SBC', INDY, 5, true);
def(0xf5, 'SBC', ZPX, 4);
def(0xf6, 'INC', ZPX, 6);
def(0xf8, 'SED', IMP, 2);
def(0xf9, 'SBC', ABSY, 4, true);
def(0xfd, 'SBC', ABSX, 4, true);
def(0xfe, 'INC', ABSX, 7);

// --- Нелегальные NOP (встречаются в старых играх) -----------------------------
for (const opcode of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) def(opcode, 'NOP', IMP, 2);
for (const opcode of [0x80, 0x82, 0x89, 0xc2, 0xe2]) def(opcode, 'NOP', IMM, 2);
for (const opcode of [0x04, 0x44, 0x64]) def(opcode, 'NOP', ZP, 3);
for (const opcode of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) def(opcode, 'NOP', ZPX, 4);
def(0x0c, 'NOP', ABS, 4);
for (const opcode of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) def(opcode, 'NOP', ABSX, 4);

class BlockCompiler {
  constructor(pc, prg, readIndex, writeIndex, illegalIndex) {
    this.pc = pc;
    this.index = pc - PRG_SIZE;
    this.prg = prg;
    this.readIndex = readIndex;
    this.writeIndex = writeIndex;
    this.illegalIndex = illegalIndex;
    this.c = new Code().i32Locals(LOCAL_COUNT);
    this.mode = IMP;
  }

  get opcode() { return this.prg[this.index]; }
  get operand() { return this.prg[this.index + 1] ?? 0; }
  get operand16() { return (this.prg[this.index + 1] ?? 0) | ((this.prg[this.index + 2] ?? 0) << 8); }

  size() {
    switch (this.mode) {
      case IMP: case ACC: return 1;
      case IMM: case ZP: case ZPX: case ZPY: case INDX: case INDY: case REL: return 2;
      default: return 3;
    }
  }

  // --- регистры --------------------------------------------------------------
  pushA() { this.c.constI32(CPU_A).load8u(); }
  pushX() { this.c.constI32(CPU_X).load8u(); }
  pushY() { this.c.constI32(CPU_Y).load8u(); }
  pushSP() { this.c.constI32(CPU_SP).load8u(); }
  pushP() { this.c.constI32(CPU_P).load8u(); }
  storeAFrom(local) { this.c.constI32(CPU_A).localGet(local).store8(); }

  // --- флаги -----------------------------------------------------------------
  updateP(clearMask, pushBits) {
    const c = this.c;
    c.constI32(CPU_P);
    this.pushP();
    if (clearMask !== 0) { c.constI32(clearMask & 0xff); c.and(); }
    pushBits();
    c.or();
    c.store8();
  }

  /** N|Z для значения в LV. */
  pushNZBits() {
    const c = this.c;
    c.localGet(LV);
    c.constI32(0x80);
    c.and();
    c.constI32(0x02);
    c.constI32(0);
    c.localGet(LV);
    c.eqz();
    c.select();
    c.or();
  }

  setNZValueInLV() {
    this.updateP(0x7d, () => this.pushNZBits());
  }

  pushFlagSet(bit) {
    const c = this.c;
    this.pushP();
    c.constI32(bit);
    c.and();
    c.constI32(0);
    c.ne();
  }

  pushFlagClear(bit) {
    const c = this.c;
    this.pushP();
    c.constI32(bit);
    c.and();
    c.constI32(0);
    c.eq();
  }

  pushCarry() {
    const c = this.c;
    this.pushP();
    c.constI32(0x01);
    c.and();
  }

  // --- адресация -------------------------------------------------------------
  storeCrossFlag(pushCond) {
    const c = this.c;
    c.constI32(1);
    c.constI32(0);
    pushCond();
    c.select();
    c.localSet(LCROSS);
  }

  setCrossFromAddressAndBase(base) {
    const c = this.c;
    this.storeCrossFlag(() => {
      c.constI32(base & 0xff00);
      c.localGet(LA);
      c.constI32(0xff00);
      c.and();
      c.ne();
    });
  }

  /** Кладёт значение операнда на стек; выставляет LCROSS для page-cross режимов. */
  readOperand() {
    const c = this.c;
    switch (this.mode) {
      case IMM:
        c.constI32(this.operand);
        return;
      case ZP:
        c.constI32(this.operand);
        c.load8u();
        return;
      case ZPX:
        c.constI32(this.operand);
        this.pushX();
        c.add();
        c.constI32(0xff);
        c.and();
        c.load8u();
        return;
      case ZPY:
        c.constI32(this.operand);
        this.pushY();
        c.add();
        c.constI32(0xff);
        c.and();
        c.load8u();
        return;
      case ABS: {
        const addr = this.operand16;
        if (addr < 0x2000) { c.constI32(addr & 0x7ff); c.load8u(); }
        else if (addr >= 0x8000) { c.constI32(addr); c.load8u(); }
        else { c.constI32(addr); c.call(this.readIndex); }
        return;
      }
      case ABSX:
      case ABSY: {
        const base = this.operand16;
        const useX = this.mode === ABSX;
        if (base < 0x1f01) {
          // Адрес гарантированно в RAM, но штраф за пересечение страницы
          // всё равно нужен (fast-path не отменяет page-cross цикл).
          this.storeCrossFlag(() => {
            c.constI32(base & 0xff);
            useX ? this.pushX() : this.pushY();
            c.add();
            c.constI32(0xff);
            c.gtU();
          });
          c.constI32(base);
          useX ? this.pushX() : this.pushY();
          c.add();
          c.constI32(0x7ff);
          c.and();
          c.load8u();
          return;
        }
        c.constI32(base);
        useX ? this.pushX() : this.pushY();
        c.add();
        c.constI32(0xffff);
        c.and();
        c.localSet(LA);
        this.setCrossFromAddressAndBase(base);
        c.localGet(LA);
        c.call(this.readIndex);
        return;
      }
      case INDX: {
        const ptr = this.operand;
        c.constI32(ptr);
        this.pushX();
        c.add();
        c.constI32(0xff);
        c.and();
        c.localSet(LP);
        c.localGet(LP);
        c.load8u();
        c.localGet(LP);
        c.constI32(1);
        c.add();
        c.constI32(0xff);
        c.and();
        c.load8u();
        c.constI32(8);
        c.shl();
        c.or();
        c.localSet(LA);
        c.constI32(0);
        c.localSet(LCROSS);
        c.localGet(LA);
        c.call(this.readIndex);
        return;
      }
      case INDY: {
        const ptr = this.operand;
        c.constI32(ptr);
        c.load8u();
        c.constI32((ptr + 1) & 0xff);
        c.load8u();
        c.constI32(8);
        c.shl();
        c.or();
        c.localSet(LP);
        c.localGet(LP);
        this.pushY();
        c.add();
        c.constI32(0xffff);
        c.and();
        c.localSet(LA);
        this.storeCrossFlag(() => {
          c.localGet(LP);
          c.constI32(0xff00);
          c.and();
          c.localGet(LA);
          c.constI32(0xff00);
          c.and();
          c.ne();
        });
        c.localGet(LA);
        c.call(this.readIndex);
        return;
      }
      default:
        throw new Error(`readOperand: режим ${this.mode}`);
    }
  }

  /** Кладёт адрес записи в LA. */
  computeTargetAddress() {
    const c = this.c;
    switch (this.mode) {
      case ZP:
        c.constI32(this.operand & 0x7ff);
        return;
      case ZPX:
        c.constI32(this.operand);
        this.pushX();
        c.add();
        c.constI32(0xff);
        c.and();
        return;
      case ZPY:
        c.constI32(this.operand);
        this.pushY();
        c.add();
        c.constI32(0xff);
        c.and();
        return;
      case ABS:
        c.constI32(this.operand16);
        return;
      case ABSX:
        c.constI32(this.operand16);
        this.pushX();
        c.add();
        c.constI32(0xffff);
        c.and();
        return;
      case ABSY:
        c.constI32(this.operand16);
        this.pushY();
        c.add();
        c.constI32(0xffff);
        c.and();
        return;
      case INDX: {
        const ptr = this.operand;
        c.constI32(ptr);
        this.pushX();
        c.add();
        c.constI32(0xff);
        c.and();
        c.localSet(LP);
        c.localGet(LP);
        c.load8u();
        c.localGet(LP);
        c.constI32(1);
        c.add();
        c.constI32(0xff);
        c.and();
        c.load8u();
        c.constI32(8);
        c.shl();
        c.or();
        return;
      }
      case INDY: {
        const ptr = this.operand;
        c.constI32(ptr);
        c.load8u();
        c.constI32((ptr + 1) & 0xff);
        c.load8u();
        c.constI32(8);
        c.shl();
        c.or();
        this.pushY();
        c.add();
        c.constI32(0xffff);
        c.and();
        return;
      }
      default:
        throw new Error(`computeTargetAddress: режим ${this.mode}`);
    }
  }

  /** Записать LV в операнд. */
  writeOperand() {
    const c = this.c;
    const mode = this.mode;
    this.computeTargetAddress();
    c.localSet(LA);
    if (mode === ABS && this.operand16 < 0x2000) {
      c.constI32(this.operand16 & 0x7ff);
      c.localGet(LV);
      c.store8();
      return;
    }
    // Только прямо адресуемая zero page гарантированно в RAM. Косвенные
    // режимы ((zp,X), (zp),Y) могут указывать на PPU/APU/маппер — через шину.
    if (mode === ZP || mode === ZPX || mode === ZPY) {
      c.localGet(LA);
      c.constI32(0x7ff);
      c.and();
      c.localGet(LV);
      c.store8();
      return;
    }
    c.localGet(LA);
    c.localGet(LV);
    c.call(this.writeIndex);
  }

  // --- завершение блока ------------------------------------------------------
  retConstant(nextPc, cycles) {
    const c = this.c;
    c.constI32(nextPc & 0xffff);
    c.constI32(cycles);
    c.constI32(16);
    c.shl();
    c.or();
    c.return_();
  }

  retWithCross(nextPc, cycles) {
    const c = this.c;
    c.constI32(nextPc & 0xffff);
    c.constI32(cycles);
    c.localGet(LCROSS);
    c.add();
    c.constI32(16);
    c.shl();
    c.or();
    c.return_();
  }

  retDynamic(cycles) {
    const c = this.c;
    c.localGet(LV);
    c.constI32(cycles);
    c.constI32(16);
    c.shl();
    c.or();
    c.return_();
  }

  retHalt() {
    this.retConstant(this.pc, 2);
  }

  // --- АЛУ -------------------------------------------------------------------
  andA() {
    const c = this.c;
    c.localSet(LV);
    c.constI32(CPU_A);
    this.pushA();
    c.localGet(LV);
    c.and();
    c.localSet(LV);
    c.constI32(CPU_A).localGet(LV).store8();
    this.setNZValueInLV();
  }

  orA() {
    const c = this.c;
    c.localSet(LV);
    c.constI32(CPU_A);
    this.pushA();
    c.localGet(LV);
    c.or();
    c.localSet(LV);
    c.constI32(CPU_A).localGet(LV).store8();
    this.setNZValueInLV();
  }

  xorA() {
    const c = this.c;
    c.localSet(LV);
    c.constI32(CPU_A);
    this.pushA();
    c.localGet(LV);
    c.xor();
    c.localSet(LV);
    c.constI32(CPU_A).localGet(LV).store8();
    this.setNZValueInLV();
  }

  /** ADC/SBC: значение операнда приходит на стек. */
  addWithCarry(sbc) {
    const c = this.c;
    c.localSet(LV);
    if (sbc) {
      c.localGet(LV);
      c.constI32(0xff);
      c.xor();
      c.localSet(LV);
    }
    c.constI32(CPU_A).load8u().localSet(LOLD); // A_old
    c.localGet(LOLD);
    c.localGet(LV);
    c.add();
    this.pushCarry();
    c.add();
    c.localSet(LT); // полная сумма
    c.localGet(LT);
    c.constI32(0xff);
    c.and();
    c.localSet(LT2); // результат
    // A = результат
    c.constI32(CPU_A);
    c.localGet(LT2);
    c.store8();
    // V = (~(A^M) & (A^res)) & 0x80 → бит 0x40
    c.localGet(LOLD);
    c.localGet(LV);
    c.xor();
    c.constI32(0xffffffff);
    c.xor();
    c.localGet(LOLD);
    c.localGet(LT2);
    c.xor();
    c.and();
    c.constI32(0x80);
    c.and();
    c.constI32(1);
    c.shrU();
    c.localSet(LBITS);
    // P = (P & 0x3C) | V | C | N | Z
    c.constI32(CPU_P);
    this.pushP();
    c.constI32(0x3c);
    c.and();
    c.localGet(LBITS);
    c.or();
    c.localGet(LT);
    c.constI32(0x100);
    c.geU();
    c.or();
    c.localGet(LT2);
    c.localSet(LV);
    this.pushNZBits();
    c.or();
    c.store8();
  }

  compare(registerAddress) {
    const c = this.c;
    c.localSet(LV); // M
    c.constI32(registerAddress).load8u().localSet(LOLD);
    c.localGet(LOLD);
    c.localGet(LV);
    c.sub();
    c.constI32(0xffff);
    c.and();
    c.localSet(LT);
    // C = reg >= M
    c.localGet(LOLD);
    c.localGet(LV);
    c.geU();
    c.localSet(LBITS);
    c.localGet(LT);
    c.constI32(0xff);
    c.and();
    c.localSet(LV);
    // P = (P & 0x7C) | C | N | Z
    c.constI32(CPU_P);
    this.pushP();
    c.constI32(0x7c);
    c.and();
    c.localGet(LBITS);
    c.or();
    this.pushNZBits();
    c.or();
    c.store8();
  }

  incDec(delta) {
    const c = this.c;
    c.localGet(LV);
    c.constI32(delta > 0 ? 1 : 0xff);
    c.add();
    c.constI32(0xff);
    c.and();
    c.localSet(LV);
    this.setNZValueInLV();
  }

  applyCarryAndNZ() {
    const c = this.c;
    c.constI32(CPU_P);
    this.pushP();
    c.constI32(0x7c);
    c.and();
    c.localGet(LT3);
    c.or();
    this.pushNZBits();
    c.or();
    c.store8();
  }

  shiftAsl() {
    const c = this.c;
    c.localGet(LV);
    c.constI32(0x80);
    c.and();
    c.constI32(7);
    c.shrU();
    c.localSet(LT3);
    c.localGet(LV);
    c.constI32(1);
    c.shl();
    c.constI32(0xff);
    c.and();
    c.localSet(LV);
    this.applyCarryAndNZ();
  }

  shiftLsr() {
    const c = this.c;
    c.localGet(LV);
    c.constI32(1);
    c.and();
    c.localSet(LT3);
    c.localGet(LV);
    c.constI32(1);
    c.shrU();
    c.localSet(LV);
    this.applyCarryAndNZ();
  }

  shiftRol() {
    const c = this.c;
    c.localGet(LV);
    c.constI32(0x80);
    c.and();
    c.constI32(7);
    c.shrU();
    c.localSet(LT3); // новый C
    c.localGet(LV);
    c.constI32(1);
    c.shl();
    this.pushCarry();
    c.or();
    c.constI32(0xff);
    c.and();
    c.localSet(LV);
    this.applyCarryAndNZ();
  }

  shiftRor() {
    const c = this.c;
    c.localGet(LV);
    c.constI32(1);
    c.and();
    c.localSet(LT3);
    c.localGet(LV);
    c.constI32(1);
    c.shrU();
    this.pushCarry();
    c.constI32(7);
    c.shl();
    c.or();
    c.constI32(0xff);
    c.and();
    c.localSet(LV);
    this.applyCarryAndNZ();
  }

  // --- стек ------------------------------------------------------------------
  pushByte(pushValue) {
    const c = this.c;
    pushValue();
    c.localSet(LV);
    // 6502: сначала запись в mem[0x100+SP], затем SP = (SP-1) & 0xFF.
    c.constI32(0x100);
    this.pushSP();
    c.add();
    c.localGet(LV);
    c.store8();
    c.constI32(CPU_SP);
    this.pushSP();
    c.constI32(1);
    c.sub();
    c.constI32(0xff);
    c.and();
    c.store8();
  }

  pullByte() {
    const c = this.c;
    c.constI32(CPU_SP);
    this.pushSP();
    c.constI32(1);
    c.add();
    c.constI32(0xff);
    c.and();
    c.localTee(LSPARE);
    c.store8();
    c.constI32(0x100);
    c.localGet(LSPARE);
    c.add();
    c.load8u();
  }

  // --- переходы --------------------------------------------------------------
  branch(pushCondition) {
    const c = this.c;
    const offset = (this.operand << 24) >> 24;
    const fallthrough = (this.pc + 2) & 0xffff;
    const target = (fallthrough + offset) & 0xffff;
    const pageCross = (fallthrough & 0xff00) !== (target & 0xff00) ? 1 : 0;
    pushCondition();
    c.if_();
    this.retConstant(target, 3 + pageCross);
    c.else_();
    this.retConstant(fallthrough, 2);
    c.end();
    c.unreachable();
  }

  emitJmpIndirect() {
    const c = this.c;
    const pointer = this.operand16;
    // Классический баг 6502: второй байт указателя читается из той же страницы.
    c.constI32(pointer);
    c.call(this.readIndex);
    c.constI32((pointer & 0xff00) | ((pointer + 1) & 0xff));
    c.call(this.readIndex);
    c.constI32(8);
    c.shl();
    c.or();
    c.localSet(LP);
    // Настоящий 6502: JMP (ind) использует прочитанное значение как адрес
    // перехода напрямую (никакой второй косвенности).
    c.localGet(LP);
    c.localSet(LV);
    this.retDynamic(5);
  }

  emitRts() {
    const c = this.c;
    this.pullByte();
    c.localSet(LP);
    this.pullByte();
    c.constI32(8);
    c.shl();
    c.localGet(LP);
    c.or();
    c.constI32(1);
    c.add();
    c.constI32(0xffff);
    c.and();
    c.localSet(LV);
    this.retDynamic(6);
  }

  emitRti() {
    const c = this.c;
    this.pullByte();
    this.restorePFromStack();
    this.pullByte();
    c.localSet(LP);
    this.pullByte();
    c.constI32(8);
    c.shl();
    c.localGet(LP);
    c.or();
    c.localSet(LV);
    this.retDynamic(6);
  }

  emitBrk() {
    const c = this.c;
    const returnPc = (this.pc + 2) & 0xffff;
    this.pushByte(() => c.constI32((returnPc >> 8) & 0xff));
    this.pushByte(() => c.constI32(returnPc & 0xff));
    this.pushByte(() => { this.pushP(); c.constI32(0x30); c.or(); });
    this.setFlag(0x04);
    c.constI32(VECTOR_IRQ);
    c.call(this.readIndex);
    c.constI32(VECTOR_IRQ + 1);
    c.call(this.readIndex);
    c.constI32(8);
    c.shl();
    c.or();
    c.localSet(LV);
    this.retDynamic(7);
  }

  restorePFromStack() {
    const c = this.c;
    c.localSet(LV);
    c.constI32(CPU_P);
    c.localGet(LV);
    c.constI32(0xcf);
    c.and();
    c.constI32(0x20);
    c.or();
    c.store8();
  }

  // --- элементарные операции -------------------------------------------------
  loadTo(registerAddress, cycles) {
    const c = this.c;
    this.readOperand();
    c.localSet(LV);
    c.constI32(registerAddress);
    c.localGet(LV);
    c.store8();
    this.setNZValueInLV();
    const nextPc = (this.pc + this.size()) & 0xffff;
    if (this.mode === ABSX || this.mode === ABSY || this.mode === INDY) {
      this.retWithCross(nextPc, cycles);
    } else {
      this.retConstant(nextPc, cycles);
    }
  }

  readThen(operation, cycles) {
    const c = this.c;
    this.readOperand();
    operation();
    const nextPc = (this.pc + this.size()) & 0xffff;
    if (this.mode === ABSX || this.mode === ABSY || this.mode === INDY) {
      this.retWithCross(nextPc, cycles);
    } else {
      this.retConstant(nextPc, cycles);
    }
  }

  storeFrom(registerAddress) {
    const c = this.c;
    this.computeTargetAddress();
    c.localSet(LA);
    const mode = this.mode;
    if (mode === ABS && this.operand16 < 0x2000) {
      c.constI32(this.operand16 & 0x7ff);
      c.constI32(registerAddress).load8u();
      c.store8();
      return;
    }
    if (mode === ZP || mode === ZPX || mode === ZPY) {
      c.localGet(LA);
      c.constI32(0x7ff);
      c.and();
      c.constI32(registerAddress).load8u();
      c.store8();
      return;
    }
    c.localGet(LA);
    c.constI32(registerAddress).load8u();
    c.call(this.writeIndex);
  }

  bit(cycles) {
    const c = this.c;
    this.readOperand();
    c.localSet(LT);
    c.constI32(CPU_A).load8u().localSet(LV);
    const nextPc = (this.pc + this.size()) & 0xffff;
    // P = (P & 0x3D) | N | V | Z
    this.updateP(0x3d, () => {
      c.localGet(LT);
      c.constI32(0x80);
      c.and();
      c.constI32(0x40);
      c.constI32(0);
      c.localGet(LT);
      c.constI32(0x40);
      c.and();
      c.constI32(0);
      c.ne();
      c.select();
      c.or();
      c.constI32(0x02);
      c.constI32(0);
      c.localGet(LV);
      c.localGet(LT);
      c.and();
      c.eqz();
      c.select();
      c.or();
    });
    this.retConstant(nextPc, cycles);
  }

  rmw(cycles, modify) {
    const c = this.c;
    const nextPc = (this.pc + this.size()) & 0xffff;
    if (this.mode === ACC) {
      this.pushA();
      c.localSet(LV);
      modify();
      c.constI32(CPU_A).localGet(LV).store8();
      this.retConstant(nextPc, cycles);
      return;
    }
    this.readOperand();
    c.localSet(LV);
    modify();
    this.writeOperand();
    this.retConstant(nextPc, cycles);
  }

  transfer(sourceAddress, targetAddress) {
    const c = this.c;
    c.constI32(targetAddress);
    c.constI32(sourceAddress).load8u();
    c.localTee(LV);
    c.store8();
    this.setNZValueInLV();
  }

  changeRegister(address, delta) {
    const c = this.c;
    c.constI32(address).load8u();
    c.constI32(delta > 0 ? 1 : 0xff);
    c.add();
    c.constI32(0xff);
    c.and();
    c.localSet(LV);
    c.constI32(address);
    c.localGet(LV);
    c.store8();
    this.setNZValueInLV();
  }

  clearFlag(bit) {
    const c = this.c;
    c.constI32(CPU_P);
    this.pushP();
    c.constI32((~bit) & 0xff);
    c.and();
    c.store8();
  }

  setFlag(bit) {
    const c = this.c;
    c.constI32(CPU_P);
    this.pushP();
    c.constI32(bit);
    c.or();
    c.store8();
  }

  setCarry() {
    const c = this.c;
    c.constI32(CPU_P);
    this.pushP();
    c.constI32(0x01);
    c.or();
    c.store8();
  }

  // --- основная генерация ----------------------------------------------------
  emit() {
    const c = this.c;
    const pc = this.pc;
    const opcode = this.opcode;
    const info = OPCODES[opcode];
    if (!info) {
      c.constI32(pc);
      c.call(this.illegalIndex);
      c.unreachable();
      this.retHalt();
      return this.c;
    }
    this.mode = info.mode;
    const cycles = info.cycles;
    const nextPc = (pc + this.size()) & 0xffff;
    switch (info.mnemonic) {
      case 'BPL': this.branch(() => this.pushFlagClear(0x80)); return this.c;
      case 'BMI': this.branch(() => this.pushFlagSet(0x80)); return this.c;
      case 'BVC': this.branch(() => this.pushFlagClear(0x40)); return this.c;
      case 'BVS': this.branch(() => this.pushFlagSet(0x40)); return this.c;
      case 'BCC': this.branch(() => this.pushFlagClear(0x01)); return this.c;
      case 'BCS': this.branch(() => this.pushFlagSet(0x01)); return this.c;
      case 'BNE': this.branch(() => this.pushFlagClear(0x02)); return this.c;
      case 'BEQ': this.branch(() => this.pushFlagSet(0x02)); return this.c;
      case 'JMP':
        if (this.mode === ABS) this.retConstant(this.operand16, 3);
        else this.emitJmpIndirect();
        return this.c;
      case 'JSR': {
        const returnAddress = (nextPc - 1) & 0xffff;
        this.pushByte(() => c.constI32((returnAddress >> 8) & 0xff));
        this.pushByte(() => c.constI32(returnAddress & 0xff));
        this.retConstant(this.operand16, 6);
        return this.c;
      }
      case 'RTS': this.emitRts(); return this.c;
      case 'RTI': this.emitRti(); return this.c;
      case 'BRK': this.emitBrk(); return this.c;
      case 'LDA': this.loadTo(CPU_A, cycles); return this.c;
      case 'LDX': this.loadTo(CPU_X, cycles); return this.c;
      case 'LDY': this.loadTo(CPU_Y, cycles); return this.c;
      case 'STA': this.storeFrom(CPU_A); this.retConstant(nextPc, cycles); return this.c;
      case 'STX': this.storeFrom(CPU_X); this.retConstant(nextPc, cycles); return this.c;
      case 'STY': this.storeFrom(CPU_Y); this.retConstant(nextPc, cycles); return this.c;
      case 'AND': this.readThen(() => this.andA(), cycles); return this.c;
      case 'ORA': this.readThen(() => this.orA(), cycles); return this.c;
      case 'EOR': this.readThen(() => this.xorA(), cycles); return this.c;
      case 'ADC': this.readThen(() => this.addWithCarry(false), cycles); return this.c;
      case 'SBC': this.readThen(() => this.addWithCarry(true), cycles); return this.c;
      case 'CMP': this.readThen(() => this.compare(CPU_A), cycles); return this.c;
      case 'CPX': this.readThen(() => this.compare(CPU_X), cycles); return this.c;
      case 'CPY': this.readThen(() => this.compare(CPU_Y), cycles); return this.c;
      case 'BIT': this.bit(cycles); return this.c;
      case 'ASL': this.rmw(cycles, () => this.shiftAsl()); return this.c;
      case 'LSR': this.rmw(cycles, () => this.shiftLsr()); return this.c;
      case 'ROL': this.rmw(cycles, () => this.shiftRol()); return this.c;
      case 'ROR': this.rmw(cycles, () => this.shiftRor()); return this.c;
      case 'INC': this.rmw(cycles, () => this.incDec(1)); return this.c;
      case 'DEC': this.rmw(cycles, () => this.incDec(-1)); return this.c;
      case 'TAX': this.transfer(CPU_A, CPU_X); this.retConstant(nextPc, cycles); return this.c;
      case 'TAY': this.transfer(CPU_A, CPU_Y); this.retConstant(nextPc, cycles); return this.c;
      case 'TXA': this.transfer(CPU_X, CPU_A); this.retConstant(nextPc, cycles); return this.c;
      case 'TYA': this.transfer(CPU_Y, CPU_A); this.retConstant(nextPc, cycles); return this.c;
      case 'TSX': this.transfer(CPU_SP, CPU_X); this.retConstant(nextPc, cycles); return this.c;
      case 'TXS':
        c.constI32(CPU_SP);
        this.pushX();
        c.store8();
        this.retConstant(nextPc, cycles);
        return this.c;
      case 'PHA':
        this.pushByte(() => this.pushA());
        this.retConstant(nextPc, cycles);
        return this.c;
      case 'PHP':
        this.pushByte(() => { this.pushP(); c.constI32(0x30); c.or(); });
        this.retConstant(nextPc, cycles);
        return this.c;
      case 'PLA':
        this.pullByte();
        c.localSet(LV);
        c.constI32(CPU_A).localGet(LV).store8();
        this.setNZValueInLV();
        this.retConstant(nextPc, cycles);
        return this.c;
      case 'PLP':
        this.pullByte();
        this.restorePFromStack();
        this.retConstant(nextPc, cycles);
        return this.c;
      case 'CLC': this.clearFlag(0x01); this.retConstant(nextPc, cycles); return this.c;
      case 'SEC': this.setCarry(); this.retConstant(nextPc, cycles); return this.c;
      case 'CLI': this.clearFlag(0x04); this.retConstant(nextPc, cycles); return this.c;
      case 'SEI': this.setFlag(0x04); this.retConstant(nextPc, cycles); return this.c;
      case 'CLV': this.clearFlag(0x40); this.retConstant(nextPc, cycles); return this.c;
      case 'CLD': this.clearFlag(0x08); this.retConstant(nextPc, cycles); return this.c;
      case 'SED': this.setFlag(0x08); this.retConstant(nextPc, cycles); return this.c;
      case 'INX': this.changeRegister(CPU_X, 1); this.retConstant(nextPc, cycles); return this.c;
      case 'INY': this.changeRegister(CPU_Y, 1); this.retConstant(nextPc, cycles); return this.c;
      case 'DEX': this.changeRegister(CPU_X, -1); this.retConstant(nextPc, cycles); return this.c;
      case 'DEY': this.changeRegister(CPU_Y, -1); this.retConstant(nextPc, cycles); return this.c;
      case 'NOP': this.retConstant(nextPc, cycles); return this.c;
      default:
        c.constI32(pc);
        c.call(this.illegalIndex);
        c.unreachable();
        this.retHalt();
        return this.c;
    }
  }
}

/**
 * Компилирует ROM в WASM-модуль.
 * @param {{prg: Uint8Array, mapper: number}} romInfo
 * @param {{onProgress?: (done: number, total: number) => void}} options
 * @returns {{ wasm: Uint8Array, blockCount: number, prgSize: number, buildMs: number }}
 */
export function compileRom(romInfo, { onProgress } = {}) {
  const prg = romInfo.prg;
  if (!prg || prg.length !== PRG_SIZE) {
    throw new Error(`Компилятор ожидает 32 КиБ PRG, получено ${prg?.length ?? 0}.`);
  }
  const module = new WasmModule();
  const typeBlock = module.typeIndex([], [TYPE_I32]);
  const typeStep = module.typeIndex([TYPE_I32], [TYPE_I32]);
  const readIndex = module.importFunction('env', 'read', [TYPE_I32], [TYPE_I32]);
  const writeIndex = module.importFunction('env', 'write', [TYPE_I32, TYPE_I32], []);
  const illegalIndex = module.importFunction('env', 'illegal', [TYPE_I32], []);

  const blockFunctionIndices = new Uint32Array(PRG_SIZE);
  const bodies = new Array(PRG_SIZE);
  const start = Date.now();
  for (let offset = 0; offset < PRG_SIZE; offset++) {
    const compiler = new BlockCompiler(PRG_SIZE + offset, prg, readIndex, writeIndex, illegalIndex);
    bodies[offset] = compiler.emit().end().body();
    if (onProgress && (offset & 0x1fff) === 0) onProgress(offset, PRG_SIZE);
  }
  for (let offset = 0; offset < PRG_SIZE; offset++) {
    blockFunctionIndices[offset] = module.function_(typeBlock, bodies[offset]);
  }
  const stepCode = new Code();
  stepCode.localGet(0);
  stepCode.constI32(PRG_SIZE);
  stepCode.sub();
  stepCode.callIndirect(typeBlock, 0);
  stepCode.end();
  const stepIndex = module.function_(typeStep, stepCode.body());

  module.setTable(blockFunctionIndices);
  module.setMemory(WASM_MEMORY_PAGES);
  module.export_('memory', KIND_MEMORY, 0);
  module.export_('step', KIND_FUNC, stepIndex);

  const wasm = module.build();
  return { wasm, blockCount: PRG_SIZE, prgSize: PRG_SIZE, buildMs: Date.now() - start };
}

export const OPCODE_TABLE = OPCODES;

/** Размер инструкции в байтах для каждого кода (для тайминга шины). */
export const OPCODE_SIZE = (() => {
  const sizes = new Uint8Array(256);
  for (let opcode = 0; opcode < 256; opcode++) {
    const info = OPCODES[opcode];
    if (!info) { sizes[opcode] = 2; continue; }
    switch (info.mode) {
      case IMP: case ACC: sizes[opcode] = 1; break;
      case IMM: case ZP: case ZPX: case ZPY: case INDX: case INDY: case REL: sizes[opcode] = 2; break;
      default: sizes[opcode] = 3;
    }
  }
  return sizes;
})();
