// Обложка карточки: титульный кадр, отрисованный из ROM игрока уже в браузере.
// В репозиторий не попадает — хранится только в IndexedDB (covers) на устройстве.

const WIDTH = 256;
const HEIGHT = 240;
const BLACK = 0xff000000;

/**
 * Кадр PPU (Uint32Array 256×240, BGR 0x00BBGGRR) → PNG data URL.
 * @param {Uint32Array|number[]|null} buffer
 * @returns {string|null} null, если кадр пустой/невалидный
 */
export function frameToDataUrl(buffer) {
  if (!buffer || buffer.length < WIDTH * HEIGHT) return null;
  let ink = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    if ((buffer[i] & 0xffffff) !== 0) ink++;
  }
  // Почти чёрный кадр (copyright/переход) обложкой не делаем.
  if (ink < WIDTH * HEIGHT * 0.01) return null;

  const canvas = createCanvas(WIDTH, HEIGHT);
  if (!canvas) return null;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  const image = context.createImageData(WIDTH, HEIGHT);
  const pixels = new Uint32Array(image.data.buffer);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const value = buffer[i] | 0;
    const red = value & 0xff;
    const green = (value >> 8) & 0xff;
    const blue = (value >> 16) & 0xff;
    // Canvas пишет RGBA в порядке байтов little-endian → 0xAABBGGRR.
    pixels[i] = 0xff000000 | (blue << 16) | (green << 8) | red;
  }
  context.putImageData(image, 0, 0);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** true, если в кадре есть заметный рисунок (не чёрный экран). */
export function frameHasInk(buffer) {
  if (!buffer || buffer.length < WIDTH * HEIGHT) return false;
  let ink = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    if ((buffer[i] & 0xffffff) !== 0) {
      if (++ink > 512) return true;
    }
  }
  return false;
}

/**
 * Достаточно ли кадр «содержательный» для обложки. Переходные экраны
 * (серый copyright, чёрный кадр) отбрасываем по доле закраски и числу цветов.
 */
export function isCoverFrame(buffer) {
  if (!buffer || buffer.length < WIDTH * HEIGHT) return false;
  let ink = 0;
  const colors = new Set();
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const value = buffer[i] & 0xffffff;
    if (value) ink++;
    if (colors.size < 64) colors.add(value);
  }
  return ink >= WIDTH * HEIGHT * 0.04 && colors.size >= 6;
}

function createCanvas(width, height) {
  // В окне используем обычный canvas: у OffscreenCanvas нет toDataURL.
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

export const COVER_WIDTH = WIDTH;
export const COVER_HEIGHT = HEIGHT;
export const COVER_BLACK = BLACK;
