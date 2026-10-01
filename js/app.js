'use strict';
/* 主程式：建立音訊路由、混音台、鍵盤控制、錄製與匯出 */

/**
 * 把 processors.js 的函式轉成模組載入 AudioWorklet。
 * 先用 Blob URL；直接開檔（file://）時 Chrome 會拒絕 Blob，改用 data: URL。
 */
async function loadProcessors(ctx) {
  const src = `(${djProcessorsModule.toString()})();`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch (err) {
    await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* 鍵盤對照：唱盤按鍵來自 DECK_DEFS */
const KEY_ACTIONS = {};
DECK_DEFS.forEach((def, deck) => {
  for (const [act, code] of Object.entries(def.keys)) KEY_ACTIONS[code] = { deck, act };
});
const XF_KEYS = { ArrowLeft: -1, ArrowRight: 1 };

const App = {
  ctx: null,
  started: false,
  starting: null,
  decks: [],
  looper: null,
  vinyl: true,
  xf: 0.5,
  xfDir: 0,
  micReady: false,
  meters: [],
  held: new Map(),
  rec: null,
  lastFrame: 0,

  init() {
    this.decks = [new Deck(this, 0, $('#deckA')), new Deck(this, 1, $('#deckB'))];
    this.looper = new LoopStation(this, $('#looper'));
    this.buildMixer();
    this.bindTopbar();
    this.bindKeyboard();
    // 避免把檔案拖到空白處時瀏覽器直接開啟檔案
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    $('#startBtn').addEventListener('click', () => this.start());
  },

  /** 第一次互動時建立 AudioContext（瀏覽器規定要有使用者操作） */
  start() {
    if (!this.starting) {
      this.starting = this.boot().catch((err) => {
        console.error(err);
        this.starting = null;
        $('#startError').textContent = `無法啟動音訊：${err.message || err}`;
      });
    }
    return this.starting;
  },

  async boot() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.AudioWorkletNode) throw new Error('這個瀏覽器不支援 AudioWorklet，請改用最新版 Chrome / Edge / Firefox / Safari');
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.resume();
    await loadProcessors(ctx);

    // 主輸出：master 音量 → 限幅器 → 喇叭／錄音
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    this.master.connect(this.limiter).connect(this.masterOut).connect(ctx.destination);
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterOut.connect(this.masterAnalyser);

    this.recorder = new AudioWorkletNode(ctx, 'dj-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.recorder.port.onmessage = (e) => this.onRecorderMessage(e.data);
    this.masterOut.connect(this.recorder);
    this.recorder.connect(ctx.destination); // 輸出是靜音，只是讓節點持續運作

    this.deckBus = ctx.createGain();
    this.deckBus.connect(this.master);
    this.micBus = ctx.createGain();
    this.micMonitor = ctx.createGain();
    this.micMonitor.gain.value = 0;
    this.micBus.connect(this.micMonitor).connect(this.master);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micBus.connect(this.micAnalyser);

    this.decks.forEach((d) => d.initAudio(ctx, this.deckBus));
    this.looper.initAudio(ctx);
    this.applyMixer();

    this.meters = [
      new Meter($('#vuA'), this.decks[0].analyser),
      new Meter($('#vuB'), this.decks[1].analyser),
      new Meter($('#vuMaster'), this.masterAnalyser),
      new Meter($('#micMeter'), this.micAnalyser),
    ];

    this.started = true;
    document.body.classList.add('started');
    $('#startOverlay').classList.add('hidden');
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  },

  /* ---------------- 混音台 ---------------- */

  buildMixer() {
    const knobDefs = [
      { k: 'gain', label: 'GAIN', min: -12, max: 12, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB` },
      { k: 'hi', label: 'HI', fmt: eqFmt },
      { k: 'mid', label: 'MID', fmt: eqFmt },
      { k: 'low', label: 'LOW', fmt: eqFmt },
      { k: 'filter', label: 'FILTER', fmt: (v) => (Math.abs(v) < 0.02 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`) },
      { k: 'echo', label: 'ECHO', min: 0, max: 1, value: 0, bipolar: false, fmt: (v) => `${Math.round(v * 100)}%` },
    ];
    function eqFmt(v) {
      if (v <= -0.99) return 'KILL';
      const db = v < 0 ? v * 36 : v * 8;
      return `${db > 0 ? '+' : ''}${db.toFixed(1)}dB`;
    }
    this.decks.forEach((deck, i) => {
      const strip = $(`.strip[data-deck="${i}"]`);
      strip.style.setProperty('--accent', deck.def.color);
      const box = $('.strip-knobs', strip);
      deck.knobs = {};
      for (const d of knobDefs) {
        const el = document.createElement('div');
        box.appendChild(el);
        deck.knobs[d.k] = new Knob(el, {
          min: d.min ?? -1,
          max: d.max ?? 1,
          value: d.value ?? 0,
          bipolar: d.bipolar,
          label: d.label,
          title: `${d.label}（唱盤 ${deck.def.name}）`,
          format: d.fmt,
          onChange: (v) => deck.setParam(d.k, v),
        });
      }
      deck.chFader = new Fader($('.ch-fader', strip), {
        vertical: true,
        value: 0.85,
        cap: 22,
        title: `唱盤 ${deck.def.name} 音量`,
        onChange: (v) => deck.setParam('fader', v),
      });
    });

    this.xfader = new Fader($('#xfader'), {
      vertical: false,
      value: 0.5,
      cap: 30,
      centerTick: true,
      title: 'Crossfader（← → 鍵控制，↓ 置中）',
      onChange: (v) => this.setXfader(v),
    });

    const center = $('#mixerKnobs');
    const mk = (label, value, max, onChange, fmt) => {
      const el = document.createElement('div');
      el.className = 'knob-sm';
      center.appendChild(el);
      return new Knob(el, { min: 0, max, value, bipolar: false, label, format: fmt || ((v) => `${Math.round(v * 100)}%`), onChange });
    };
    this.masterKnob = mk('MASTER', 0.8, 1.2, (v) => this.setGain(this.master, v));
    this.loopKnob = mk('LOOP', 1, 1.5, (v) => this.looper.out && this.setGain(this.looper.out, v));
    this.micKnob = mk('MIC', 1, 2, (v) => this.setGain(this.micBus, v));
    this.clickKnob = mk('CLICK', 0.6, 1, (v) => this.looper.metroGain && this.setGain(this.looper.metroGain, v));
  },

  applyMixer() {
    this.setGain(this.master, this.masterKnob.value);
    this.setGain(this.looper.out, this.loopKnob.value);
    this.setGain(this.micBus, this.micKnob.value);
    this.setGain(this.looper.metroGain, this.clickKnob.value);
    this.setXfader(this.xf);
  },

  setGain(node, v) {
    if (node && this.ctx) node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  },

  /** Crossfader：中間兩邊都是全音量，往一側推時另一側淡出 */
  setXfader(x, fromKeys) {
    this.xf = x;
    if (fromKeys) this.xfader.set(x, false);
    const a = x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI);
    const b = x >= 0.5 ? 1 : Math.sin(x * Math.PI);
    this.decks[0].setParam('xf', a);
    this.decks[1].setParam('xf', b);
  },

  setMicMonitor(on) {
    this.setGain(this.micMonitor, on ? 1 : 0);
    if (on) toast('監聽開啟：麥克風會出現在喇叭與混音錄音中（請戴耳機避免回授）');
  },

  async enableMic() {
    if (this.micReady) return true;
    await this.start();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('無法使用麥克風：請用 https 網址或 localhost 開啟', 'error');
      return false;
    }
    const btn = $('#micBtn');
    btn.textContent = '要求權限中…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micBus);
      const settings = stream.getAudioTracks()[0].getSettings();
      const inLat = typeof settings.latency === 'number' ? settings.latency : 0.01;
      const outLat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
      this.looper.suggestLatency(Math.round((inLat + outLat) * 1000));
      this.micReady = true;
      btn.textContent = '🎤 麥克風已啟用';
      btn.classList.add('on');
      btn.disabled = true;
      return true;
    } catch (err) {
      console.error(err);
      btn.textContent = '啟用麥克風';
      toast('沒有取得麥克風權限：' + (err.message || err.name), 'error');
      return false;
    }
  },

  /* ---------------- 錄製混音 & 匯出 ---------------- */

  bindTopbar() {
    $('#recBtn').addEventListener('click', async () => {
      await this.start();
      this.toggleRecord();
    });
    $('#recFormat').addEventListener('change', (e) => e.target.blur());
    $('#vinylMode').addEventListener('change', (e) => (this.vinyl = e.target.checked));
    const dlg = $('#help');
    $('#helpBtn').addEventListener('click', () => (dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '')));
    $('#helpClose').addEventListener('click', () => (dlg.close ? dlg.close() : dlg.removeAttribute('open')));
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  },

  toggleRecord() {
    if (this.rec) {
      if (!this.rec.stopping) this.stopRecord();
    } else {
      this.startRecord();
    }
  },

  startRecord() {
    const fmt = $('#recFormat').value;
    if (fmt === 'wav') {
      this.rec = { fmt, chunks: [], frames: 0, start: performance.now() };
      this.recorder.port.postMessage({ type: 'start' });
    } else {
      const mime = pickRecorderMime();
      if (!mime) {
        toast('這個瀏覽器不支援壓縮錄音，改用 WAV');
        $('#recFormat').value = 'wav';
        this.startRecord();
        return;
      }
      if (!this.streamDest) {
        this.streamDest = this.ctx.createMediaStreamDestination();
        this.masterOut.connect(this.streamDest);
      }
      const mr = new MediaRecorder(this.streamDest.stream, { mimeType: mime, audioBitsPerSecond: 256000 });
      const parts = [];
      const rec = { fmt, mr, mime, start: performance.now() };
      mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
      mr.onstop = () => {
        const dur = (performance.now() - rec.start) / 1000;
        this.rec = null;
        this.addExport(new Blob(parts, { type: mime }), `dj-mix-${stamp()}.${mimeExt(mime)}`, dur, false);
      };
      mr.start(1000);
      this.rec = rec;
    }
    document.body.classList.add('recording');
    $('#recBtn .rec-label').textContent = '停止錄製';
    toast('開始錄製混音（主輸出：唱盤 + Loop + 監聽中的麥克風）');
  },

  stopRecord() {
    const r = this.rec;
    r.stopping = true;
    r.end = performance.now();
    document.body.classList.remove('recording');
    $('#recBtn .rec-label').textContent = '錄製混音';
    if (r.fmt === 'wav') this.recorder.port.postMessage({ type: 'stop' });
    else r.mr.stop();
  },

  onRecorderMessage(m) {
    const r = this.rec;
    if (!r || r.fmt !== 'wav') return;
    if (m.type === 'data') {
      r.chunks.push(floatsToInt16(m.L, m.R));
      r.frames += m.L.length;
    } else if (m.type === 'stopped') {
      this.rec = null;
      const sr = this.ctx.sampleRate;
      const blob = new Blob([wavHeader(r.frames, sr), ...r.chunks], { type: 'audio/wav' });
      this.addExport(blob, `dj-mix-${stamp()}.wav`, r.frames / sr, false);
    }
  },

  addExport(blob, name, duration, autoDownload) {
    const url = URL.createObjectURL(blob);
    const li = document.createElement('li');
    li.className = 'export-item';
    li.innerHTML = `
      <div class="ex-info"><div class="ex-name"></div><div class="ex-meta">${fmtTime(duration, false)} · ${fmtSize(blob.size)}</div></div>
      <audio controls preload="metadata"></audio>
      <a class="btn small primary">⬇ 下載</a>
      <button type="button" class="btn icon ghost" title="從清單移除">✕</button>`;
    $('.ex-name', li).textContent = name;
    $('audio', li).src = url;
    const a = $('a', li);
    a.href = url;
    a.download = name;
    $('button', li).addEventListener('click', () => {
      URL.revokeObjectURL(url);
      li.remove();
      if (!$('#exportList').children.length) $('#exports').hidden = true;
    });
    $('#exportList').prepend(li);
    $('#exports').hidden = false;
    if (autoDownload) a.click();
    toast(`已匯出：${name}`, 'ok');
    if (!autoDownload) $('#exports').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  /* ---------------- 鍵盤 ---------------- */

  bindKeyboard() {
    const isField = (el) =>
      el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file'].includes(el.type)));

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isField(e.target)) {
        if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
        return;
      }
      const code = e.code;
      const known = KEY_ACTIONS[code] || /^Digit[1-4]$/.test(code) || code in XF_KEYS || code === 'ArrowDown';
      if (!this.started) {
        if (known || code === 'Space' || code === 'Enter') {
          e.preventDefault();
          this.start();
        }
        return;
      }
      if (!known) return;
      e.preventDefault();
      if (e.repeat || this.held.has(code)) return;
      this.held.set(code, this.keyDown(code, e.shiftKey));
      $$(`[data-key="${code}"]`).forEach((el) => el.classList.add('is-down'));
    });

    window.addEventListener('keyup', (e) => this.keyUp(e.code));
    // 切換視窗時放開所有按鍵，避免卡在倒帶／加速
    window.addEventListener('blur', () => [...this.held.keys()].forEach((c) => this.keyUp(c)));
  },

  /** 執行按下的動作，回傳放開時要呼叫的函式（或 null） */
  keyDown(code, shift) {
    const ka = KEY_ACTIONS[code];
    if (ka) {
      const deck = this.decks[ka.deck];
      switch (ka.act) {
        case 'play':
          deck.togglePlay();
          return null;
        case 'cue':
          if (shift) deck.setCue();
          else deck.drop();
          return null;
        default:
          return deck.startHold(ka.act, shift);
      }
    }
    if (/^Digit[1-4]$/.test(code)) {
      const i = Number(code.slice(5)) - 1;
      if (shift) this.looper.stopToggle(i);
      else this.looper.press(i);
      return null;
    }
    if (code in XF_KEYS) {
      const dir = XF_KEYS[code];
      this.xfDir = dir;
      return () => {
        if (this.xfDir === dir) this.xfDir = 0;
      };
    }
    if (code === 'ArrowDown') this.setXfader(0.5, true);
    return null;
  },

  keyUp(code) {
    if (!this.held.has(code)) return;
    const release = this.held.get(code);
    this.held.delete(code);
    $$(`[data-key="${code}"]`).forEach((el) => el.classList.remove('is-down'));
    if (release) release();
  },

  /* ---------------- 畫面更新 ---------------- */

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.xfDir) this.setXfader(clamp(this.xf + this.xfDir * dt * 1.6, 0, 1), true);
    for (const d of this.decks) d.render();
    this.looper.render();
    for (const m of this.meters) m.update(dt);
    if (this.rec) {
      const secs = ((this.rec.end || now) - this.rec.start) / 1000;
      let text = fmtTime(secs, false);
      if (this.rec.fmt === 'wav') text += ` · ${fmtSize(this.rec.frames * 4)}`;
      if (text !== this._recText) $('#recTime').textContent = this._recText = text;
    }
    requestAnimationFrame((t) => this.frame(t));
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
