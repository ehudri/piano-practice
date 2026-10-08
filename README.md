# Practice — a piano practice timer that only counts real playing

A calm, single-screen web app for iPad. Tap **Start**, put the iPad on the music
stand and play. The big clock only moves while it hears actual piano playing.
Talking, silence, one held note, clapping, and random key-mashing don't count.
Slow, hesitant playing with wrong notes still counts.

- Big active-time clock, with a live **Listening / Playing** indicator
- Optional goal (10–60 min presets or custom). The ring fills with *active* time,
  and a soft chime and confetti mark the goal.
- Short pauses (page turns, going back to repeat a passage, up to 3.5 s) keep
  counting. Longer breaks stop the clock and aren't counted.
- Keeps the screen awake while listening
- **Today** and **This week** totals, saved on the device (no account, no server).
  Audio is analysed in the browser and never leaves the iPad.
- Works offline and opens full-screen from the Home Screen

Plain HTML/CSS/JS, no build step.

```
index.html              the single screen
css/styles.css          design (dark theme, one accent colour)
js/config.js            ← every detection threshold, in one object
js/detector.js          the "is this real playing?" analysis (no DOM; also runs in Node)
js/capture-worklet.js   microphone tap (AudioWorklet)
js/app.js               UI, sessions, storage, wake lock, chime
sw.js, manifest.webmanifest, icons/   offline + Add to Home Screen
tools/simulate.js       offline test bench with synthetic piano, mashing and speech
.github/workflows/pages.yml           deploys to GitHub Pages
```

## Publish with GitHub Pages

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Merge this work into `main` (or push to `main`). The **Deploy to GitHub Pages**
   workflow runs on every push to `main`. You can also start it from the
   **Actions** tab with **Run workflow**.
4. When it finishes, the site is at `https://<your-user>.github.io/piano-practice/`.
   The workflow run's summary also shows the link.

The workflow publishes only the app files. The README and `tools/` are left out.

## Use it on an iPad

1. Open the Pages URL in **Safari**. The microphone needs https, which Pages provides.
2. Tap **Share → Add to Home Screen**, then open **Practice** from the Home Screen.
   It opens full-screen and also works offline.
3. Tap **Start** and allow the microphone. Tap **Goal** to set a target if you
   want one.
4. Put the iPad on the music stand or nearby, and play.

Tips:

- **Stop the microphone prompt from coming back:** in Safari, tap **aA** (or
  the page settings button) → **Website Settings → Microphone → Allow**.
- **Screen stays on** through the Screen Wake Lock API: iPadOS 16.4+ in Safari,
  18.4+ when opened from the Home Screen. On older versions, set **Settings →
  Display & Brightness → Auto-Lock** to *Never* while you practise. If the iPad
  locks or you switch apps, the session pauses (iPadOS stops background
  microphones). Tap **Resume**.
- **Chime volume** follows the iPad's media volume.
- **Reset** finishes the session and adds it to your totals. An unfinished session
  is kept if the app is closed. It resumes the same day, and is filed into
  history on a later day.
- The first ~4–6 s of playing are needed to be sure. That time is added back
  once playing is recognised, so nothing is lost.

## How detection works

Every ~21 ms the detector measures loudness against an adaptive noise floor,
finds note onsets (spectral flux), and tracks pitch (YIN). For each note it
also finds the pitch of the newly struck note: it subtracts the spectrum just
before the attack from the one just after, so notes still ringing under the
pedal drop out, and then runs harmonic summation. Over a rolling window it
combines these into sub-scores:

| Sub-score | Question it answers | Rejects |
|---|---|---|
| **Tonality** (gate) | Is the sound pitched, stable, and tuned to one semitone grid like an instrument? | talking (gliding, untuned pitch), clapping, TV noise |
| **Activity** (gate) | Are notes being struck at a reasonable rate? | silence, one held note |
| **Key** | Do the notes' pitch classes fit one key? This is a likelihood ratio of "diatonic" vs. "random". | random notes, mashing |
| **Melody** | Are most intervals steps or small leaps? | jumping randomly around the keyboard |
| **Rhythm** | Are successive note gaps in simple ratios (1:1, 2:1)? | erratic timing (small weight) |

`score = (0.6 × stronger of key/melody + 0.2 × the other + 0.2 × rhythm) × activity × tonality gate`

Real pieces show a clear key, especially with chords or both hands. Scales and
chromatic exercises show a clear stepwise line. Random notes show neither.
Playing quality doesn't enter into it: wrong notes and uneven timing only nudge
the score. The smoothed score uses hysteresis. Counting starts above
`enterScore`, stops below `exitScore`, and stops after a silence longer than
`pauseGraceSec`.

## Tuning the thresholds

All thresholds are in **`js/config.js`**, with a comment on each.

**Debug panel:** long-press the **Practice** logo (or press `d` on a keyboard).
It shows a 30-second graph of the score with the enter/exit thresholds, the
sub-scores, and raw values: level and noise floor, detected pitch, notes per
second, tuning coherence, detected key and in-key share, melodic and rhythmic
shares. Play normally for a minute, then mash keys for a minute, and watch
which bars separate the two.

Common adjustments:

| Symptom | Look at | Try |
|---|---|---|
| Real playing isn't counted (stays *Listening*) | which bar is low | lower `state.enterScore` (e.g. 0.5) |
| …and **Tonality** is low | `tuning R` is low (out-of-tune piano?) or `stable` is low | lower `scores.tonality.tuning` to `[0.2, 0.5]`, or `scores.tonalityGate` to `[0.4, 0.65]` |
| …and **Activity** is low | very slow pieces | lower `scores.onsetRate` to `[0.1, 0.3]` |
| …in a quiet or distant setup | `level` close to `floor` | lower `level.soundMarginDb` (e.g. 6) |
| Atonal/chromatic music isn't counted | **Key** low and **Melody** low | lower `scores.melody.range`, or reduce `scores.key.outOfKeyRate` strictness by raising it |
| Mashing / noodling still counts | **Key** or **Rhythm** high during mashing | raise `state.enterScore` / `exitScore`, lower `scores.key.outOfKeyRate` |
| Counting stops during page turns | `since sound` exceeds the grace | raise `state.pauseGraceSec` |
| Clock keeps running too long after you stop | | lower `state.pauseGraceSec` |

**Offline check:** after changing thresholds, `node tools/simulate.js` runs
17 synthetic scenarios, including slow and hesitant scales, two-hand pieces
with pedal, chords, fast runs, a chromatic exercise, pauses, random notes,
clusters, two-handed banging, synthetic speech, clapping, a held chord, and
silence. It prints how many seconds each one was credited. Use
`--trace <scenario>` for per-second sub-scores, `--seeds 3` for more random
variations, and `--wav out/` to write the audio so you can listen to it. The
audio is synthetic, so treat it as a regression check. Final tuning is done
with a real piano and the debug panel.

## Run locally

Any static server works. The microphone needs `localhost` or https:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

To try it on an iPad before publishing, you need https, e.g. GitHub Pages or a
tunnel.
