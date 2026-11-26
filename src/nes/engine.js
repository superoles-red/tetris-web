// Браузерный движок: rAF-цикл, звук, пауза, снапшоты, музыка меню.
// Фасад повторяет старый engine.js (JSNES), чтобы app.js/compositor.js
// требовали минимум правок; внутри — наша консоль с перекомпилированным WASM.

import { Console } from './console.js';
import { parseRom, sha256Hex, RomError } from './rom.js';
import { compileRom } from './compile.js';
import { CartridgeAudio, SAMPLE_RATE } from '../audio-output.js';
import { CartridgeMix, SHUFFLE, TRACKS } from './mix.js';

const FRAME_MS = 1000 / 60.0988;
const MAX_CATCHUP = 8;
const AUDIO_CATCHUP_MS = 4 * FRAME_MS;
const STATE_VERSION = 1;
const BUTTON_CODES = {
  left: 6, right: 7, down: 5, up: 4, a: 0, b: 1, start: 3, select: 2,
};

/** Лёгкий PPU для головы, играющей музыку меню: без рендера, только тайминги. */
class HeadlessPPU {
  constructor() {
    this.vramMem = new Uint8Array(0x8000);
    this.spriteMem = new Uint8Array(256);
    this.buffer = new Uint32Array(256 * 240);
    this.scanline = 0;
    this.dot = 0;
    this.frameEnded = false;
    this.nmiPending = false;
    this.nmiEnabled = false;
    this.vblank = false;
    this.f_bgVisibility = 1;
  }
  reset() { this.scanline = 0; this.dot = 0; this.frameEnded = false; this.nmiPending = false; this.vblank = false; }
  setMirroring() {}
  setChrWindow(bytes) { this.vramMem.set(bytes, 0); }
  startFrame() {}
  readReg(address) {
    if ((address & 7) === 2) { const value = this.vblank ? 0x80 : 0; this.vblank = false; return value; }
    return 0;
  }
  writeReg(address, value) {
    const reg = address & 7;
    if (reg === 0) this.nmiEnabled = Boolean(value & 0x80);
    if (reg === 1) this.f_bgVisibility = value & 0x08;
    if (reg === 4) this.spriteMem[0] = value;
  }
  writeMem() {}
  readMem() { return 0; }
  advanceDots(dots) {
    this.dot += dots;
    while (this.dot >= 341) {
      this.dot -= 341;
      this.scanline++;
      if (this.scanline === 241) {
        this.vblank = true;
        if (this.nmiEnabled) this.nmiPending = true;
      }
      if (this.scanline >= 262) {
        this.scanline = 0;
        this.vblank = false;
        this.frameEnded = true;
      }
    }
  }
  renderFullFrame() { return this.buffer; }
  toJSON() { return { scanline: this.scanline, dot: this.dot, vblank: this.vblank }; }
  fromJSON(state) { Object.assign(this, state); }
}

export class Engine {
  constructor({ onFrame, onError } = {}) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.onProgress = null;
    this.console = null;
    this.nes = null;
    this.romInfo = null;
    this.romSha256 = null;
    this.compiled = null;
    this.wasmModule = null;
    this.loaded = false;
    this.started = false;
    this.paused = false;
    this.present = true;
    this.totalFrames = 0;
    this.heldSince = new Map();
    this.pendingReleases = new Set();
    this.request = null;
    this.lastTime = null;
    this.accumulator = 0;
    this.emitAudio = true;
    this.playingMenu = false;
    this.menuVolume = 1;
    this.menuConsole = null;
    this.audio = new CartridgeAudio();
    this.mix = new CartridgeMix((left, right) => {
      if (this.emitAudio) this.audio.write(left, right);
    });
    this.tick = this.tick.bind(this);
  }

  /**
   * Загрузить ROM игрока: разбор, компиляция (или кэш), создание консоли.
   * @param {Uint8Array} romBytes
   * @param {{cachedProgram?: {romSha256?: string, wasm?: Uint8Array}}} [options]
   */
  async load(romBytes, options = {}) {
    const bytes = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
    const romInfo = parseRom(bytes);
    if (!romInfo.supported) throw new RomError('mapper', romInfo.reason ?? 'Этот ROM не поддерживается.');
    const sha = await sha256Hex(bytes);
    let wasmBytes = null;
    let wasmModule = null;
    const cached = options.cachedProgram;
    if (cached && cached.romSha256 === sha && cached.wasm) {
      try {
        wasmBytes = cached.wasm instanceof Uint8Array ? cached.wasm : new Uint8Array(cached.wasm);
        wasmModule = await WebAssembly.compile(wasmBytes);
      } catch {
        wasmBytes = null;
        wasmModule = null;
      }
    }
    if (!wasmModule) {
      this.onProgress?.('compile');
      const compiled = compileRom(romInfo);
      wasmBytes = compiled.wasm;
      this.onProgress?.('instantiate');
      wasmModule = await WebAssembly.compile(wasmBytes);
    }
    this.romInfo = romInfo;
    this.romSha256 = sha;
    this.wasmModule = wasmModule;
    this.compiled = { schema: 1, romSha256: sha, wasm: wasmBytes };

    const console = await Console.create(romInfo, {
      wasmModule,
      wasmBytes,
      sampleRate: SAMPLE_RATE,
      onAudioSample: (left, right) => this.#onAudioSample(left, right),
    });
    this.console = console;
    // Композитор работает с полным кадром 256×240: отключаем «телевизионный»
    // кроп, как это делал старый порт.
    console.ppu.clipToTvSize = false;
    this.mix.attach(console);
    this.nes = this.#createFacade();
    this.loaded = true;
    this.totalFrames = 0;
    this.lastTime = null;
    this.accumulator = 0;

    // Отдельная голова для музыки меню: тот же ROM, свой тайминг, без картинки.
    try {
      this.menuConsole = await Console.create(romInfo, {
        wasmModule,
        wasmBytes,
        ppu: new HeadlessPPU(),
        sampleRate: SAMPLE_RATE,
        onAudioSample: (left, right) => this.#onMenuAudioSample(left, right),
      });
    } catch {
      this.menuConsole = null;
    }
    this.onProgress?.('ready');
    return this;
  }

  #createFacade() {
    const engine = this;
    const console = this.console;
    return {
      cpu: { mem: console.cpuMem },
      ppu: console.ppu,
      rom: { mapperType: this.romInfo.mapper },
      cartridgeLanguage: 'en',
      frame: () => engine.#runFrame(true),
      buttonDown: (player, code) => console.buttonDown(player, code),
      buttonUp: (player, code) => console.buttonUp(player, code),
      toJSON: () => console.toJSON(),
      fromJSON: state => console.fromJSON(state),
    };
  }

  get compiledProgram() {
    return this.compiled;
  }

  get language() {
    return this.nes?.cartridgeLanguage ?? 'en';
  }

  setRomLanguage(language) {
    if (!this.nes) return;
    this.nes.cartridgeLanguage = language === 'ru' ? 'ru' : 'en';
  }

  /** Оставлено для совместимости со старым app.js. */
  setLanguage(language) {
    this.setRomLanguage(language);
  }

  setPaused(value) {
    this.paused = Boolean(value);
    if (this.paused) {
      this.playingMenu = false;
      if (this.request !== null) cancelAnimationFrame(this.request);
      this.request = null;
      this.clearButtons();
      this.audio.pause();
    } else if (this.started && this.request === null) {
      this.lastTime = null;
      this.accumulator = 0;
      this.request = requestAnimationFrame(this.tick);
    }
  }

  start() {
    this.audio.stopPreview();
    this.started = true;
    this.setPaused(false);
  }

  reset() {
    if (!this.console) return;
    this.clearButtons();
    this.audio.clear();
    this.console.reset();
    this.console.ppu.clipToTvSize = false;
    this.mix.attach(this.console);
    this.totalFrames = 0;
    this.lastTime = null;
    this.accumulator = 0;
  }

  setButton(name, pressed) {
    if (!this.nes || !Object.hasOwn(BUTTON_CODES, name)) return;
    if (pressed) {
      this.pendingReleases.delete(name);
      if (this.heldSince.has(name)) return;
      this.heldSince.set(name, this.totalFrames);
      this.nes.buttonDown(1, BUTTON_CODES[name]);
    } else if (this.heldSince.has(name)) {
      if (this.totalFrames - this.heldSince.get(name) < 2) this.pendingReleases.add(name);
      else this.release(name);
    }
  }

  release(name) {
    this.pendingReleases.delete(name);
    this.heldSince.delete(name);
    this.nes?.buttonUp(1, BUTTON_CODES[name]);
  }

  clearButtons() {
    for (const name of [...this.heldSince.keys()]) this.release(name);
  }

  #runFrame(present = true) {
    this.console.frame();
    const buffer = this.console.ppu.buffer;
    if (this.onFrame) this.onFrame(buffer, this.nes, present);
    return buffer;
  }

  tick(time) {
    if (this.paused) return;
    const delta = this.lastTime === null ? FRAME_MS : time - this.lastTime;
    this.lastTime = time;
    const stalled = delta > FRAME_MS * MAX_CATCHUP;
    if (stalled) this.audio.flush();
    this.accumulator += Math.min(Math.max(0, delta), FRAME_MS * MAX_CATCHUP);
    try {
      while (this.accumulator >= FRAME_MS && !this.paused) {
        this.accumulator -= FRAME_MS;
        this.present = this.accumulator < FRAME_MS;
        this.emitAudio = !stalled || this.accumulator < AUDIO_CATCHUP_MS;
        if (this.playingMenu) {
          if (this.menuConsole) {
            this.menuConsole.frame();
            // Картридж уходит в демо после титульной темы — начинаем заново.
            if (this.menuConsole.cpuMem[0x29] === 0xfb) {
              this.menuConsole.reset();
              this.menuConsole.ppu.nmiEnabled = false;
            }
          }
          continue;
        }
        this.mix.flushTrack();
        this.#runFrame(this.present);
        this.mix.advancePlaylist();
        this.totalFrames++;
        for (const name of this.pendingReleases) {
          if (this.totalFrames - this.heldSince.get(name) >= 2) this.release(name);
        }
      }
    } catch (error) {
      this.setPaused(true);
      if (this.onError) this.onError(error);
      else throw error;
      return;
    }
    this.present = true;
    if (!this.paused) this.request = requestAnimationFrame(this.tick);
  }

  // --- звук ------------------------------------------------------------------
  #onAudioSample(left, right) {
    this.mix.sample(left, right, this.console?.apu?.channels ?? null);
  }

  #onMenuAudioSample(left, right) {
    if (this.menuVolume <= 0) return;
    this.audio.write(left * this.menuVolume, right * this.menuVolume);
  }

  playMenuMusic(volume = 100) {
    this.menuVolume = Math.max(0, Math.min(100, volume)) / 100;
    if (!this.console) return;
    this.audio.wake();
    if (this.playingMenu) return;
    if (!this.menuConsole) return;
    this.playingMenu = true;
    this.start();
  }

  stopMenuMusic() {
    if (this.playingMenu) this.setPaused(true);
  }

  setMix(options) { this.mix.set(options, this.paused); }
  startMusic(track) { return this.mix.startMusic(track); }
  previewMusic() { return false; }
  stopPreview() { this.audio.pause(); }
  wakeAudio() { return this.audio.wake(); }
  setAudioPageActive(active) { this.audio.setPageActive(active); }
  setMuted(value) { this.audio.setMuted(Boolean(value)); }

  // --- снапшоты --------------------------------------------------------------
  captureStart() {
    return {
      stateVersion: STATE_VERSION,
      romSha256: this.romSha256,
      language: this.nes?.cartridgeLanguage ?? 'en',
      console: this.console.toJSON(),
      mix: this.mix.snapshot(),
    };
  }

  captureProgress() {
    return { ...this.captureStart(), playlist: this.mix.capturePlaylist() };
  }

  assertCompatible(state) {
    if (!state || state.stateVersion !== STATE_VERSION) {
      throw new Error('Несовместимый формат сохранения.');
    }
    if (state.romSha256 && this.romSha256 && state.romSha256 !== this.romSha256) {
      throw new Error('Сохранение от другого ROM.');
    }
  }

  restoreStart(state) {
    this.assertCompatible(state);
    this.clearButtons();
    this.audio.clear();
    this.console.fromJSON(state.console);
    this.setRomLanguage(state.language ?? 'en');
    this.mix.attach(this.console, state.mix);
    this.mix.requestTrack(this.paused);
    this.totalFrames = 0;
    this.lastTime = null;
    this.accumulator = 0;
  }

  restoreProgress(state) {
    this.assertCompatible(state);
    this.mix.restorePlaylist(state.playlist);
    this.restoreStart(state);
  }

  renderPausedFrame(present) {
    if (!this.paused || !this.console) return false;
    const ppu = this.console.ppu;
    if (typeof ppu.renderFullFrame !== 'function') return false;
    ppu.renderFullFrame();
    present(ppu.buffer, this.nes);
    return true;
  }
}

export { SHUFFLE, TRACKS };
