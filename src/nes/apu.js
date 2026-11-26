// Собственная модель звукового сопроцессора NES 2A03 (APU).
//
// Никакого кода JSNES здесь нет: JSNES 2.1.0 (dev-only, Apache-2.0) использован
// только как поведенческий эталон при разработке (какие регистры, в каком
// порядке и с какими последствиями меняются). Все алгоритмы — по документации
// NESdev (APU, APU Pulse, APU Triangle, APU Noise, APU Frame Counter, APU DMC).
//
// Модель тактирования:
//  * `advance(cpuCycles)` двигает АПУ событиями: следующий тик таймера канала,
//    следующий шаг frame sequencer'а или следующий аудиосэмпл. Внутри одной
//    порции state-машина проходит все события по порядку, поэтому результат
//    не зависит от того, как эти циклы нарезаны (`advance(1000)` ≡ 10×`advance(100)`).
//  * Длительность сэмпла задаётся рационально: `sampleRate` берётся из
//    конструктора, а дробный sample timer хранится в целых числах
//    (накопленные полутакты CPU × sampleRate), поэтому нет накопления
//    ошибки округления и нет зависимости от размера порции.
//  * Выход — стерео (для 2A03 моно, поэтому L = R), значения в −1..1,
//    микширование через нелинейные DAC-таблицы NES (square/tnd).
//
// DMC: реализованы регистры $4010-$4013, статус в $4015 и уровень прямого
// DAC-загруза $4011, НО реальное воспроизведение сэмплов/DMA не реализовано
// (для Тетриса не нужно). Места заглушки помечены `DMC STUB`.

/** Тактовая частота CPU NTSC (Гц). */
export const CPU_CLOCK_NTSC = 1789772.5;

/** CPU_CLOCK_NTSC * 2 — целое число для точной рациональной арифметики сэмплов. */
const CPU_CLOCK_X2 = 3579545;

/** 32 значения length counter (индекс — биты 3..7 регистра длины). */
const LENGTH_TABLE = Uint8Array.from([
  0x0a, 0xfe, 0x14, 0x02, 0x28, 0x04, 0x50, 0x06,
  0xa0, 0x08, 0x3c, 0x0a, 0x0e, 0x0c, 0x1a, 0x0e,
  0x0c, 0x10, 0x18, 0x12, 0x30, 0x14, 0x60, 0x16,
  0xc0, 0x18, 0x48, 0x1a, 0x10, 0x1c, 0x20, 0x1e,
]);

/** Скважность импульсных каналов: 12.5%, 25%, 50%, 75%. */
const DUTY_SEQUENCES = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];

/** Периоды шумового канала, циклы CPU (NTSC). */
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

/** Периоды DMC в циклах CPU (NTSC); для заглушки нужны только как состояние регистра. */
const DMC_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

// Frame sequencer: позиции шагов в тактах CPU и полный период.
// Значения — как у аппаратного счётчика: шаги приходятся на нечётные
// полутакты APU (жёстко зафиксированные позиции, см. NESdev).
const FRAME_STEPS_4 = [7457, 14913, 22371, 29828, 29829];
const FRAME_PERIOD_4 = 29830;
const FRAME_STEPS_5 = [7457, 14913, 22371, 29829, 37281];
const FRAME_PERIOD_5 = 37282;

/** Таблицы нелинейного DAC-микшера и его точка покоя. */
function buildDacTables() {
  // Аппаратная нелинейность ЦАП NES (формула blargg с NESdev): сумма
  // импульсов и сумма triangle/noise/dmc смешиваются через
  // R-2R-подобные цепочки. Таблицы заранее посчитаны в целых единицах
  // (масштаб 1/32768), как принято в эталонных эмуляторах.
  const square = new Float64Array(512);
  const tnd = new Float64Array(3264);
  let maxSquare = 0;
  let maxTnd = 0;
  for (let i = 0; i < square.length; i++) {
    const value = Math.floor((95.52 / (8128 / (i / 16) + 100)) * 0.98411 * 50000);
    square[i] = value;
    if (value > maxSquare) maxSquare = value;
  }
  for (let i = 0; i < tnd.length; i++) {
    const value = Math.floor((163.67 / (24329 / (i / 16) + 100)) * 0.98411 * 50000);
    tnd[i] = value;
    if (value > maxTnd) maxTnd = value;
  }
  return { square, tnd, dc: (maxSquare + maxTnd) / 2 };
}

const DAC = buildDacTables();
const DAC_SCALE = 1 / 32768;
/** Коэффициент DC-блокера (постоянная времени ~1024 сэмпла, как в эталоне). */
const DC_BLOCK_COEFF = 1 - 1 / 1024;

/** Глубина аудио-«окна» для значений channels (уровни 0..15). */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Огибающая (envelope) импульсных каналов и шума.
 * Тактируется quarter-frame (~240 Гц).
 */
class Envelope {
  constructor() {
    this.reset();
  }

  reset() {
    this.constant = false; // $400x bit4: постоянный громкость вместо огибающей
    this.loop = false; // $400x bit5: зациклить огибающую (он же length halt)
    this.period = 0; // $400x bits0..3: V (период огибающей / громкость)
    this.start = false; // флаг перезапуска, ставится записью в $4003/$4007/$400F
    this.divider = 0;
    this.level = 0;
  }

  write(value) {
    this.constant = (value & 0x10) !== 0;
    this.period = value & 0x0f;
    this.loop = (value & 0x20) !== 0;
  }

  /** Тик quarter-frame. */
  clock() {
    if (this.start) {
      this.start = false;
      this.divider = this.period + 1;
      this.level = 0x0f;
    } else if (--this.divider <= 0) {
      this.divider = this.period + 1;
      if (this.level > 0) {
        this.level--;
      } else {
        this.level = this.loop ? 0x0f : 0;
      }
    }
  }

  /** Текущая громкость 0..15. */
  get volume() {
    return this.constant ? this.period : this.level;
  }
}

/**
 * Импульсный канал (pulse 1 / pulse 2).
 *
 * Таймер: значение 11 бит; период = 2*(timer+1) циклов CPU (таймер APU
 * тикает каждые 2 такта CPU). Счётчик скважности двигается по 8-шаговой
 * последовательности своей duty.
 */
class PulseChannel {
  /** @param {boolean} isPulse1 — у pulse 1 инверсный сумматор sweep на единицу. */
  constructor(isPulse1) {
    this.isPulse1 = isPulse1;
    this.envelope = new Envelope();
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.duty = 0;
    this.lengthHalt = false;
    this.length = 0;
    this.timerPeriod = 0;
    this.timerWait = 0;
    this.dutyStep = 0;
    // Sweep unit.
    this.sweepEnabled = false;
    this.sweepPeriod = 0;
    this.sweepNegate = false;
    this.sweepShift = 0;
    this.sweepDivider = 0;
    this.sweepReload = true;
    this.envelope.reset();
    // После инициализации JSNES ($4003=0) огибающая ждёт запуска.
    this.envelope.start = true;
  }

  get period() {
    return (this.timerPeriod + 1) << 1;
  }

  writeReg(offset, value) {
    switch (offset) {
      case 0:
        this.envelope.write(value);
        this.lengthHalt = (value & 0x20) !== 0;
        this.duty = (value >> 6) & 0x03;
        break;
      case 1:
        this.sweepEnabled = (value & 0x80) !== 0;
        this.sweepPeriod = (value >> 4) & 0x07;
        this.sweepNegate = (value & 0x08) !== 0;
        this.sweepShift = value & 0x07;
        this.sweepReload = true;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((value & 0x07) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[(value >> 3) & 0x1f];
        this.envelope.start = true;
        break;
      default:
        break;
    }
  }

  setEnabled(value) {
    this.enabled = value;
    if (!value) this.length = 0;
  }

  get lengthStatus() {
    return this.enabled && this.length > 0 ? 1 : 0;
  }

  /** Тик таймера: шаг последовательности скважности. */
  clockTimer() {
    this.dutyStep = (this.dutyStep + 1) & 0x07;
  }

  /** Тик quarter-frame. */
  clockEnvelope() {
    this.envelope.clock();
  }

  /** Тик half-frame: length counter, затем sweep unit. */
  clockHalfFrame() {
    if (!this.lengthHalt && this.length > 0) this.length--;
    this.clockSweep();
  }

  /** Тик half-frame для sweep unit. */
  clockSweep() {
    // Такая же схема счётчика, как у аппаратного sweep (divider = P+1).
    if (--this.sweepDivider <= 0) {
      this.sweepDivider = this.sweepPeriod + 1;
      if (this.sweepEnabled && this.sweepShift > 0 && this.timerPeriod > 7) {
        if (!this.sweepNegate) {
          this.timerPeriod += this.timerPeriod >> this.sweepShift;
          if (this.timerPeriod > 0x7ff) this.timerPeriod = 4095;
        } else {
          // Pulse 1 в negate-режиме складывает ones' complement (ещё −1).
          this.timerPeriod -= (this.timerPeriod >> this.sweepShift) + (this.isPulse1 ? 1 : 0);
        }
      }
    }
    if (this.sweepReload) {
      this.sweepReload = false;
      this.sweepDivider = this.sweepPeriod + 1;
    }
  }

  /** Мгновенный уровень канала 0..15 за текущий такт. */
  get outputLevel() {
    if (!this.enabled || this.length === 0 || this.timerPeriod < 8) return 0;
    // Переполнение цели sweep (negate-режим не переполняет период).
    if (!this.sweepNegate && this.timerPeriod + (this.timerPeriod >> this.sweepShift) > 0x7ff) return 0;
    return DUTY_SEQUENCES[this.duty][this.dutyStep] * this.envelope.volume;
  }
}

/**
 * Треугольный канал: 32-шаговый генератор, линейный счётчик и length counter.
 * Таймер APU тикает каждые (timer+1) тактов CPU.
 */
class TriangleChannel {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.control = false; // $4008 bit7: управление linear counter / length halt
    this.reloadValue = 0;
    // JSNES при инициализации пишет $400B=0, что выставляет флаг перезагрузки.
    this.linearReload = true;
    this.linearCounter = 0;
    this.timerPeriod = 0;
    this.timerWait = 0;
    this.counter = 0;
    this.length = 0;
  }

  get period() {
    return this.timerPeriod + 1;
  }

  writeReg(offset, value) {
    switch (offset) {
      case 0:
        this.control = (value & 0x80) !== 0;
        this.reloadValue = value & 0x7f;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((value & 0x07) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[(value >> 3) & 0x1f];
        this.linearReload = true;
        break;
      default:
        break;
    }
  }

  setEnabled(value) {
    this.enabled = value;
    if (!value) this.length = 0;
  }

  get lengthStatus() {
    return this.enabled && this.length > 0 ? 1 : 0;
  }

  /** Тик таймера: сдвиг 32-шаговой последовательности. */
  clockTimer() {
    if (this.linearCounter > 0 && this.length > 0) {
      this.counter = (this.counter + 1) & 0x1f;
    }
  }

  /** Тик quarter-frame: linear counter. */
  clockLinearCounter() {
    if (this.linearReload) {
      this.linearCounter = this.reloadValue;
    } else if (this.linearCounter > 0) {
      this.linearCounter--;
    }
    if (!this.control) this.linearReload = false;
  }

  /** Тик half-frame: length counter. */
  clockLengthCounter() {
    if (!this.control && this.length > 0) this.length--;
  }

  /** Мгновенный уровень канала 0..15. */
  get outputLevel() {
    if (!this.enabled || this.length === 0 || this.linearCounter === 0) return 0;
    // Диапазон таймера, на котором эталонный JSNES не интерполирует triangle.
    if (this.timerPeriod < 8) return 0;
    // Аппаратная 32-шаговая последовательность: 15,14,...,0,0,1,...,15.
    const step = this.counter;
    return step < 16 ? 15 - step : step - 16;
  }
}

/**
 * Шумовой канал: 15-битный LFSR с отводом от бита 1 (mode 0) или 6 (mode 1),
 * огибающая и length counter.
 *
 * Последовательность сдвигов эквивалентна аппаратной; начальное состояние
 * (0x4000) выбрано так, чтобы порядок состояний совпадал с эталонным JSNES,
 * что позволяет сравнивать форму сигнала на реальных записях.
 */
class NoiseChannel {
  constructor() {
    this.envelope = new Envelope();
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.lengthHalt = false;
    this.length = 0;
    this.mode = 0;
    this.periodIndex = 0;
    this.period = NOISE_PERIODS[0];
    this.timerWait = 0;
    this.lfsr = 0x4000;
    this.outputHigh = false;
    this.envelope.reset();
    this.envelope.start = true;
    // JSNES после инициализации записывает $400E=0 (период 4) — сохраняем то же
    // состояние свободно бегущего LFSR, чтобы фаза совпадала при сравнении.
  }

  writeReg(offset, value) {
    switch (offset) {
      case 0:
        this.envelope.write(value);
        this.lengthHalt = (value & 0x20) !== 0;
        break;
      case 2:
        this.mode = (value >> 7) & 1;
        this.periodIndex = value & 0x0f;
        this.period = NOISE_PERIODS[this.periodIndex];
        break;
      case 3:
        if (this.enabled) this.length = LENGTH_TABLE[(value >> 3) & 0x1f];
        this.envelope.start = true;
        break;
      default:
        break;
    }
  }

  setEnabled(value) {
    this.enabled = value;
    if (!value) this.length = 0;
  }

  get lengthStatus() {
    return this.enabled && this.length > 0 ? 1 : 0;
  }

  /** Тик LFSR: обновляет бит выхода. */
  clockTimer() {
    const tap = this.mode ? 6 : 1;
    const feedback = (this.lfsr & 1) ^ ((this.lfsr >> tap) & 1);
    this.lfsr = (this.lfsr >>> 1) | (feedback << 14);
    // Громкость проходит, когда обратная связь равна нулю (порядок состояний
    // совпадает с эталонным JSNES 2.1.0).
    this.outputHigh = feedback === 0;
  }

  /** Тик quarter-frame. */
  clockEnvelope() {
    this.envelope.clock();
  }

  /** Тик half-frame. */
  clockHalfFrame() {
    if (!this.lengthHalt && this.length > 0) this.length--;
  }

  /** Мгновенный уровень канала 0..15. */
  get outputLevel() {
    if (!this.enabled || this.length === 0 || !this.outputHigh) return 0;
    return this.envelope.volume;
  }
}

/**
 * DMC — заглушка.
 *
 * DMC STUB: реальное воспроизведение (DMA-выборка байтов из памяти, счётчик
 * оставшихся байт, DMC IRQ) не реализовано — для Тетриса оно не нужно.
 * Реализованы только регистры $4010-$4013 и прямой DAC-уровень $4011,
 * чтобы отражённое состояние и $4015 не «врали» о включённом канале.
 */
class DmcStub {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.irqEnabled = false;
    this.loop = false;
    this.irqFlag = false; // DMC STUB: никогда не выставляется
    this.rateIndex = 0;
    this.period = DMC_PERIODS[0];
    this.directLoad = 0;
    this.deltaCounter = 0;
    this.dacLsb = 0;
    this.sampleLevel = 0;
    this.sampleAddress = 0;
    this.sampleLength = 0;
    this.bytesRemaining = 0; // DMC STUB: всегда 0, воспроизведения нет
  }

  writeReg(address, value) {
    switch (address) {
      case 0x4010:
        this.irqEnabled = (value & 0x80) !== 0;
        this.loop = (value & 0x40) !== 0;
        this.rateIndex = value & 0x0f;
        this.period = DMC_PERIODS[this.rateIndex];
        // DMC STUB: перезапуск/IRQ не эмулируются.
        if (!this.irqEnabled) this.irqFlag = false;
        break;
      case 0x4011:
        this.directLoad = value & 0x7f;
        this.deltaCounter = this.directLoad >> 1;
        this.dacLsb = this.directLoad & 1;
        this.sampleLevel = (this.deltaCounter << 1) + this.dacLsb;
        break;
      case 0x4012:
        this.sampleAddress = value;
        break;
      case 0x4013:
        this.sampleLength = value;
        break;
      default:
        break;
    }
  }

  /** Бит 4 статуса $4015. DMC STUB: байт не осталось, канал «молчит». */
  get lengthStatus() {
    return 0;
  }

  get irqStatus() {
    return 0;
  }
}

/**
 * APU 2A03.
 *
 * Контракт (docs/ARCHITECTURE.md §3.4):
 *   new APU({ sampleRate = 48000, onSample })
 *   reset(), writeReg(addr, value), readReg(addr), advance(cpuCycles)
 *   irqPending, channels {pulse1,pulse2,triangle,noise}
 *   toJSON()/fromJSON(state)
 */
export class APU {
  /**
   * @param {{sampleRate?: number, onSample?: (left: number, right: number) => void}} [options]
   */
  constructor({ sampleRate = 48000, onSample = null } = {}) {
    const rate = Math.round(Number(sampleRate));
    this.sampleRate = Number.isFinite(rate) && rate > 0 ? rate : 48000;
    this.onSample = typeof onSample === 'function' ? onSample : null;
    this.pulse1 = new PulseChannel(true);
    this.pulse2 = new PulseChannel(false);
    this.triangle = new TriangleChannel();
    this.noise = new NoiseChannel();
    this.dmc = new DmcStub();
    this.reset();
  }

  reset() {
    this.pulse1.reset();
    this.pulse2.reset();
    this.triangle.reset();
    this.noise.reset();
    this.dmc.reset();

    /** Уровни каналов 0..15 за последний сэмпл-интервал (для разделения музыки/эффектов). */
    this.channels = { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 };

    // Фракционный sample timer: накопленные полутакты CPU × sampleRate.
    // Сэмпл выдаётся, когда значение достигает CPU_CLOCK_X2.
    this.samplePhase = 0;
    this.accCycles = 0;
    this.accPulse1 = 0;
    this.accPulse2 = 0;
    this.accTriangle = 0;
    this.accNoise = 0;
    this.accDmc = 0;
    this.emittedSamples = 0;
    // DC-блокер выходного каскада.
    this.dcPrevIn = 0;
    this.dcPrevOut = 0;
    this.dcReady = false;

    // Frame sequencer.
    this.frameMode = 0; // 0 = 4 шага, 1 = 5 шагов
    this.frameStep = 0;
    this.frameCycleCounter = 0;
    // На аппарате после сброса frame IRQ, как правило, запрещён; JSNES 2.1.0
    // (наш поведенческий эталон) стартует с запрещённым IRQ. Игры, которым
    // нужен frame IRQ, явно пишут $4017.
    this.irqInhibit = true;
    this.frameIrqFlag = false;
    this.irqPending = false;
  }

  setFrameRate() {
    // Фасад для совместимости с JSNES: у нас аудио привязано к тактам CPU,
    // а не к кадрам, поэтому пересчёт sample timer не нужен.
  }

  /**
   * Подтвердить обслуживание IRQ (вызывается шиной/консолью после входа
   * CPU в обработчик прерывания). Снимает выставленный APU флаг frame IRQ.
   */
  acknowledgeIrq() {
    this.frameIrqFlag = false;
    this.dmc.irqFlag = false; // DMC STUB: флаг всегда 0
    this.#updateIrq();
  }

  /**
   * Запись в регистр APU ($4000-$4013, $4015, $4017).
   * @param {number} address
   * @param {number} value
   */
  writeReg(address, value) {
    value &= 0xff;
    if (address >= 0x4000 && address <= 0x4003) {
      this.pulse1.writeReg(address - 0x4000, value);
    } else if (address >= 0x4004 && address <= 0x4007) {
      this.pulse2.writeReg(address - 0x4004, value);
    } else if (address >= 0x4008 && address <= 0x400b) {
      this.triangle.writeReg(address - 0x4008, value);
    } else if (address >= 0x400c && address <= 0x400f) {
      this.noise.writeReg(address - 0x400c, value);
    } else if (address >= 0x4010 && address <= 0x4013) {
      this.dmc.writeReg(address, value);
    } else if (address === 0x4015) {
      this.#writeStatus(value);
    } else if (address === 0x4017) {
      this.#writeFrameCounter(value);
    }
  }

  /**
   * Чтение регистра APU. Реально читается только $4015 (статус).
   * Бит 5 (open bus) не выставляется — его добавляет шина/маппер.
   * @param {number} address
   * @returns {number}
   */
  readReg(address) {
    if ((address & 0x1f) !== 0x15) return 0;
    const status =
      this.pulse1.lengthStatus |
      (this.pulse2.lengthStatus << 1) |
      (this.triangle.lengthStatus << 2) |
      (this.noise.lengthStatus << 3) |
      (this.dmc.lengthStatus << 4) |
      ((this.frameIrqFlag ? 1 : 0) << 6) |
      ((this.dmc.irqStatus ? 1 : 0) << 7);
    // Чтение $4015 сбрасывает флаг frame IRQ.
    if (this.frameIrqFlag) {
      this.frameIrqFlag = false;
      this.#updateIrq();
    }
    return status & 0xff;
  }

  /**
   * Продвинуть APU на N тактов CPU.
   * Детерминирован: результат не зависит от разбиения N на порции.
   * @param {number} cpuCycles
   */
  advance(cpuCycles) {
    let remaining = Math.floor(cpuCycles);
    if (!(remaining > 0)) return;

    while (remaining > 0) {
      // Сколько тактов до следующего события каждого типа.
      const sampleWait = Math.ceil((CPU_CLOCK_X2 - this.samplePhase) / (2 * this.sampleRate));
      const frameWait = this.#nextFrameWait();
      const pulse1Wait = this.pulse1.timerWait > 0 ? this.pulse1.timerWait : 1;
      const pulse2Wait = this.pulse2.timerWait > 0 ? this.pulse2.timerWait : 1;
      const triangleWait =
        this.triangle.timerPeriod > 0 ? (this.triangle.timerWait > 0 ? this.triangle.timerWait : 1) : Infinity;
      const noiseWait = this.noise.period > 0 ? (this.noise.timerWait > 0 ? this.noise.timerWait : 1) : Infinity;

      let step = remaining;
      if (sampleWait < step) step = sampleWait;
      if (frameWait < step) step = frameWait;
      if (pulse1Wait < step) step = pulse1Wait;
      if (pulse2Wait < step) step = pulse2Wait;
      if (triangleWait < step) step = triangleWait;
      if (noiseWait < step) step = noiseWait;
      if (!(step >= 1)) step = 1;

      // 1. Интегрируем текущие уровни каналов за step тактов.
      const levelPulse1 = this.pulse1.outputLevel;
      const levelPulse2 = this.pulse2.outputLevel;
      const levelTriangle = this.triangle.outputLevel;
      const levelNoise = this.noise.outputLevel;
      const levelDmc = this.dmc.sampleLevel;
      this.accCycles += step;
      this.accPulse1 += levelPulse1 * step;
      this.accPulse2 += levelPulse2 * step;
      this.accTriangle += levelTriangle * step;
      this.accNoise += levelNoise * step;
      this.accDmc += levelDmc * step;

      // 2. Двигаем счётчики.
      this.pulse1.timerWait -= step;
      this.pulse2.timerWait -= step;
      if (this.triangle.timerPeriod > 0) this.triangle.timerWait -= step;
      // Шумовой счётчик decrement'ится всегда (как в эталонном JSNES), даже
      // если период сейчас 0: при включении периода накопившийся «хвост»
      // даёт ровно ту же серию сдвигов LFSR.
      this.noise.timerWait -= step;
      this.frameCycleCounter += step;
      this.samplePhase += step * 2 * this.sampleRate;
      remaining -= step;

      // 3. Обрабатываем события, попавшие на конец такта.
      this.#clockPulseTimer(this.pulse1);
      this.#clockPulseTimer(this.pulse2);
      if (this.triangle.timerPeriod > 0) {
        while (this.triangle.timerWait <= 0) {
          this.triangle.clockTimer();
          this.triangle.timerWait += this.triangle.period;
        }
      }
      if (this.noise.period > 0) {
        while (this.noise.timerWait <= 0) {
          this.noise.clockTimer();
          this.noise.timerWait += this.noise.period;
        }
      }
      this.#clockFrameSequencer();

      // 4. Выдаём сэмплы, если sample timer переполнился.
      while (this.samplePhase >= CPU_CLOCK_X2) {
        this.#emitSample();
        this.samplePhase -= CPU_CLOCK_X2;
      }
    }
  }

  // --- Frame sequencer ---------------------------------------------------

  #writeStatus(value) {
    this.pulse1.setEnabled((value & 0x01) !== 0);
    this.pulse2.setEnabled((value & 0x02) !== 0);
    this.triangle.setEnabled((value & 0x04) !== 0);
    this.noise.setEnabled((value & 0x08) !== 0);
    this.dmc.enabled = (value & 0x10) !== 0;
    // Запись $4015 сбрасывает флаг DMC IRQ (DMC STUB: флаг всегда 0).
    this.dmc.irqFlag = false;
    if (!(value & 0x10)) {
      this.dmc.bytesRemaining = 0;
    } else if (this.dmc.bytesRemaining === 0) {
      // DMC STUB: перезапуск сэмпла не эмулируется.
      this.dmc.bytesRemaining = 0;
    }
    this.#updateIrq();
  }

  #writeFrameCounter(value) {
    this.frameMode = (value >> 7) & 1;
    this.irqInhibit = (value & 0x40) !== 0;
    if (this.irqInhibit) this.frameIrqFlag = false;
    // Сброс делителя frame sequencer'а. На аппарате сброс происходит через
    // несколько тактов после записи (задержка зависит от фазы APU); наша
    // шина не сообщает длину текущей инструкции, поэтому счётчик
    // перезапускается с текущего такта — см. ограничения в README задачи.
    this.frameCycleCounter = 0;
    this.frameStep = 0;
    if (this.frameMode === 1) {
      // 5-step: запись $4017 сразу тактирует quarter и half frame.
      this.#clockQuarterFrame();
      this.#clockHalfFrame();
    }
    this.#updateIrq();
  }

  #frameSteps() {
    return this.frameMode === 0 ? FRAME_STEPS_4 : FRAME_STEPS_5;
  }

  #framePeriod() {
    return this.frameMode === 0 ? FRAME_PERIOD_4 : FRAME_PERIOD_5;
  }

  /** Тактов CPU до следующего шага/сброса frame sequencer'а (всегда ≥1). */
  #nextFrameWait() {
    const steps = this.#frameSteps();
    const target = this.frameStep < steps.length ? steps[this.frameStep] : this.#framePeriod();
    const wait = target - this.frameCycleCounter;
    return wait > 0 ? wait : 1;
  }

  #clockFrameSequencer() {
    const steps = this.#frameSteps();
    const period = this.#framePeriod();
    while (this.frameStep < steps.length && this.frameCycleCounter >= steps[this.frameStep]) {
      this.#fireFrameStep(this.frameStep);
      this.frameStep++;
    }
    if (this.frameStep >= steps.length && this.frameCycleCounter >= period) {
      this.frameCycleCounter -= period;
      this.frameStep = 0;
      if (this.frameMode === 0) {
        // На аппарате флаг IRQ выставляется в конце 4-шаговой
        // последовательности; inhibit снимает именно линию IRQ, но флаг при
        // этом активно сбрасывается на границе периода (поведение JSNES).
        this.frameIrqFlag = !this.irqInhibit;
      }
    }
  }

  #fireFrameStep(step) {
    if (this.frameMode === 0) {
      switch (step) {
        case 0:
        case 2:
          this.#clockQuarterFrame();
          break;
        case 1:
          this.#clockQuarterFrame();
          this.#clockHalfFrame();
          break;
        case 3:
          // Флаг IRQ выставляется за такт до half-frame такта.
          this.frameIrqFlag = true;
          break;
        case 4:
          this.#clockQuarterFrame();
          this.#clockHalfFrame();
          this.frameIrqFlag = true;
          break;
        default:
          break;
      }
    } else {
      switch (step) {
        case 0:
        case 2:
          this.#clockQuarterFrame();
          break;
        case 1:
        case 4:
          this.#clockQuarterFrame();
          this.#clockHalfFrame();
          break;
        default:
          break;
      }
    }
    this.#updateIrq();
  }

  #clockQuarterFrame() {
    this.pulse1.clockEnvelope();
    this.pulse2.clockEnvelope();
    this.noise.clockEnvelope();
    this.triangle.clockLinearCounter();
  }

  #clockHalfFrame() {
    this.triangle.clockLengthCounter();
    this.pulse1.clockHalfFrame();
    this.pulse2.clockHalfFrame();
    this.noise.clockHalfFrame();
  }

  #updateIrq() {
    // DMC STUB: у DMC флаг IRQ всегда 0.
    this.irqPending = Boolean((this.frameIrqFlag && !this.irqInhibit) || this.dmc.irqFlag);
  }

  // --- Тактирование каналов ---------------------------------------------

  #clockPulseTimer(channel) {
    while (channel.timerWait <= 0) {
      channel.clockTimer();
      channel.timerWait += channel.period;
    }
  }

  // --- Микширование и выдача сэмплов ------------------------------------

  #emitSample() {
    const cycles = this.accCycles;
    const qPulse1 = Math.floor((this.accPulse1 * 16) / cycles);
    const qPulse2 = Math.floor((this.accPulse2 * 16) / cycles);
    const qTriangle = Math.floor((this.accTriangle * 16) / cycles);
    const qNoise = Math.floor((this.accNoise * 16) / cycles);
    const qDmc = Math.floor((this.accDmc * 16) / cycles);

    // Нелинейный DAC: две импульсные суммы и «tnd»-сумма смешиваются по
    // аппаратной кривой. Индексы — те же, что у аппаратных таблиц:
    // square = (pulse1+pulse2)/2, tnd = (3*tri + 2*noise + dmc)/2.
    const squareIndex = (qPulse1 + qPulse2) >> 1;
    const tndIndex = (3 * qTriangle + (qNoise << 1) + qDmc) >> 1;
    const raw =
      (DAC.square[squareIndex >= 0 && squareIndex < DAC.square.length ? squareIndex : DAC.square.length - 1] +
        DAC.tnd[tndIndex >= 0 && tndIndex < DAC.tnd.length ? tndIndex : DAC.tnd.length - 1] -
        DAC.dc) *
      DAC_SCALE;

    // AC-связь выходного каскада: y[n] = (x[n] - x[n-1]) + R*y[n-1].
    if (!this.dcReady) {
      this.dcPrevIn = raw;
      this.dcReady = true;
    }
    let sample = raw - this.dcPrevIn + this.dcPrevOut * DC_BLOCK_COEFF;
    this.dcPrevIn = raw;
    this.dcPrevOut = sample;
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;

    // Уровни каналов за только что закрытый интервал.
    if (cycles > 0) {
      this.channels.pulse1 = round4(this.accPulse1 / cycles);
      this.channels.pulse2 = round4(this.accPulse2 / cycles);
      this.channels.triangle = round4(this.accTriangle / cycles);
      this.channels.noise = round4(this.accNoise / cycles);
    }
    this.accCycles = 0;
    this.accPulse1 = 0;
    this.accPulse2 = 0;
    this.accTriangle = 0;
    this.accNoise = 0;
    this.accDmc = 0;
    this.emittedSamples++;

    if (this.onSample) this.onSample(sample, sample);
  }

  // --- Сохранение состояния ---------------------------------------------

  /** Полное состояние APU в виде plain-объекта (пригодно для JSON). */
  toJSON() {
    return clonePlain({
      version: 1,
      sampleRate: this.sampleRate,
      samplePhase: this.samplePhase,
      accCycles: this.accCycles,
      accPulse1: this.accPulse1,
      accPulse2: this.accPulse2,
      accTriangle: this.accTriangle,
      accNoise: this.accNoise,
      accDmc: this.accDmc,
      emittedSamples: this.emittedSamples,
      dcPrevIn: this.dcPrevIn,
      dcPrevOut: this.dcPrevOut,
      dcReady: this.dcReady,
      channels: { ...this.channels },
      pulse1: { ...this.pulse1, envelope: { ...this.pulse1.envelope } },
      pulse2: { ...this.pulse2, envelope: { ...this.pulse2.envelope } },
      triangle: { ...this.triangle },
      noise: { ...this.noise, envelope: { ...this.noise.envelope } },
      dmc: { ...this.dmc },
      frameMode: this.frameMode,
      frameStep: this.frameStep,
      frameCycleCounter: this.frameCycleCounter,
      irqInhibit: this.irqInhibit,
      frameIrqFlag: this.frameIrqFlag,
      irqPending: this.irqPending,
    });
  }

  /**
   * Восстановить состояние из toJSON().
   * @param {object|string} state
   */
  fromJSON(state) {
    const data = typeof state === 'string' ? JSON.parse(state) : clonePlain(state);
    if (!data || typeof data !== 'object') throw new TypeError('APU.fromJSON: ожидался объект состояния');

    const restoredRate = Math.round(Number(data.sampleRate));
    if (Number.isFinite(restoredRate) && restoredRate > 0 && restoredRate !== this.sampleRate) {
      // Фаза sample timer'а меряется в единицах «полутакты × sampleRate».
      const scale = this.sampleRate > 0 ? restoredRate / this.sampleRate : 1;
      this.samplePhase = Math.round((data.samplePhase || 0) * scale);
      this.sampleRate = restoredRate;
    } else {
      this.samplePhase = data.samplePhase || 0;
    }

    this.accCycles = data.accCycles || 0;
    this.accPulse1 = data.accPulse1 || 0;
    this.accPulse2 = data.accPulse2 || 0;
    this.accTriangle = data.accTriangle || 0;
    this.accNoise = data.accNoise || 0;
    this.accDmc = data.accDmc || 0;
    this.emittedSamples = data.emittedSamples || 0;
    this.dcPrevIn = data.dcPrevIn || 0;
    this.dcPrevOut = data.dcPrevOut || 0;
    this.dcReady = Boolean(data.dcReady);
    this.channels = {
      pulse1: data.channels?.pulse1 || 0,
      pulse2: data.channels?.pulse2 || 0,
      triangle: data.channels?.triangle || 0,
      noise: data.channels?.noise || 0,
    };

    this.pulse1 = this.#restorePulse(data.pulse1, true);
    this.pulse2 = this.#restorePulse(data.pulse2, false);
    this.triangle = Object.assign(new TriangleChannel(), data.triangle || {});
    this.noise = this.#restoreNoise(data.noise);
    this.dmc = Object.assign(new DmcStub(), data.dmc || {});

    this.frameMode = data.frameMode ? 1 : 0;
    this.frameStep = data.frameStep || 0;
    this.frameCycleCounter = data.frameCycleCounter || 0;
    this.irqInhibit = data.irqInhibit !== undefined ? Boolean(data.irqInhibit) : true;
    this.frameIrqFlag = Boolean(data.frameIrqFlag);
    this.#updateIrq();
  }

  #restorePulse(data, isPulse1) {
    const channel = new PulseChannel(isPulse1);
    if (!data) return channel;
    const envelope = data.envelope ? data.envelope : {};
    const { envelope: _omit, ...fields } = data;
    Object.assign(channel, fields);
    channel.envelope = Object.assign(new Envelope(), envelope);
    return channel;
  }

  #restoreNoise(data) {
    const channel = new NoiseChannel();
    if (!data) return channel;
    const envelope = data.envelope ? data.envelope : {};
    const { envelope: _omit, ...fields } = data;
    Object.assign(channel, fields);
    channel.envelope = Object.assign(new Envelope(), envelope);
    return channel;
  }
}

export default APU;
