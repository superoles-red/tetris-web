// Smoke-тесты dev-эталона JSNES 2.1.0 (tools/reference/*).
// Игровой ROM в репозиторий не входит и в CI отсутствует → тесты с ROM skip.
// Пути по умолчанию — известные дампы на машине разработчика; можно переопределить
// переменными окружения TETRIS_ROM_EN / TETRIS_ROM_RU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { runReferenceFile } from '../tools/reference/run-jsnes.mjs';
import { runPpuStates } from '../tools/reference/ppu-state.mjs';
import { runApuLog } from '../tools/reference/apu-log.mjs';
import {
  normalizeScenario,
  applyScenarioAtFrame,
  parseScenarioText,
  scenarioToJson,
  SCENARIOS,
} from '../tools/reference/scenario.mjs';

const EN_ROM = process.env.TETRIS_ROM_EN ?? '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game.nes';
const RU_ROM = process.env.TETRIS_ROM_RU ?? '/Users/oleskarpov/Documents/ChatGPT/Реверс инженерия/tetris-dendy-web/game-ru.nes';
const EN_MISSING = !existsSync(EN_ROM);
const RU_MISSING = !existsSync(RU_ROM);
const SKIP_EN = EN_MISSING ? 'нет ROM (CI): задайте TETRIS_ROM_EN' : false;
const SKIP_RU = RU_MISSING ? 'нет ROM (CI): задайте TETRIS_ROM_RU' : false;

// --- сценарий ввода (без ROM) ----------------------------------------------

test('сценарий: формы событий и удержания', () => {
  const scenario = normalizeScenario([
    { frame: 100, buttons: ['start'], hold: 4 },
    { frame: 140, down: ['a'], up: ['left'] },
    { from: 200, until: 203, buttons: ['down'] },
    { frame: 300, press: ['b'], release: ['a'] },
  ]);
  assert.deepEqual(scenario, [
    { frame: 100, down: [3], up: [] },
    { frame: 104, down: [], up: [3] },
    { frame: 140, down: [0], up: [6] },
    { frame: 141, down: [], up: [0] }, // down без hold держится 1 кадр
    { frame: 200, down: [5], up: [] },
    { frame: 203, down: [], up: [5] },
    { frame: 300, down: [1], up: [0] },
    { frame: 301, down: [], up: [1] }, // press без hold держится 1 кадр
  ]);
});

test('сценарий: DSL и готовые пресеты', () => {
  assert.deepEqual(parseScenarioText('start@100+4,a@140'), [
    { frame: 100, buttons: ['start'], hold: 4 },
    { frame: 140, buttons: ['a'] },
  ]);
  assert.deepEqual(normalizeScenario('start@10+2'), [
    { frame: 10, down: [3], up: [] },
    { frame: 12, down: [], up: [3] },
  ]);
  assert.ok(SCENARIOS.gameplay.length >= 5);
  assert.equal(scenarioToJson(normalizeScenario(SCENARIOS.menu))[0].down[0], 'start');
  assert.throws(() => parseScenarioText('nonsense'), /Формат/);
  assert.throws(() => normalizeScenario([{ frame: 1, buttons: ['turbo'] }]), /Неизвестная кнопка/);
});

test('сценарий: применение к кадру', () => {
  const scenario = normalizeScenario('start@2+2');
  const applied = [];
  const down = code => applied.push(`down:${code}`);
  const up = code => applied.push(`up:${code}`);
  assert.equal(applyScenarioAtFrame(scenario, 1, down, up), null);
  assert.deepEqual(applyScenarioAtFrame(scenario, 2, down, up), { down: [3], up: [] });
  assert.deepEqual(applyScenarioAtFrame(scenario, 4, down, up), { down: [], up: [3] });
  assert.deepEqual(applied, ['down:3', 'up:3']);
});

// --- JSNES: загрузка ROM ----------------------------------------------------

test('JSNES: EN-дамп (mapper 148) грузится через dev-патч заголовка и даёт разные кадры', { skip: SKIP_EN }, async () => {
  const result = await runReferenceFile({ romPath: EN_ROM, frames: 10, ramAt: [10] });
  assert.equal(result.engine, 'jsnes');
  assert.equal(result.rom.mapper, 148);
  assert.equal(result.rom.jsnesHeaderPatched, true, 'для mapper 148 должен быть dev-патч 148→NROM');
  assert.equal(result.rom.jsnesMapper, 0);
  assert.equal(result.frameHashes.length, 10);
  const unique = new Set(result.frameHashes.map(frame => frame.sha256));
  assert.ok(unique.size >= 2, `кадры должны различаться, уникальных хэшей: ${unique.size}`);
  for (const frame of result.frameHashes) assert.match(frame.sha256, /^[0-9a-f]{64}$/);
  // RAM-дамп: 2 КиБ hex по умолчанию.
  assert.equal(result.ramDumps.length, 1);
  assert.equal(result.ramDumps[0].frame, 10);
  assert.equal(result.ramDumps[0].hex.length, 0x800 * 2);
});

test('JSNES: RU-дамп (mapper 3, CNROM) грузится без патча', { skip: SKIP_RU }, async () => {
  const result = await runReferenceFile({ romPath: RU_ROM, frames: 10 });
  assert.equal(result.rom.mapper, 3);
  assert.equal(result.rom.jsnesHeaderPatched, false);
  assert.equal(result.frameHashes.length, 10);
  assert.ok(new Set(result.frameHashes.map(frame => frame.sha256)).size >= 2);
});

test('JSNES: сценарий ввода доводит до геймплея (EN)', { skip: SKIP_EN }, async () => {
  // 600 кадров дорого для smoke; проверяем, что сценарий применяется и кадры меняются.
  const result = await runReferenceFile({ romPath: EN_ROM, frames: 120, scenario: 'gameplay' });
  // 5 START (hold 4) + down/left/a (hold 2): по 2 события на нажатие.
  assert.equal(result.scenario.length, 16);
  assert.ok(result.frameHashes.length === 120);
  assert.ok(new Set(result.frameHashes.map(frame => frame.sha256)).size > 5);
});

// --- PPU-состояние ----------------------------------------------------------

test('ppu-state: состояние PPU снимается в JSON (EN)', { skip: SKIP_EN }, async () => {
  const result = await runPpuStates({ romPath: EN_ROM, frames: [3] });
  assert.equal(result.ppuStates.length, 1);
  const { state } = result.ppuStates[0];
  assert.equal(state.memory.vramMem.length, 0x8000 * 2); // hex
  assert.equal(state.memory.chrWindow.length, 0x2000 * 2);
  assert.equal(state.memory.spriteMem.length, 0x100 * 2);
  assert.equal(state.memory.paletteRam.length, 0x20 * 2);
  assert.equal(state.palettes.imgPalette.length, 16);
  assert.equal(state.palettes.sprPalette.length, 16);
  assert.equal(state.buffer.sha256.length, 64);
  assert.ok(Number.isInteger(state.timing.scanline));
  assert.ok(['vertical', 'horizontal', 'four', 'unknown'].includes(state.mirroring.name));
  assert.equal(result.rom.jsnesHeaderPatched, true);
});

// --- APU-лог ----------------------------------------------------------------

test('apu-log: записи APU-регистров с циклами + эталонный WAV (EN)', { skip: SKIP_EN }, async () => {
  const wavPath = '/tmp/tetris-reference-apu-log.wav';
  try {
    const log = await runApuLog({ romPath: EN_ROM, frames: 30, sampleRate: 48000, wavPath });
    assert.equal(log.engine, 'jsnes');
    assert.ok(Array.isArray(log.apuWrites));
    assert.ok(log.apuWrites.length > 0, 'за 30 кадров должны быть записи APU');
    for (const write of log.apuWrites.slice(0, 50)) {
      assert.ok(write.frame >= 1);
      assert.ok(write.cycle >= 0);
      assert.ok(write.address >= 0x00 && write.address <= 0x17);
      assert.ok(write.value >= 0 && write.value <= 0xff);
    }
    // Циклы неубывающие (лог в порядке выполнения).
    for (let i = 1; i < log.apuWrites.length; i++) {
      assert.ok(log.apuWrites[i].cycle >= log.apuWrites[i - 1].cycle, 'циклы должны идти по возрастанию');
    }
    assert.ok(log.audio.sampleCount > 0);
    assert.match(log.audio.sha256, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(wavPath), 'WAV должен быть записан');
    const { stat } = await import('node:fs/promises');
    assert.ok((await stat(wavPath)).size > 44, 'WAV больше заголовка');
    assert.equal(log.audio.wav.path, wavPath);
  } finally {
    await rm(wavPath, { force: true });
  }
});
