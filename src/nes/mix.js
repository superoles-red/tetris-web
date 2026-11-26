// Микс звука: разделение музыки и эффектов по каналам APU + плейлист треков.
// Адреса RAM ($0200-$04FF) — это данные картриджа Tengen Tetris, драйвер
// звука; здесь только логика чтения/записи, без игровых таблиц.

function effectOwner(ram, channel) {
  let node = ram[0x03e7 + channel];
  for (let depth = 0; node >= 1 && node <= 11 && depth < 11; depth++) {
    const next = ram[0x03dc + node - 1];
    if (next === 0) {
      const sequence = ram[0x020e + node - 1];
      return sequence >= 9 && sequence <= 20;
    }
    node = next;
  }
  return false;
}

function percent(value, fallback) {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : fallback;
}

export const SHUFFLE = 'shuffle';
export const TRACKS = [1, 2, 3, 4];

// Пары указателей голосов на границе полного цикла каждого трека.
const SCORE_LOOPS = [
  [0xe82d, 0xe5d7],
  [0xf186, 0xf050],
  [0xf67c, 0xf612],
  [0xf8d1, 0xf811],
];

/** @param {(left:number,right:number)=>void} output */
export class CartridgeMix {
  constructor(output) {
    this.output = output;
    this.sound = 1;
    this.music = 1;
    this.track = 1;
    this.trackChoice = 1;
    this.remainingTracks = [];
    this.repeatedTrack = false;
    this.atLoopEnd = false;
    this.effectMask = 0;
    this.pendingTrack = false;
    this.console = null;
    this.ram = null;
    this.apu = null;
  }

  /** Подключить консоль: перехват записей APU, чтобы знать, кто владеет каналом. */
  attach(console, state) {
    this.console = console;
    this.ram = console.cpuMem;
    this.apu = console.apu;
    this.effectMask = state?.effectMask ?? 0;
    this.pendingTrack = state?.pendingTrack ?? false;
    this.atLoopEnd = false;
    if (!this.apu || this.apu.__mixHooked) return;
    this.apu.__mixHooked = true;
    const writeReg = this.apu.writeReg.bind(this.apu);
    this.apu.writeReg = (address, value) => {
      if (address >= 0x4000 && address < 0x4010 && this.ram) {
        const channel = (address - 0x4000) >> 2;
        if (effectOwner(this.ram, channel)) this.effectMask |= 1 << channel;
        else this.effectMask &= ~(1 << channel);
      }
      writeReg(address, value);
    };
  }

  snapshot() {
    return { pendingTrack: this.pendingTrack, effectMask: this.effectMask };
  }

  capturePlaylist() {
    return {
      choice: this.trackChoice, track: this.track, remaining: [...this.remainingTracks],
      repeatedTrack: this.repeatedTrack, atLoopEnd: this.atLoopEnd,
    };
  }

  restorePlaylist(playlist) {
    this.trackChoice = playlist.choice;
    this.track = playlist.track;
    this.remainingTracks = [...playlist.remaining];
    this.repeatedTrack = playlist.repeatedTrack === true;
  }

  set({ sound, music, track }, deferTrack) {
    this.sound = percent(sound, this.sound);
    this.music = percent(music, this.music);
    if (track === SHUFFLE || TRACKS.includes(track)) {
      if (track !== this.trackChoice) this.startMusic(track, this.track);
      this.requestTrack(deferTrack);
    }
  }

  startMusic(choice, previous) {
    this.trackChoice = choice;
    this.remainingTracks = [];
    this.repeatedTrack = false;
    this.atLoopEnd = false;
    this.track = choice === SHUFFLE ? this.nextTrack(previous) : choice;
    return this.track;
  }

  nextTrack(previous) {
    const bag = this.remainingTracks;
    if (!bag.length) {
      bag.push(...TRACKS);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      const last = bag.length - 1;
      if (bag[last] === previous) [bag[last], bag[0]] = [bag[0], bag[last]];
    }
    return bag.pop();
  }

  advancePlaylist() {
    if (this.trackChoice !== SHUFFLE || !this.ram) return;
    const ram = this.ram;
    if (ram[0x29] !== 0 || this.pendingTrack) {
      this.atLoopEnd = false;
      return;
    }
    const [end, start] = SCORE_LOOPS[this.track - 1];
    const id = this.track - 1;
    let ending = false;
    let looped = false;
    for (let i = 0; i < 11; i++) {
      const sequence = ram[0x020e + i];
      if ((sequence !== id && sequence !== id + 4) || !ram[0x0292 + i]) continue;
      const pointer = ram[0x0219 + i] | (ram[0x0224 + i] << 8);
      ending ||= pointer === end;
      looped ||= pointer === start;
    }
    if (this.atLoopEnd && looped) {
      this.atLoopEnd = false;
      if (this.repeatedTrack) {
        this.repeatedTrack = false;
        this.track = this.nextTrack(this.track);
        this.requestTrack(true);
      } else {
        this.repeatedTrack = true;
        this.pendingTrack = true;
      }
    } else {
      this.atLoopEnd = ending;
    }
  }

  requestTrack(deferTrack = false) {
    if (!this.ram) return;
    const ram = this.ram;
    if (ram[0x49] !== 1 || ![0, 1, 3].includes(ram[0x29])) return;
    if (ram[0x04f5] === this.track) return;
    ram[0x04f5] = this.track;
    this.pendingTrack = ram[0x29] !== 3;
    if (!deferTrack) this.flushTrack();
  }

  flushTrack() {
    if (!this.pendingTrack || !this.ram) return;
    const ram = this.ram;
    if (ram[0x29] !== 0 && ram[0x29] !== 1) {
      this.pendingTrack = false;
      return;
    }
    const first = (ram[0x0209] + 1) & 7;
    const second = (first + 1) & 7;
    if (first === ram[0x0208] || second === ram[0x0208]) return;
    ram[0x0200 + first] = 8;
    ram[0x0200 + second] = ram[0xa043 + this.track];
    ram[0x0209] = second;
    this.pendingTrack = false;
  }

  /**
   * Микширование одного сэмпла: full — стерео-микс всех каналов из APU,
   * channels — уровни каналов (0..15). При разных громкостях музыки и
   * эффектов каналы разделяются по effectMask.
   */
  sample(left, right, channels) {
    if (this.sound === this.music) {
      this.output(left * this.music, right * this.music);
      return;
    }
    if (!channels) {
      // Без поканальных данных — общий микс на минимальной громкости.
      const base = Math.min(this.sound, this.music);
      this.output(left * base, right * base);
      return;
    }
    let musicSum = 0;
    let sfxSum = 0;
    const values = [channels.pulse1, channels.pulse2, channels.triangle, channels.noise];
    for (let i = 0; i < 4; i++) {
      const level = values[i] ?? 0;
      if (this.effectMask & (1 << i)) sfxSum += level;
      else musicSum += level;
    }
    const base = Math.min(this.sound, this.music);
    const diff = Math.abs(this.music - this.sound);
    const sign = this.music > this.sound ? 1 : -1;
    const correction = ((musicSum - sfxSum) / 30) * sign * diff;
    this.output(left * base + correction, right * base + correction);
  }
}
