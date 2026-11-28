const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
import crypto from 'node:crypto';
const RU = process.env.ROM_PATH;
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8085/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text().slice(0, 160)); });

const menuTransitions = [];
async function watchMenus(ms) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    const m = await page.evaluate(() => ({ menu: document.getElementById('overlay').dataset.menu, hidden: document.getElementById('overlay').hidden, scene: document.getElementById('game').dataset.scene }));
    const key = JSON.stringify(m);
    if (key !== last) { menuTransitions.push({ t: Date.now(), ...m }); last = key; }
    await page.waitForTimeout(80);
  }
}
const hashCanvas = async () => page.evaluate(() => {
  const c = document.getElementById('picture');
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < data.length; i += 97) h = (h * 31 + data[i]) | 0;
  return h;
});
const press = async (id, times = 1) => {
  const el = page.locator(id);
  for (let i = 0; i < times; i++) { await el.dispatchEvent('pointerdown'); await page.waitForTimeout(30); await el.dispatchEvent('pointerup'); await page.waitForTimeout(30); }
};

await page.goto(BASE_URL, { waitUntil: 'load' });
await watchMenus(700);
await page.setInputFiles('#rom-file', RU);
await watchMenus(9000);
console.log('boot transitions', menuTransitions.map(x => x.menu || x.scene).join(' -> '));

// --- партия solo с максимальным handicap: быстро до game over ---
await page.locator('#play').click(); await page.waitForTimeout(250); if (await page.locator('#confirm-yes').isVisible().catch(() => false)) { await page.locator('#confirm-yes').click(); } await page.waitForTimeout(300);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#setup-choices .choice-row')];
  // handicap — ищем строку, у которой значение содержит 'РЯД'
  for (const row of rows) {
    const value = row.querySelector('.choice-value');
    if (value && /РЯД/i.test(value.textContent)) { row.querySelector('.choice-arrow.next').click(); }
  }
});
await page.waitForTimeout(200);
await page.locator('#start').click();
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => document.getElementById('game').dataset.scene) === 'play') break; await page.waitForTimeout(500); }
console.log('solo scene', await page.evaluate(() => document.getElementById('game').dataset.scene));
const before = await hashCanvas();
await press('[data-button="left"]'); await press('[data-button="a"]'); await press('[data-button="down"]', 2);
await page.waitForTimeout(600);
console.log('canvas reacts to input', before !== await hashCanvas());

// быстро проигрываем: жмём «вниз» без остановки
await page.evaluate(() => { window.__autoDown = setInterval(() => { for (const sel of ['[data-button="down"]']) { const el = document.querySelector(sel); if (el) { el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); el.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); } } }, 120); });
let recordEditor = false;
for (let t = 0; t < 180; t++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => ({ menu: document.getElementById('overlay').dataset.menu, scene: document.getElementById('game').dataset.scene, edit: !document.getElementById('record-edit-menu').hidden }));
  if (st.menu === 'record-edit' || st.edit) { recordEditor = true; console.log('record editor after', t + 1, 's'); break; }
  if (t % 10 === 9) console.log(t + 1 + 's scene', st.scene, 'menu', st.menu);
}
await page.evaluate(() => clearInterval(window.__autoDown));
if (recordEditor) {
  const input = page.locator('#record-input');
  console.log('input visible', await input.isVisible(), 'bbox', JSON.stringify(await input.boundingBox()));
  await input.fill('ТЕСТ');
  await page.waitForTimeout(300);
  console.log('input value', await input.inputValue());
  await page.screenshot({ path: '/tmp/pt-record-edit.png' });
  await page.locator('#record-submit').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/pt-record-confirm.png' });
  await page.locator('#record-confirm-yes').click();
  await page.waitForTimeout(700);
  const table = await page.evaluate(() => ({ rows: document.getElementById('record-rows').innerText, visible: !document.getElementById('records-table')?.hidden }));
  console.log('records table', JSON.stringify(table).slice(0, 200));
  await page.screenshot({ path: '/tmp/pt-records.png' });
} else {
  console.log('NO record editor reached');
}
console.log('errors', errors.slice(0, 6));
await browser.close();
