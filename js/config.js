/*
 * Piano Practice — detection & timing configuration.
 *
 * Every tunable threshold lives in this one object. Ranges written as
 * [lo, hi] map a raw measurement onto a 0..1 sub-score: at or below `lo`
 * scores 0, at or above `hi` scores 1, with a smooth ramp between.
 *
 * Tune with the debug panel (long-press the logo in the app): it shows the
 * raw measurements and sub-scores live while you play — or mash keys.
 * Offline check: `node tools/simulate.js` runs synthetic scenarios.
 */
(function (root) {
  'use strict';

  const CONFIG = {
    analysis: {
      fftSize: 2048,          // spectrum for onset detection (≈43 ms at 48 kHz)
      hopSize: 1024,          // analysis step in samples (≈21 ms at 48 kHz)
    },

    level: {
      // Background-noise floor: follows quiet frames down quickly, creeps up slowly.
      floorRiseDbPerSec: 0.5,
      initialFloorDb: -70,
      maxFloorDb: -42,        // never assume the room is louder than this (dBFS)
      soundMarginDb: 9,       // "sounding" = this many dB above the noise floor…
      minSoundDb: -68,        // …and never quieter than this (dBFS)
    },

    pitch: {
      minHz: 50,
      maxHz: 2000,
      yinThreshold: 0.2,      // YIN absolute threshold for picking the period
      pitchedMax: 0.3,        // a frame is pitched when YIN aperiodicity is below this
      stableCents: 30,        // a stable run holds its pitch within ± this many cents…
      stableMinFrames: 5,     // …for at least this many frames (≈100 ms)
    },

    onset: {
      fluxGamma: 1e5,         // log compression of the spectrum before flux
      medianWindowSec: 0.5,   // adaptive threshold = median of recent flux…
      thresholdFactor: 1.5,   // …times this…
      thresholdDelta: 0.04,   // …plus this
      minIntervalSec: 0.07,   // ignore onsets closer together than this
    },

    // Pitch of each struck note: spectrum after the attack minus spectrum
    // before it (so pedal / still-ringing notes drop out), then harmonic
    // summation over semitone candidates.
    notePitch: {
      fftSize: 8192,          // ≈170 ms: fine enough to separate low semitones
      beforeGapMs: 20,        // "before" spectrum ends this long before the attack
      afterDelayMs: 20,       // "after" spectrum starts this long after it (skips hammer noise)
      waitFrames: 9,          // read the pitch this many hops after the onset (≈190 ms)
      minMidi: 28,            // E1
      maxMidi: 100,           // E7
      maxPartialHz: 5000,
      harmonics: 10,
      harmonicWeights: [1, 0.66, 0.52, 0.44, 0.38, 0.34, 0.31, 0.29, 0.27, 0.25],
      harmonicTolerance: 0.03,// ± fraction of a partial's frequency (≈ half a semitone)
      minSalience: 2.2,       // best candidate vs. average candidate; lower = unpitched onset
    },

    window: {
      seconds: 7,             // activity, melody, rhythm, stability
      keySeconds: 14,         // key and tuning (a key lasts; random notes don't settle)
    },

    scores: {
      // Tonality — a gate. Pitched, stable and tuned like an instrument?
      // Rejects talking (gliding, untuned pitch), clapping and noise.
      tonality: {
        stableFrac: [0.15, 0.45],     // share of sounding frames in stable pitch runs
        tuning: [0.3, 0.65],          // coherence of pitches with one semitone grid (0..1)
        pitchedOnsets: [0.25, 0.65],  // share of onsets followed by a clear pitch
        weights: [0.3, 0.5, 0.2],     // stableFrac, tuning, pitchedOnsets
      },
      tonalityGate: [0.5, 0.75],      // the score is multiplied by this ramp of tonality

      // Activity — a gate. Notes per second in the window (no upper limit).
      onsetRate: [0.15, 0.5],

      // Key consistency: likelihood ratio "notes from one diatonic key" vs.
      // "random pitch classes", squashed to 0..1 (0.5 = no evidence either way).
      key: {
        outOfKeyRate: 0.12,           // chromatic / wrong notes a real piece may contain
        softness: 1.5,                // larger = gentler transition
      },

      // Melodic coherence: weighted share of "musical" intervals between notes.
      melody: {
        range: [0.55, 0.85],
        voices: 1,                    // compare each note with the nearest of this many previous notes
        // Weight per interval in semitones (index 0..12); larger leaps weigh 0.
        //               unis m2 M2 m3   M3   P4   TT P5   m6   M6   m7 M7 P8
        intervalWeights: [0.5, 1, 1, 0.6, 0.6, 0.4, 0, 0.3, 0.1, 0.1, 0, 0, 0.3],
      },

      // Rhythmic regularity: share of successive inter-onset intervals in simple ratios.
      rhythm: {
        range: [0.4, 0.8],
        ratios: [1, 2, 0.5, 1.5, 2 / 3],
        tolerance: 0.08,              // relative
      },

      // Score = strongest of (key, melody) + a little of the other + rhythm.
      // Pieces with chords/two hands show a clear key; chromatic exercises a
      // clear stepwise line; random notes show neither.
      weights: { strongest: 0.6, other: 0.2, rhythm: 0.2 },

      minEvidence: 3,                 // fewer samples than this pull a sub-score toward 0.5
      smoothingSec: 0.6,              // time constant of the score's smoothing
    },

    state: {
      enterScore: 0.55,       // start counting when the smoothed score rises above this
      exitScore: 0.4,         // stop counting when it falls below this
      minNotesToEnter: 4,     // pitched notes needed in the window before counting starts
      pauseGraceSec: 3.5,     // silences shorter than this keep counting (page turns, repeats)
      trimLongPauses: true,   // a longer silence is not counted at all (grace is taken back)
      retroCreditMaxSec: 7,   // on entering "playing", credit the warm-up already heard (max)
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
  else root.PP_CONFIG = CONFIG;
})(typeof self !== 'undefined' ? self : this);
