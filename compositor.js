// Раскладка оригинального кадра 256×240: кадр приходит из PPU движка
// (ppu.buffer в формате BGR 0x00BBGGRR), координаты — из несжатой картинки NES.
// Никаких файлов с графикой игры здесь нет: всё, что видно, — пиксели ROM
// игрока, отрисованные его же PPU.
const LABELS = {
  next: [16, 16, 32, 8],
  score: [108, 16, 40, 8],
  lines: [108, 32, 40, 8],
  level: [108, 48, 40, 8],
  high: [160, 16, 80, 8],
  stats: [176, 48, 40, 8],
  ranking: [64, 80, 136, 8]
};
// В русском переводе подписи стоят в других клетках nametable.
const RU_LABELS = {
  ...LABELS,
  score: [112, 16, 32, 8],
  high: [168, 16, 48, 8],
  stats: [152, 48, 80, 8],
  ranking: [104, 80, 48, 8]
};
const NUMBERS = {
  score: [7, 12, 2], lines: [9, 12, 4], level: [11, 12, 6], high: [19, 29, 4]
};
const GAME = new Set(['play', 'pause', 'gameover', 'dance']);
const BLACK = 0xff000000;
const SRC_WIDTH = 256;
const STAGE_WIDTH = 33;
const SOLO_DANCERS = 6;
const WELL_W = 88;
const WELL_H = 184;
const WELL_BORDER = 4;
const PAUSE_CORNER = 64;
const BORDER_INK = '#3cabff';
const round = Math.round;

function numberBox(ppu, key) {
  let [first, last, row] = NUMBERS[key];
  const address = 0x2000 + 32 * row;
  while (first < last && !ppu.vramMem[address + first]) first++;
  while (last > first && !ppu.vramMem[address + last]) last--;
  return [first * 8, row * 8, (last - first + 1) * 8, 8];
}

// OAM 0–3 — живая фигура, 8–11 — превью. Две строки появления делят HUD
// с оригинальной панелью: переносим только настоящие тайлы блоков.
function copyPiece(ppu, pixels, first, originX, originY, destX, destY, width, height) {
  const oam = ppu.spriteMem;
  for (let index = first; index < first + 4; index++) {
    const i = index * 4;
    const left = oam[i + 3] - originX;
    const top = oam[i] + 1 - originY;
    if (left >= width || top >= height || left <= -8 || top <= -8) continue;
    const attr = oam[i + 2];
    const tile = ppu.ptTile[256 * ppu.f_spPatternTable + oam[i + 1]].pix;
    for (let y = Math.max(0, -top); y < Math.min(8, height - top); y++) {
      const row = (attr & 128 ? 7 - y : y) * 8;
      const offset = (destY + top + y) * SRC_WIDTH + destX + left;
      for (let x = Math.max(0, -left); x < Math.min(8, width - left); x++) {
        const ink = tile[row + (attr & 64 ? 7 - x : x)];
        if (ink) pixels[offset + x] = BLACK | ppu.sprPalette[(attr & 3) * 4 + ink];
      }
    }
  }
}

export class Compositor {
  constructor(canvas, resultBar) {
    this.canvas = canvas;
    this.resultBar = resultBar;
    this.game = canvas.closest('#game');
    this.ctx = canvas.getContext('2d');
    this.source = document.createElement('canvas');
    this.source.width = SRC_WIDTH;
    this.source.height = 272;
    this.sourceCtx = this.source.getContext('2d', { alpha: false });
    this.image = this.sourceCtx.createImageData(SRC_WIDTH, 272);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.frameImage = null;
    this.frameReady = false;
    this.opponent = false;
    this.shared = false;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  resize() {
    const w = Math.max(1, round(this.canvas.clientWidth));
    const h = Math.max(1, round(this.canvas.clientHeight));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx.imageSmoothingEnabled = false;
    this.landscape = window.matchMedia('(orientation: landscape)').matches;
    if (!this.landscape) {
      const style = getComputedStyle(this.game);
      this.dropWidth = parseFloat(style.getPropertyValue('--portrait-drop-width')) || 76;
      this.dropTop = (parseFloat(style.getPropertyValue('--portrait-drop-top')) || 45) / 100;
      this.dropHeight = parseFloat(style.getPropertyValue('--portrait-drop-height')) || 120;
      this.controlsHeight = parseFloat(style.getPropertyValue('--portrait-controls-height')) || 54;
    }
    this.paint();
  }

  /**
   * @param {Uint32Array} buffer кадр PPU движка (BGR 0x00BBGGRR)
   * @param {string} scene 'play'|'pause'|'gameover'|'dance'|'scores'|'raw'
   * @param {object} nes фасад движка (cpu.mem, ppu, cartridgeLanguage)
   */
  draw(buffer, scene, nes) {
    if (!buffer || !nes?.ppu) return;
    this.nes = nes;
    const language = nes.cartridgeLanguage === 'ru' ? 'ru' : 'en';
    this.labels = language === 'ru' ? RU_LABELS : LABELS;
    if (this.scene !== 'dance' || scene !== 'dance') this.firstFloor = SOLO_DANCERS - 1;
    this.scene = scene;
    const pixels = this.pixels;
    for (let i = 0; i < 256 * 240; i++) pixels[i] = BLACK | buffer[i];
    if (scene === 'scores') {
      // Обычные буквы таблицы — небесный цвет из рамки; редактируемую букву
      // картридж мигает отдельной палитрой спрайтов, её не трогаем.
      const tableInk = 0xdc0e22, borderInk = 0xffab3c; // JSNES BGR
      for (let y = 96; y < 216; y++) {
        for (let x = 56; x < 200; x++) {
          const i = y * 256 + x;
          if ((buffer[i] & 0xffffff) === tableInk) pixels[i] = BLACK | borderInk;
        }
      }
    }
    if (GAME.has(scene)) {
      const ppu = nes.ppu;
      pixels.fill(BLACK, 256 * 240);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 10; col++) {
          const tile = ppu.vramMem[0x2000 + (row + 6) * 32 + col + 2];
          if (tile === 0 || tile > 15) continue;
          for (let line = 0; line < 8; line++) {
            const from = (48 + row * 8 + line) * 256 + 16 + col * 8;
            const to = (240 + row * 8 + line) * 256 + col * 8;
            for (let j = 0; j < 8; j++) pixels[to + j] = BLACK | buffer[from + j];
          }
        }
      }
      copyPiece(ppu, pixels, 0, 16, 48, 0, 240, 80, 16);
      copyPiece(ppu, pixels, 8, 16, 24, 80, 240, 32, 24);
      if (this.opponent) {
        for (let row = 0; row < 2; row++) {
          for (let col = 0; col < 10; col++) {
            const tile = ppu.vramMem[0x2000 + (row + 6) * 32 + col + 20];
            if (tile === 0 || tile > 15) continue;
            for (let line = 0; line < 8; line++) {
              const from = (48 + row * 8 + line) * 256 + 160 + col * 8;
              const to = (240 + row * 8 + line) * 256 + 160 + col * 8;
              for (let j = 0; j < 8; j++) pixels[to + j] = BLACK | buffer[from + j];
            }
          }
        }
        copyPiece(ppu, pixels, 4, 160, 48, 160, 240, 80, 16);
      }
      this.preview = this.inkBounds(80, 240, 32, 24);
      this.graph = this.graphBox(buffer);
      if (scene === 'dance') {
        const ram = nes.cpu.mem;
        if (ram[0x6a] < 0x7c) {
          const count = Math.min(SOLO_DANCERS, 1 + ram[0x70] + 2 * ram[0x72]);
          this.firstFloor = SOLO_DANCERS - count;
        } else {
          for (let i = 0; i < SOLO_DANCERS; i++) {
            if (ram[0x01a2 + i]) this.firstFloor = Math.min(this.firstFloor, SOLO_DANCERS - i - 1);
          }
        }
      }
    }
    this.sourceCtx.putImageData(this.image, 0, 0);
    this.paint();
  }

  inkBounds(x, y, w, h) {
    let x1 = w, x2 = -1, y1 = h, y2 = -1;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        if ((this.pixels[(y + row) * 256 + x + col] & 0xffffff) === 0) continue;
        x1 = Math.min(x1, col); x2 = Math.max(x2, col);
        y1 = Math.min(y1, row); y2 = Math.max(y2, row);
      }
    }
    return x2 < 0 ? null : [x + x1, y + y1, x2 - x1 + 1, y2 - y1 + 1];
  }

  graphBox(buffer) {
    for (let y = 64; y < 208; y++) {
      for (let x = 168; x < 224; x++) {
        if (buffer[y * 256 + x] & 0xffffff) return [168, y, 56, 224 - y];
      }
    }
    return [168, 208, 56, 16];
  }

  blit(rect, x, y, width, height) {
    if (!rect || width <= 0 || height <= 0) return;
    const x1 = round(x), y1 = round(y);
    this.ctx.drawImage(this.source, ...rect, x1, y1, round(x + width) - x1, round(y + height) - y1);
  }

  fit(rect, cx, y, scale, maxWidth = Infinity) {
    if (!rect) return;
    const size = Math.min(scale, maxWidth / rect[2]);
    this.blit(rect, cx - rect[2] * size / 2, y, rect[2] * size, rect[3] * size);
  }

  metric(key, cx, y, width, scale, previewHeight = Infinity) {
    const label = this.labels[key];
    const small = Math.min(scale, width / label[2]);
    this.fit(label, cx, y, small);
    const top = y + 8 * small + 4 * scale;
    if (key === 'next') {
      if (this.preview) this.fit(this.preview, cx, top, Math.min(scale * 1.4, previewHeight / this.preview[3]), width);
    } else {
      this.fit(numberBox(this.nes.ppu, key), cx, top, scale * 1.4, width);
    }
  }

  stats(cx, y, width, height, scale) {
    this.fit(this.labels.stats, cx, y, scale, width);
    const top = y + 11 * scale;
    this.chart(cx, top, width, height - 11 * scale, scale * 1.3);
  }

  chart(cx, y, width, height, scale, bottomAlign = false) {
    const graph = this.graph;
    const designRows = bottomAlign ? 30 : 20;
    const zoom = Math.min(scale, width / 56, Math.max(.5, height / designRows));
    const keyHeight = 16 * zoom;
    const bars = graph[3] - 16;
    const barHeight = Math.max(0, Math.min(bars * zoom, height - keyHeight));
    const top = y + (bottomAlign ? height - barHeight - keyHeight : 0);
    if (bars) this.blit([168, graph[1], 56, bars], cx - 28 * zoom, top, 56 * zoom, barHeight);
    this.blit([168, 208, 56, 16], cx - 28 * zoom, top + barHeight, 56 * zoom, keyHeight);
  }

  // Наш собственный бортик колодца: у нас нет вырезанной из игры рамки,
  // поэтому вокруг оригинального кадра рисуем простой нейтральный контур.
  bezel(left, top, width, height, k) {
    const line = Math.max(1, round(1.6 * k));
    this.ctx.strokeStyle = BORDER_INK;
    this.ctx.lineWidth = line;
    this.ctx.strokeRect(round(left) + line / 2, round(top) + line / 2,
      round(width) - line, round(height) - line);
  }

  /** Режим игры: 'solo', 'vs' (соперник) или 'with' (общий колодец). */
  setGameMode(mode) {
    this.opponent = mode === 'vs';
    this.shared = mode === 'with';
  }

  /** Общий колодец режима WITH COMPUTER: 12×18 клеток, два игрока. */
  sharedWell(left, top, k) {
    const border = 8 * k;
    const width = 96 * k + border * 2;
    const height = 144 * k + border * 2;
    const x = round(left), y = round(top);
    this.wellRect = [x, y, round(width), round(height)];
    this.frameRect(x, y, round(width), round(height), Math.max(6, round(border)));
    const innerX = x + Math.round(border), innerY = y + Math.round(border);
    const innerW = round(width) - Math.round(border) * 2;
    const innerH = round(height) - Math.round(border) * 2;
    if (innerW > 1 && innerH > 1) this.blit([80, 80, 96, 144], innerX, innerY, innerW, innerH);
  }

  /** Маленький колодец компьютера: тот же кадр игры, но из правого колодца. */
  miniWell(left, top, unit, borderPx) {
    const x = round(left), y = round(top);
    const width = WELL_W * unit, height = WELL_H * unit;
    const previous = this.wellRect;
    this.wellRect = [x, y, width, height];
    this.frameRect(x, y, width, height, round(borderPx));
    const border = round(borderPx);
    const innerX = x + border, innerY = y + border;
    const innerW = width - border * 2, innerH = height - border * 2;
    if (innerW > 1 && innerH > 1) {
      const spawnH = round(16 * unit);
      this.blit([160, 240, 80, 16], innerX, innerY, innerW, spawnH);
      this.blit([160, 64, 80, 160], innerX, innerY + spawnH, innerW, innerH - spawnH);
    }
    this.wellRect = previous;
  }

  // Игровая рамка (40×40, как frame.png): ею обводим колодец и панели HUD.
  setFrameImage(url) {
    if (!url) return;
    const image = new Image();
    image.onload = () => {
      this.frameImage = image;
      this.frameReady = true;
    };
    image.src = url;
  }

  /** 9-slice из игровой рамки: углы 16×16, кромки нативными тайлами. */
  frameRect(left, top, width, height, border) {
    const x = round(left), y = round(top), w = round(width), h = round(height);
    const b = Math.max(2, Math.round(border));
    if (w < 4 * b || h < 4 * b) return false;
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(x + b, y + b, w - 2 * b, h - 2 * b);
    if (!this.frameReady || !this.frameImage) {
      ctx.strokeStyle = BORDER_INK;
      ctx.lineWidth = Math.max(2, b / 3);
      ctx.strokeRect(x + b / 2, y + b / 2, w - b, h - b);
      ctx.restore();
      return true;
    }
    const img = this.frameImage;
    const slice = img.width >= 48 ? 16 : 16;
    const middle = img.width - slice * 2;
    const tile = b;
    // углы
    ctx.drawImage(img, 0, 0, slice, slice, x, y, b, b);
    ctx.drawImage(img, img.width - slice, 0, slice, slice, x + w - b, y, b, b);
    ctx.drawImage(img, 0, img.height - slice, slice, slice, x, y + h - b, b, b);
    ctx.drawImage(img, img.width - slice, img.height - slice, slice, slice, x + w - b, y + h - b, b, b);
    // кромки: нативный тайл игровой рамки, без растяжения
    for (let cx = b; cx < w - b - 0.5; cx += tile) {
      const cw = Math.min(tile, w - b - cx);
      ctx.drawImage(img, slice, 0, middle, slice, x + cx, y, cw, b);
      ctx.drawImage(img, slice, img.height - slice, middle, slice, x + cx, y + h - b, cw, b);
    }
    for (let cy = b; cy < h - b - 0.5; cy += tile) {
      const ch = Math.min(tile, h - b - cy);
      ctx.drawImage(img, 0, slice, slice, middle, x, y + cy, b, ch);
      ctx.drawImage(img, img.width - slice, slice, slice, middle, x + w - b, y + cy, b, ch);
    }
    ctx.restore();
    return true;
  }

  well(left, top, k) {
    const width = round(WELL_W * k), height = round(WELL_H * k);
    // Нативная рамка 16 px из игры: не сжимаем её, чтобы узор оставался чётким.
    const border = this.frameReady && this.frameImage && this.frameImage.width >= 48
      ? 16
      : Math.max(4, Math.round(WELL_BORDER * k));
    const x = round(left), y = round(top);
    this.wellRect = [x, y, width, height];
    this.frameRect(x, y, width, height, border);
    const innerX = x + border, innerY = y + border;
    const innerW = width - border * 2, innerH = height - border * 2;
    if (this.scene === 'dance') {
      this.dance(innerX, innerY, k);
      return;
    }
    if (innerW > 1 && innerH > 1) {
      // Верхние 2 ряда — зона спавна, которую draw() собрал из игровых
      // спрайтов (без фонового мусора), остальные 20 рядов — само поле.
      const spawnH = round(innerH / 11);
      this.blit([0, 240, 80, 16], innerX, innerY, innerW, spawnH);
      this.blit([16, 64, 80, 160], innerX, innerY + spawnH, innerW, innerH - spawnH);
    }
    if (this.scene === 'pause') this.fit([96, 64, 64, 16], innerX + (innerW - 64 * k) / 2, innerY + 70 * k, k);
  }

  thumbnail() {
    if (!this.wellRect || this.wellRect[2] < 1 || this.wellRect[3] < 1) return null;
    const preview = document.createElement('canvas');
    preview.width = WELL_W;
    preview.height = WELL_H;
    const ctx = preview.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, ...this.wellRect, 0, 0, WELL_W, WELL_H);
    return preview.toDataURL('image/png');
  }

  dance(x, y, k) {
    const tally = [88, 120, 152, 184, 208];
    this.fit([16, 64, 80, 16], x + 40 * k, y + 3 * k, .9 * k);
    for (let i = 0; i < tally.length; i++) {
      this.fit([16, tally[i], 80, 16], x + 40 * k, y + (21 + 16.5 * i) * k, .86 * k);
    }
    const count = SOLO_DANCERS - this.firstFloor;
    const cols = count >= 3 ? 2 : 1;
    const rows = Math.ceil(count / cols);
    const s = Math.min(72 / (cols * STAGE_WIDTH + (cols - 1) * 4), 69 / (rows * 24 + (rows - 1) * 2));
    const sceneTop = 104 + (69 - (rows * 24 + (rows - 1) * 2) * s) / 2;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, count - row * cols);
      const start = 40 - ((STAGE_WIDTH * inRow + (inRow - 1) * 4) * s) / 2;
      const floor = this.firstFloor + i;
      this.blit([112, 85 + 24 * floor, STAGE_WIDTH, 24], x + (start + (i % cols) * (STAGE_WIDTH + 4) * s) * k,
        y + (sceneTop + row * 26 * s) * k, STAGE_WIDTH * s * k, 24 * s * k);
    }
  }

  sideHUD(x, top, width, height, keys, framed = false) {
    if (this.scene === 'dance') keys = keys.filter(key => key !== 'next');
    const cx = x + width / 2;
    const slots = keys.map(key => key === 'next' || key === 'stats' ? 38 : 25);
    const slotTotal = slots.reduce((a, b) => a + b, 0);
    const gaps = keys.length - 1;
    const scale = Math.min(width / 50, height / (slotTotal + 6 * gaps), 2);
    const gap = gaps ? Math.min((framed ? 12 : 24) * scale, (height - slotTotal * scale) / gaps) : 0;
    const total = slotTotal * scale + gap * gaps;
    let y = top + (framed ? 0 : Math.max(0, (height - total) / 2));
    if (framed) this.hudPanel(x - 3, y - 4, width + 6, total + 8);
    keys.forEach((key, i) => {
      const slot = slots[i] * scale;
      if (key === 'stats') this.stats(cx, y, width, slot, scale);
      else this.metric(key, cx, y, width, scale, slot - 12 * scale);
      y += slot + gap;
    });
  }

  scores(w, h) {
    const gap = Math.min(20, w * .035);
    const wide = this.landscape && w > h * 1.22;
    const rail = wide ? Math.min(140, w * .27) : 0;
    const designHeight = wide ? 164 : 202;
    const cx = wide ? (w + rail) / 2 : w / 2;
    const k = Math.min(3.5, (w - 2 * gap - rail) / 144, (h - 2 * gap) / designHeight);
    const listW = 144 * k;
    const top = (h - designHeight * k) / 2;
    this.fit(this.labels.ranking, cx, top, k);
    if (wide) {
      const x = cx - listW / 2 - gap - rail;
      this.sideHUD(x, top, rail, 164 * k, ['score', 'lines', 'level']);
    } else {
      const slot = listW / 3;
      ['score', 'lines', 'level'].forEach((key, i) => {
        this.metric(key, cx + (i - 1) * slot, top + 18 * k, slot - 3, k * .78);
      });
    }
    const first = top + (wide ? 16 : 54) * k;
    for (let i = 0; i < 15; i++) this.fit([56, 96 + 8 * i, 144, 8], cx, first + 10 * i * k, k);
  }

  // Панели HUD как в самой игре: чёрная заливка и тонкие синие линии.
  hudPanel(x, y, w, h, border = 4) {
    x = round(x); y = round(y); w = round(w); h = round(h);
    if (w < 3 || h < 3) return;
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, h);
    const outer = Math.max(2, Math.round(border * 0.55));
    const inner = Math.max(1, Math.round(border * 0.25));
    ctx.strokeStyle = '#3cabff';
    ctx.lineWidth = outer;
    ctx.strokeRect(x + outer / 2, y + outer / 2, w - outer, h - outer);
    if (w > outer * 2 + inner * 2 + 2 && h > outer * 2 + inner * 2 + 2) {
      ctx.strokeStyle = '#0000b4';
      ctx.lineWidth = inner;
      const inset = outer + inner / 2 + 1;
      ctx.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
    }
  }

  portrait(w, h) {
    const pad = Math.min(7, Math.max(3, w * .012));
    const opponent = this.opponent;
    const railW = opponent ? Math.max(this.dropWidth, 112) : this.dropWidth;
    const headerWidth = Math.min(w - PAUSE_CORNER - pad, 624);
    const scale = Math.min(2.05, w / 260, h / 320);
    const headers = this.scene === 'dance' ? [['score', .5], ['high', .5]] :
      opponent ? [['next', .5], ['score', .5]] :
        this.shared ? [['next', .5], ['score', .5]] :
        [['next', .24], ['score', .34], ['high', .42]];
    const fieldTop = round(pad + 30 * scale + 6);
    this.hudPanel(2, 2, headerWidth + pad - 3, fieldTop - 4, Math.max(3, round(3 * scale)));
    let left = pad;
    for (const [key, portion] of headers) {
      const slot = headerWidth * portion;
      this.metric(key, left + slot / 2, pad, slot - 5, scale, 18 * scale);
      left += slot;
    }

    const fieldWidth = w - railW;
    const fieldBottom = h - this.controlsHeight;
    if (this.shared) {
      const k = Math.min((fieldWidth - 2 * pad) / 112, (fieldBottom - fieldTop) / 160);
      this.sharedWell((fieldWidth - 112 * k) / 2, fieldTop + (fieldBottom - fieldTop - 160 * k) / 2, k);
    } else {
      const k = Math.min((fieldWidth - 2 * pad) / WELL_W, (fieldBottom - fieldTop) / WELL_H);
      this.well((fieldWidth - WELL_W * k) / 2, fieldTop + (fieldBottom - fieldTop - WELL_H * k) / 2, k);
    }

    const railLeft = w - railW + pad;
    const railWidth = railW - 2 * pad;
    const railTop = fieldTop;
    const railBottom = fieldBottom;
    const railCenter = railLeft + railWidth / 2;
    this.hudPanel(railLeft - pad + 2, railTop - 5, railWidth + pad * 2 - 4, railBottom - railTop + 10, Math.max(3, round(2.2 * scale)));
    if (this.shared) {
      // Общий колодец: показываем счётчик линий, без графика и уровня.
      const metricScale = Math.min(scale, railWidth / 50);
      this.metric('lines', railCenter, railTop + 4, railWidth, metricScale);
    } else if (opponent) {
      // Сверху — линии/уровень, снизу — маленький колодец компьютера.
      const unit = Math.max(1, Math.floor(Math.min(railWidth / WELL_W, (railBottom - railTop - 120) / WELL_H)));
      const mw = WELL_W * unit, mh = WELL_H * unit;
      const metricScale = Math.min(scale, railWidth / 50);
      this.metric('lines', railCenter, railTop + 4, railWidth, metricScale);
      this.metric('level', railCenter, railTop + 34 * metricScale + 4, railWidth, metricScale);
      this.miniWell(railCenter - mw / 2, railBottom - mh, unit, Math.max(4, round(4 * scale)));
    } else {
      const railScale = Math.min(scale, railWidth / 50, (railBottom - railTop) / 105);
      this.metric('lines', railCenter, railTop, railWidth, railScale);
      this.metric('level', railCenter, railTop + 31 * railScale, railWidth, railScale);
      const chartTop = railTop + 63 * railScale;
      this.chart(railCenter, chartTop, railWidth, railBottom - chartTop, railScale * 1.3, true);
    }
  }

  landscapeGame(w, h) {
    const pad = Math.min(9, Math.max(3, h * .012));
    if (this.shared) {
      const k = Math.min((h - 2 * pad) / 160, (w - 2 * (58 + pad)) / 112);
      const fieldW = 112 * k, left = (w - fieldW) / 2;
      this.sharedWell(left, (h - 160 * k) / 2, k);
      const gap = Math.min(38, Math.max(10, left * .09));
      const side = Math.max(20, Math.min(180, left - gap - pad));
      const top = Math.min(38, Math.max(9, h * .05));
      const bottom = Math.min(h - 112, h * .68);
      this.sideHUD(left - gap - side, top, side, Math.max(48, bottom - top), ['score', 'lines'], true);
      const rightX = left + fieldW + gap;
      const rightW = Math.max(20, Math.min(side, w - PAUSE_CORNER - rightX));
      this.sideHUD(rightX, top, rightW, Math.max(48, bottom - top), ['next'], true);
      return;
    }
    const k = Math.min((h - 2 * pad) / WELL_H, (w - 2 * (58 + pad)) / WELL_W);
    const fieldW = WELL_W * k, left = (w - fieldW) / 2;
    this.well(left, (h - WELL_H * k) / 2, k);

    const gap = Math.min(38, Math.max(10, left * .09));
    const side = Math.max(20, Math.min(180, left - gap - pad));
    const rightX = left + fieldW + gap;
    const clearRight = w - (this.scene === 'dance' ? pad : PAUSE_CORNER) - rightX;
    const rightW = clearRight >= 66 ? Math.min(side, clearRight) : side;
    const y = Math.min(38, Math.max(9, h * .05));
    const rightY = clearRight < 66 ? Math.max(PAUSE_CORNER + 2, y) : y;
    const bottom = Math.min(h - 112, h * .68);
    const nearDrop = rightX + rightW > w * .87 - 18;
    const rightBottom = nearDrop && this.scene !== 'dance' ? Math.min(bottom, h * .60 - 18) : bottom;
    const leftX = left - gap - side;
    const leftHeight = Math.max(48, bottom - y);
    const rightHeight = Math.max(48, rightBottom - rightY);
    if (this.opponent) {
      const hudBottom = y + Math.min(leftHeight, 118);
      this.sideHUD(leftX, y, side, hudBottom - y, ['score', 'lines'], true);
      const unit = Math.max(1, Math.floor(Math.min(side / WELL_W, (h - 70 - hudBottom) / WELL_H)));
      const mw = WELL_W * unit;
      if (mw <= side) this.miniWell(leftX + (side - mw) / 2, h - 70 - WELL_H * unit, unit, Math.max(4, round(3 * pad)));
      this.sideHUD(rightX, rightY, rightW, rightHeight, ['next', 'level', 'stats'], true);
    } else {
      this.sideHUD(leftX, y, side, leftHeight, ['score', 'lines', 'level'], true);
      this.sideHUD(rightX, rightY, rightW, rightHeight, ['next', 'high', 'stats'], true);
    }
  }

  paint() {
    if (!this.nes) return;
    const w = this.canvas.width, h = this.canvas.height;
    if (w < 2 || h < 2) return;
    this.ctx.clearRect(0, 0, w, h);
    if (this.scene === 'scores') {
      if (!this.resultBar.hidden) {
        const available = this.resultBar.offsetTop - 14;
        this.hudPanel(3, 3, w - 6, available);
        this.scores(w, available);
      }
      return;
    }
    if (!GAME.has(this.scene)) {
      // Совместимый режим: показываем оригинальный кадр как есть.
      const k = Math.min(w / 256, h / 240);
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, w, h);
      this.blit([0, 0, 256, 240], (w - 256 * k) / 2, (h - 240 * k) / 2, 256 * k, 240 * k);
      return;
    }

    if (this.landscape) this.landscapeGame(w, h);
    else this.portrait(w, h);
  }
}
