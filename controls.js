// Нижняя панель управления: зоны нажатия как в старом порте.
// Пересечение разделителя переключает удерживаемое направление независимо
// от того, где палец коснулся экрана в первый раз.
export function bindControls({ pad, setInput, pause }) {
  const touches = new Map();
  const game = pad.closest('#game');
  const isPlaying = () => !game.inert && game.dataset.scene === 'play';
  const movement = pad.querySelector('.moves');
  const rotation = pad.querySelector('.turns');
  const down = pad.querySelector('[data-button="down"]');
  const pauseButton = pad.querySelector('#pause-key');
  // Кнопку «вниз» выносим из пары движений: центр каждой группы должен
  // совпадать с двумя горизонтальными зонами нажатия.
  pad.append(down);
  const buttons = [...pad.querySelectorAll('[data-button]')];
  const portrait = matchMedia('(orientation: portrait)');
  const coarseLandscape = matchMedia('(orientation: landscape) and (pointer: coarse)');

  function readPoint(x, y) {
    const box = pad.getBoundingClientRect();
    if (y < box.top || y >= box.bottom || x < box.left || x >= box.right) return null;
    const mid = box.left + box.width * 0.5;
    const drop = down.getBoundingClientRect();
    const reach = Math.max(20, box.width * 0.12);
    if (y >= drop.top && y < drop.bottom) {
      const movementEdge = coarseLandscape.matches
        ? Math.min(mid, movement.getBoundingClientRect().right + reach)
        : mid;
      if (x >= movementEdge) return { group: 'drop', button: 'down' };
    }
    const left = x < mid;
    const isPortrait = portrait.matches;
    const start = isPortrait && !left ? drop.bottom : box.top + box.height * (isPortrait ? 0.38 : 0.5);
    if (y < start) return null;
    let split = box.left + box.width * (left ? 0.25 : 0.75);
    if (!isPortrait) {
      const cluster = (left ? movement : rotation).getBoundingClientRect();
      if (coarseLandscape.matches && (left ? x >= cluster.right + reach : x < cluster.left - reach)) return null;
      split = cluster.left + cluster.width * 0.5;
    }
    return left
      ? { group: 'move', button: x < split ? 'left' : 'right' }
      : { group: 'action', button: x < split ? 'b' : 'a' };
  }

  function release(id) {
    const touch = touches.get(id);
    if (!touch) return;
    touches.delete(id);
    setInput(id, touch.button, false);
  }

  function clear() {
    for (const id of [...touches.keys()]) release(id);
  }

  // Смена экрана картриджа может случиться, пока пальцы ещё на экране.
  new MutationObserver(() => { if (!isPlaying()) clear(); })
    .observe(game, { attributes: true, attributeFilter: ['inert', 'data-scene'] });

  pad.addEventListener('touchstart', (event) => {
    if (isPlaying() && !pauseButton.contains(event.target) && event.cancelable) event.preventDefault();
  }, { passive: false });

  pad.addEventListener('pointerdown', (event) => {
    if (!isPlaying() || pauseButton.contains(event.target) || event.button !== 0) return;
    const hit = readPoint(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, hit);
    setInput(event.pointerId, hit.button, true);
  });
  pad.addEventListener('pointermove', (event) => {
    const id = event.pointerId;
    const touch = touches.get(id);
    // Палец, начавший на «вниз», держит его до отпускания.
    if (!touch || touch.group === 'drop') return;
    const next = isPlaying() && readPoint(event.clientX, event.clientY);
    if (!next || next.group !== touch.group) {
      release(id);
    } else if (touch.button !== next.button) {
      setInput(id, touch.button, false);
      touches.set(id, next);
      setInput(id, next.button, true);
    }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    pad.addEventListener(name, event => release(event.pointerId));
  }
  // Клавиатурная/assistive-активация не создаёт pointer-событий.
  for (const button of buttons) {
    button.addEventListener('click', (event) => {
      if (!isPlaying() || event.detail !== 0) return;
      const name = button.dataset.button;
      const id = 'activate-' + name;
      setInput(id, name, true);
      setInput(id, name, false);
    });
  }
  pauseButton.onclick = pause;
  return { clear };
}
