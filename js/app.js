/*
 * Piano Practice — UI, microphone capture, sessions and storage.
 * Detection itself lives in detector.js; thresholds in config.js.
 */
(function () {
  'use strict';

  const CONFIG = window.PP_CONFIG;
  const { PracticeDetector } = window.PPDetector;

  const PRESETS = [10, 15, 20, 30, 45, 60];
  const CHUNK = CONFIG.analysis.hopSize;
  const KEYS = { sessions: 'pp.sessions.v1', current: 'pp.current.v1', goal: 'pp.goal.v1' };
  const MAX_SESSIONS = 2000;
  const RING_C = 2 * Math.PI * 92;
  const STATUS_TEXT = { ready: 'Ready', listening: 'Listening', playing: 'Playing', paused: 'Paused' };

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'),
    logo: $('logo'),
    today: $('today'),
    week: $('week'),
    dial: $('dial'),
    ringFill: $('ringFill'),
    statusText: $('statusText'),
    time: $('time'),
    goalText: $('goalText'),
    startBtn: $('startBtn'),
    startLabel: $('startLabel'),
    resetBtn: $('resetBtn'),
    goalBtn: $('goalBtn'),
    goalLabel: $('goalLabel'),
    sheet: $('goalSheet'),
    presets: $('presets'),
    customValue: $('customValue'),
    debug: $('debug'),
    dbgState: $('dbgState'),
    dbgSpark: $('dbgSpark'),
    dbgBars: $('dbgBars'),
    dbgMetrics: $('dbgMetrics'),
    confetti: $('confetti'),
    toast: $('toast'),
  };

  // ------------------------------------------------------------ storage

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode or storage full: the timer still works, it just won't remember.
    }
  }

  // -------------------------------------------------------------- state

  const state = {
    running: false,
    playing: false,
    active: 0, // seconds of active playing in this session
    startedAt: 0, // ms timestamp of the session's first Start
    goalMin: Number(load(KEYS.goal, 0)) || 0,
    celebrated: false,
  };
  let sessions = load(KEYS.sessions, []);
  if (!Array.isArray(sessions)) sessions = [];

  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function weekStart(ts) {
    const d = new Date(dayStart(ts));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start on Monday
    return d.getTime();
  }

  function archive(start, end, active, goalMin) {
    if (!(active >= 1)) return;
    sessions.push({ start, end, active: Math.round(active), goal: goalMin || 0 });
    if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);
    save(KEYS.sessions, sessions);
  }

  function persistCurrent() {
    if (state.active > 0 && state.startedAt) {
      save(KEYS.current, {
        startedAt: state.startedAt,
        active: state.active,
        goalMin: state.goalMin,
        updatedAt: Date.now(),
      });
    } else {
      save(KEYS.current, null);
    }
  }

  /** Continue today's unfinished session; file away one from an earlier day. */
  function restoreCurrent() {
    const cur = load(KEYS.current, null);
    if (!cur || !(cur.active > 0) || !cur.startedAt) {
      save(KEYS.current, null);
      return;
    }
    if (dayStart(cur.startedAt) === dayStart(Date.now())) {
      state.active = cur.active;
      state.startedAt = cur.startedAt;
      state.celebrated = state.goalMin > 0 && state.active >= state.goalMin * 60;
    } else {
      archive(cur.startedAt, cur.updatedAt || cur.startedAt, cur.active, cur.goalMin);
      save(KEYS.current, null);
    }
  }

  function totals() {
    const now = Date.now();
    const d0 = dayStart(now);
    const w0 = weekStart(now);
    let today = state.active;
    let week = state.active;
    for (const s of sessions) {
      if (s.start >= d0) today += s.active;
      if (s.start >= w0) week += s.active;
    }
    return { today, week };
  }

  // --------------------------------------------------------- formatting

  const pad = (n) => String(n).padStart(2, '0');

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function fmtTotal(sec) {
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  }

  // ------------------------------------------------------------ render

  let shown = 0; // displayed seconds (eases toward state.active on jumps)
  let shownSec = -1;
  let lastP = 0;
  let frame = 0;

  function statusName() {
    if (state.running) return state.playing ? 'playing' : 'listening';
    return state.active > 0 ? 'paused' : 'ready';
  }

  function render() {
    const status = statusName();
    el.app.dataset.status = status;
    el.app.dataset.running = String(state.running);
    el.statusText.textContent = STATUS_TEXT[status];
    el.startLabel.textContent = state.running ? 'Pause' : state.active > 0 ? 'Resume' : 'Start';
    el.resetBtn.hidden = state.running || state.active <= 0;
    el.goalLabel.textContent = state.goalMin ? `${state.goalMin} min` : 'Goal';
    renderClock(true);
  }

  function renderClock(force) {
    const sec = Math.floor(shown);
    if (sec !== shownSec || force) {
      shownSec = sec;
      el.time.textContent = fmtClock(sec);
      const t = totals();
      el.today.textContent = fmtTotal(t.today);
      el.week.textContent = fmtTotal(t.week);
    }

    const goal = state.goalMin * 60;
    const done = goal > 0 && state.active >= goal;
    const p = goal > 0 ? Math.min(1, shown / goal) : (shown % 60) / 60;
    if (p < lastP - 0.5) {
      // Minute sweep wrapped around: jump instead of animating backwards.
      el.ringFill.style.transition = 'none';
      el.ringFill.style.strokeDashoffset = String(RING_C * (1 - p));
      void el.ringFill.getBoundingClientRect();
      el.ringFill.style.transition = '';
    } else {
      el.ringFill.style.strokeDashoffset = String(RING_C * (1 - p));
    }
    lastP = p;
    el.dial.classList.toggle('minute', goal <= 0);
    el.dial.classList.toggle('complete', done);
    el.goalText.textContent = goal > 0 ? (done ? 'Goal reached' : `of ${state.goalMin} min`) : 'No goal set';
  }

  /** One rAF loop while anything moves: eases the clock after detector jumps. */
  function tick() {
    frame = 0;
    const diff = state.active - shown;
    shown = Math.abs(diff) > 1.5 ? shown + diff * 0.12 : state.active;
    renderClock(false);
    if (!el.debug.hidden) renderDebug();
    if (state.running || shown !== state.active) frame = requestAnimationFrame(tick);
  }

  function wake() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------- audio

  let ctx = null;
  let unlocked = false;
  let stream = null;
  let source = null;
  let capture = null;
  let sink = null;
  let workletLoaded = null;
  let detector = null;
  let muteUntil = 0;

  /** Create/resume the AudioContext. Must run inside a user gesture on iPad. */
  function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        ctx = new AC();
      }
      ctx.onstatechange = () => {
        if (state.running && ctx.state !== 'running') ctx.resume().catch(() => {});
      };
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (!unlocked) {
      // iOS only lets Web Audio make sound after a sound is started in a tap.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
      unlocked = true;
    }
    return ctx;
  }

  async function startListening() {
    const ac = ensureContext();
    if (!ac || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('This browser can’t use the microphone here. Open the page in Safari over https.');
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      toast(
        err && err.name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it for this site (Settings › Apps › Safari › Microphone), then tap Start.'
          : 'Couldn’t open the microphone.',
      );
      return false;
    }
    await ac.resume().catch(() => {});

    if (!detector || detector.sr !== ac.sampleRate) detector = new PracticeDetector(CONFIG, ac.sampleRate);
    detector.reset();

    if (!sink) {
      sink = ac.createGain(); // silent: keeps the capture node pulled by the graph
      sink.gain.value = 0;
      sink.connect(ac.destination);
    }
    source = ac.createMediaStreamSource(stream);

    if (ac.audioWorklet && window.AudioWorkletNode) {
      try {
        workletLoaded = workletLoaded || ac.audioWorklet.addModule('js/capture-worklet.js');
        await workletLoaded;
        capture = new AudioWorkletNode(ac, 'pp-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: { chunk: CHUNK },
        });
        capture.port.onmessage = (e) => onSamples(e.data);
      } catch {
        workletLoaded = null;
        capture = null;
      }
    }
    if (!capture) {
      capture = ac.createScriptProcessor(CHUNK, 1, 1);
      capture.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0));
    }
    source.connect(capture);
    capture.connect(sink);

    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (state.running) pause('The microphone was interrupted — tap Resume to continue.');
      });
    }
    return true;
  }

  function stopListening() {
    if (capture) {
      if (capture.port) capture.port.onmessage = null;
      else capture.onaudioprocess = null;
      try {
        capture.disconnect();
      } catch {
        /* already disconnected */
      }
      capture = null;
    }
    if (source) {
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      source = null;
    }
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
  }

  function onSamples(samples) {
    if (!state.running || !detector) return;
    let credit;
    if (performance.now() < muteUntil) {
      // Our own chime is ringing: don't analyse it, but keep counting if playing.
      credit = detector.playing ? samples.length / detector.sr : 0;
    } else {
      credit = detector.process(samples);
    }
    if (credit) state.active = Math.max(0, state.active + credit);
    if (detector.playing !== state.playing) {
      state.playing = detector.playing;
      render();
    }
    recordDebug();
    checkGoal();
    wake();
  }

  // ----------------------------------------------------------- session

  let busy = false;
  let persistTimer = 0;
  let wasAutoPaused = false;

  async function toggle() {
    if (busy) return;
    if (state.running) {
      pause();
      return;
    }
    busy = true;
    el.startBtn.disabled = true;
    let ok = false;
    try {
      ok = await startListening();
    } catch {
      toast('Couldn’t start listening. Please try again.');
    } finally {
      busy = false;
      el.startBtn.disabled = false;
    }
    if (!ok) {
      stopListening();
      render();
      return;
    }
    state.running = true;
    state.playing = false;
    if (!state.startedAt) state.startedAt = Date.now();
    requestWakeLock();
    clearInterval(persistTimer);
    persistTimer = setInterval(persistCurrent, 5000);
    render();
    wake();
  }

  function pause(message) {
    state.running = false;
    state.playing = false;
    stopListening();
    releaseWakeLock();
    clearInterval(persistTimer);
    persistCurrent();
    render();
    wake();
    if (message) toast(message);
  }

  function reset() {
    if (state.running) pause();
    archive(state.startedAt || Date.now(), Date.now(), state.active, state.goalMin);
    state.active = 0;
    state.startedAt = 0;
    state.celebrated = false;
    shown = 0;
    debugHistory.length = 0;
    persistCurrent();
    render();
  }

  // -------------------------------------------------------------- goal

  function setGoal(min) {
    state.goalMin = min;
    save(KEYS.goal, min);
    state.celebrated = min > 0 && state.active >= min * 60;
    persistCurrent();
    render();
    closeSheet();
  }

  function checkGoal() {
    const goal = state.goalMin * 60;
    if (goal > 0 && !state.celebrated && state.active >= goal) {
      state.celebrated = true;
      celebrate();
    }
  }

  function celebrate() {
    chime();
    muteUntil = performance.now() + 3500;
    el.dial.classList.remove('celebrate');
    void el.dial.offsetWidth;
    el.dial.classList.add('celebrate');
    confetti();
    toast(`Goal reached — ${state.goalMin} minutes of real playing. Lovely work.`, true);
    render();
  }

  /** A soft bell arpeggio, synthesised so it works offline. */
  function chime() {
    const ac = ensureContext();
    if (!ac) return;
    const master = ac.createGain();
    master.gain.value = 0.55;
    master.connect(ac.destination);
    const t0 = ac.currentTime + 0.05;
    [76, 79, 84, 88].forEach((midi, i) => {
      const f = 440 * 2 ** ((midi - 69) / 12);
      const start = t0 + i * 0.15;
      for (const [ratio, amp, decay] of [[1, 0.3, 2.6], [2.76, 0.06, 0.9], [5.4, 0.025, 0.4]]) {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.value = f * ratio;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(amp, start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, start + decay);
        osc.connect(g).connect(master);
        osc.start(start);
        osc.stop(start + decay + 0.05);
      }
    });
  }

  function confetti() {
    const canvas = el.confetti;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = (canvas.width = innerWidth * dpr);
    const h = (canvas.height = innerHeight * dpr);
    const g = canvas.getContext('2d');
    const r = el.dial.getBoundingClientRect();
    const cx = (r.left + r.width / 2) * dpr;
    const cy = (r.top + r.height / 2) * dpr;
    const colors = ['#86d6bc', '#b9ead9', '#e8f7f1', '#ffffff', '#5fbf9f'];
    const parts = Array.from({ length: 150 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = (5 + Math.random() * 11) * dpr;
      return {
        x: cx + Math.cos(a) * r.width * 0.3 * dpr,
        y: cy + Math.sin(a) * r.width * 0.3 * dpr,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 4 * dpr,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        size: (4 + Math.random() * 6) * dpr,
        color: colors[(Math.random() * colors.length) | 0],
      };
    });
    const t0 = performance.now();
    const life = 2600;
    (function step(now) {
      const k = (now - t0) / life;
      g.clearRect(0, 0, w, h);
      if (k >= 1) return;
      for (const p of parts) {
        p.vx *= 0.985;
        p.vy = p.vy * 0.985 + 0.32 * dpr;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        g.globalAlpha = 1 - k * k;
        g.fillStyle = p.color;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        g.restore();
      }
      requestAnimationFrame(step);
    })(t0);
  }

  // ------------------------------------------------------- goal sheet

  let customMin = 25;

  function buildPresets() {
    el.presets.innerHTML = '';
    for (const m of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.innerHTML = `<span class="chip-in"><b>${m}</b><span>min</span></span>`;
      b.setAttribute('aria-pressed', String(state.goalMin === m));
      b.addEventListener('click', () => setGoal(m));
      el.presets.appendChild(b);
    }
  }

  function openSheet() {
    ensureContext();
    if (state.goalMin && !PRESETS.includes(state.goalMin)) customMin = state.goalMin;
    el.customValue.textContent = customMin;
    buildPresets();
    el.sheet.classList.remove('closing');
    el.sheet.hidden = false;
  }

  function closeSheet() {
    if (el.sheet.hidden || el.sheet.classList.contains('closing')) return;
    el.sheet.classList.add('closing');
    setTimeout(() => {
      el.sheet.hidden = true;
      el.sheet.classList.remove('closing');
    }, 240);
  }

  function stepCustom(delta) {
    customMin = Math.min(240, Math.max(5, customMin + delta));
    el.customValue.textContent = customMin;
  }

  // ------------------------------------------------------- wake lock

  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      // Not allowed right now (e.g. low battery); the screen may dim.
    }
  }

  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // iPadOS stops the microphone in the background, so pause honestly.
      if (state.running) {
        pause();
        wasAutoPaused = true;
      }
      persistCurrent();
    } else if (wasAutoPaused) {
      wasAutoPaused = false;
      toast('Paused while the app was in the background. Tap Resume to carry on.');
    }
  });
  window.addEventListener('pagehide', persistCurrent);

  // ------------------------------------------------------------ toast

  let toastTimer = 0;

  function toast(text, accent) {
    clearTimeout(toastTimer);
    el.toast.textContent = text;
    el.toast.classList.toggle('accent', !!accent);
    el.toast.hidden = false;
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth;
    el.toast.style.animation = '';
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 4500);
  }

  // ------------------------------------------------------------ debug

  const DBG_ROWS = [
    ['score', 'Score'],
    ['tonality', 'Tonality'],
    ['activity', 'Activity'],
    ['key', 'Key'],
    ['melody', 'Melody'],
    ['rhythm', 'Rhythm'],
  ];
  const debugHistory = []; // { score, playing } every ~100 ms, last 30 s
  let lastDebugSample = 0;
  let lastDebugRender = 0;
  const dbgOut = {};

  function buildDebug() {
    el.dbgBars.innerHTML = '';
    for (const [key, label] of DBG_ROWS) {
      const row = document.createElement('div');
      row.className = 'dbg-row' + (key === 'score' ? ' total' : '');
      const marks =
        key === 'score'
          ? `<em style="left:${CONFIG.state.exitScore * 100}%"></em><em style="left:${CONFIG.state.enterScore * 100}%"></em>`
          : '';
      row.innerHTML = `<label>${label}</label><div class="dbg-track"><i></i>${marks}</div><output>–</output>`;
      el.dbgBars.appendChild(row);
      dbgOut[key] = { bar: row.querySelector('i'), out: row.querySelector('output') };
    }
  }

  function recordDebug() {
    const now = performance.now();
    if (now - lastDebugSample < 100) return;
    lastDebugSample = now;
    debugHistory.push({ score: detector.snapshot.score, playing: detector.playing });
    if (debugHistory.length > 300) debugHistory.shift();
  }

  function renderDebug() {
    const now = performance.now();
    if (now - lastDebugRender < 100 || !detector) return;
    lastDebugRender = now;
    const s = detector.snapshot;
    const m = s.metrics;
    const vals = { score: s.score, ...s.sub };
    for (const [key] of DBG_ROWS) {
      const v = vals[key] || 0;
      dbgOut[key].bar.style.width = `${(v * 100).toFixed(1)}%`;
      dbgOut[key].out.textContent = v.toFixed(2);
    }
    el.dbgState.textContent = state.running ? s.state : 'not listening';
    el.dbgState.classList.toggle('playing', state.running && s.state === 'playing');
    const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
    const rows = [
      ['level', `${f(m.db, 0)} dB`],
      ['floor', `${f(m.floorDb, 0)} dB`],
      ['pitch', m.pitch || '–'],
      ['aperiodicity', f(m.aperiodicity)],
      ['notes', `${m.pitchedNotes ?? 0}/${m.notes ?? 0}`],
      ['notes / s', f(m.onsetRate, 1)],
      ['stable', f(m.stableFrac)],
      ['tuning R', `${f(m.tuningR)} (${f(m.tuningCents, 0)}¢)`],
      ['key', m.keyName || '–'],
      ['in key', `${f(m.keyFit)} of ${m.keyNotes ?? 0}`],
      ['melody', `${f(m.melodyFrac)} / ${m.intervals ?? 0}`],
      ['rhythm', `${f(m.rhythmFrac)} / ${m.rhythmPairs ?? 0}`],
      ['since sound', `${f(Math.min(m.gap, 99), 1)} s`],
      ['pitched on.', f(m.pitchedOnsetFrac)],
    ];
    el.dbgMetrics.innerHTML = rows.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
    drawSpark();
  }

  function drawSpark() {
    const c = el.dbgSpark;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth * dpr;
    const h = c.clientHeight * dpr;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const y = (v) => h - 4 * dpr - v * (h - 8 * dpr);
    const x = (i) => (i / 299) * w;
    // Counted stretches.
    g.fillStyle = 'rgba(134, 214, 188, 0.12)';
    debugHistory.forEach((p, i) => {
      if (p.playing) g.fillRect(x(i), 0, w / 299 + 1, h);
    });
    // Thresholds.
    g.setLineDash([4 * dpr, 4 * dpr]);
    g.lineWidth = dpr;
    for (const [v, col] of [[CONFIG.state.enterScore, 'rgba(134,214,188,0.6)'], [CONFIG.state.exitScore, 'rgba(255,255,255,0.25)']]) {
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(0, y(v));
      g.lineTo(w, y(v));
      g.stroke();
    }
    g.setLineDash([]);
    // Score line.
    g.strokeStyle = '#86d6bc';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    const off = 300 - debugHistory.length;
    debugHistory.forEach((p, i) => (i ? g.lineTo(x(i + off), y(p.score)) : g.moveTo(x(i + off), y(p.score))));
    g.stroke();
  }

  function toggleDebug() {
    el.debug.hidden = !el.debug.hidden;
    if (!el.debug.hidden) {
      lastDebugRender = 0;
      if (detector) renderDebug();
      wake();
    }
  }

  // ------------------------------------------------------------ wiring

  el.startBtn.addEventListener('click', toggle);
  el.resetBtn.addEventListener('click', reset);
  el.goalBtn.addEventListener('click', openSheet);
  $('stepDown').addEventListener('click', () => stepCustom(-5));
  $('stepUp').addEventListener('click', () => stepCustom(5));
  $('customSet').addEventListener('click', () => setGoal(customMin));
  $('noGoal').addEventListener('click', () => setGoal(0));
  el.sheet.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeSheet();
  });
  $('dbgClose').addEventListener('click', toggleDebug);

  // Long-press the logo for the detection panel (also: press "d").
  let pressTimer = 0;
  el.logo.addEventListener('pointerdown', () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(toggleDebug, 650);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    el.logo.addEventListener(ev, () => clearTimeout(pressTimer));
  }
  el.logo.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSheet();
      if (!el.debug.hidden) toggleDebug();
    } else if (e.key === 'd' && !e.metaKey && !e.ctrlKey) {
      toggleDebug();
    } else if (e.key === ' ' && el.sheet.hidden && e.target === document.body) {
      e.preventDefault();
      toggle();
    }
  });

  // First tap anywhere unlocks audio so the goal chime can play later.
  document.addEventListener('pointerdown', ensureContext, { once: true, passive: true });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  el.ringFill.style.strokeDasharray = String(RING_C);
  restoreCurrent();
  shown = state.active;
  buildDebug();
  render();

  // Day/week totals roll over at midnight even when idle.
  setInterval(() => renderClock(true), 60000);

  // Exposed for testing in the browser console.
  window.pp = { state, get detector() { return detector; }, config: CONFIG };
})();
