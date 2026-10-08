#!/usr/bin/env node
/*
 * Offline sanity check for the playing detector.
 *
 * Synthesises piano-like playing (scales, melodies, chords, fast runs), and
 * things that must NOT count (random notes, key-mashing clusters, speech,
 * clapping, silence, one held note), runs each through js/detector.js with
 * js/config.js, and prints how many seconds were credited.
 *
 *   node tools/simulate.js              # table of all scenarios
 *   node tools/simulate.js --trace ode  # per-second sub-scores for one scenario
 *   node tools/simulate.js --seeds 3    # every scenario with 3 different random seeds
 *   node tools/simulate.js --wav out/   # also write each scenario as a WAV file
 *   node tools/simulate.js --only ode   # just one scenario (combine with --wav)
 *
 * Synthetic audio is only an approximation of a real piano in a real room;
 * use the in-app debug panel (long-press the logo) for final tuning.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('../js/config.js');
const { PracticeDetector } = require('../js/detector.js');

const SR = 48000;

// ------------------------------------------------------------------ random

function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.gauss = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

// --------------------------------------------------------------- synthesis

/** Additive piano-ish tone: inharmonic partials, two detuned strings, hammer thump. */
function addPianoNote(out, t0, midi, dur, vel, rng) {
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  const B = 3.5e-4 * 2 ** (((midi - 60) / 12) * 0.8);
  const tau1 = 2.5 * 2 ** (-(midi - 60) / 20);
  const start = Math.round(t0 * SR);
  const relN = Math.round(dur * SR);
  const total = Math.min(out.length - start, relN + Math.round(0.35 * SR));
  if (total <= 0) return;
  const bassCut = midi < 48 ? 0.35 : 1;
  for (let n = 1; n < 40; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    if (fn > 7000) break;
    let amp = vel * (n === 1 ? bassCut : 0.9 / n ** 0.9) * (0.7 + 0.6 * rng());
    const tau = tau1 / (1 + 0.18 * (n - 1) * Math.sqrt(f0 / 261));
    for (const detune of [-0.4, 0.4]) {
      const w = (2 * Math.PI * fn * 2 ** (detune / 1200)) / SR;
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const ph = 2 * Math.PI * rng();
      let c = Math.cos(ph);
      let s = Math.sin(ph);
      const decay = Math.exp(-1 / (tau * SR));
      const rel = Math.exp(-1 / (0.07 * SR));
      let env = 0.5 * amp;
      for (let i = 0; i < total; i++) {
        const attack = i < 150 ? i / 150 : 1;
        out[start + i] += env * attack * s;
        const nc = c * cw - s * sw;
        s = s * cw + c * sw;
        c = nc;
        env *= i < relN ? decay : rel * decay;
      }
    }
  }
  // Hammer noise.
  let lp = 0;
  const hn = Math.min(out.length - start, Math.round(0.02 * SR));
  for (let i = 0; i < hn; i++) {
    lp += 0.25 * (rng() * 2 - 1 - lp);
    out[start + i] += vel * 0.25 * lp * Math.exp(-i / (0.004 * SR));
  }
}

/** Glottal sawtooth with a gliding f0 through three formant resonators. */
function addSpeech(out, t0, dur, f0Base, rng) {
  const vowels = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];
  let t = t0;
  const end = t0 + dur;
  while (t < end) {
    const syllables = rng.int(4, 12);
    const phraseLen = syllables * 0.24;
    for (let k = 0; k < syllables && t < end; k++) {
      const cons = 0.04 + 0.06 * rng();
      if (rng() < 0.5) addNoiseBurst(out, t, cons, 0.03, 3000, rng);
      t += cons;
      const vlen = 0.12 + 0.13 * rng();
      const decl = 1.2 - (0.35 * (k * 0.24)) / phraseLen;
      const st0 = Math.log2(f0Base * decl);
      const glide = (rng() * 2 - 1) * 3; // semitones over the syllable
      const fm = rng.pick(vowels);
      renderVowel(out, t, vlen, st0, glide, fm, 0.12 * (0.6 + 0.4 * rng()));
      t += vlen;
    }
    t += 0.3 + 0.6 * rng();
  }
}

function renderVowel(out, t0, len, log2f0, glideSt, formants, amp) {
  const start = Math.round(t0 * SR);
  const n = Math.min(out.length - start, Math.round(len * SR));
  const res = formants.map((F, i) => {
    const bw = [80, 100, 120][i];
    const r = Math.exp((-Math.PI * bw) / SR);
    return { b1: 2 * r * Math.cos((2 * Math.PI * F) / SR), b2: -r * r, g: 1 - r, y1: 0, y2: 0 };
  });
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f0 = 2 ** (log2f0 + (glideSt * Math.sin(Math.PI * u * 0.9)) / 12 + 0.01 * Math.sin(i / 300));
    phase += f0 / SR;
    phase -= Math.floor(phase);
    let x = 2 * phase - 1;
    for (const f of res) {
      const y = f.g * x + f.b1 * f.y1 + f.b2 * f.y2;
      f.y2 = f.y1;
      f.y1 = y;
      x = y;
    }
    const env = Math.min(1, i / (0.02 * SR), (n - i) / (0.03 * SR));
    out[start + i] += amp * 8 * env * x;
  }
}

function addNoiseBurst(out, t0, len, amp, hpHz, rng) {
  const start = Math.round(t0 * SR);
  const n = Math.min(out.length - start, Math.round(len * SR));
  const a = Math.exp((-2 * Math.PI * hpHz) / SR);
  let prevX = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const x = rng() * 2 - 1;
    y = a * (y + x - prevX);
    prevX = x;
    out[start + i] += amp * y * Math.min(1, i / 100, (n - i) / 200);
  }
}

function addClap(out, t0, amp, rng) {
  const start = Math.round(t0 * SR);
  const n = Math.min(out.length - start, Math.round(0.12 * SR));
  let bp1 = 0;
  let bp2 = 0;
  const r = 0.97;
  const w = (2 * Math.PI * 1400) / SR;
  for (let i = 0; i < n; i++) {
    const x = (rng() * 2 - 1) * Math.exp(-i / (0.012 * SR));
    const y = x + 2 * r * Math.cos(w) * bp1 - r * r * bp2;
    bp2 = bp1;
    bp1 = y;
    out[start + i] += amp * 0.06 * y;
  }
}

/** Small Schroeder reverb so onsets and pitches smear like in a real room. */
function reverb(x, wet) {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => {
    const n = Math.round(d * SR);
    return { buf: new Float32Array(n), i: 0, g: 10 ** ((-3 * d) / 0.5) };
  });
  const aps = [0.005, 0.0017].map((d) => ({ buf: new Float32Array(Math.round(d * SR)), i: 0 }));
  const out = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = x[n] + c.g * y;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    s *= 0.25;
    for (const a of aps) {
      const b = a.buf[a.i];
      const y = -0.7 * s + b;
      a.buf[a.i] = s + 0.7 * y;
      a.i = (a.i + 1) % a.buf.length;
      s = y;
    }
    out[n] = x[n] + wet * s;
  }
  return out;
}

function finish(x, rng, noiseDb = -62) {
  const y = reverb(x, 0.35);
  const nAmp = 10 ** (noiseDb / 20) * Math.sqrt(3);
  for (let i = 0; i < y.length; i++) y[i] += nAmp * (rng() * 2 - 1);
  return y;
}

// ------------------------------------------------------------- music bits

const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Plays [midi | midi[], beats] events with optional human imperfections. */
function perform(out, t0, events, bpm, rng, opts = {}) {
  const { jitter = 0.03, wrong = 0, hesitate = 0, vel = 0.25, legato = 0.95, pedal = false } = opts;
  const beat = 60 / bpm;
  let t = t0;
  out.soundEnd = out.soundEnd || 0;
  for (const [notes, beats] of events) {
    if (hesitate && rng() < hesitate) t += 0.6 + 0.9 * rng();
    const dur = beats * beat;
    const list = Array.isArray(notes) ? notes : [notes];
    for (const m of list) {
      if (m == null) continue;
      let midi = m;
      if (wrong && rng() < wrong) midi += rng() < 0.5 ? -1 : 1;
      const held = pedal ? dur * 2.5 : dur * legato;
      addPianoNote(out, t + rng.gauss() * 0.006, midi, held, vel * (0.75 + 0.5 * rng()), rng);
      out.soundEnd = Math.max(out.soundEnd, t + held);
    }
    t += dur * (1 + rng.gauss() * jitter);
  }
  return t;
}

function scaleEvents(startMidi, octaves, beats) {
  const up = [];
  for (let o = 0; o < octaves; o++) for (const s of C_MAJOR) up.push(startMidi + 12 * o + s);
  up.push(startMidi + 12 * octaves);
  const down = up.slice(0, -1).reverse();
  return [...up, ...down].map((m) => [m, beats]);
}

const ODE_RH = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, null,
  64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60, null];

function odeEvents(withLeftHand) {
  const ev = [];
  ODE_RH.forEach((m, i) => {
    const bar = Math.floor(i / 4);
    const lh = withLeftHand && i % 4 === 0 ? [[48, 43, 48, 43, 48, 43, 43, 48][bar % 8]] : [];
    ev.push([[m, ...lh], 1]);
  });
  return ev;
}

const FUR_ELISE = [
  [76, 0.5], [75, 0.5], [76, 0.5], [75, 0.5], [76, 0.5], [71, 0.5], [74, 0.5], [72, 0.5],
  [[69, 45], 1], [52, 0.5], [57, 0.5], [60, 0.5], [64, 0.5], [69, 0.5],
  [[71, 40], 1], [52, 0.5], [56, 0.5], [64, 0.5], [68, 0.5], [71, 0.5],
  [[72, 45], 1], [52, 0.5], [57, 0.5], [64, 0.5],
];

function chordEvents() {
  const prog = [[48, 60, 64, 67], [53, 60, 65, 69], [55, 59, 62, 67], [48, 60, 64, 67],
    [45, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 65], [48, 55, 64, 72]];
  const ev = [];
  for (const ch of prog) {
    ev.push([ch, 1]);
    ev.push([[ch[0] + 12, ch[3]], 0.5]);
    ev.push([[ch[2]], 0.5]);
  }
  return ev;
}

// --------------------------------------------------------------- scenarios

const LEAD = 2; // seconds of room noise before anything happens

const SCENARIOS = [
  {
    id: 'scale-beginner', expect: 'count',
    desc: 'C-major scale, slow & hesitant, 10 % wrong notes',
    build(out, rng) {
      let t = LEAD;
      for (let r = 0; r < 3; r++) t = perform(out, t, scaleEvents(60, 1, 1), 66, rng, { jitter: 0.15, wrong: 0.1, hesitate: 0.12 });
      return [[LEAD, t]];
    },
  },
  {
    id: 'ode', expect: 'count',
    desc: 'Ode to Joy, right hand + left-hand bass',
    build(out, rng) {
      let t = LEAD;
      for (let r = 0; r < 2; r++) t = perform(out, t, odeEvents(true), 96, rng, { jitter: 0.06 });
      return [[LEAD, t]];
    },
  },
  {
    id: 'ode-slow-rh', expect: 'count',
    desc: 'Ode to Joy, right hand only, very slow beginner',
    build(out, rng) {
      let t = LEAD;
      for (let r = 0; r < 2; r++) t = perform(out, t, odeEvents(false), 52, rng, { jitter: 0.2, wrong: 0.08, hesitate: 0.1 });
      return [[LEAD, t]];
    },
  },
  {
    id: 'fur-elise', expect: 'count',
    desc: 'Für Elise opening, both hands, pedal',
    build(out, rng) {
      let t = LEAD;
      for (let r = 0; r < 4; r++) t = perform(out, t, FUR_ELISE, 120, rng, { jitter: 0.08, pedal: true });
      return [[LEAD, t]];
    },
  },
  {
    id: 'chords-pedal', expect: 'count',
    desc: 'Chord progression, broken chords, sustain pedal',
    build(out, rng) {
      let t = LEAD;
      for (let r = 0; r < 3; r++) t = perform(out, t, chordEvents(), 76, rng, { jitter: 0.05, pedal: true });
      return [[LEAD, t]];
    },
  },
  {
    id: 'fast-scales', expect: 'count',
    desc: '2-octave scales in sixteenths (~7 notes/s)',
    build(out, rng) {
      let t = LEAD;
      for (let r = 0; r < 5; r++) t = perform(out, t, scaleEvents(60, 2, 0.25), 104, rng, { jitter: 0.04 });
      return [[LEAD, t]];
    },
  },
  {
    id: 'chromatic', expect: 'count',
    desc: 'Chromatic scale exercise in eighths',
    build(out, rng) {
      const ev = [];
      for (let m = 60; m <= 72; m++) ev.push([m, 0.5]);
      for (let m = 71; m > 60; m--) ev.push([m, 0.5]);
      let t = LEAD;
      for (let r = 0; r < 4; r++) t = perform(out, t, ev, 84, rng, { jitter: 0.05 });
      return [[LEAD, t]];
    },
  },
  {
    id: 'with-pauses', expect: 'count',
    desc: 'Ode, 2.5 s page-turn pause, then a 9 s break',
    build(out, rng) {
      let t = perform(out, LEAD, odeEvents(true), 96, rng);
      t = perform(out, t + 2.5, odeEvents(true), 96, rng);
      const b = t;
      t = perform(out, t + 9, odeEvents(true), 96, rng);
      return [[LEAD, b], [b + 9, t]];
    },
  },
  {
    id: 'random-notes', expect: 'reject',
    desc: 'Random single notes over 4 octaves, random timing',
    build(out, rng) {
      for (let t = LEAD; t < 40; t += -Math.log(1 - rng()) / 3) addPianoNote(out, t, rng.int(36, 84), 0.4, 0.25 * (0.6 + 0.8 * rng()), rng);
      return [];
    },
  },
  {
    id: 'random-octave', expect: 'reject',
    desc: 'Random notes within one octave, steady pulse',
    build(out, rng) {
      for (let t = LEAD; t < 40; t += 0.3 + 0.1 * rng()) addPianoNote(out, t, rng.int(60, 72), 0.3, 0.25, rng);
      return [];
    },
  },
  {
    id: 'mash-clusters', expect: 'reject',
    desc: 'Key-mashing clusters (3–7 keys at once)',
    build(out, rng) {
      for (let t = LEAD; t < 40; t += 0.15 + 0.45 * rng()) {
        const base = rng.int(36, 80);
        const k = rng.int(3, 7);
        for (let i = 0; i < k; i++) addPianoNote(out, t + 0.01 * rng(), base + rng.int(0, 10), 0.3, 0.12, rng);
      }
      return [];
    },
  },
  {
    id: 'mash-two-hands', expect: 'reject',
    desc: 'Two-handed banging, wide random registers',
    build(out, rng) {
      for (let t = LEAD; t < 40; t += 0.12 + 0.25 * rng()) {
        const base = rng.int(30, 90);
        for (let i = 0; i < rng.int(1, 4); i++) addPianoNote(out, t, base + rng.int(0, 5), 0.2, 0.2, rng);
      }
      return [];
    },
  },
  {
    id: 'speech-male', expect: 'reject',
    desc: 'Talking (synthetic voice, ~120 Hz)',
    build(out, rng) {
      addSpeech(out, LEAD, 38, 120, rng);
      return [];
    },
  },
  {
    id: 'speech-female', expect: 'reject',
    desc: 'Talking (synthetic voice, ~210 Hz)',
    build(out, rng) {
      addSpeech(out, LEAD, 38, 210, rng);
      return [];
    },
  },
  {
    id: 'clapping', expect: 'reject',
    desc: 'Clapping / knocking',
    build(out, rng) {
      for (let t = LEAD; t < 40; t += 0.3 + 0.4 * rng()) addClap(out, t, 0.6, rng);
      return [];
    },
  },
  {
    id: 'held-note', expect: 'reject',
    desc: 'One chord struck and held every 8 s',
    build(out, rng) {
      for (let t = LEAD; t < 40; t += 8) for (const m of [48, 60, 64, 67]) addPianoNote(out, t, m, 7.5, 0.2, rng);
      return [];
    },
  },
  {
    id: 'silence', expect: 'reject',
    desc: 'Room noise only',
    build() {
      return [];
    },
  },
];

// ------------------------------------------------------------------- run

function render(sc, seed) {
  const rng = rngFrom(seed);
  const out = new Float32Array(SR * 120);
  const spans = sc.build(out, rng);
  // Count until the last note stops sounding (sustain-pedal ring-out is still playing).
  if (spans.length && out.soundEnd) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], out.soundEnd);
  const end = spans.length ? Math.max(...spans.map((s) => s[1])) + 4 : 42;
  const audio = finish(out.subarray(0, Math.round(end * SR)), rng);
  return { audio, spans };
}

function run(sc, seed, trace, config = CONFIG, rendered = render(sc, seed)) {
  const { audio, spans } = rendered;
  const det = new PracticeDetector(config, SR);
  const chunk = 1024;
  let counted = 0;
  const acc = { tonality: 0, activity: 0, key: 0, melody: 0, rhythm: 0, score: 0, n: 0 };
  const peak = { tonality: 0, activity: 0, key: 0, melody: 0, rhythm: 0 };
  let maxScore = 0;
  let nextTrace = 1;
  for (let i = 0; i + chunk <= audio.length; i += chunk) {
    counted += det.process(audio.subarray(i, i + chunk));
    const s = det.snapshot;
    maxScore = Math.max(maxScore, s.score);
    const inside = spans.length ? spans.some(([a, b]) => s.time >= a + 2 && s.time <= b) : s.time > LEAD + 7;
    if (inside) {
      for (const k of ['tonality', 'activity', 'key', 'melody', 'rhythm']) {
        acc[k] += s.sub[k];
        peak[k] = Math.max(peak[k], s.sub[k]);
      }
      acc.score += s.score;
      acc.n++;
    }
    if (trace && s.time >= nextTrace) {
      nextTrace += 1;
      const m = s.metrics;
      console.log(
        `${s.time.toFixed(0).padStart(3)}s ${s.state.padEnd(7)} score ${s.score.toFixed(2)} | ` +
          `ton ${s.sub.tonality.toFixed(2)} act ${s.sub.activity.toFixed(2)} key ${s.sub.key.toFixed(2)} ` +
          `mel ${s.sub.melody.toFixed(2)} rhy ${s.sub.rhythm.toFixed(2)} | ` +
          `db ${m.db.toFixed(0)} floor ${m.floorDb.toFixed(0)} stable ${m.stableFrac.toFixed(2)} R ${m.tuningR.toFixed(2)} ` +
          `pof ${m.pitchedOnsetFrac.toFixed(2)} rate ${m.onsetRate.toFixed(1)} ${m.keyName} fit ${m.keyFit.toFixed(2)}/${m.keyNotes} ` +
          `melF ${m.melodyFrac.toFixed(2)}/${m.intervals} rhyF ${m.rhythmFrac.toFixed(2)} pitch ${m.pitch}`,
      );
    }
  }
  const expected = spans.reduce((a, [x, y]) => a + (y - x), 0);
  for (const k of Object.keys(acc)) if (k !== 'n') acc[k] = acc.n ? acc[k] / acc.n : 0;
  return { counted, expected, acc, peak, maxScore, audio };
}

function writeWav(file, audio) {
  const buf = Buffer.alloc(44 + audio.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + audio.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(audio.length * 2, 40);
  for (let i = 0; i < audio.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

function main() {
  const args = process.argv.slice(2);
  const traceId = args.includes('--trace') ? args[args.indexOf('--trace') + 1] : null;
  const wavDir = args.includes('--wav') ? args[args.indexOf('--wav') + 1] : null;
  const seeds = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 1;
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  if (wavDir) fs.mkdirSync(wavDir, { recursive: true });

  if (traceId) {
    const sc = SCENARIOS.find((s) => s.id === traceId);
    if (!sc) throw new Error(`unknown scenario ${traceId}`);
    run(sc, args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : 1, true);
    return;
  }

  console.log('scenario          expect  counted / expected   ton  act  key  mel  rhy  score(max)  ok');
  let failures = 0;
  for (const sc of SCENARIOS.filter((s) => !only || s.id === only)) {
    for (let seed = 1; seed <= seeds; seed++) {
      const r = run(sc, seed, false);
      if (wavDir && seed === 1) writeWav(path.join(wavDir, `${sc.id}.wav`), r.audio);
      const ok =
        sc.expect === 'count'
          ? Math.abs(r.counted - r.expected) <= Math.max(3, 0.12 * r.expected)
          : r.counted <= 2;
      if (!ok) failures++;
      const a = r.acc;
      console.log(
        `${sc.id.padEnd(17)} ${sc.expect.padEnd(6)} ${r.counted.toFixed(1).padStart(6)} / ${r.expected.toFixed(1).padStart(5)}` +
          `        ${a.tonality.toFixed(2)} ${a.activity.toFixed(2)} ${a.key.toFixed(2)} ${a.melody.toFixed(2)} ${a.rhythm.toFixed(2)}` +
          `  ${a.score.toFixed(2)} (${r.maxScore.toFixed(2)})  ${ok ? '✓' : '✗'}`,
      );
    }
  }
  console.log(failures ? `\n${failures} scenario(s) outside tolerance` : '\nall scenarios within tolerance');
  process.exitCode = failures ? 1 : 0;
}

if (require.main === module) main();
module.exports = { SCENARIOS, render, run };
