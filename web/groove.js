// The "groove": how a song actually goes, for people who have never heard it.
//
// Three things, cheapest first — tempo and meter (one number, one dropdown),
// a strum pattern for players who don't read tempo marks, and an optional beat
// map that the community fills in song by song. A song with none of these is
// still perfectly usable; each layer only adds.

export const FEELS = {
  straight: 'Straight',
  swing: 'Swing',
  lilt: 'Lilt (6/8)',
};

export const METERS = ['4/4', '3/4', '6/8', '2/4', '12/8', '5/4'];

export const EMPTY = { meter: null, bpm: null, feel: null, strum: null, note: null };

/** Coerce anything into a groove we're willing to store or display. */
export function normalize(g) {
  if (!g) return { ...EMPTY };
  const bpm = Number(g.bpm);
  return {
    meter: METERS.includes(g.meter) ? g.meter : null,
    bpm: Number.isFinite(bpm) && bpm >= 30 && bpm <= 260 ? Math.round(bpm) : null,
    feel: FEELS[g.feel] ? g.feel : null,
    strum: typeof g.strum === 'string' && g.strum.trim() ? g.strum.trim().slice(0, 32) : null,
    note: typeof g.note === 'string' && g.note.trim() ? g.note.trim().slice(0, 140) : null,
  };
}

export function isEmpty(g) {
  const n = normalize(g);
  return !n.meter && !n.bpm && !n.feel && !n.strum && !n.note;
}

/** Beats per bar, from the meter. 6/8 and 12/8 are felt in 2 and 4. */
export function beatsPerBar(meter) {
  switch (meter) {
    case '3/4': return 3;
    case '2/4': return 2;
    case '6/8': return 2;
    case '12/8': return 4;
    case '5/4': return 5;
    default: return 4;
  }
}

/**
 * A strum pattern is written as D (down), U (up), x (muted) and - (rest),
 * optionally spaced into beats: "D DU UDU".
 */
export function parseStrum(str) {
  if (!str) return null;
  const out = [];
  for (const ch of str) {
    if (ch === ' ') { out.push({ gap: true }); continue; }
    const c = ch.toLowerCase();
    if (c === 'd') out.push({ dir: 'down', muted: false });
    else if (c === 'u') out.push({ dir: 'up', muted: false });
    else if (c === 'x') out.push({ dir: 'down', muted: true });
    else if (c === '-' || c === '.') out.push({ rest: true });
  }
  return out.length ? out : null;
}

// ------------------------------------------------------------- metronome

/**
 * Web Audio metronome with a one-bar count-in. Beats are scheduled ahead of
 * time against the audio clock, so the pulse stays steady even when the main
 * thread is busy rendering.
 */
export class Metronome {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.running = false;
    this.onBeat = null;
    this.beat = 0;
    this.countInBars = 1;
  }

  start(bpm, meter = '4/4') {
    this.stop();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = this.ctx || new AC();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.bpm = bpm;
    this.perBar = beatsPerBar(meter);
    this.spb = 60 / bpm;
    this.beat = 0;
    this.nextTime = this.ctx.currentTime + 0.12;
    this.running = true;

    // Schedule 150ms ahead, checked every 25ms.
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
    return true;
  }

  schedule() {
    if (!this.running) return;
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      const inBar = this.beat % this.perBar;
      const bar = Math.floor(this.beat / this.perBar);
      this.click(this.nextTime, inBar === 0, bar < this.countInBars);
      if (this.onBeat) {
        const t = this.nextTime, b = this.beat, ib = inBar, counting = bar < this.countInBars;
        const delay = Math.max(0, (t - this.ctx.currentTime) * 1000);
        setTimeout(() => this.onBeat({ beat: b, inBar: ib, counting }), delay);
      }
      this.nextTime += this.spb;
      this.beat++;
    }
  }

  click(at, accent, countIn) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1500 : 900;
    // The count-in is deliberately louder so a group hears where bar one is.
    const peak = countIn ? 0.5 : accent ? 0.34 : 0.2;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    o.connect(g).connect(this.ctx.destination);
    o.start(at);
    o.stop(at + 0.08);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ------------------------------------------------------------- tap tempo

/** Averages the last few taps into a BPM. Returns null until it has enough. */
export class TapTempo {
  constructor() { this.taps = []; }
  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 6) this.taps.shift();
    if (this.taps.length < 2) return null;
    const spans = [];
    for (let i = 1; i < this.taps.length; i++) spans.push(this.taps[i] - this.taps[i - 1]);
    const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
    const bpm = Math.round(60000 / avg);
    return bpm >= 30 && bpm <= 260 ? bpm : null;
  }
  reset() { this.taps = []; }
}
