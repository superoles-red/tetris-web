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

/** Переходный кадр с серым фоном (copyright → титульный экран). */
export function frameLooksTransitional(buffer) {
  if (!buffer || buffer.length < WIDTH * HEIGHT) return true;
  let gray = 0;
  const total = WIDTH * HEIGHT;
  for (let i = 0; i < total; i++) {
    if ((buffer[i] & 0xffffff) === 0x525252) gray++;
  }
  return gray > total * 0.45;
}

/** Кадр годится для обложки: содержательный и не серый переходный. */
export function isUsableCoverFrame(buffer) {
  return isCoverFrame(buffer) && !frameLooksTransitional(buffer);
}

/**
 * Проверка уже сохранённой обложки (data URL) без доверия к кэшу:
 * серый переходный кадр отбрасываем, чтобы старые записи в IndexedDB
 * не показывались как «обложка». Требует DOM (вызывается в браузере).
 */
export async function coverDataUrlIsUsable(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
  if (typeof document === 'undefined') return true;
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) return false;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    let gray = 0;
    let ink = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 16) {
      total++;
      const red = data[i], green = data[i + 1], blue = data[i + 2];
      const color = (red << 16) | (green << 8) | blue;
      if (color === 0x525252) gray++;
      if (color) ink++;
      if (colors.size < 256) colors.add(color);
    }
    // У NES-палитры мало цветов (титульный экран Tengen — ~13 разных RGB),
    // поэтому порог по цветам низкий; серый copyright ловим по его доле.
    return colors.size >= 8 && gray <= total * 0.45 && ink >= total * 0.02;
  } catch {
    return false;
  }
}

export const COVER_WIDTH = WIDTH;
export const COVER_HEIGHT = HEIGHT;
export const COVER_BLACK = BLACK;
