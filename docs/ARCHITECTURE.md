# Архитектура `tetris-web`

Статус: рабочий документ. Обновляется вместе с кодом.

## 1. Задача и границы

Веб-порт Tetris (Tengen, NES) **без эмулятора**. Игрок приносит свой ROM (`.nes`).
Код 6502 из ROM **статически перекомпилируется в WebAssembly** в браузере игрока.
Всё, что видно и слышно в игре, — оригинальные данные ROM (PPU-рендер и APU из
самого картриджа). Мы не поставляем и не храним ни ROM, ни производную графику/звук.

- Никакого ROM, CHR/PRG-дампов, скриншотов игры и записей музыки в репозитории,
  в git-истории и в сборочных артефактах. В `data/dumps.json` — только имена
  вариантов и SHA-256.
- В раздаче только наш код (MIT), наши простые иконки/обложка-заглушка, шрифты
  с разрешающей лицензией.
- Рекомпилятор — наш; он же платформа для других NES-игр (пока поддерживаются
  только небанкованные мапперы, см. §6).

## 2. Структура

```
index.html                страница игры (RU/EN интерфейс)
app.js                    UI-поток: карточка → ROM → установка → игра
compositor.js             раскладка/кроп оригинального кадра (из старого порта)
controls.js viewport.js   тач и вьюпорт
install.js locale.js      PWA-установка и локализация оболочки
rankings.js saved-run.js  рекорды и сохранения (полный режим известных дампов)
style.css controls.css install.css
sw.js manifest.webmanifest

src/nes/rom.js            разбор iNES, профиль дампа, хэши
src/nes/mapper.js         мапперы 0/3/148 (для Tetris) + фолбэки
src/nes/compile.js        статическая трансляция 6502 → WASM (главный модуль)
src/nes/wasm.js           минимальный энкодер бинарного WASM
src/nes/ppu.js            PPU: регистры, скролл, спрайты, кадровый рендер
src/nes/apu.js            APU: 2 импульса, треугольник, шум, огибающие
src/nes/console.js        шина, тактирование, прерывания, снапшоты
src/nes/engine.js         браузерный движок: rAF, звук, пауза, PWA-статус
src/nes/render-buffer.js  (общий формат кадра: BGR Uint32 256×240)

src/byop/store.js         IndexedDB: ROM игрока, снапшоты, профиль
src/byop/passport.js      «паспорт дампа»: что нашли, что доступно
src/byop/menu-checkpoint.js кэш «сразу в меню» после первого запуска
data/dumps.json           известные дампы: имя, SHA-256, язык, полнота

tools/reference/*         dev-only эталон на JSNES (Apache-2.0), НЕ входит в сайт
tools/compare.mjs         побайтовое сравнение кадров с эталоном
tools/serve.mjs           локальная статика
tests/*.test.mjs          node:test, без ROM в репозитории (см. §9)
```

## 3. Модель исполнения

### 3.1 Статическая перекомпиляция

`compile.js` получает `ROM` (после проверки маппера) и строит `WebAssembly.Module`:

- 32 768 функций — по одной на каждый адрес `$8000…$FFFF` (по 1 инструкции 6502).
  Таблица функций индексируется как `pc - 0x8000`; экспорт `step(pc: i32) -> i32`
  делает `call_indirect` по этой таблице.
- Результат блока: `nextPC | (cycles << 16)`. `cycles` включает page-cross и
  branch-penalty, посчитанные на месте.
- Регистры: `A,X,Y,SP,P` — байты в linear memory по `CPU_STATE = 0x010000`
  (A+0, X+1, Y+2, SP+3, P+4). Флаги в `P`: N=0x80 V=0x40 U=0x20 D=0x08 I=0x04
  Z=0x02 C=0x01.
- Память: страница 0..0xFFFF — адресное пространство CPU:
  `0x0000-0x07FF` RAM (зеркала на чтении/записи дают `addr & 0x7FF`),
  `0x8000-0xFFFF` — текущее окно PRG (копия 32 КиБ). `CPU_STATE` — сразу после.
- Статически известные адреса: RAM читается/пишется напрямую, ROM читается
  напрямую, `$2000-$5FFF` — через импорты. Динамические адреса (indirect,
  abs,X/abs,Y) всегда через импорты `read`/`write` — там разбирается, RAM это,
  регистр PPU/APU или запись в маппер.
- Импорты: `env.read(addr)->i32`, `env.write(addr,val)->void`.
  Всё остальное (PPU, APU, маппер, контроллер) живёт в JS.
- Недокументированные коды: реализуются по известной таблице, JAM-коды
  останавливают исполнение (`Console` сообщает ошибку «игра остановилась»).
- Код, исполняемый из RAM (`JMP ($0000)` в RAM), не поддерживается; `Console`
  сообщает понятную ошибку.

### 3.2 Консоль и кадр

`console.js` — шина и время:

```
runFrame():
  while (true):
    r = wasm.step(pc); pc = r & 0xFFFF; cycles = r >>> 16
    ppu.advanceDots(cycles * 3)          // рендерит видимые строки, ставит vblank/NMI
    apu.advance(cycles)                  // сэмплы в onAudioSample
    if (dmaPending) { ppu.advanceDots(513*3); apu.advance(513); dmaPending=false }
    if (ppu.nmiPending && !(P & I)) takeInterrupt(0xFFFA), +7 циклов
    else if (apu.irqPending && !(P & I)) takeInterrupt(0xFFFE), +7
    if (ppu.frameEnded) break
```

- `frameEnded` выставляется PPU на границе кадра (строка 262). Сравнение с
  эталоном JSNES идёт по кадрам, поэтому граница должна совпадать с JSNES.
- `$4014` OAM DMA: копируем 256 байт сразу, задерживаем CPU на 513 циклов.
- Контроллер: `$4016` стробирование + сдвиг битов; `buttonDown/buttonUp`
  принимают JSNES-коды 0..7 (A,B,SELECT,START,UP,DOWN,LEFT,RIGHT).
- `cpu.mem` — живое `Uint8Array(65536)` поверх linear memory: фронтенд читает
  и пишет RAM по известным адресам игры (`rankings.js`, `cartridge`-адреса,
  «паспорт»). Записи через это представление сразу видны компилированному коду.

### 3.3 PPU (контракт для `src/nes/ppu.js`)

Собственная модель, не JSNES. Обязательный JSNES-совместимый фасад нужен
`compositor.js` и `app.js` (они работают с оригинальным кадром и его раскладкой):

| Поле/метод | Формат |
|---|---|
| `vramMem` | `Uint8Array(0x8000)`; `[0..0x1FFF]` — текущее 8 КиБ окно CHR; `[0x2000..0x3EFF]` nametables по JSNES-нотации; `[0x3F00..]` палитры |
| `spriteMem` | `Uint8Array(256)` OAM |
| `ptTile` | массив 512 `{ pix: Uint8Array(64) }` — декодированные 2-bit пиксели |
| `sprPalette`, `imgPalette` | `Uint32Array(16)`; цвет `0x00BBGGRR` (как JSNES) |
| `buffer` | `Uint32Array(256*240)`, BGR-цвета, как в JSNES |
| `f_bgVisibility`, `f_spVisibility`, `f_bgClipping`, `f_spClipping`, `f_spriteSize`, `f_bgPatternTable`, `f_spPatternTable`, `f_nmiOnVblank`, `f_color` | флаги регистров |
| `writeMem(addr,val)`, `readMem(addr)` | путь `$2007` |
| `readReg(addr)`, `writeReg(addr,val)` | `$2000-$3FFF` с зеркалами |
| `startFrame()`, `advanceDots(n)`, `renderFullFrame()` | тактирование; `renderFullFrame` рендерит кадр без CPU (пауза/смена языка) |
| `frameEnded`, `nmiPending`, `sprite0Hit` | события |
| `setMirroring(type)`, `setChrWindow(bytes8k)`, `toJSON()/fromJSON()` | утилиты |

Рендер строки — в момент её начала (`advanceDots` переходит на строку `s` →
рендерит `s`), поэтому scroll/palette-изменения посреди кадра учитываются.
Sprite 0 hit выставляется при совпадении непрозрачных пикселей BG и спрайта 0.
Приоритет спрайтов, 8×16, flips, левый кроп — по железу.
Тайминги (vblank, NMI, граница кадра) сверить с JSNES 2.1.0 — только как
поведенческий эталон, код писать свой.

### 3.4 APU (контракт для `src/nes/apu.js`)

`constructor({ sampleRate = 48000, onSample })`, `reset()`, `writeReg(addr,val)`,
`readReg(addr)`, `advance(cpuCycles)`, `toJSON()/fromJSON()`, поля `irqPending`
и `channels` (уровни 0..15 за последний интервал: `{pulse1,pulse2,triangle,noise}`).

- 2 импульсных канала (duty 12.5/25/50/75, envelope, sweep, length),
  треугольник (linear counter), шум (LFSR), frame sequencer 4/5 шагов,
  $4015 enable/status, frame IRQ.
- Выход стерео, микширование через аппаратные DAC-таблицы NES.
- `advance` копит точный sample timer, `onSample(l,r)` в диапазоне −1..1.
- DMC не обязателен для Тетриса; реализовать чтение/запись регистров и заглушку.

### 3.5 Браузерный движок (`src/nes/engine.js`)

Повторяет фасад старого `engine.js`, чтобы `app.js`/`compositor.js` требовали
минимум правок:

```
new Engine({ onFrame, onError })
await engine.load(romBytes)          // компиляция + Console
engine.reset(); engine.start(); engine.setPaused(bool)
engine.setButton(name, down); engine.clearButtons()
engine.nes                            // { frame(), buttonDown/Up, cpu.mem, ppu, cartridgeLanguage, toJSON/fromJSON }
engine.playMenuMusic(volume); engine.stopMenuMusic()
engine.setMix({sound,music}); engine.startMusic(track); engine.previewMusic(gain); engine.stopPreview()
engine.wakeAudio(); engine.setAudioPageActive(bool); engine.setMuted(bool)
engine.captureStart()/restoreStart(state); engine.captureProgress()/restoreProgress(state)
engine.renderPausedFrame(present)
```

- rAF-цикл: догоняющая эмуляция кадров, как в старом `engine.js` (MAX_CATCHUP),
  аудио — короткими PCM-блоками через `audio-output.js` (сохраняем).
- Музыку меню играет отдельная голова `Console` без кадра (title theme из ROM).
- Запись на паузе: `renderFullFrame()` из снапшота — без исполнения CPU.
- Снапшот: `{version, romSha256, cpu:{ram,A,X,Y,SP,P}, ppu, apu, mapper, controllers}`.
  Хранить только для известных профилей (`data/dumps.json`), иначе функция скрыта.

## 4. BYOP: ROM игрока

1. Карточка: шаг 1 — «Добавить ROM» (`<input type=file accept=".nes">` или
   drag&drop), шаг 2 — «Установить игру» (PWA install; до шага 1 неактивен).
2. Проверка: iNES/NES 2.0 заголовок, размер консистентен, PRG/CHR читаются,
   маппер поддерживается. Ошибки — человеческим языком, кнопка «другой ROM».
3. ROM кладётся в IndexedDB (`src/byop/store.js`, база `tetris-web`), считается
   SHA-256, строится «паспорт дампа» (§5). Ничего не уходит в сеть.
4. Сборка: `compile.js` в Web Worker; прогресс; результат (WASM) кэшируется
   в IndexedDB по SHA ROM, чтобы второй запуск не компилировал заново.
5. Офлайн: SW кэширует только оболочку; ROM и WASM живут в IndexedDB.
6. «Другой ROM» на главной/в настройках: замена ROM, сброс сохранений по старому
   SHA (с подтверждением).

## 5. Паспорт дампа

`data/dumps.json` — известные варианты (No-Intro): `sha256`, `name`, `region`,
`language`, `mapper`, `prg`, `chr`, `mirroring`, `full` (полный режим).

- **Полный режим** (SHA совпал): автозапуск партии, рекорды, сохранения,
  кнопка продолжения, оригинальная раскладка HUD.
- **Совместимый режим** (NES-ROM с поддерживаемым маппером, SHA неизвестен):
  игра запускается, надстройки скрыты, честный текст «ваш дамп не в каталоге —
  рекорды и сохранения недоступны; нужен файл из каталога».
- **Отказ**: не NES-файл, битый заголовок, неподдерживаемый маппер, нет CHR/PRG.

## 6. Мапперы

Пока поддержаны мапперы с фиксированным 32 КиБ PRG-окном: 0 (NROM),
3 (CNROM), 148 (Tengen 800008; CHR-банк = `(value & prg[addr]) & 7`, PRG-банк
только при >32 КиБ PRG — такие дампы пока отклоняем). Остальные (1/2/4/7…)
дают понятный отказ. Для Тетриса этого достаточно: оба известных дампа 32 КиБ
PRG / 16 КиБ CHR.

## 7. Где брать оригинальную картинку

- Вся графика игры — только из ROM игрока: PPU-рендер, декодированные CHR,
  палитры, OAM. Скриншотов/апскейлов игры в репозитории нет.
- «Обложка» до добавления ROM — наша простая типографика/иконка; после
  добавления ROM обложку можно отрисовать из титульного экрана самого ROM
  (canvas → кэш в IndexedDB, в git не попадает).
- Иконки PWA — наши собственные, не из игры.

## 8. Тесты и эталон

- `node --test tests/` — без игровых ROM. Разрешено: собственные тестовые ROM
  (наш ассемблер/генератор), публичные CPU-тесты, скачанные в CI по пину SHA
  (в репозиторий не коммитятся), синтетические PPU/APU-состояния.
- `tools/compare.mjs` — dev-only сравнение с JSNES 2.1.0 (npm devDependency):
  одинаковый ROM, одинаковый сценарий ввода → SHA-256 кадров, RAM-дампы,
  WAV; первый расходящийся кадр и инструкция — в отчёт. Результаты прогонов
  (без ROM) можно коммитить в `tests/reports/`.
- CI: `npm ci && npm test` + компиляция и запуск тестового ROM.

## 9. Лицензии и правила

- Наш код — MIT (`LICENSE`); JSNES — только devDependency (Apache-2.0,
  `THIRD_PARTY_NOTICES.md`), в сборку сайта не попадает.
- Запрещено коммитить: ROM, дампы CHR/PRG, скриншоты игры, записи музыки,
  любые производные ассеты, ROM-патчи.
- PR-ы: одна задача = ветка `dsh/<тема>`; в `main` без ревью не пушим
  (для первого коммита репозитория допускается bootstrap).
