export const SAMPLE_RATE = 48000;
const BLOCK_SIZE = 1024;
const START_LEAD = .018;
const MAX_LEAD = .108;
const CLOCK_CHECK_MS = 450;
const RESUME_TIMEOUT = 900;

// Scheduling short PCM blocks also works on plain-HTTP LAN addresses where
// AudioWorklet is unavailable. The browser converts the NES sample rate to the
// output device's rate. Game audio comes directly from the emulated APU.
export class CartridgeAudio {
  constructor() {
    this.left = new Float32Array(BLOCK_SIZE);
    this.right = new Float32Array(BLOCK_SIZE);
    this.sources = new Set();
    this.excerpts = new Map();
    this.previewToken = 0;
    this.count = 0;
    this.nextTime = 0;
    this.muted = false;
    this.pageActive = !document.hidden;
    this.session = navigator.audioSession;
    this.session?.addEventListener?.('statechange', () => {
      if (this.blocked()) this.interrupt();
      else this.recover();
    });
  }

  blocked() {
    return !this.pageActive || document.hidden || this.session?.state === 'interrupted';
  }

  wake() {
    this.wanted = true;
    if (this.blocked()) return Promise.resolve(false);
    const trusted = navigator.userActivation?.isActive ?? true;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return Promise.resolve(false);
    try {
      // Set the mixing policy before creating or waking Web Audio.
      if (this.session && this.session.type !== 'ambient') this.session.type = 'ambient';
    } catch { /* Older browsers choose their Web Audio default. */ }
    try {
      if (!this.context || this.context.state === 'closed' || (trusted && this.needsReplacement)) {
        const old = this.context;
        this.clear();
        this.finishResume(false);
        this.resetClockCheck();
        const context = new Audio({ latencyHint: 'interactive' });
        this.context = context;
        this.gain = context.createGain();
        this.gain.gain.value = this.muted ? 0 : 0.8;
        this.gain.connect(context.destination);
        this.needsReplacement = false;
        this.needsCheck = true;
        context.addEventListener('statechange', () => {
          if (context === this.context) this.syncOutput();
        });
        if (old && old.state !== 'closed') old.close().catch(() => {});
      }
      return this.recover(trusted);
    } catch {
      return Promise.resolve(false);
    }
  }

  setPageActive(active) {
    if (this.pageActive === active) {
      if (active) this.recover();
      return;
    }
    this.pageActive = active;
    if (active) {
      this.recover();
    } else {
      this.interrupt();
      const context = this.context;
      if (context?.state === 'running') {
        // A quick return can get here before the suspend promise settles.
        context.suspend().then(() => {
          if (this.context === context) this.recover();
        }).catch(() => {});
      }
    }
  }

  pause() {
    this.wanted = false;
    this.clear();
    this.resetClockCheck();
    this.finishResume(false);
  }

  interrupt() {
    this.clear();
    this.resetClockCheck();
    this.needsCheck = true;
    this.finishResume(false);
  }

  syncOutput() {
    if (this.blocked() || this.context?.state === 'interrupted') {
      this.interrupt();
    } else if (this.context?.state === 'running') {
      this.finishResume(true);
      this.checkClock();
    } else if (this.context?.state === 'suspended') {
      this.flush();
      this.needsCheck = true;
      this.recover();
    }
  }

  recover(trusted = false) {
    const context = this.context;
    if (!context || !this.wanted || this.blocked() || this.needsReplacement) return Promise.resolve(false);
    if (context.state === 'running') {
      this.checkClock();
      return Promise.resolve(true);
    }
    if (context.state === 'closed') return Promise.resolve(false);
    if (this.pending && (!trusted || this.pending.trusted)) return this.pending.promise;
    this.finishResume(false);
    const request = { trusted };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    this.pending = request;
    request.timer = setTimeout(() => {
      if (this.pending !== request) return;
      this.needsReplacement = context.state !== 'running';
      this.finishResume(!this.needsReplacement);
    }, RESUME_TIMEOUT);
    // Safari must receive resume in the original tap/key event, even when
    // a previously issued automatic request is still pending.
    const finish = () => {
      if (this.pending !== request) return;
      const running = context.state === 'running' && !this.blocked();
      this.finishResume(running);
      if (running) this.checkClock();
    };
    try { context.resume().then(finish, finish); } catch { finish(); }
    return request.promise;
  }

  finishResume(running) {
    if (!this.pending) return;
    const request = this.pending;
    this.pending = null;
    clearTimeout(request.timer);
    request.resolve(running);
  }

  resetClockCheck() {
    clearTimeout(this.clockTimer);
    this.clockTimer = 0;
    this.nudged = false;
  }

  checkClock() {
    if (!this.needsCheck || this.clockTimer || !this.wanted || this.blocked()) return;
    const context = this.context;
    const started = context.currentTime;
    this.clockTimer = setTimeout(() => {
      this.clockTimer = 0;
      if (this.context !== context || !this.wanted || this.blocked() || context.state !== 'running') return;
      if (context.currentTime > started + .01) {
        this.needsCheck = false;
        this.needsReplacement = false;
        this.nudged = false;
        return;
      }
      // WebKit can report running while the output clock is still frozen.
      // Give it one suspend/resume cycle before replacing it on a player gesture.
      this.flush();
      if (this.nudged) {
        this.needsReplacement = true;
        return;
      }
      this.nudged = true;
      this.clockTimer = setTimeout(() => {
        this.clockTimer = 0;
        this.needsReplacement = true;
      }, RESUME_TIMEOUT);
      const finish = () => {
        if (this.context !== context || !this.nudged) return;
        clearTimeout(this.clockTimer);
        this.clockTimer = 0;
        this.recover();
      };
      context.suspend().then(finish, finish);
    }, CLOCK_CHECK_MS);
  }

  write(left, right) {
    if (this.muted || !this.pageActive || this.needsReplacement || this.context?.state !== 'running') return;
    this.left[this.count] = left;
    this.right[this.count] = right;
    if (++this.count < BLOCK_SIZE) return;
    this.count = 0;
    if (this.blocked()) return;

    const now = this.context.currentTime;
    if (this.nextTime > now + MAX_LEAD) return;
    if (this.nextTime <= now) this.nextTime = now + START_LEAD;

    const buffer = this.context.createBuffer(2, BLOCK_SIZE, SAMPLE_RATE);
    buffer.copyToChannel(this.left, 0);
    buffer.copyToChannel(this.right, 1);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  async previewMusic() {
    // Предпросмотр треков из записей игры больше не используется:
    // это была производная запись оригинальной музыки. No-op для совместимости.
    return false;
  }

  stopPreview() {
    this.previewToken++;
    if (this.preview) {
      this.preview.stop();
      this.preview = null;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 0.8;
    if (muted) this.clear();
  }

  clear() {
    this.stopPreview();
    this.flush();
  }

  flush() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.nextTime = 0;
    this.count = 0;
  }
}
