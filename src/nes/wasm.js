// Минимальный энкодер бинарного WebAssembly (MVP: i32-арифметика, память,
// таблица функций, импорты/экспорты). Используется перекомпилятором
// 6502 → WASM и тестами. Собранный модуль не зависит от JS-кода: всё общение
// с внешним миром идёт через два импорта `env.read`/`env.write`.

/** Байтовый писатель с LEB128. */
export class Writer {
  constructor(capacity = 1024) {
    this.bytes = new Uint8Array(capacity);
    this.length = 0;
  }

  ensure(extra) {
    const need = this.length + extra;
    if (need <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  u8(value) {
    this.ensure(1);
    this.bytes[this.length++] = value & 0xff;
  }

  u8At(index, value) {
    this.bytes[index] = value & 0xff;
  }

  u32(value) {
    let v = value >>> 0;
    this.ensure(5);
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      this.bytes[this.length++] = byte;
    } while (v !== 0);
  }

  /** Знаковый LEB128 для i32.const и подобных. */
  i32(value) {
    let v = value | 0;
    this.ensure(5);
    for (;;) {
      let byte = v & 0x7f;
      v >>= 7;
      const sign = byte & 0x40;
      if ((v === 0 && !sign) || (v === -1 && sign)) {
        this.bytes[this.length++] = byte;
        return;
      }
      this.bytes[this.length++] = byte | 0x80;
    }
  }

  raw(array) {
    this.ensure(array.length);
    this.bytes.set(array, this.length);
    this.length += array.length;
  }

  /** Дописать уже готовые байты как length-prefixed блок. */
  block(bytes) {
    this.u32(bytes.length);
    this.raw(bytes);
  }

  take() {
    const out = this.bytes.slice(0, this.length);
    this.bytes = new Uint8Array(Math.max(1024, out.length * 2));
    this.length = 0;
    return out;
  }

  view() {
    return this.bytes.subarray(0, this.length);
  }
}

/** Коды типов значений и служебные байты. */
export const TYPE_I32 = 0x7f;
export const TYPE_VOID = 0x40;
export const KIND_FUNC = 0x00;
export const KIND_TABLE = 0x01;
export const KIND_MEMORY = 0x02;

export const OP = {
  unreachable: 0x00,
  nop: 0x01,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  call: 0x10,
  call_indirect: 0x11,
  drop: 0x1a,
  select: 0x1b,
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  i32_load: 0x28,
  i32_load8_u: 0x2d,
  i32_load16_u: 0x2f,
  i32_store: 0x36,
  i32_store8: 0x3a,
  i32_store16: 0x3b,
  i32_const: 0x41,
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_lt_u: 0x49,
  i32_gt_s: 0x4a,
  i32_gt_u: 0x4b,
  i32_le_s: 0x4c,
  i32_le_u: 0x4d,
  i32_ge_s: 0x4e,
  i32_ge_u: 0x4f,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_xor: 0x73,
  i32_shl: 0x74,
  i32_shr_s: 0x75,
  i32_shr_u: 0x76,
};

/**
 * Тело функции: список инструкций + локальные переменные.
 * Стек-машина: методы пишут байты, следя за стеком вызывающий.
 */
export class Code {
  constructor() {
    this.w = new Writer(512);
    this.locals = [];
  }

  /** Объявить локальные i32. */
  i32Locals(count) {
    this.locals.push([count, TYPE_I32]);
    return this;
  }

  end() {
    this.w.u8(OP.end);
    return this;
  }

  // --- константы и переменные
  constI32(value) { this.w.u8(OP.i32_const); this.w.i32(value); return this; }
  localGet(index) { this.w.u8(OP.local_get); this.w.u32(index); return this; }
  localSet(index) { this.w.u8(OP.local_set); this.w.u32(index); return this; }
  localTee(index) { this.w.u8(OP.local_tee); this.w.u32(index); return this; }

  // --- память (адрес на стеке)
  load8u(offset = 0) { this.w.u8(OP.i32_load8_u); this.w.u32(0); this.w.u32(offset); return this; }
  load16u(offset = 0) { this.w.u8(OP.i32_load16_u); this.w.u32(1); this.w.u32(offset); return this; }
  load32(offset = 0) { this.w.u8(OP.i32_load); this.w.u32(2); this.w.u32(offset); return this; }
  store8(offset = 0) { this.w.u8(OP.i32_store8); this.w.u32(0); this.w.u32(offset); return this; }
  store16(offset = 0) { this.w.u8(OP.i32_store16); this.w.u32(1); this.w.u32(offset); return this; }
  store32(offset = 0) { this.w.u8(OP.i32_store); this.w.u32(2); this.w.u32(offset); return this; }

  // --- арифметика/логика
  add() { this.w.u8(OP.i32_add); return this; }
  sub() { this.w.u8(OP.i32_sub); return this; }
  mul() { this.w.u8(OP.i32_mul); return this; }
  and() { this.w.u8(OP.i32_and); return this; }
  or() { this.w.u8(OP.i32_or); return this; }
  xor() { this.w.u8(OP.i32_xor); return this; }
  shl() { this.w.u8(OP.i32_shl); return this; }
  shrS() { this.w.u8(OP.i32_shr_s); return this; }
  shrU() { this.w.u8(OP.i32_shr_u); return this; }
  eqz() { this.w.u8(OP.i32_eqz); return this; }
  eq() { this.w.u8(OP.i32_eq); return this; }
  ne() { this.w.u8(OP.i32_ne); return this; }
  ltU() { this.w.u8(OP.i32_lt_u); return this; }
  gtU() { this.w.u8(OP.i32_gt_u); return this; }
  leU() { this.w.u8(OP.i32_le_u); return this; }
  geU() { this.w.u8(OP.i32_ge_u); return this; }
  select() { this.w.u8(OP.select); return this; }
  drop() { this.w.u8(OP.drop); return this; }

  // --- управление
  if_() { this.w.u8(OP.if); this.w.u8(TYPE_VOID); return this; }
  else_() { this.w.u8(OP.else); return this; }
  return_() { this.w.u8(OP.return); return this; }
  unreachable() { this.w.u8(OP.unreachable); return this; }
  call(index) { this.w.u8(OP.call); this.w.u32(index); return this; }
  callIndirect(typeIndex, tableIndex = 0) {
    this.w.u8(OP.call_indirect);
    this.w.u32(typeIndex);
    this.w.u32(tableIndex);
    return this;
  }

  body() {
    const head = new Writer(16);
    head.u8(this.locals.length);
    for (const [count, type] of this.locals) {
      head.u32(count);
      head.u8(type);
    }
    head.raw(this.w.view());
    return head.take();
  }
}

/** Сборка модуля: типы, импорты, функции, таблица, память, экспорты. */
export class WasmModule {
  constructor() {
    this.types = []; // [{params:[], results:[]}]
    this.imports = []; // [{module,name,typeIndex}]
    this.functions = []; // typeIndex для каждой определённой функции
    this.codes = []; // Uint8Array тела
    this.tableMin = 0;
    this.memoryPages = 0;
    this.exports = []; // [{name,kind,index}]
    this.elementFunctions = null; // Uint32Array индексов функций в таблице
  }

  typeIndex(params, results) {
    const key = params.join(',') + '>' + results.join(',');
    const index = this.types.findIndex(type => type.key === key);
    if (index >= 0) return index;
    this.types.push({ key, params, results });
    return this.types.length - 1;
  }

  importFunction(module, name, params, results) {
    const typeIndex = this.typeIndex(params, results);
    const index = this.imports.length;
    this.imports.push({ module, name, typeIndex });
    return index;
  }

  /** Добавить функцию; возвращает её индекс (с учётом импортов). */
  function_(typeIndex, body) {
    const index = this.imports.length + this.functions.length;
    this.functions.push(typeIndex);
    this.codes.push(body);
    return index;
  }

  setTable(functions) {
    this.tableMin = functions.length;
    this.elementFunctions = functions;
  }

  setMemory(pages) {
    this.memoryPages = pages;
  }

  export_(name, kind, index) {
    this.exports.push({ name, kind, index });
  }

  build() {
    const out = new Writer(1024 * 1024);
    // header
    out.raw(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

    // 1. types
    {
      const section = new Writer(this.types.length * 8 + 8);
      section.u32(this.types.length);
      for (const type of this.types) {
        section.u8(0x60);
        section.u32(type.params.length);
        for (const param of type.params) section.u8(param);
        section.u32(type.results.length);
        for (const result of type.results) section.u8(result);
      }
      out.u8(1);
      out.block(section.view());
    }

    // 2. imports
    if (this.imports.length) {
      const section = new Writer();
      section.u32(this.imports.length);
      const encoder = new TextEncoder();
      for (const item of this.imports) {
        const module = encoder.encode(item.module);
        const name = encoder.encode(item.name);
        section.u32(module.length);
        section.raw(module);
        section.u32(name.length);
        section.raw(name);
        section.u8(KIND_FUNC);
        section.u32(item.typeIndex);
      }
      out.u8(2);
      out.block(section.view());
    }

    // 3. functions
    {
      const section = new Writer();
      section.u32(this.functions.length);
      for (const typeIndex of this.functions) section.u32(typeIndex);
      out.u8(3);
      out.block(section.view());
    }

    // 4. table
    if (this.tableMin) {
      const section = new Writer();
      section.u32(1);
      section.u8(0x70); // funcref
      section.u8(0x00); // limits: min only
      section.u32(this.tableMin);
      out.u8(4);
      out.block(section.view());
    }

    // 5. memory
    if (this.memoryPages) {
      const section = new Writer();
      section.u32(1);
      section.u8(0x00);
      section.u32(this.memoryPages);
      out.u8(5);
      out.block(section.view());
    }

    // 7. exports
    {
      const section = new Writer();
      section.u32(this.exports.length);
      const encoder = new TextEncoder();
      for (const item of this.exports) {
        const name = encoder.encode(item.name);
        section.u32(name.length);
        section.raw(name);
        section.u8(item.kind);
        section.u32(item.index);
      }
      out.u8(7);
      out.block(section.view());
    }

    // 9. elements
    if (this.elementFunctions && this.elementFunctions.length) {
      const section = new Writer();
      section.u32(1); // один сегмент
      section.u32(0); // таблица 0
      section.u8(OP.i32_const);
      section.i32(0);
      section.u8(OP.end);
      section.u32(this.elementFunctions.length);
      for (const funcIndex of this.elementFunctions) section.u32(funcIndex);
      out.u8(9);
      out.block(section.view());
    }

    // 10. code
    {
      const section = new Writer(this.codes.length * 64 + 16);
      section.u32(this.codes.length);
      for (const body of this.codes) section.block(body);
      out.u8(10);
      out.block(section.view());
    }

    return out.take();
  }
}
