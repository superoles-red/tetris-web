// В обычной вкладке Safari статус-бар принадлежит браузеру. Установленное
// приложение может рисовать под ним и на старте сообщать нулевой верхний отступ.
export function bindPhoneInsets() {
  if (!/iPhone|iPod/i.test(navigator.userAgent)) return;
  const root = document.documentElement;
  root.setAttribute('data-iphone', '');
  const display = matchMedia('(display-mode: standalone), (display-mode: fullscreen)');
  let settle;
  function measure() {
    const standalone = navigator.standalone === true || display.matches;
    root.toggleAttribute('data-iphone-standalone', standalone);
    const width = innerWidth;
    const layoutHeight = innerHeight;
    const visual = window.visualViewport;
    const unzoomed = !visual || Math.abs(visual.scale - 1) < .01;
    let height = layoutHeight;
    if (unzoomed && visual?.height > 0 && Math.abs(width - visual.width) <= 2) {
      height = Math.min(height, visual.height + Math.max(0, visual.offsetTop));
    }
    const style = getComputedStyle(root);
    const topInset = parseFloat(style.getPropertyValue('--device-safe-top')) || 0;
    const bottomInset = parseFloat(style.getPropertyValue('--device-safe-bottom')) || 0;
    if (standalone && unzoomed && width < height && screen.height > screen.width) {
      const gap = screen.height - height;
      const allowance = Math.min(128, Math.max(64, topInset + bottomInset + 2));
      if (Math.abs(width - screen.width) <= 2 && screen.height >= layoutHeight && gap > 0 && gap <= allowance) {
        height = screen.height;
      }
    }
    if (height > 0) root.style.setProperty('--phone-app-height', height + 'px');

    if (!standalone) {
      root.style.removeProperty('--iphone-status-floor');
      return;
    }
    const tall = Math.max(screen.width, screen.height, height) >= 812;
    const fallback = tall ? 47 : 20;
    root.style.setProperty('--iphone-status-floor', (topInset > 0 ? 0 : fallback) + 'px');
  }
  function refresh() {
    measure();
    clearTimeout(settle);
    settle = setTimeout(measure, 250);
  }
  for (const event of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(event, refresh);
  window.visualViewport?.addEventListener('resize', refresh);
  display.addEventListener?.('change', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
}
