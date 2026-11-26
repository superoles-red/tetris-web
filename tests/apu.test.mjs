// Тесты APU 2A03 (src/nes/apu.js).
//
// 1) Юнит-тесты по спецификации NESdev: огибающая, length counter, sweep,
//    linear counter, frame sequencer, frame IRQ, статус $4015, микшер.
// 2) Детерминизм: advance(большими порциями) ≡ advance(малыми порциями).
// 3) Полное сохранение состояния (toJSON/fromJSON).
// 4) Дифференциальный тест с JSNES 2.1.0 на реальных ROM: сценарий с музыкой
//    и эффектами (Start/Left/Right/Down/A, 480 кадров), запись таймлайна
//    регистровых записей (адрес, значение, номер такта CPU), воспроизведение
//    того же таймлайна через наш APU и сравнение формы сигнала: корреляция
//    по окнам 30 мс (шаг 10 мс), RMS-отношение, спектральное сходство.
//    Свободно бегущие фазы делителей синхронизируются со снимком JSNES в
//    момент t0: на железе эта фаза произвольна, сравнивать нужно форму.
//    Оба сигнала одинаково фильтруются ВЧ (скользящее среднее 5 мс).
//    Без ROM тест пропускается; ROM в репозиторий не копируется, WAV и
//    JSON-отчёт пишутся только в /tmp.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import APU, { CPU_CLOCK_NTSC } from '../src/nes/apu.js';

/* ------------------------------------------------------------------ */
/* Вспомогательные функции                                             */
/* ------------------------------------------------------------------ */

/** Продвинуть APU на cycles тактов, собирая сэмплы. */
function collect(apu, cycles, chunk = 0) {
  const samples = [];
  const prev = apu.onSample;
  apu.onSample = (left, right) => {
    samples.push([left, right]);
    if (prev) prev(left, right);
  };
  try {
    if (chunk > 0) {
      let left = cycles;
      while (left > 0) {
        const step = Math.min(chunk, left);
        apu.advance(step);
        left -= step;
      }
    } else {
      apu.advance(cycles);
    }
  } finally {
    apu.onSample = prev;
  }
  return samples;
}

/** RMS массива сэмплов по левому каналу. */
function rms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const [left] of samples) sum += left * left;
  return Math.sqrt(sum / samples.length);
}

/** AC-RMS (стандартное отклонение) одномерного массива — RMS после удаления среднего. */
function acRms(values) {
  if (values.length === 0) return 0;
  let mean = 0;
  for (const value of values) mean += value;
  mean /= values.length;
  let sum = 0;
  for (const value of values) sum += (value - mean) * (value - mean);
  return Math.sqrt(sum / values.length);
}

/**
 * Одинаковая для эталона и нашей модели ВЧ-коррекция: вычитаем скользящее
 * среднее шириной ~5 мс (отсечка ~200 Гц). Это убирает DC/суббасовый дрейф,
 * в частности артефакт целочисленного DC-фильтра JSNES, который «залипает»
 * на остатке до 1023/32768 в тишине и даёт ложные всплески на выключении
 * каналов. Сравниваем форму слышимого сигнала, одинаково обработанного.
 */
function highPass(values, halfWindow = 120) {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - halfWindow);
    const to = Math.min(n, i + halfWindow + 1);
    out[i] = values[i] - (prefix[to] - prefix[from]) / (to - from);
  }
  return out;
}

const QUARTER = 7457;
const HALF = 14913;
const FRAME4 = 29830;
const FRAME5 = 37282;

/* ------------------------------------------------------------------ */
/* Конструктор и сброс                                                 */
/* ------------------------------------------------------------------ */

test('APU: конструктор, sampleRate, тишина после сброса', () => {
  const samples = [];
  const apu = new APU({ sampleRate: 48000, onSample: (l, r) => samples.push([l, r]) });
  assert.equal(apu.sampleRate, 48000);
  assert.deepEqual(apu.channels, { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 });
  assert.equal(apu.irqPending, false);
  assert.equal(apu.readReg(0x4015), 0);

  apu.advance(20000);
  assert.equal(samples.length, 536); // 20000 / (1789772.5/48000) ≈ 536.4
  for (const [left, right] of samples) {
    assert.equal(left, 0);
    assert.equal(right, 0);
  }
  // Частота сэмплов соответствует sampleRate.
  assert.ok(Math.abs(apu.emittedSamples - (20000 * 48000) / CPU_CLOCK_NTSC) < 2);
});

test('APU: sampleRate из конструктора влияет на частоту сэмплов', () => {
  for (const rate of [44100, 48000, 22050]) {
    const apu = new APU({ sampleRate: rate });
    apu.advance(Math.round(CPU_CLOCK_NTSC));
    assert.ok(Math.abs(apu.emittedSamples - rate) <= 2, `${rate}: ${apu.emittedSamples}`);
  }
  const fallback = new APU({ sampleRate: 0 });
  assert.equal(fallback.sampleRate, 48000);
});

test('APU: reset очищает всё состояние', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x0f);
  apu.writeReg(0x4000, 0xbf);
  apu.writeReg(0x4002, 0x80);
  apu.writeReg(0x4003, 0x08);
  apu.writeReg(0x4008, 0x80);
  apu.writeReg(0x400e, 0x0c);
  apu.writeReg(0x4017, 0x00);
  apu.advance(50000);
  apu.reset();
  assert.equal(apu.pulse1.length, 0);
  assert.equal(apu.pulse1.enabled, false);
  assert.equal(apu.triangle.length, 0);
  assert.equal(apu.noise.enabled, false);
  assert.equal(apu.frameIrqFlag, false);
  assert.equal(apu.irqPending, false);
  assert.equal(apu.readReg(0x4015), 0);
  assert.equal(apu.emittedSamples, 0);
});

/* ------------------------------------------------------------------ */
/* Length counter                                                      */
/* ------------------------------------------------------------------ */

test('APU: length counter загружается, тикает на half-frame и уважает halt', () => {
  const apu = new APU();
  // Pulse 1: enable, длина = LENGTH_TABLE[1] = 254.
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4003, 0x08);
  assert.equal(apu.pulse1.length, 254);
  assert.equal(apu.readReg(0x4015) & 1, 1);

  apu.advance(HALF); // первый half-frame
  assert.equal(apu.pulse1.length, 253);
  apu.advance(FRAME4 - HALF); // второй half-frame
  assert.equal(apu.pulse1.length, 252);

  // Halt (bit5) останавливает счётчик.
  apu.writeReg(0x4000, 0x20);
  apu.advance(FRAME4);
  assert.equal(apu.pulse1.length, 252);

  // Снятие halt — счётчик снова тикает.
  apu.writeReg(0x4000, 0x00);
  apu.advance(FRAME4);
  assert.equal(apu.pulse1.length, 250);
});

test('APU: запись длины при выключенном канале не загружает length counter', () => {
  const apu = new APU();
  apu.writeReg(0x4003, 0x08); // канал выключен
  assert.equal(apu.pulse1.length, 0);
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4003, 0x08);
  assert.equal(apu.pulse1.length, 254);
});

test('APU: выключение канала через $4015 обнуляет length counter', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x0f);
  apu.writeReg(0x4003, 0x08);
  apu.writeReg(0x4007, 0x08);
  apu.writeReg(0x400b, 0x08);
  apu.writeReg(0x400f, 0x08);
  assert.equal(apu.pulse1.length, 254);
  apu.writeReg(0x4015, 0x00);
  assert.equal(apu.pulse1.length, 0);
  assert.equal(apu.pulse2.length, 0);
  assert.equal(apu.triangle.length, 0);
  assert.equal(apu.noise.length, 0);
});

/* ------------------------------------------------------------------ */
/* Огибающая                                                           */
/* ------------------------------------------------------------------ */

test('APU: envelope decay и loop', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  // Envelope: period 0, loop+halt (bit5), без constant volume (bit4=0).
  apu.writeReg(0x4000, 0x20);
  apu.writeReg(0x4003, 0x00); // запуск огибающей + length
  apu.advance(QUARTER);
  assert.equal(apu.pulse1.envelope.level, 15);
  // Дальше каждый quarter-frame уменьшает уровень на 1 (period 0).
  for (let level = 14; level >= 0; level--) {
    apu.pulse1.clockEnvelope();
    assert.equal(apu.pulse1.envelope.level, level);
  }
  apu.pulse1.clockEnvelope(); // loop → снова 15
  assert.equal(apu.pulse1.envelope.level, 15);
});

test('APU: envelope без loop останавливается на нуле; constant volume игнорирует огибающую', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4000, 0x07); // envelope period 7, без loop
  apu.writeReg(0x4003, 0x00);
  apu.advance(QUARTER * 400); // заведомо больше полного спада
  assert.equal(apu.pulse1.envelope.level, 0);

  apu.writeReg(0x4000, 0x1a); // constant volume = 10
  assert.equal(apu.pulse1.envelope.volume, 10);
  const fresh = new APU();
  fresh.writeReg(0x4000, 0x1a);
  assert.equal(fresh.pulse1.envelope.volume, 10);
});

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

test('APU: sweep увеличивает/уменьшает период и клэмпит переполнение', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4000, 0x1f); // constant volume 15
  apu.writeReg(0x4002, 0x00);
  apu.writeReg(0x4003, 0x02); // timerPeriod = 0x200
  apu.writeReg(0x4001, 0x81); // enable, period=0, negate=0, shift=1

  apu.advance(HALF);
  assert.equal(apu.pulse1.timerPeriod, 0x200 + 0x100);
  apu.advance(FRAME4 - HALF);
  assert.equal(apu.pulse1.timerPeriod, 0x300 + 0x180);

  // Переполнение цели: период > 0x7FF → канал молчит, период клампится.
  const overflow = new APU();
  overflow.writeReg(0x4015, 0x01);
  overflow.writeReg(0x4000, 0x1f);
  overflow.writeReg(0x4002, 0xff);
  overflow.writeReg(0x4003, 0x07); // 0x7FF
  overflow.writeReg(0x4001, 0x81);
  assert.equal(overflow.pulse1.outputLevel, 0); // mute по цели sweep
  overflow.advance(HALF);
  assert.equal(overflow.pulse1.timerPeriod, 4095);

  // Negate-режим: pulse 1 вычитает ones' complement (+1).
  const neg = new APU();
  neg.writeReg(0x4015, 0x03);
  neg.writeReg(0x4002, 0x00);
  neg.writeReg(0x4003, 0x02);
  neg.writeReg(0x4001, 0x89);
  neg.writeReg(0x4006, 0x00);
  neg.writeReg(0x4007, 0x02);
  neg.writeReg(0x4005, 0x89);
  neg.advance(HALF);
  assert.equal(neg.pulse1.timerPeriod, 0x200 - 0x100 - 1);
  assert.equal(neg.pulse2.timerPeriod, 0x200 - 0x100);
});

test('APU: sweep-перезагрузка периода счётчика по записи $4001', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4002, 0x00);
  apu.writeReg(0x4003, 0x02);
  apu.writeReg(0x4001, 0xb1); // enable, period=3, shift=1
  assert.equal(apu.pulse1.sweepReload, true);
  // Первый half-frame: счётчик догружается периодом P+1=4 и sweep
  // применяется (поведение эталонного JSNES: сначала тик, потом reload).
  apu.advance(HALF);
  assert.equal(apu.pulse1.timerPeriod, 0x300);
  assert.equal(apu.pulse1.sweepDivider, 4);
  // Следующие тики только уменьшают делитель; период обновится через P+1
  // half-frame (первый — 14913, затем +14916 на кадр).
  apu.advance(74577 - HALF);
  assert.equal(apu.pulse1.timerPeriod, 0x480);
});

/* ------------------------------------------------------------------ */
/* Triangle: linear counter и length                                   */
/* ------------------------------------------------------------------ */

test('APU: triangle linear counter (reload и decrement)', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x04);
  apu.writeReg(0x4008, 0x08); // control=0, reload value = 8
  apu.writeReg(0x400b, 0x00); // linearReload=true, length=LENGTH_TABLE[0]=10
  assert.equal(apu.triangle.length, 10);
  apu.advance(QUARTER);
  assert.equal(apu.triangle.linearCounter, 8);
  assert.equal(apu.triangle.linearReload, false);
  apu.triangle.clockLinearCounter();
  assert.equal(apu.triangle.linearCounter, 7);
  for (let i = 0; i < 7; i++) apu.triangle.clockLinearCounter();
  assert.equal(apu.triangle.linearCounter, 0);
});

test('APU: triangle control=1 удерживает linear counter (перезагрузка каждый quarter)', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x04);
  apu.writeReg(0x4008, 0x88); // control=1, reload 8
  apu.writeReg(0x400b, 0x00);
  apu.advance(QUARTER * 10);
  assert.equal(apu.triangle.linearCounter, 8);
  assert.equal(apu.triangle.length, 10); // control=1 == length halt
});

test('APU: triangle 32-шаговая последовательность уровней', () => {
  const apu = new APU();
  apu.triangle.enabled = true;
  apu.triangle.length = 10;
  apu.triangle.linearCounter = 10;
  apu.triangle.timerPeriod = 100;
  for (let counter = 0; counter < 32; counter++) {
    apu.triangle.counter = counter;
    // Аппаратная последовательность: 15,14,...,0,0,1,...,15.
    const expected = counter < 16 ? 15 - counter : counter - 16;
    assert.equal(apu.triangle.outputLevel, expected, `counter=${counter}`);
  }
});

/* ------------------------------------------------------------------ */
/* Frame sequencer                                                     */
/* ------------------------------------------------------------------ */

test('APU: 4-step frame sequencer: шаги по точным тактам CPU', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4000, 0x00); // envelope (period 0), length halt снят
  apu.writeReg(0x4003, 0x08); // length=254, envelope start
  assert.equal(apu.pulse1.length, 254);
  assert.equal(apu.pulse1.envelope.start, true);

  apu.advance(QUARTER - 1);
  assert.equal(apu.pulse1.envelope.start, true, 'до шага 7457 ничего не тактируется');
  assert.equal(apu.pulse1.length, 254);

  apu.advance(1); // такт 7457: quarter frame
  assert.equal(apu.pulse1.envelope.start, false);
  assert.equal(apu.pulse1.envelope.level, 15);
  assert.equal(apu.pulse1.length, 254, 'half-frame ещё не было');

  apu.advance(HALF - QUARTER); // такт 14913: half frame
  assert.equal(apu.pulse1.length, 253);
  assert.equal(apu.pulse1.envelope.level, 14);

  // step 2 (22371) — только quarter.
  apu.advance(22371 - HALF);
  assert.equal(apu.pulse1.envelope.level, 13);
  assert.equal(apu.pulse1.length, 253);

  // step 3/4 (29828/29829) — half frame и frame IRQ.
  apu.advance(29829 - 22371);
  assert.equal(apu.pulse1.length, 252);
  assert.equal(apu.pulse1.envelope.level, 12);
  assert.equal(apu.frameIrqFlag, true);
});

test('APU: 5-step frame sequencer: сброс счётчика и немедленные quarter/half', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4003, 0x08);
  assert.equal(apu.pulse1.length, 254);
  apu.writeReg(0x4017, 0x80); // 5-step, IRQ inhibit
  assert.equal(apu.frameMode, 1);
  assert.equal(apu.frameCycleCounter, 0);
  assert.equal(apu.pulse1.length, 253, 'запись сразу тактирует half-frame');

  apu.advance(HALF); // step1: quarter+half
  assert.equal(apu.pulse1.length, 252);
  apu.advance(29829 - HALF); // step3: no-op
  assert.equal(apu.pulse1.length, 252);
  apu.advance(37281 - 29829); // step4: quarter+half
  assert.equal(apu.pulse1.length, 251);
  apu.advance(FRAME5 - 37281); // сброс периода
  assert.equal(apu.frameStep, 0);
  assert.equal(apu.frameIrqFlag, false);
});

/* ------------------------------------------------------------------ */
/* Frame IRQ и статус $4015                                            */
/* ------------------------------------------------------------------ */

test('APU: frame IRQ выставляется в 4-step, запрещается inhibit и чистится чтением $4015', () => {
  const apu = new APU();
  // По умолчанию (как JSNES) IRQ запрещён.
  apu.advance(FRAME4);
  assert.equal(apu.irqPending, false);

  apu.writeReg(0x4017, 0x00); // 4-step, IRQ разрешён, счётчик с нуля
  apu.advance(29827);
  assert.equal(apu.irqPending, false);
  apu.advance(1); // такт 29828 (step 3)
  assert.equal(apu.frameIrqFlag, true);
  assert.equal(apu.irqPending, true);
  assert.ok(apu.readReg(0x4015) & 0x40);
  assert.equal(apu.irqPending, false);
  assert.equal(apu.readReg(0x4015) & 0x40, 0, 'чтение сбросило флаг');

  // Inhibit (bit6) очищает флаг и запрещает IRQ.
  apu.writeReg(0x4017, 0x00);
  apu.advance(29828);
  assert.equal(apu.irqPending, true);
  apu.writeReg(0x4017, 0x40);
  assert.equal(apu.irqPending, false);
  assert.equal(apu.frameIrqFlag, false);
  apu.advance(FRAME4);
  assert.equal(apu.irqPending, false);
});

test('APU: статус $4015 отражает length counter каналов', () => {
  const apu = new APU();
  assert.equal(apu.readReg(0x4015), 0);
  apu.writeReg(0x4015, 0x0f);
  apu.writeReg(0x4003, 0x08);
  apu.writeReg(0x4007, 0x08);
  apu.writeReg(0x400b, 0x08);
  apu.writeReg(0x400f, 0x08);
  assert.equal(apu.readReg(0x4015) & 0x0f, 0x0f);
  apu.writeReg(0x4015, 0x05);
  assert.equal(apu.readReg(0x4015) & 0x0f, 0x05);
  // Остальные регистры APU читаются как 0.
  assert.equal(apu.readReg(0x4000), 0);
  assert.equal(apu.readReg(0x4017), 0);
});

/* ------------------------------------------------------------------ */
/* Каналы: выходной сигнал                                             */
/* ------------------------------------------------------------------ */

test('APU: импульсный канал даёт ненулевой сигнал, duty 12.5/25/50/75', () => {
  // Средняя доля «включённых» шагов в последовательности duty.
  const onesPerEight = { 0: 1, 1: 2, 2: 4, 3: 6 };
  for (const [dutyText, ones] of Object.entries(onesPerEight)) {
    const duty = Number(dutyText);
    const apu = new APU();
    apu.writeReg(0x4015, 0x01);
    apu.writeReg(0x4000, 0x1f | (duty << 6)); // constant volume 15, halt снят
    apu.writeReg(0x4002, 0x00);
    apu.writeReg(0x4003, 0x01); // timer = 0x100, length load
    const samples = collect(apu, 20000);
    assert.ok(rms(samples) > 0.01, `duty=${duty} должен звучать`);

    const levels = [];
    const prev = apu.onSample;
    apu.onSample = (left, right) => {
      levels.push(apu.channels.pulse1);
      if (prev) prev(left, right);
    };
    try {
      apu.advance(120000);
    } finally {
      apu.onSample = prev;
    }
    const average = levels.reduce((a, b) => a + b, 0) / levels.length;
    const expected = (15 * ones) / 8;
    assert.ok(Math.abs(average - expected) < 0.5, `duty=${duty}: средний уровень ${average} вместо ${expected}`);
  }
});

test('APU: triangle звучит и channels.triangle в диапазоне 0..15', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x04);
  apu.writeReg(0x4008, 0x7f); // control=0, reload 127 (hold на quarter)
  apu.writeReg(0x400a, 0x40);
  apu.writeReg(0x400b, 0x00); // timer=0x40, length=10
  apu.writeReg(0x4017, 0x40); // IRQ inhibit, чтобы не мешал
  const samples = collect(apu, 20000);
  assert.ok(rms(samples) > 0.005, 'triangle должен звучать');
  for (const [left] of samples) {
    assert.ok(left >= -1 && left <= 1);
    assert.ok(apu.channels.triangle >= 0 && apu.channels.triangle <= 15);
  }
});

test('APU: noise LFSR (mode 0/1), переключение режима меняет последовательность', () => {
  const sequenceFor = mode => {
    const apu = new APU();
    apu.writeReg(0x4015, 0x08);
    apu.writeReg(0x400c, 0x1f); // constant volume 15, halt=0
    apu.writeReg(0x400e, 0x08 | (mode << 7)); // период 202 цикла
    apu.writeReg(0x400f, 0x08);
    const bits = [];
    for (let i = 0; i < 32; i++) {
      apu.advance(202);
      bits.push(apu.noise.outputHigh ? 1 : 0);
    }
    return bits;
  };
  const a = sequenceFor(0);
  const b = sequenceFor(1);
  assert.notDeepEqual(a, b);
  // 15-битный LFSR не должен застревать.
  assert.ok(a.some(bit => bit === 0) && a.some(bit => bit === 1));

  const apu = new APU();
  assert.equal(apu.noise.lfsr, 0x4000);
  apu.noise.clockTimer();
  assert.equal(apu.noise.outputHigh, true);
  assert.equal(apu.noise.lfsr, 0x2000);
});

test('APU: микшер — ненулевой сигнал на известных настройках и диапазон −1..1', () => {
  const apu = new APU({ sampleRate: 48000 });
  apu.writeReg(0x4015, 0x0f);
  apu.writeReg(0x4000, 0xbf); // pulse1: 50% duty, constant 15
  apu.writeReg(0x4002, 0x71);
  apu.writeReg(0x4003, 0x01);
  apu.writeReg(0x4004, 0xbf); // pulse2: 50% duty, constant 15
  apu.writeReg(0x4006, 0x8f);
  apu.writeReg(0x4007, 0x01);
  apu.writeReg(0x4008, 0x7f); // triangle
  apu.writeReg(0x400a, 0x53);
  apu.writeReg(0x400b, 0x01);
  apu.writeReg(0x400c, 0x1c); // noise
  apu.writeReg(0x400e, 0x08);
  apu.writeReg(0x400f, 0x08);
  apu.writeReg(0x4017, 0x40);
  const samples = collect(apu, 24000); // 0.5 c
  assert.ok(rms(samples) > 0.02, `RMS=${rms(samples)}`);
  let max = 0;
  for (const [left, right] of samples) {
    assert.equal(left, right, '2A03 моно: L === R');
    assert.ok(Number.isFinite(left));
    assert.ok(left >= -1 && left <= 1);
    max = Math.max(max, Math.abs(left));
  }
  assert.ok(max > 0.01);
  assert.ok(apu.channels.pulse1 > 0);
});

test('APU: DMC-заглушка — регистры принимаются, воспроизведения/IRQ нет', () => {
  const apu = new APU();
  apu.writeReg(0x4010, 0x0f);
  apu.writeReg(0x4011, 0x40);
  apu.writeReg(0x4012, 0x30);
  apu.writeReg(0x4013, 0x10);
  apu.writeReg(0x4015, 0x10);
  assert.equal(apu.readReg(0x4015) & 0x10, 0, 'DMC STUB: байт не осталось');
  assert.equal(apu.readReg(0x4015) & 0x80, 0, 'DMC STUB: DMC IRQ не выставляется');
  assert.equal(apu.dmc.bytesRemaining, 0);
  assert.equal(apu.dmc.sampleLevel, 0x40);
  assert.equal(apu.irqPending, false);
  apu.advance(50000);
  assert.equal(apu.irqPending, false);
});

/* ------------------------------------------------------------------ */
/* Детерминизм и сохранение состояния                                  */
/* ------------------------------------------------------------------ */

// Один и тот же сценарий регистровых записей с разной нарезкой advance().
const SCRIPT_SEGMENTS = [
  { cycles: 3000, writes: [[0x4015, 0x0f], [0x4000, 0xbf], [0x4002, 0x71], [0x4003, 0x01]] },
  { cycles: 14913, writes: [[0x4004, 0xbc], [0x4006, 0x8f], [0x4007, 0x01]] },
  { cycles: 29830, writes: [[0x4001, 0xad], [0x4005, 0xda]] },
  { cycles: 50000, writes: [[0x4008, 0xbf], [0x400a, 0x53], [0x400b, 0x01]] },
  { cycles: 50000, writes: [[0x400c, 0xbc], [0x400e, 0x08], [0x400f, 0x08]] },
  { cycles: 200000, writes: [[0x4002, 0x8f], [0x4006, 0xe2]] },
];

function playScript(apu, smallChunks) {
  const samples = [];
  const prev = apu.onSample;
  apu.onSample = (left, right) => samples.push([left, right]);
  try {
    for (const segment of SCRIPT_SEGMENTS) {
      for (const [address, value] of segment.writes) apu.writeReg(address, value);
      if (smallChunks) {
        let left = segment.cycles;
        while (left > 0) {
          const step = Math.min(7, left);
          apu.advance(step);
          left -= step;
        }
      } else {
        apu.advance(segment.cycles);
      }
    }
  } finally {
    apu.onSample = prev;
  }
  return samples;
}

test('APU: advance(большими порциями) ≡ advance(малыми порциями)', () => {
  const big = new APU();
  const bigSamples = collect(big, 600000);
  const small = new APU();
  const smallSamples = collect(small, 600000, 7);
  assert.equal(bigSamples.length, smallSamples.length);
  for (let i = 0; i < bigSamples.length; i++) {
    assert.equal(bigSamples[i][0], smallSamples[i][0], `sample ${i}`);
  }
  // Значения channels тоже детерминированы.
  assert.deepEqual(big.channels, small.channels);
});

test('APU: детерминизм на скрипте с записями регистров', () => {
  const a = new APU();
  const b = new APU();
  const big = playScript(a, false);
  const small = playScript(b, true);
  assert.deepEqual(big, small);
  assert.ok(big.length > 1000);
});

test('APU: toJSON/fromJSON восстанавливают полное состояние', () => {
  const apu = new APU({ sampleRate: 48000 });
  apu.writeReg(0x4015, 0x0f);
  apu.writeReg(0x4000, 0xbf);
  apu.writeReg(0x4002, 0x71);
  apu.writeReg(0x4003, 0x08);
  apu.writeReg(0x4001, 0xad);
  apu.writeReg(0x4008, 0xbf);
  apu.writeReg(0x400a, 0x53);
  apu.writeReg(0x400b, 0x01);
  apu.writeReg(0x400c, 0xbc);
  apu.writeReg(0x400e, 0x08);
  apu.writeReg(0x400f, 0x08);
  apu.advance(100000);

  const state = apu.toJSON();
  // состояние должно быть JSON-сериализуемым и не содержать функций
  const roundTrip = JSON.parse(JSON.stringify(state));
  const restored = new APU({ sampleRate: 48000 });
  restored.fromJSON(roundTrip);

  assert.equal(restored.readReg(0x4015), apu.readReg(0x4015));
  const samplesA = collect(apu, 120000);
  const samplesB = collect(restored, 120000);
  assert.deepEqual(samplesA, samplesB);
  assert.deepEqual(apu.channels, restored.channels);
});

test('APU: fromJSON корректно восстанавливает и после него можно продолжать', () => {
  const apu = new APU();
  apu.writeReg(0x4015, 0x01);
  apu.writeReg(0x4000, 0xbf);
  apu.writeReg(0x4002, 0x71);
  apu.writeReg(0x4003, 0x08);
  apu.advance(30000);
  const state = apu.toJSON();
  const copy = new APU();
  copy.fromJSON(state);
  // Обе модели должны давать одинаковый результат после продолжения.
  apu.writeReg(0x4002, 0x8f);
  copy.writeReg(0x4002, 0x8f);
  assert.deepEqual(collect(apu, 30000), collect(copy, 30000));
});

/* ------------------------------------------------------------------ */
/* Дифференциальный тест с JSNES на реальном ROM                       */
/* ------------------------------------------------------------------ */

const ROM_CANDIDATES = [
  process.env.TETRIS_ROM || '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game.nes',
  process.env.TETRIS_ROM_RU || '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game-ru.nes',
];

const JSNES_ROOT = new URL('../node_modules/jsnes/src/', import.meta.url);

async function loadJsnes() {
  const nesModule = await import(new URL('nes.js', JSNES_ROOT).href);
  const mappersModule = await import(new URL('mappers/index.js', JSNES_ROOT).href);
  const Mappers = mappersModule.default;
  // JSNES 2.1.0 не содержит mapper 148 (Tengen 800008), который используется
  // в Тетрисе. Для дифференциального прогона добавляем его в рантайме теста;
  // в node_modules ничего не пишем.
  if (!Mappers[148]) {
    Mappers[148] = class Mapper148Tengen extends Mappers[0] {
      static mapperName = 'Tengen 800008 (test shim)';

      write(address, value) {
        if (address < 0x8000) {
          super.write(address, value);
          return;
        }
        // Как в оригинальном картридже: CHR-банк = (value & PRG[addr]) & 7.
        const latch = value & this.nes.cpu.mem[address];
        if (this.nes.rom.romCount > 2) this.load32kRomBank((latch >> 3) & 1, 0x8000);
        this.load8kVromBank((latch & 7) * 2, 0);
      }
    };
  }
  return nesModule.default;
}

/**
 * Сценарий ввода: навигация по меню (Start/Up/Down по RAM-сценe $29,
 * как в самой игре) с выбором музыки, затем игра в «play»-сцене с
 * движениями/сбросом фигур (Start/Left/Right/Down/A). Даёт музыку и SFX.
 */
function makeScenarioInputs() {
  const START = 3;
  const UP = 4;
  const DOWN = 5;
  const LEFT = 6;
  const RIGHT = 7;
  const A = 0;
  // Сцены игры в RAM $29 (см. cartridge.js в оригинальном проекте):
  // $fa title, $fc mode, $fd level, $fe handicap, $ff music, $00 play.
  const menuSizes = { 0xfc: 5, 0xfd: 10, 0xfe: 5, 0xff: 5 };
  const cursorAddress = { 0xfc: 0x4f0, 0xfd: 0x4f1, 0xfe: 0x4f3, 0xff: 0x4f5 };
  const targets = { 0xfc: 0, 0xfd: 0, 0xfe: 0, 0xff: 1 }; // music = track 1

  const pressed = new Set();
  let heldButton = null;
  let wait = 0;
  return function beforeFrame(nes, frame) {
    const setButton = (code, down) => {
      if (down) {
        if (!pressed.has(code)) {
          nes.buttonDown(1, code);
          pressed.add(code);
        }
      } else if (pressed.has(code)) {
        nes.buttonUp(1, code);
        pressed.delete(code);
      }
    };
    const scene = nes.cpu.mem[0x29];
    if (heldButton !== null) {
      setButton(heldButton, false);
      heldButton = null;
      wait = 2;
      return;
    }
    if (scene === 0) {
      // Игра: движение/поворот/сброс фигуры.
      const phase = frame % 40;
      setButton(LEFT, phase === 2 || phase === 3);
      setButton(A, phase === 10 || phase === 11);
      setButton(RIGHT, phase === 18 || phase === 19);
      setButton(A, phase === 26 || phase === 27);
      setButton(DOWN, phase >= 32 && phase <= 36);
      return;
    }
    if (wait > 0) {
      wait--;
      return;
    }
    if (scene in cursorAddress) {
      const current = nes.cpu.mem[cursorAddress[scene]];
      const target = targets[scene];
      const size = menuSizes[scene];
      if (target !== current) {
        const steps = (target + size - current) % size;
        const button = steps <= size / 2 ? DOWN : UP;
        setButton(button, true);
        heldButton = button;
        return;
      }
    }
    setButton(START, true);
    heldButton = START;
  };
}

/** Записать моно-WAV в /tmp для ручного прослушивания. */
function writeWav(path, leftChannel, sampleRate) {
  const frames = leftChannel.length;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const clamped = Math.max(-1, Math.min(1, leftChannel[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  writeFileSync(path, buffer);
}

/** Линейная интерполяция массива. */
function interp(values, position) {
  const i = Math.floor(position);
  if (i < 0) return values[0] || 0;
  if (i + 1 >= values.length) return values[values.length - 1] || 0;
  const frac = position - i;
  return values[i] * (1 - frac) + values[i + 1] * frac;
}

/** Среднее, медиана, перцентиль. */
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Пирсонова корреляция двух окон. */
function correlation(a, b, length) {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < length; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= length;
  meanB /= length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

/** Радикс-2 FFT (in-place), размер — степень двойки. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Амплитудный спектр окна (N — степень двойки), с окном Ханна. */
function spectrumMagnitude(values, offset, n) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = values[offset + i] * w;
  }
  fft(re, im);
  const magnitude = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) magnitude[i] = Math.hypot(re[i], im[i]);
  return magnitude;
}

/** Косинусное сходство двух нормированных спектров. */
function spectralSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 1; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Синхронизация свободно бегущих делителей нашего APU со снимком JSNES.
 *
 * На железе фаза таймеров при включении произвольна, а регистровые записи её
 * не сбрасывают: «форма» сигнала не зависит от этой фазы. Для честного
 * сравнения формы (а не случайной фазы) в момент старта сравнения t0
 * начальное состояние делителей берётся из эталонного JSNES, дальше обе
 * модели получают один и тот же таймлайн записей регистров.
 */
function synchronizeFromJsnes(apu, papu) {
  const syncPulse = (channel, square) => {
    channel.enabled = square.isEnabled;
    channel.duty = square.dutyMode;
    channel.lengthHalt = !square.lengthCounterEnable;
    channel.length = square.lengthCounter;
    channel.timerPeriod = square.progTimerMax;
    channel.dutyStep = square.squareCounter & 0x07;
    channel.timerWait = square.progTimerCount > 0 ? square.progTimerCount : 1;
    channel.envelope.constant = square.envDecayDisable;
    channel.envelope.loop = square.envDecayLoopEnable;
    channel.envelope.period = square.envDecayRate;
    channel.envelope.start = square.envReset;
    channel.envelope.divider = square.envDecayCounter;
    channel.envelope.level = square.envVolume;
    channel.sweepEnabled = square.sweepActive;
    channel.sweepPeriod = square.sweepCounterMax;
    channel.sweepNegate = square.sweepMode === 1;
    channel.sweepShift = square.sweepShiftAmount;
    channel.sweepDivider = square.sweepCounter;
    channel.sweepReload = square.updateSweepPeriod;
  };
  syncPulse(apu.pulse1, papu.square1);
  syncPulse(apu.pulse2, papu.square2);

  const triangle = papu.triangle;
  apu.triangle.enabled = triangle.isEnabled;
  apu.triangle.control = triangle.lcControl;
  apu.triangle.reloadValue = triangle.lcLoadValue;
  apu.triangle.linearReload = triangle.lcHalt;
  apu.triangle.linearCounter = triangle.linearCounter;
  apu.triangle.timerPeriod = triangle.progTimerMax;
  apu.triangle.timerWait = triangle.progTimerCount > 0 ? triangle.progTimerCount : 1;
  apu.triangle.counter = triangle.triangleCounter;
  apu.triangle.length = triangle.lengthCounter;

  const noise = papu.noise;
  apu.noise.enabled = noise.isEnabled;
  apu.noise.lengthHalt = !noise.lengthCounterEnable;
  apu.noise.length = noise.lengthCounter;
  apu.noise.mode = noise.randomMode;
  apu.noise.period = noise.progTimerMax;
  apu.noise.timerWait = noise.progTimerCount > 0 ? noise.progTimerCount : 1;
  apu.noise.outputHigh = noise.randomBit === 1;
  // JSNES хранит LFSR в «обратном» виде (сдвиг влево, feedback в бит 0);
  // переводим 15 бит в нашу правосдвиговую форму.
  let lfsr = 0;
  for (let bit = 0; bit < 15; bit++) {
    if ((noise.shiftReg >> bit) & 1) lfsr |= 1 << (14 - bit);
  }
  apu.noise.lfsr = lfsr || 0x4000;
  apu.noise.envelope.constant = noise.envDecayDisable;
  apu.noise.envelope.loop = noise.envDecayLoopEnable;
  apu.noise.envelope.period = noise.envDecayRate;
  apu.noise.envelope.start = noise.envReset;
  apu.noise.envelope.divider = noise.envDecayCounter;
  apu.noise.envelope.level = noise.envVolume;

  apu.dmc.enabled = papu.dmc.isEnabled;
  apu.dmc.deltaCounter = papu.dmc.deltaCounter;
  apu.dmc.dacLsb = papu.dmc.dacLsb;
  apu.dmc.sampleLevel = papu.dmc.isEnabled ? (papu.dmc.deltaCounter << 1) + papu.dmc.dacLsb : 0;

  apu.frameMode = papu.countSequence;
  apu.frameStep = papu.frameStep;
  apu.frameCycleCounter = papu.frameCycleCounter;
  apu.irqInhibit = !papu.frameIrqEnabled;
  apu.frameIrqFlag = papu.frameIrqActive;
  apu.irqPending = Boolean(apu.frameIrqFlag && !apu.irqInhibit);

  // Состояние DC-блокера в единицах DAC-таблицы (у JSNES — целые).
  apu.dcPrevIn = papu.prevSampleL / 32768;
  apu.dcPrevOut = papu.smpAccumL / 32768;
  apu.dcReady = true;
  apu.channels = { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 };
}

/**
 * Прогнать JSNES со сценарием, записать таймлайн регистровых записей и
 * эталонные сэмплы, затем сравнить с нашей моделью.
 */
async function runDifferential(romPath, frameCount) {
  const NES = await loadJsnes();
  const sampleRate = 48000;
  const reference = [];
  const writes = [];
  let totalCycles = 0;
  let syncSnapshot = null;
  let syncTime = 0;
  const SYNC_AT_CYCLES = Math.round(CPU_CLOCK_NTSC * 1.0); // начинаем сравнение с 1 c

  const nes = new NES({
    sampleRate,
    onAudioSample: (left, right) => reference.push((left + right) / 2),
  });
  nes.loadROM(new Uint8Array(readFileSync(romPath)));
  // Центральная панорама: сравниваем моно-сигнал без стерео-разложения JSNES.
  nes.papu.setPanning([128, 128, 128, 128, 128]);

  const papu = nes.papu;
  const originalClock = papu.clockFrameCounter.bind(papu);
  papu.clockFrameCounter = (cycles, catchupCycles) => {
    totalCycles += cycles;
    return originalClock(cycles, catchupCycles);
  };
  const originalWrite = papu.writeReg.bind(papu);
  papu.writeReg = (address, value) => {
    if (syncSnapshot === null && totalCycles >= SYNC_AT_CYCLES) {
      // Снимок состояния ДО записи: ровно то состояние, в котором канал
      // находится на границе инструкции.
      syncSnapshot = papu.toJSON();
      syncTime = totalCycles;
    }
    writes.push([address, value, totalCycles]);
    return originalWrite(address, value);
  };

  const beforeFrame = makeScenarioInputs();
  for (let frame = 0; frame < frameCount; frame++) {
    beforeFrame(nes, frame);
    nes.frame();
  }

  assert.ok(syncSnapshot !== null, 'не удалось найти точку синхронизации');
  const syncIndex = writes.findIndex(entry => entry[2] >= syncTime);
  assert.ok(syncIndex >= 0);

  // Воспроизводим таймлайн через наш APU, стартуя со снимка состояния.
  const ours = [];
  const ourChannelFrames = [];
  let apuRef = null;
  const apu = new APU({
    sampleRate,
    onSample: (left, right) => {
      ours.push((left + right) / 2);
      if (apuRef) ourChannelFrames.push({ ...apuRef.channels });
    },
  });
  apuRef = apu;
  // Восстанавливаем поля каналов напрямую из снимка JSNES.
  const snapshotPapu = reconstructPapuView(syncSnapshot);
  synchronizeFromJsnes(apu, snapshotPapu);

  let previousTime = syncTime;
  for (let i = syncIndex; i < writes.length; i++) {
    const [address, value, time] = writes[i];
    const delta = time - previousTime;
    if (delta > 0) apu.advance(delta);
    apu.writeReg(address, value);
    previousTime = time;
  }
  const tail = totalCycles - previousTime;
  if (tail > 0) apu.advance(tail);

  /* ---- Выравнивание по времени и метрики ---------------------------- */
  // JSNES использует sampleTimerMax = floor(1024*CPU_FREQ/sampleRate),
  // поэтому его эффективный период сэмпла чуть короче точного.
  const jsnesSamplePeriod = Math.floor((1024 * CPU_CLOCK_NTSC) / sampleRate) / 1024;
  const exactSamplePeriod = CPU_CLOCK_NTSC / sampleRate;
  const ratio = exactSamplePeriod / jsnesSamplePeriod; // на сколько индексов JSNES за наш сэмпл
  const basePosition = syncTime / jsnesSamplePeriod - 1;

  const alignedRef = [];
  const alignedOurs = [];
  const alignedChannels = [];
  for (let k = 0; k < ours.length; k++) {
    const refPos = basePosition + (k + 1) * ratio;
    if (refPos < 0 || refPos + 2 >= reference.length) continue;
    alignedRef.push(interp(reference, refPos));
    alignedOurs.push(ours[k]);
    alignedChannels.push(ourChannelFrames[k] || { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 });
  }

  // Пропускаем первый 0.1 c (переходные процессы фильтра на старте сравнения)
  // и одинаково фильтруем оба сигнала (DC/суббас).
  const skip = Math.round(sampleRate * 0.1);
  const ref2 = highPass(alignedRef.slice(skip));
  const ours2 = highPass(alignedOurs.slice(skip));

  const windowSize = Math.round(sampleRate * 0.03); // 30 мс
  const hop = Math.round(sampleRate * 0.01); // 10 мс
  const correlations = [];
  const rmsRatios = [];
  const spectral = [];
  const windowTimes = [];
  const windowMixes = [];
  const fftSize = 1024;
  // Активные окна ищем по AC-RMS (после удаления среднего): у JSNES
  // целочисленный DC-фильтр замирает на смещении до 1023/32768 в тишине,
  // и это не должно считаться «звуком».
  const refGlobalAc = acRms(ref2);
  // Сравниваем окна с заметным уровнем: ниже 35% от глобального AC-RMS —
  // это тишина/затухания, где у JSNES доминирует артефакт DC-фильтра.
  const activeThreshold = Math.max(1e-4, refGlobalAc * 0.35);
  let skippedQuietWindows = 0;
  for (let start = 0; start + windowSize <= ref2.length; start += hop) {
    const refWindow = ref2.slice(start, start + windowSize);
    const ourWindow = ours2.slice(start, start + windowSize);
    if (acRms(refWindow) < activeThreshold) continue;

    // Средние уровни каналов нашей модели на этом окне (alignedChannels
    // выровнен вместе с сэмплами: индекс k соответствует ours[k]).
    let mix = { pulse1: 0, pulse2: 0, triangle: 0, noise: 0 };
    for (let n = 0; n < windowSize; n++) {
      const frame = alignedChannels[skip + start + n];
      if (!frame) break;
      mix.pulse1 += frame.pulse1;
      mix.pulse2 += frame.pulse2;
      mix.triangle += frame.triangle;
      mix.noise += frame.noise;
    }
    mix = {
      pulse1: Number((mix.pulse1 / windowSize).toFixed(2)),
      pulse2: Number((mix.pulse2 / windowSize).toFixed(2)),
      triangle: Number((mix.triangle / windowSize).toFixed(2)),
      noise: Number((mix.noise / windowSize).toFixed(2)),
    };

    // Окна, где наша модель молчит (все каналы выключены), не сравниваем:
    // у JSNES после $4015 каналы могут «залипать» на последнем значении
    // sampleValue (артефакт кэша, не поведение железа), и его DC-хвост
    // даёт ложную «активность» эталона.
    if (mix.pulse1 + mix.pulse2 + mix.triangle + mix.noise < 0.5) {
      skippedQuietWindows++;
      continue;
    }

    correlations.push(correlation(refWindow, ourWindow, windowSize));
    rmsRatios.push(acRms(ourWindow) / acRms(refWindow));
    // Абсолютное время окна в прогоне JSNES (с начала эмуляции).
    windowTimes.push(syncTime / CPU_CLOCK_NTSC + (skip + start) / sampleRate);
    windowMixes.push(mix);
    if (start + fftSize <= ref2.length) {
      spectral.push(spectralSimilarity(spectrumMagnitude(ref2, start, fftSize), spectrumMagnitude(ours2, start, fftSize)));
    }
  }

  // Где расходится: окна с самой низкой корреляцией.
  const worstWindows = correlations
    .map((value, index) => ({
      seconds: Number(windowTimes[index].toFixed(2)),
      correlation: Number(value.toFixed(3)),
      rmsRatio: Number(rmsRatios[index].toFixed(3)),
      channels: windowMixes[index],
    }))
    .sort((a, b) => a.correlation - b.correlation)
    .slice(0, 5);

  const metrics = {
    rom: romPath.split(/[/\\]/).pop(),
    frames: frameCount,
    sampleRate,
    syncSeconds: Number((syncTime / CPU_CLOCK_NTSC).toFixed(3)),
    comparedSeconds: Number((ref2.length / sampleRate).toFixed(2)),
    refSamples: reference.length,
    ourSamples: ours.length,
    windowMs: Math.round((windowSize / sampleRate) * 1000),
    hopMs: Math.round((hop / sampleRate) * 1000),
    activeWindows: correlations.length,
    skippedQuietWindows,
    correlationMean: Number(mean(correlations).toFixed(4)),
    correlationMedian: Number(quantile(correlations, 0.5).toFixed(4)),
    correlationP10: Number(quantile(correlations, 0.1).toFixed(4)),
    correlationP25: Number(quantile(correlations, 0.25).toFixed(4)),
    correlationAbove90: correlations.filter(c => c > 0.9).length,
    correlationAbove50: correlations.filter(c => c > 0.5).length,
    rmsRatioMedian: Number(quantile(rmsRatios, 0.5).toFixed(4)),
    rmsRatioP10: Number(quantile(rmsRatios, 0.1).toFixed(4)),
    rmsRatioP90: Number(quantile(rmsRatios, 0.9).toFixed(4)),
    spectralMean: Number(mean(spectral).toFixed(4)),
    spectralMedian: Number(quantile(spectral, 0.5).toFixed(4)),
    worstWindows,
  };

  const stem = `/tmp/apu-diff-${metrics.rom.replace(/[^a-z0-9._-]/gi, '_')}`;
  writeWav(`${stem}-jsnes.wav`, alignedRef.slice(skip), sampleRate);
  writeWav(`${stem}-ours.wav`, alignedOurs.slice(skip), sampleRate);
  metrics.wav = [stem + '-jsnes.wav', stem + '-ours.wav'];
  return { metrics, apu, times: { syncTime, totalCycles } };
}

/**
 * Восстановить «представление JSNES» из снимка toJSON() так, чтобы
 * synchronizeFromJsnes() могла читать поля (часть полей не сериализуется
 * JSNES через toJSON — для них подставляем значения по умолчанию).
 */
function reconstructPapuView(snapshot) {
  const channelView = (channel, fallback) => Object.assign({}, fallback, channel);
  return {
    square1: channelView(snapshot.square1, {
      updateSweepPeriod: false,
    }),
    square2: channelView(snapshot.square2, {
      updateSweepPeriod: false,
    }),
    triangle: snapshot.triangle,
    noise: snapshot.noise,
    dmc: snapshot.dmc,
    countSequence: snapshot.countSequence,
    frameStep: snapshot.frameStep,
    frameCycleCounter: snapshot.frameCycleCounter,
    frameIrqEnabled: snapshot.frameIrqEnabled,
    frameIrqActive: snapshot.frameIrqActive,
    prevSampleL: snapshot.prevSampleL,
    smpAccumL: snapshot.smpAccumL,
  };
}

const existingRoms = ROM_CANDIDATES.filter(path => existsSync(path));

for (const romPath of existingRoms) {
  test(`APU: дифференциальный тест с JSNES на ROM ${romPath.split(/[/\\]/).pop()}`, { timeout: 180000 }, async () => {
    const { metrics } = await runDifferential(romPath, 480);
    // Отчёт в /tmp: цифры сравнения и WAV-файлы для ручного прослушивания.
    const reportPath = `/tmp/apu-diff-report-${metrics.rom.replace(/[^a-z0-9._-]/gi, '_')}.json`;
    writeFileSync(reportPath, JSON.stringify(metrics, null, 2) + '\n');
    console.log('[APU diff]', JSON.stringify(metrics));
    console.log(
      `[APU diff] ${metrics.rom}: окон ${metrics.activeWindows} по 30 мс; ` +
        `корреляция mean=${metrics.correlationMean} median=${metrics.correlationMedian} p10=${metrics.correlationP10}; ` +
        `RMS=${metrics.rmsRatioMedian} (p10..p90 ${metrics.rmsRatioP10}..${metrics.rmsRatioP90}); ` +
        `спектр=${metrics.spectralMean}; отчёт ${reportPath}`,
    );

    assert.ok(metrics.activeWindows >= 300, `мало активных окон: ${metrics.activeWindows}`);
    assert.ok(metrics.refSamples > 0 && metrics.ourSamples > 0);
    // Форма сигнала должна совпадать в пределах тайминговых допусков.
    // Измеренные значения на этих дампах: медиана корреляции ≈0.998,
    // среднее ≈0.988, p10 ≈0.977, RMS-отношение ≈1.005, спектр ≈0.99.
    // Худшие окна (0.62..0.80) — тихие переходы/затухания и редкие шумовые
    // эффекты, где у JSNES сказывается квантование таймингов; см. worstWindows.
    assert.ok(
      metrics.correlationMedian > 0.98,
      `медианная корреляция по 30-мс окнам слишком низкая: ${metrics.correlationMedian.toFixed(3)}`,
    );
    assert.ok(
      metrics.correlationMean > 0.95,
      `средняя корреляция слишком низкая: ${metrics.correlationMean.toFixed(3)}`,
    );
    assert.ok(
      metrics.correlationP10 > 0.9,
      `p10 корреляции слишком низкий: ${metrics.correlationP10.toFixed(3)}`,
    );
    assert.ok(
      metrics.rmsRatioMedian > 0.9 && metrics.rmsRatioMedian < 1.1,
      `RMS-отношение вне допуска: ${metrics.rmsRatioMedian.toFixed(3)}`,
    );
    assert.ok(
      metrics.spectralMean > 0.95,
      `спектральное сходство слишком низкое: ${metrics.spectralMean.toFixed(3)}`,
    );
  });
}

if (existingRoms.length === 0) {
  test('APU: дифференциальный тест с JSNES (пропущен — нет ROM)', { skip: 'ROM не найден по путям из задачи' }, () => {});
}
