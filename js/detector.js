/*
 * Piano Practice — "is this real playing?" detector.
 *
 * Feed it raw microphone samples; it returns how many seconds of *active
 * playing* to credit. No DOM access, so it also runs under Node (see
 * tools/simulate.js).
 *
 * Every hop (~21 ms):
 *   level (dB) + adaptive noise floor
 *   spectral flux             -> note onsets
 *   YIN pitch + aperiodicity  -> pitched frames, stable pitch runs, note pitches
 * Over rolling windows:
 *   tonality  stable pitch, tuned to one semitone grid, pitched onsets
 *             (gate: rejects talking, clapping, noise)
 *   activity  onset rate (gate: silence and one held note score 0)
 *   key       likelihood that the notes' pitch classes come from one
 *             diatonic key rather than at random
 *   melody    share of steps and small leaps between successive notes
 *   rhythm    share of inter-onset intervals in simple ratios
 * score = (strongest of key/melody, plus a little of the other, plus rhythm)
 *         × activity × tonality gate, smoothed. A hysteresis state machine
 *         with a pause grace then decides what is counted.
 */
(function (root) {
  'use strict';

  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const TWO_PI = Math.PI * 2;

  // ---------------------------------------------------------------- helpers

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  /** Smooth 0..1 ramp of x over [lo, hi]. */
  function ramp(x, range) {
    const t = clamp01((x - range[0]) / (range[1] - range[0]));
    return t * t * (3 - 2 * t);
  }

  /** Pull a score toward a neutral 0.5 when it rests on too few samples. */
  function shrink(score, n, minEvidence) {
    if (n >= minEvidence) return score;
    const w = n / minEvidence;
    return w * score + (1 - w) * 0.5;
  }

  function median(values) {
    if (!values.length) return 0;
    const s = Array.from(values).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  function pitchClass(midi) {
    return ((Math.round(midi) % 12) + 12) % 12;
  }

  function midiName(midi) {
    const m = Math.round(midi);
    return NOTE_NAMES[pitchClass(m)] + (Math.floor(m / 12) - 1);
  }

  // Centred, rotated Krumhansl–Kessler profiles (used to name the key).
  const KEY_PROFILES = (function () {
    const out = [];
    for (const [suffix, base] of [[' major', KK_MAJOR], [' minor', KK_MINOR]]) {
      const mean = base.reduce((a, b) => a + b, 0) / 12;
      for (let tonic = 0; tonic < 12; tonic++) {
        const p = new Float32Array(12);
        let norm = 0;
        for (let i = 0; i < 12; i++) {
          p[(i + tonic) % 12] = base[i] - mean;
          norm += (base[i] - mean) ** 2;
        }
        out.push({ name: NOTE_NAMES[tonic] + suffix, p, norm: Math.sqrt(norm) });
      }
    }
    return out;
  })();

  /** Best Krumhansl–Kessler match for a pitch-class histogram. */
  function nameKey(hist) {
    let mean = 0;
    for (let i = 0; i < 12; i++) mean += hist[i];
    mean /= 12;
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += (hist[i] - mean) ** 2;
    if (norm === 0) return { name: '–', r: 0 };
    norm = Math.sqrt(norm);
    let best = { name: '–', r: -1 };
    for (const kp of KEY_PROFILES) {
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += (hist[i] - mean) * kp.p[i];
      const r = dot / (norm * kp.norm);
      if (r > best.r) best = { name: kp.name, r };
    }
    return best;
  }

  // ------------------------------------------------------------------- FFT

  /** In-place iterative radix-2 complex FFT with precomputed tables. */
  class FFT {
    constructor(n) {
      this.n = n;
      const levels = Math.round(Math.log2(n));
      if (1 << levels !== n) throw new Error('FFT size must be a power of two');
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cos[i] = Math.cos((TWO_PI * i) / n);
        this.sin[i] = Math.sin((TWO_PI * i) / n);
      }
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
        this.rev[i] = r;
      }
    }

    transform(re, im) {
      const { n, cos, sin, rev } = this;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = im[l] * cos[k] - re[l] * sin[k];
            re[l] = re[j] - tre;
            im[l] = im[j] - tim;
            re[j] += tre;
            im[j] += tim;
          }
        }
      }
    }
  }

  /** YIN (de Cheveigné & Kawahara 2002) with parabolic refinement. */
  function yin(x, W, tauMin, tauMax, threshold, d) {
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = x[j] - x[j + tau];
        s += v * v;
      }
      d[tau] = s;
    }
    d[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      tau = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[tau]) tau = t;
    }
    let refined = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1];
      const b = d[tau];
      const c = d[tau + 1];
      const den = a - 2 * b + c;
      if (den > 0) refined = tau + (0.5 * (a - c)) / den;
    }
    return { tau: refined, aper: d[tau] };
  }

  // ------------------------------------------------------- frame analysis

  /** Per-hop features from the most recent samples. */
  class FrameAnalyzer {
    constructor(cfg, sampleRate) {
      const p = cfg.pitch;
      this.cfg = cfg;
      this.sr = sampleRate;
      this.hop = cfg.analysis.hopSize;
      this.Nf = cfg.analysis.fftSize;

      // YIN runs on a decimated copy to keep it cheap.
      this.dec = sampleRate >= 64000 ? 4 : sampleRate >= 32000 ? 2 : 1;
      this.ysr = sampleRate / this.dec;
      this.tauMin = Math.max(2, Math.floor(this.ysr / p.maxHz));
      this.tauMax = Math.ceil(this.ysr / p.minHz);
      this.yW = this.tauMax;
      this.ybuf = new Float32Array(this.yW + this.tauMax + 1);
      this.yd = new Float32Array(this.tauMax + 2);

      // Note pitch compares spectra just before and just after each attack, so
      // keep enough history to reach back past the attack once the note is read.
      const np = cfg.notePitch;
      this.Np = np.fftSize;
      this.afterDelay = Math.round((np.afterDelayMs / 1000) * sampleRate);
      this.beforeGap = Math.round((np.beforeGapMs / 1000) * sampleRate);
      const history = this.Nf / 2 + (np.waitFrames + 1) * this.hop + this.beforeGap + this.Np;
      this.N = Math.max(this.Nf, this.ybuf.length * this.dec, 2 * this.hop, history);
      this.buf = new Float32Array(this.N);
      this.count = 0; // samples pushed so far (absolute index of buf[N] )

      this.fftP = new FFT(this.Np);
      this.reP = new Float32Array(this.Np);
      this.imP = new Float32Array(this.Np);
      this.specA = new Float32Array(this.Np / 2);
      this.specB = new Float32Array(this.Np / 2);
      this.salience = new Float32Array(np.maxMidi + 1);

      this.fft = new FFT(this.Nf);
      this.re = new Float32Array(this.Nf);
      this.im = new Float32Array(this.Nf);
      this.win = new Float32Array(this.Nf);
      for (let i = 0; i < this.Nf; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / this.Nf);
      this.logMag = new Float32Array(this.Nf / 2 + 1);
      this.k0 = Math.max(1, Math.floor((30 * this.Nf) / sampleRate));
      this.k1 = Math.min(this.Nf / 2 - 1, Math.floor((8000 * this.Nf) / sampleRate));
      this.reset();
    }

    reset() {
      this.buf.fill(0);
      this.logMag.fill(0);
      this.count = 0;
    }

    push(samples) {
      const n = samples.length;
      this.buf.copyWithin(0, n);
      this.buf.set(samples, this.N - n);
      this.count += n;
    }

    /**
     * Pitch of the note struck at absolute sample `attack`, using only audio
     * before `end`. The spectrum before the attack is subtracted from the one
     * after it, so notes still ringing (pedal, overlapping notes) drop out and
     * the new note's partials remain; harmonic summation over semitone
     * candidates then picks its pitch. Returns { midi, salience } or null.
     */
    onsetPitch(attack, end, offset) {
      const np = this.cfg.notePitch;
      const base = this.count - this.N;
      const a0 = attack + this.afterDelay;
      const a1 = Math.min(end, this.count, a0 + this.Np);
      if (a1 - a0 < this.Np / 4) return null;
      const b1 = attack - this.beforeGap;
      const b0 = Math.max(base, b1 - this.Np);
      const A = this._spectrum(a0 - base, a1 - base, this.specA);
      const B = b1 - b0 >= this.Np / 4 ? this._spectrum(b0 - base, b1 - base, this.specB) : null;
      if (B) for (let k = 0; k < A.length; k++) A[k] = Math.sqrt(Math.max(0, A[k] - B[k]));
      else for (let k = 0; k < A.length; k++) A[k] = Math.sqrt(A[k]);

      const binHz = this.sr / this.Np;
      const kMax = Math.min(A.length - 2, Math.floor(np.maxPartialHz / binHz));
      const S = this.salience;
      let best = -1;
      let sum = 0;
      for (let m = np.minMidi; m <= np.maxMidi; m++) {
        const f0 = 440 * 2 ** ((m - 69 + offset) / 12);
        let s = 0;
        for (let h = 1; h <= np.harmonics; h++) {
          const k = (h * f0) / binHz;
          if (k > kMax) break;
          const tol = Math.max(1, k * np.harmonicTolerance);
          let peak = 0;
          for (let j = Math.max(1, Math.floor(k - tol)), j1 = Math.ceil(k + tol); j <= j1; j++) if (A[j] > peak) peak = A[j];
          s += peak * np.harmonicWeights[h - 1];
        }
        S[m] = s;
        sum += s;
        if (best < 0 || s > S[best]) best = m;
      }
      const mean = sum / (np.maxMidi - np.minMidi + 1);
      if (!(mean > 0)) return null;
      return { midi: best + offset, salience: S[best] / mean };
    }

    /** Amplitude spectrum of buf[i0, i1), Hann-windowed and zero-padded to Np. */
    _spectrum(i0, i1, out) {
      const { reP, imP, buf } = this;
      const L = i1 - i0;
      reP.fill(0);
      imP.fill(0);
      for (let j = 0; j < L; j++) reP[j] = buf[i0 + j] * (0.5 - 0.5 * Math.cos((TWO_PI * j) / L));
      this.fftP.transform(reP, imP);
      const scale = 4 / L;
      for (let k = 0; k < out.length; k++) out[k] = Math.hypot(reP[k], imP[k]) * scale;
      return out;
    }

    /** @param {number} pitchMinDb  YIN is skipped for frames quieter than this. */
    analyze(pitchMinDb) {
      const { N, Nf, buf } = this;

      // Level of the most recent two hops.
      let e = 0;
      for (let i = N - 2 * this.hop; i < N; i++) e += buf[i] * buf[i];
      const db = 10 * Math.log10(e / (2 * this.hop) + 1e-12);

      // Spectral flux: summed rise of the log-compressed spectrum.
      const { re, im, win, logMag } = this;
      for (let i = 0, j = N - Nf; i < Nf; i++, j++) {
        re[i] = buf[j] * win[i];
        im[i] = 0;
      }
      this.fft.transform(re, im);
      const scale = 4 / Nf; // a full-scale sine peaks at 1
      const gamma = this.cfg.onset.fluxGamma;
      let flux = 0;
      for (let k = this.k0; k <= this.k1; k++) {
        const l = Math.log(1 + gamma * scale * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        if (l > logMag[k]) flux += l - logMag[k];
        logMag[k] = l;
      }
      flux /= this.k1 - this.k0 + 1;

      // YIN pitch.
      let midi = NaN;
      let aper = 1;
      if (db > pitchMinDb) {
        const { dec, ybuf, yW, tauMax } = this;
        const len = ybuf.length;
        for (let i = 0, j = N - len * dec; i < len; i++, j += dec) {
          let s = 0;
          for (let q = 0; q < dec; q++) s += buf[j + q];
          ybuf[i] = s / dec;
        }
        const r = yin(ybuf, yW, this.tauMin, tauMax, this.cfg.pitch.yinThreshold, this.yd);
        aper = r.aper;
        midi = 69 + 12 * Math.log2(this.ysr / r.tau / 440);
      }
      return { db, flux, midi, aper };
    }
  }

  // -------------------------------------------------------------- detector

  class PracticeDetector {
    constructor(config, sampleRate) {
      this.cfg = config;
      this.sr = sampleRate;
      this.hop = config.analysis.hopSize;
      this.dt = this.hop / sampleRate;
      this.analyzer = new FrameAnalyzer(config, sampleRate);
      this.stage = new Float32Array(this.hop);
      this.fluxHistLen = Math.max(3, Math.round(config.onset.medianWindowSec / this.dt));
      this.reset();
    }

    /** Forget everything heard so far (call when (re)starting listening). */
    reset() {
      this.analyzer.reset();
      this.stageFill = 0;
      this.t = 0;
      this.frames = []; // short window: { t, sounding, stable }
      this.notes = []; // short window: onsets { t, midi, pitched, done }
      this.keyNotes = []; // key window: pitched onsets
      this.runs = []; // key window: stable pitch runs { tEnd, ref }
      this.run = null;
      this.openNote = null;
      this.floorDb = this.cfg.level.initialFloorDb;
      this.fluxHist = [];
      this.prevFlux = 0;
      this.prevPrevFlux = 0;
      this.prevFrame = null;
      this.lastOnsetT = -Infinity;
      this.tuningOffset = 0;
      this.lastPitch = NaN;
      this.score = 0;
      this.pitchedNoteCount = 0;
      this.state = 'idle';
      this.lastSoundT = -Infinity;
      this.runStartT = 0;
      this.lastExitT = -Infinity;
      this.silentCounted = 0;
      this.snapshot = {
        time: 0,
        state: 'idle',
        score: 0,
        raw: 0,
        sub: { tonality: 0, activity: 0, key: 0, melody: 0, rhythm: 0 },
        metrics: {},
      };
    }

    /**
     * Feed any number of mono samples. Returns the seconds of active playing
     * to add to the session (negative when a trailing pause is taken back).
     */
    process(samples) {
      let credit = 0;
      for (let i = 0; i < samples.length;) {
        const n = Math.min(this.hop - this.stageFill, samples.length - i);
        this.stage.set(samples.subarray(i, i + n), this.stageFill);
        this.stageFill += n;
        i += n;
        if (this.stageFill === this.hop) {
          this.analyzer.push(this.stage);
          this.stageFill = 0;
          credit += this._step();
        }
      }
      return credit;
    }

    get playing() {
      return this.state === 'playing';
    }

    // ---- per-hop work

    _step() {
      const cfg = this.cfg;
      this.t += this.dt;
      const t = this.t;

      const soundThr = Math.max(this.floorDb + cfg.level.soundMarginDb, cfg.level.minSoundDb);
      const f = this.analyzer.analyze(soundThr);
      this._trackFloor(f.db);

      const sounding = f.db > soundThr;
      const pitched = sounding && f.aper < cfg.pitch.pitchedMax;
      const frame = { t, db: f.db, sounding, pitched, midi: pitched ? f.midi : NaN, stable: false };
      if (pitched) this.lastPitch = f.midi;

      this._trackRun(frame);
      this._detectOnset(frame, f.flux, soundThr);
      this._captureNotePitch();

      this.frames.push(frame);
      const horizon = t - cfg.window.seconds;
      while (this.frames.length && this.frames[0].t < horizon) this.frames.shift();
      while (this.notes.length && this.notes[0].t < horizon) this.notes.shift();
      const keyHorizon = t - cfg.window.keySeconds;
      while (this.runs.length && this.runs[0].tEnd < keyHorizon) this.runs.shift();
      while (this.keyNotes.length && this.keyNotes[0].t < keyHorizon) this.keyNotes.shift();

      if (pitched) {
        if (t - this.lastSoundT > cfg.state.pauseGraceSec) this.runStartT = t;
        this.lastSoundT = t;
      }

      this._computeScores(soundThr, f);
      return this._updateState();
    }

    /** Noise floor: follows quiet frames down quickly, creeps up slowly. */
    _trackFloor(db) {
      const lv = this.cfg.level;
      if (db < this.floorDb) this.floorDb += (db - this.floorDb) * 0.3;
      else this.floorDb += Math.min(db - this.floorDb, lv.floorRiseDbPerSec * this.dt);
      if (this.floorDb > lv.maxFloorDb) this.floorDb = lv.maxFloorDb;
    }

    /** Group consecutive pitched frames holding one pitch (octave slips tolerated). */
    _trackRun(frame) {
      const pc = this.cfg.pitch;
      if (!frame.pitched) {
        this.run = null;
        return;
      }
      const r = this.run;
      let diff = r ? frame.midi - r.ref : Infinity;
      diff -= 12 * Math.round(diff / 12);
      if (!r || Math.abs(diff) * 100 > pc.stableCents) {
        this.run = { ref: frame.midi, count: 1, pending: [frame], summary: null };
        return;
      }
      r.count++;
      r.ref += diff / r.count;
      if (r.summary) {
        frame.stable = true;
        r.summary.tEnd = frame.t;
        r.summary.ref = r.ref;
      } else if (r.count < pc.stableMinFrames) {
        r.pending.push(frame);
      } else {
        for (const fr of r.pending) fr.stable = true;
        frame.stable = true;
        r.pending = null;
        r.summary = { tEnd: frame.t, ref: r.ref };
        this.runs.push(r.summary);
      }
    }

    _detectOnset(frame, flux, soundThr) {
      const oc = this.cfg.onset;
      const h = this.fluxHist;
      h.push(flux);
      if (h.length > this.fluxHistLen) h.shift();
      const prev = this.prevFrame;
      const peak = this.prevFlux;
      if (prev && peak > this.prevPrevFlux && peak >= flux) {
        const thr = median(h) * oc.thresholdFactor + oc.thresholdDelta;
        const loud = prev.db > soundThr || frame.db > soundThr;
        if (peak > thr && loud && prev.t - this.lastOnsetT >= oc.minIntervalSec) {
          // Sub-hop onset time from a parabola through the flux peak.
          const a = this.prevPrevFlux;
          const den = a - 2 * peak + flux;
          const t = prev.t + (den < 0 ? (0.5 * (a - flux)) / den : 0) * this.dt;
          // The flux peaks when the attack sits mid-window.
          const attack = Math.round(t * this.sr - this.analyzer.Nf / 2);
          if (this.openNote) this._finalizeNote(this.openNote, attack - this.analyzer.beforeGap);
          const note = { t, attack, midi: NaN, pitched: false, done: false, age: 0 };
          this.notes.push(note);
          this.openNote = note;
          this.lastOnsetT = t;
        }
      }
      this.prevPrevFlux = this.prevFlux;
      this.prevFlux = flux;
      this.prevFrame = frame;
    }

    _captureNotePitch() {
      const n = this.openNote;
      if (!n) return;
      n.age++;
      if (n.age >= this.cfg.notePitch.waitFrames) this._finalizeNote(n, Infinity);
    }

    /** Decide the pitch of a note from audio up to absolute sample `end`. */
    _finalizeNote(n, end) {
      const p = this.analyzer.onsetPitch(n.attack, end, this.tuningOffset);
      if (p && p.salience >= this.cfg.notePitch.minSalience) {
        n.midi = p.midi;
        n.pitched = true;
        this.keyNotes.push(n);
      }
      n.salience = p ? p.salience : 0;
      n.done = true;
      if (this.openNote === n) this.openNote = null;
    }

    // ---- window scores

    _computeScores(soundThr, f) {
      const cfg = this.cfg;
      const sc = cfg.scores;
      const grace = cfg.state.pauseGraceSec;
      const me = sc.minEvidence;

      // Stability: share of sounding frames inside stable pitch runs.
      let sounding = 0;
      let stable = 0;
      for (const fr of this.frames) {
        if (!fr.sounding) continue;
        sounding++;
        if (fr.stable) stable++;
      }
      const stableFrac = sounding >= 10 ? stable / sounding : 0;

      // Tuning: instruments share one semitone grid, voices glide freely.
      let cs = 0;
      let sn = 0;
      for (const r of this.runs) {
        const dev = r.ref - Math.round(r.ref);
        cs += Math.cos(TWO_PI * dev);
        sn += Math.sin(TWO_PI * dev);
      }
      const nRuns = this.runs.length;
      const tuningR = nRuns ? Math.hypot(cs, sn) / nRuns : 0;
      if (nRuns >= 4) this.tuningOffset = Math.atan2(sn, cs) / TWO_PI;
      const off = this.tuningOffset;

      // Key: are the notes' pitch classes drawn from one diatonic scale
      // (allowing some chromatic / wrong notes) rather than at random?
      const pcHist = new Float32Array(12);
      for (const n of this.keyNotes) pcHist[pitchClass(n.midi - off)]++;
      const nKey = this.keyNotes.length;
      let inKey = 0;
      for (let tonic = 0; tonic < 12; tonic++) {
        let m = 0;
        for (const step of MAJOR_SCALE) m += pcHist[(tonic + step) % 12];
        if (m > inKey) inKey = m;
      }
      const out = sc.key.outOfKeyRate;
      const llr =
        inKey * Math.log((12 * (1 - out)) / 7) + (nKey - inKey) * Math.log((12 * out) / 5) - Math.log(12);
      const keyFit = nKey ? inKey / nKey : 0;
      const keyName = nKey >= 4 ? nameKey(pcHist).name : '–';

      // Notes.
      const done = this.notes.filter((n) => n.done);
      const pitchedNotes = done.filter((n) => n.pitched);
      const pof = done.length ? pitchedNotes.length / done.length : 0;
      const rate = this.notes.length / Math.max(1, Math.min(cfg.window.seconds, this.t));

      // Melody: interval from each note to the nearest of the last few notes.
      let melW = 0;
      let intervals = 0;
      const weights = sc.melody.intervalWeights;
      for (let i = 1; i < pitchedNotes.length; i++) {
        const b = pitchedNotes[i];
        if (b.t - pitchedNotes[i - 1].t > grace) continue;
        let d = Infinity;
        for (let j = i - 1; j >= Math.max(0, i - sc.melody.voices); j--) {
          d = Math.min(d, Math.abs(Math.round(b.midi - off) - Math.round(pitchedNotes[j].midi - off)));
        }
        melW += d < weights.length ? weights[d] : 0;
        intervals++;
      }
      const melFrac = intervals ? melW / intervals : 0;

      // Rhythm: is each inter-onset interval a simple ratio of the previous one?
      let hits = 0;
      let pairs = 0;
      let prevIoi = 0;
      const slack = 0.5 * this.dt; // onset times are only this precise
      for (let i = 1; i < this.notes.length; i++) {
        const ioi = this.notes[i].t - this.notes[i - 1].t;
        if (ioi > grace) {
          prevIoi = 0;
          continue;
        }
        if (prevIoi > 0) {
          for (const q of sc.rhythm.ratios) {
            const want = prevIoi * q;
            if (Math.abs(ioi - want) <= sc.rhythm.tolerance * Math.max(ioi, want) + slack) {
              hits++;
              break;
            }
          }
          pairs++;
        }
        prevIoi = ioi;
      }
      const rhythmFrac = pairs ? hits / pairs : 0;

      const ts = sc.tonality;
      const sub = this.snapshot.sub;
      sub.tonality =
        ts.weights[0] * ramp(stableFrac, ts.stableFrac) +
        ts.weights[1] * shrink(ramp(tuningR, ts.tuning), nRuns, 2 * me) +
        ts.weights[2] * shrink(ramp(pof, ts.pitchedOnsets), done.length, me);
      sub.activity = ramp(rate, sc.onsetRate);
      sub.key = 1 / (1 + Math.exp(-llr / sc.key.softness));
      sub.melody = shrink(ramp(melFrac, sc.melody.range), intervals, me);
      sub.rhythm = shrink(ramp(rhythmFrac, sc.rhythm.range), pairs, me);

      // Real music shows a clear key or a clearly stepwise line (or both).
      const w = sc.weights;
      const musical =
        (w.strongest * Math.max(sub.key, sub.melody) + w.other * Math.min(sub.key, sub.melody) + w.rhythm * sub.rhythm) /
        (w.strongest + w.other + w.rhythm);
      const raw = musical * sub.activity * ramp(sub.tonality, sc.tonalityGate);
      this.score += (1 - Math.exp(-this.dt / sc.smoothingSec)) * (raw - this.score);
      this.pitchedNoteCount = pitchedNotes.length;

      const s = this.snapshot;
      s.time = this.t;
      s.score = this.score;
      s.raw = raw;
      const m = s.metrics;
      m.db = f.db;
      m.floorDb = this.floorDb;
      m.soundThr = soundThr;
      m.pitch = Number.isFinite(this.lastPitch) ? midiName(this.lastPitch - off) : '–';
      m.aperiodicity = f.aper;
      m.stableFrac = stableFrac;
      m.tuningR = tuningR;
      m.tuningCents = off * 100;
      m.runs = nRuns;
      m.pitchedOnsetFrac = pof;
      m.notes = this.notes.length;
      m.pitchedNotes = pitchedNotes.length;
      m.onsetRate = rate;
      m.keyName = keyName;
      m.keyFit = keyFit;
      m.keyNotes = nKey;
      m.keyLLR = llr;
      m.melodyFrac = melFrac;
      m.intervals = intervals;
      m.rhythmFrac = rhythmFrac;
      m.rhythmPairs = pairs;
      m.gap = this.t - this.lastSoundT;
    }

    // ---- state machine & time accounting

    _updateState() {
      const st = this.cfg.state;
      const t = this.t;
      const gap = t - this.lastSoundT;
      let credit = 0;
      if (this.state === 'idle') {
        if (this.score >= st.enterScore && this.pitchedNoteCount >= st.minNotesToEnter && gap <= st.pauseGraceSec) {
          this.state = 'playing';
          // Credit the warm-up the window needed to become confident.
          credit = Math.max(0, Math.min(t - this.runStartT, t - this.lastExitT, st.retroCreditMaxSec));
          this.silentCounted = 0;
        }
      } else if (gap > st.pauseGraceSec) {
        this.state = 'idle';
        if (st.trimLongPauses) credit = -this.silentCounted;
        this.silentCounted = 0;
        this.lastExitT = t;
      } else if (this.score < st.exitScore) {
        this.state = 'idle';
        this.silentCounted = 0;
        this.lastExitT = t;
      } else {
        credit = this.dt;
        this.silentCounted = gap > 0 ? this.silentCounted + this.dt : 0;
      }
      this.snapshot.state = this.state;
      return credit;
    }
  }

  const api = { PracticeDetector, FrameAnalyzer, FFT, yin, midiName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PPDetector = api;
})(typeof self !== 'undefined' ? self : this);
