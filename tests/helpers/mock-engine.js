// Мок движка для визуальной проверки оболочки, пока src/nes/engine.js
// пишется параллельно. Лежит ТОЛЬКО в tests/helpers и никогда не попадает
// в сборку сайта. Рисует синтетический кадр собственной геометрией — никаких
// данных/графики Tetris здесь нет.

const WIDTH = 256;
const HEIGHT = 240;
const FRAME_MS = 1000 / 60.0988;

function bgr(red, green, blue) {
  return (blue << 16) | (green << 8) | red;
}

const COLORS = {
  floor: bgr(40, 46, 58),
  wall: bgr(90, 120, 160),
  pieces: [bgr(60, 200, 255), bgr(255, 210, 60), bgr(120, 230, 120), bgr(220, 120, 255)]
};

export class Engine {
  constructor({ onFrame, onError } = {}) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.onProgress = null;
    this.nes = null;
    this.paused = true;
    this.started = false;
    this.language = 'en';
    this.frameIndex = 0;
    this.romSha256 = 'mock';
    this.playlist = null;
    this.menuMusic = false;
    this.buttonState = new Map();
    this.interval = null;
    this.nes = this.createNes();
    this.buffer = this.nes.ppu.buffer;
    this.tick = this.tick.bind(this);
  }

  createNes() {
    const buffer = new Uint32Array(WIDTH * HEIGHT);
    const vramMem = new Uint8Array(0x8000);
    const spriteMem = new Uint8Array(256);
    const ptTile = Array.from({ length: 512 }, () => ({ pix: new Uint8Array(64) }));
    // Синтетический nametable: «подписи» и «цифры» — прямоугольники, которые
    // compositor просто вырезает; для раскладки этого достаточно.
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        vramMem[0x2000 + row * 32 + col] = row < 8 ? 0x40 + (col % 10) : 0;
      }
    }
    vramMem[0x3f00] = 0x0f;
    const mem = new Uint8Array(0x10000);
    const ppu = {
      vramMem, spriteMem, ptTile, buffer,
      sprPalette: new Uint32Array(16).fill(bgr(255, 255, 255)),
      imgPalette: new Uint32Array(16).fill(bgr(255, 255, 255)),
      f_bgVisibility: true, f_spVisibility: true, f_bgClipping: false, f_spClipping: false,
      f_spriteSize: 0, f_bgPatternTable: 0, f_spPatternTable: 0, f_nmiOnVblank: true, f_color: 0,
      writeMem() {}, readMem() { return 0; }, readReg() { return 0; }, writeReg() {},
      startFrame() {}, advanceDots() {}, renderFullFrame() {},
      frameEnded: false, nmiPending: false, sprite0Hit: false,
      toJSON() { return { frameIndex: this._engineFrame ?? 0 }; },
      fromJSON() {}
    };
    const nes = {
      cpu: { mem },
      ppu,
      cartridgeLanguage: 'en',
      frame: () => this.renderFrame(),
      buttonDown: (_port, button) => { this.buttonState.set(button, true); if (button === 3) this.startPulse = true; },
      buttonUp: (_port, button) => { this.buttonState.set(button, false); },
      toJSON: () => ({
        stateVersion: 1,
        romSha256: this.romSha256,
        language: this.language,
        ram: Array.from(nes.cpu.mem),
        frameIndex: this.frameIndex
      }),
      fromJSON: (state) => {
        if (!state || state.stateVersion !== 1 || state.romSha256 !== this.romSha256) {
          throw new Error('Incompatible state');
        }
        nes.cpu.mem.set(state.ram);
        this.frameIndex = state.frameIndex ?? 0;
      }
    };
    ppu._engine = this;
    return nes;
  }

  async load(_romBytes, options = {}) {
    this.cachedProgramUsed = Boolean(options?.cachedProgram);
    this.onProgress?.('compile');
    await new Promise(resolve => setTimeout(resolve, 20));
    this.onProgress?.('instantiate');
    await new Promise(resolve => setTimeout(resolve, 20));
    this.reset();
    this.onProgress?.('ready');
    this.compiledProgram = {
      romSha256: this.romSha256,
      wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      schema: 1
    };
    return this;
  }

  reset() {
    this.clearButtons();
    this.frameIndex = 0;
    const mem = this.nes.cpu.mem;
    mem.fill(0);
    // Синтетический прогресс картриджа: boot → title → play.
    mem[0x49] = 0;
    mem[0x29] = 0xfa;
    mem[0x4a] = 0;
    this.nes.ppu.frameEnded = false;
    this.initialized = false;
  }

  setRomLanguage(language) {
    this.language = language === 'ru' ? 'ru' : 'en';
    if (this.nes) this.nes.cartridgeLanguage = this.language;
  }

  setPaused(value) {
    this.paused = Boolean(value);
    if (this.paused) {
      this.stopLoop();
      this.clearButtons();
    } else if (this.started) {
      this.startLoop();
    }
  }

  start() {
    this.started = true;
    this.menuMusic = false;
    this.setPaused(false);
  }

  startLoop() {
    if (this.interval !== null) return;
    this.interval = setInterval(this.tick, FRAME_MS);
    if (typeof this.interval.unref === 'function') this.interval.unref();
  }

  stopLoop() {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  tick() {
    if (this.paused) return;
    try {
      this.renderFrame(true);
    } catch (error) {
      this.setPaused(true);
      this.onError?.(error);
    }
  }

  renderFrame(present = true) {
    this.frameIndex++;
    const mem = this.nes.cpu.mem;
    if (this.frameIndex === 6) { mem[0x49] = 1; mem[0x29] = 0xfa; }
    // Автозапуск: createSoloStart жмёт START на титульном экране.
    // Кнопка нажимается и отпускается между кадрами, поэтому ловим импульс в
    // buttonDown, а картридж реагирует на него со следующего кадра.
    if (!this.startPressedAt && this.startPulse && mem[0x29] === 0xfa && this.frameIndex > 8) {
      this.startPressedAt = this.frameIndex;
      this.startPulse = false;
    }
    if (this.startPressedAt && this.frameIndex - this.startPressedAt > 3) {
      mem[0x29] = 0x00;
      mem[0x4a] = 1; // картридж в партии: readScene отдаёт 'play'
      this.startPressedAt = 0;
    }
    this.startPulse = false;
    this.paintSyntheticFrame();
    if (present) this.onFrame?.(this.nes.ppu.buffer, this.nes, true);
    return this.nes;
  }


  paintSyntheticFrame() {
    const buffer = this.nes.ppu.buffer;
    buffer.fill(bgr(8, 10, 16));
    // «Экран»: рамка, колодец, несколько «фигур» — наша синтетика.
    const wellX = 16, wellY = 8, wellW = 80, wellH = 224;
    for (let y = wellY; y < wellY + wellH; y++) {
      for (let x = wellX; x < wellX + wellW; x++) {
        const border = x < wellX + 2 || x >= wellX + wellW - 2 || y >= wellY + wellH - 2;
        buffer[y * WIDTH + x] = border ? COLORS.wall : bgr(4, 6, 10);
      }
    }
    const blocks = [
      [22, 200, 0], [30, 200, 1], [38, 200, 0],
      [54, 184, 2], [62, 184, 2], [54, 192, 3]
    ];
    for (const [x, y, color] of blocks) {
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          buffer[(y + py) * WIDTH + x + px] = COLORS.pieces[color % COLORS.pieces.length];
        }
      }
    }
    // Правая панель-подписи (compositor вырезает эти прямоугольники).
    for (const [x, y, w] of [[108, 16, 40], [108, 32, 40], [108, 48, 40], [160, 16, 80], [16, 16, 32]]) {
      for (let py = y; py < y + 8; py++) {
        for (let px = x; px < x + w; px++) buffer[py * WIDTH + px] = COLORS.floor;
      }
    }
    // «Цифры» в nametable уже закодированы плитками, их вырежет compositor.
  }

  setButton(name, down) {
    const codes = { a: 0, b: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7 };
    if (!(name in codes)) return;
    if (down) this.nes.buttonDown(1, codes[name]);
    else this.nes.buttonUp(1, codes[name]);
  }

  clearButtons() {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7]) this.nes.buttonUp(1, code);
  }

  playMenuMusic() { this.menuMusic = true; }
  stopMenuMusic() { this.menuMusic = false; }
  setMix() {}
  startMusic(track) { return track; }
  previewMusic() { return false; }
  stopPreview() {}
  wakeAudio() { return Promise.resolve(false); }
  setAudioPageActive() {}
  setMuted() {}

  captureStart() {
    return {
      stateVersion: 1,
      romSha256: this.romSha256,
      language: this.language,
      ram: Array.from(this.nes.cpu.mem),
      frameIndex: this.frameIndex
    };
  }

  restoreStart(state) {
    if (!state || state.stateVersion !== 1 || state.romSha256 !== this.romSha256) {
      throw new Error('Incompatible menu checkpoint');
    }
    this.nes.cpu.mem.set(state.ram);
    this.frameIndex = state.frameIndex ?? 0;
  }

  captureProgress() {
    return { ...this.captureStart(), playlist: { choice: 1, track: 1, remaining: [], repeatedTrack: false, atLoopEnd: false } };
  }

  restoreProgress(state) {
    this.restoreStart(state);
    this.playlist = state.playlist ?? null;
  }

  renderPausedFrame(present) {
    if (!this.paused) return false;
    present?.(this.nes.ppu.buffer, this.nes);
    return true;
  }
}
