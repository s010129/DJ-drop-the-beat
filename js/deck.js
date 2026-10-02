'use strict';
/* 唱盤：載入音樂、播放控制、倒帶／加速、刷碟、EQ／濾波／回音、波形顯示 */

const PEAKS_PER_SEC = 150;
const ZOOM_PPS = 110; // 放大波形：每秒幾個像素
const REW_RATE = -3; // 倒帶速度
const FF_RATE = 2.5; // 加速到的速度
const BEND = 0.04; // Shift + 倒帶／加速 = 微調 ±4%（對拍用）
const PLATTER_DPS = 200; // 33⅓ 轉：每秒 200 度
const TEMPO_RANGES = [8, 16, 50];

const DECK_DEFS = [
  {
    name: 'A',
    color: '#22d3ee',
    dim: 'rgba(34, 211, 238, 0.26)',
    keys: { cue: 'KeyW', echo: 'KeyE', rew: 'KeyA', play: 'KeyS', ff: 'KeyD' },
    caps: { cue: 'W', echo: 'E', rew: 'A', play: 'S', ff: 'D' },
    top: [
      ['cue', 5],
      ['echo', 9],
    ],
  },
  {
    name: 'B',
    color: '#f472b6',
    dim: 'rgba(244, 114, 182, 0.26)',
    keys: { cue: 'KeyO', echo: 'KeyI', rew: 'KeyK', play: 'KeyL', ff: 'Semicolon' },
    caps: { cue: 'O', echo: 'I', rew: 'K', play: 'L', ff: ';' },
    top: [
      ['echo', 1],
      ['cue', 5],
    ],
  },
];

const PAD_LABELS = {
  cue: 'CUE · DROP',
  echo: 'ECHO 回音',
  rew: '◀◀ 倒帶',
  play: '▶❚❚ 播放',
  ff: '▶▶ 加速',
};

function deckMarkup(def) {
  // 按鍵排列與實體鍵盤一致：上排比下排往左錯開 1/4 鍵
  const pad = (act, col) =>
    `<button type="button" class="pad pad-${act}" style="grid-column:${col} / span 4" data-act="${act}" data-key="${def.keys[act]}">` +
    `<kbd>${def.caps[act]}</kbd><span>${PAD_LABELS[act]}</span></button>`;
  return `
    <div class="deck-head">
      <div class="deck-id">${def.name}</div>
      <div class="deck-info">
        <div class="track-name">拖放音樂到這裡，或按「載入音樂」</div>
        <div class="track-meta">
          <span class="bpm">— BPM</span>
          <span class="tempo-read">±0.0%</span>
          <span class="state-pill">NO TRACK</span>
        </div>
      </div>
      <div class="deck-load">
        <label class="btn small">載入音樂<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" hidden></label>
        <button type="button" class="btn small ghost demo-btn">示範節拍</button>
      </div>
    </div>
    <div class="wave">
      <canvas class="wave-zoom" title="左右拖曳可以刷碟"></canvas>
      <canvas class="wave-overview" title="點擊跳到該位置"></canvas>
    </div>
    <div class="deck-time">
      <span class="elapsed">0:00.0</span>
      <span class="flash"></span>
      <span class="remain">-0:00.0</span>
    </div>
    <div class="deck-body">
      <div class="platter" title="按住拖曳轉動唱片＝刷碟">
        <div class="vinyl"><div class="vinyl-label"><span>${def.name}</span></div><div class="vinyl-mark"></div></div>
      </div>
      <div class="tempo-col">
        <div class="tempo-end">+</div>
        <div class="tempo-fader"></div>
        <div class="tempo-end">−</div>
        <button type="button" class="btn tiny range-btn" title="切換速度範圍">±16%</button>
        <button type="button" class="btn tiny sync-btn" title="把速度對齊另一台唱盤的 BPM">SYNC</button>
      </div>
    </div>
    <div class="keys-cluster">
      <div class="key-row">${def.top.map(([act, col]) => pad(act, col)).join('')}</div>
      <div class="key-row">${pad('rew', 2)}${pad('play', 6)}${pad('ff', 10)}</div>
    </div>
    <div class="deck-foot">
      <button type="button" class="btn tiny ghost setcue-btn">設定 CUE 點（Shift+${def.caps.cue}）</button>
      <span class="cue-read">CUE 0:00.0</span>
    </div>`;
}

class Deck {
  constructor(app, index, root) {
    this.app = app;
    this.index = index;
    this.def = DECK_DEFS[index];
    this.root = root;
    this.ctx = null;
    this.node = null;
    this.loaded = false;
    this.loading = false;
    this.name = '';
    this.duration = 0;
    this.time = 0;
    this.rate = 0;
    this.reportAt = 0;
    this.playing = false;
    this.cue = 0;
    this.tempo = 0; // %
    this.tempoRange = 16;
    this.beat = null; // { bpm, firstBeat }
    this.peaks = null;
    this.hold = { rew: false, ff: false, up: false, down: false };
    this.scratching = false;
    this.scratchRate = 0;
    this.echoThrowOn = false;
    this.params = { gain: 0, hi: 0, mid: 0, low: 0, filter: 0, echo: 0, fader: 0.85, xf: 1 };
    this.ovDirty = true;
    this.buildUI();
  }

  /* ---------------- 介面 ---------------- */

  buildUI() {
    const root = this.root;
    root.innerHTML = deckMarkup(this.def);
    root.style.setProperty('--accent', this.def.color);
    root.style.setProperty('--accent-dim', this.def.dim);
    this.nameEl = $('.track-name', root);
    this.bpmEl = $('.bpm', root);
    this.tempoEl = $('.tempo-read', root);
    this.stateEl = $('.state-pill', root);
    this.elapsedEl = $('.elapsed', root);
    this.remainEl = $('.remain', root);
    this.flashEl = $('.flash', root);
    this.cueEl = $('.cue-read', root);
    this.vinyl = $('.vinyl', root);
    this.zoomView = new CanvasView($('.wave-zoom', root));
    this.ovView = new CanvasView($('.wave-overview', root), () => (this.ovDirty = true));
    this.ovCache = document.createElement('canvas');

    const fileInput = $('input[type=file]', root);
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (f) this.loadFile(f);
    });
    $('.demo-btn', root).addEventListener('click', () => this.loadDemo());

    // 拖放音檔
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('drag');
    });
    root.addEventListener('dragleave', (e) => {
      if (!root.contains(e.relatedTarget)) root.classList.remove('drag');
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f) this.loadFile(f);
    });

    // 畫面上的按鍵（滑鼠／觸控）
    $$('.pad', root).forEach((btn) => {
      const act = btn.dataset.act;
      if (act === 'play') {
        btn.addEventListener('click', () => this.togglePlay());
      } else if (act === 'cue') {
        btn.addEventListener('click', (e) => (e.shiftKey ? this.setCue() : this.drop()));
      } else {
        let release = null;
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          btn.setPointerCapture(e.pointerId);
          btn.classList.add('is-down');
          release = this.startHold(act, e.shiftKey);
        });
        const end = () => {
          btn.classList.remove('is-down');
          if (release) release();
          release = null;
        };
        btn.addEventListener('pointerup', end);
        btn.addEventListener('pointercancel', end);
        btn.addEventListener('lostpointercapture', end);
      }
    });
    $('.setcue-btn', root).addEventListener('click', () => this.setCue());

    // 速度推桿
    this.tempoFader = new Fader($('.tempo-fader', root), {
      vertical: true,
      min: -this.tempoRange,
      max: this.tempoRange,
      value: 0,
      cap: 22,
      centerTick: true,
      title: '速度（雙擊歸零）',
      onChange: (v) => this.setTempo(v),
    });
    this.rangeBtn = $('.range-btn', root);
    this.rangeBtn.addEventListener('click', () => {
      const i = TEMPO_RANGES.indexOf(this.tempoRange);
      this.setTempoRange(TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length]);
    });
    $('.sync-btn', root).addEventListener('click', () => this.sync());

    // 刷碟：唱片轉盤與放大波形
    this.bindScratch($('.platter', root), 'platter');
    this.bindScratch(this.zoomView.canvas, 'wave');

    // 總覽波形：點擊／拖曳跳點
    const ov = this.ovView.canvas;
    const seekFrom = (e) => {
      const r = ov.getBoundingClientRect();
      this.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * this.duration);
    };
    ov.addEventListener('pointerdown', (e) => {
      if (!this.loaded) return;
      ov.setPointerCapture(e.pointerId);
      seekFrom(e);
    });
    ov.addEventListener('pointermove', (e) => {
      if (this.loaded && ov.hasPointerCapture(e.pointerId)) seekFrom(e);
    });
  }

  bindScratch(el, mode) {
    let last = 0;
    let lastT = 0;
    let still = 0;
    let active = false;
    const read = (e) => {
      if (mode === 'wave') return e.clientX;
      const r = el.getBoundingClientRect();
      return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.loaded || e.button > 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      active = true;
      last = read(e);
      lastT = e.timeStamp;
      this.scratching = true;
      this.scratchRate = 0;
      this.updateRate();
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const v = read(e);
      let d = v - last;
      if (mode === 'platter') {
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
      }
      const dt = Math.max(0.004, (e.timeStamp - lastT) / 1000);
      last = v;
      lastT = e.timeStamp;
      const inst = mode === 'platter' ? d / PLATTER_DPS / dt : -d / ZOOM_PPS / dt;
      this.scratchRate = clamp(this.scratchRate * 0.4 + inst * 0.6, -8, 8);
      this.updateRate();
      clearTimeout(still);
      still = setTimeout(() => {
        if (!active) return;
        this.scratchRate = 0;
        this.updateRate();
      }, 50);
    });
    const end = () => {
      if (!active) return;
      active = false;
      clearTimeout(still);
      this.scratching = false;
      this.updateRate(0.06);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  /* ---------------- 音訊 ---------------- */

  initAudio(ctx, bus) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, 'dj-deck', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => this.onMessage(e.data);

    this.trim = ctx.createGain();
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 220;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.8;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 3200;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = Math.min(20000, ctx.sampleRate * 0.45);
    this.fxIn = ctx.createGain();
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.delay = ctx.createDelay(2);
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.45;
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.node.connect(this.trim);
    this.trim.connect(this.eqLow).connect(this.eqMid).connect(this.eqHigh).connect(this.hp).connect(this.lp).connect(this.fxIn);
    this.fxIn.connect(this.fader);
    this.fxIn.connect(this.echoSend).connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);
    this.delay.connect(this.fader);
    this.fader.connect(this.xf);
    this.xf.connect(this.analyser);
    this.xf.connect(bus);

    for (const k of Object.keys(this.params)) this.setParam(k, this.params[k]);
    this.setEchoTime();
  }

  setParam(name, v) {
    this.params[name] = v;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const eqDb = (x) => (x < 0 ? x * 36 : x * 8); // 左轉到底接近消音（kill），右轉最多 +8 dB
    switch (name) {
      case 'gain':
        this.trim.gain.setTargetAtTime(dbToGain(v), t, 0.015);
        break;
      case 'hi':
        this.eqHigh.gain.setTargetAtTime(eqDb(v), t, 0.015);
        break;
      case 'mid':
        this.eqMid.gain.setTargetAtTime(eqDb(v), t, 0.015);
        break;
      case 'low':
        this.eqLow.gain.setTargetAtTime(eqDb(v), t, 0.015);
        break;
      case 'filter':
        this.applyFilter(v);
        break;
      case 'echo':
        if (!this.echoThrowOn) this.echoSend.gain.setTargetAtTime(v * 0.85, t, 0.02);
        break;
      case 'fader':
        this.fader.gain.setTargetAtTime(v * v, t, 0.01);
        break;
      case 'xf':
        this.xf.gain.setTargetAtTime(v, t, 0.005);
        break;
    }
  }

  /** 單旋鈕濾波：左轉 = 低通、右轉 = 高通、中間 = 不作用 */
  applyFilter(v) {
    const t = this.ctx.currentTime;
    const top = Math.min(20000, this.ctx.sampleRate * 0.45);
    let lp = top;
    let hp = 10;
    if (v < -0.02) lp = top * Math.pow(150 / top, (-v - 0.02) / 0.98);
    if (v > 0.02) hp = 10 * Math.pow(600, (v - 0.02) / 0.98);
    const q = Math.abs(v) > 0.02 ? 1.4 : 0.707;
    this.lp.frequency.setTargetAtTime(lp, t, 0.02);
    this.hp.frequency.setTargetAtTime(hp, t, 0.02);
    this.lp.Q.setTargetAtTime(q, t, 0.02);
    this.hp.Q.setTargetAtTime(q, t, 0.02);
  }

  /** 回音延遲 = 3/4 拍（不知道 BPM 時用 0.375 秒） */
  setEchoTime() {
    if (!this.ctx) return;
    const beat = this.beat ? 60 / (this.beat.bpm * this.speed()) : 0.5;
    this.delay.delayTime.setTargetAtTime(clamp(beat * 0.75, 0.05, 1.9), this.ctx.currentTime, 0.05);
  }

  /** 按住 E / I：把聲音整個丟進回音，放開後留下尾音 */
  setEchoThrow(on) {
    this.echoThrowOn = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.echoSend.gain.setTargetAtTime(on ? 1 : this.params.echo * 0.85, t, on ? 0.005 : 0.03);
    this.feedback.gain.cancelScheduledValues(t);
    this.feedback.gain.setTargetAtTime(on ? 0.62 : 0.45, on ? t : t + 1.2, on ? 0.01 : 0.4);
    this.root.classList.toggle('echo-on', on);
  }

  onMessage(m) {
    if (m.type === 'pos') {
      this.time = m.time;
      this.rate = m.rate;
      this.reportAt = performance.now();
    } else if (m.type === 'ended' && this.playing) {
      this.playing = false;
      this.updateRate(0.002);
    }
  }

  speed() {
    return 1 + this.tempo / 100;
  }

  currentTime() {
    if (!this.loaded) return 0;
    const dt = Math.min(0.1, (performance.now() - this.reportAt) / 1000);
    return clamp(this.time + this.rate * dt, 0, this.duration);
  }

  /** 依目前狀態（刷碟／倒帶／加速／播放／暫停）計算目標速率，tau 為趨近時間常數 */
  updateRate(tau = 0.03) {
    let target = 0;
    let state = this.loaded ? 'PAUSE' : 'NO TRACK';
    if (this.scratching) {
      target = this.scratchRate;
      tau = 0.01;
      state = 'SCRATCH';
    } else if (this.hold.rew) {
      target = REW_RATE;
      state = '◀◀ REW';
    } else if (this.hold.ff) {
      target = FF_RATE;
      state = '▶▶ FAST';
    } else if (this.playing) {
      target = this.speed() * (1 + (this.hold.up ? BEND : 0) - (this.hold.down ? BEND : 0));
      state = this.hold.up ? 'PLAY +' : this.hold.down ? 'PLAY −' : 'PLAY';
    }
    if (this.node) this.node.port.postMessage({ type: 'rate', target, tau });
    if (!this.loaded) state = 'NO TRACK';
    if (state !== this._state) {
      this._state = state;
      this.stateEl.textContent = state;
    }
    this.root.classList.toggle('playing', this.playing && this.loaded);
  }

  /* ---------------- 操作 ---------------- */

  togglePlay() {
    if (!this.loaded) return this.needTrack();
    if (!this.playing && this.currentTime() >= this.duration - 0.05) this.seek(0);
    this.playing = !this.playing;
    const vinyl = this.app.vinyl;
    this.updateRate(vinyl ? (this.playing ? 0.05 : 0.14) : 0.002);
  }

  /** W / O：跳回 CUE 點並立刻播放 —— Drop the beat! */
  drop() {
    if (!this.loaded) return this.needTrack();
    this.seek(this.cue);
    this.playing = true;
    this.updateRate(0.002);
    this.flash('DROP!');
  }

  setCue() {
    if (!this.loaded) return this.needTrack();
    this.cue = this.currentTime();
    this.cueEl.textContent = 'CUE ' + fmtTime(this.cue);
    this.flash('CUE SET');
  }

  /** 按住型操作：回傳放開時要呼叫的函式 */
  startHold(act, shift) {
    if (act === 'rew' || act === 'ff') {
      const key = shift ? (act === 'ff' ? 'up' : 'down') : act;
      this.hold[key] = true;
      this.updateRate(key === 'up' || key === 'down' ? 0.04 : act === 'ff' ? 0.25 : 0.12);
      return () => {
        this.hold[key] = false;
        this.updateRate(0.08);
      };
    }
    if (act === 'echo') {
      this.setEchoThrow(true);
      return () => this.setEchoThrow(false);
    }
    return () => {};
  }

  seek(time) {
    if (!this.loaded) return;
    time = clamp(time, 0, this.duration);
    this.node.port.postMessage({ type: 'seek', time });
    this.time = time;
    this.reportAt = performance.now();
  }

  setTempo(v) {
    this.tempo = v;
    if (Math.abs(this.tempoFader.value - v) > 1e-9) this.tempoFader.set(v, false);
    this.tempoEl.textContent = (v > 0.05 ? '+' : v < -0.05 ? '−' : '±') + Math.abs(v).toFixed(1) + '%';
    this.updateBpmText();
    this.updateRate(0.03);
    this.setEchoTime();
  }

  setTempoRange(r) {
    this.tempoRange = r;
    this.rangeBtn.textContent = `±${r}%`;
    this.tempoFader.setRange(-r, r);
  }

  sync() {
    const other = this.app.decks[1 - this.index];
    if (!this.beat || !other.beat) {
      toast('兩台唱盤都需要偵測到 BPM 才能 SYNC');
      return;
    }
    const target = other.beat.bpm * other.speed();
    let best = null;
    for (const mult of [1, 2, 0.5]) {
      const pct = ((target * mult) / this.beat.bpm - 1) * 100;
      if (best === null || Math.abs(pct) < Math.abs(best)) best = pct;
    }
    if (Math.abs(best) > this.tempoRange) {
      const r = TEMPO_RANGES.find((x) => x >= Math.abs(best));
      if (!r) {
        toast('BPM 差太多，無法 SYNC');
        return;
      }
      this.setTempoRange(r);
    }
    this.setTempo(best);
    this.flash('SYNC');
  }

  updateBpmText() {
    this.bpmEl.textContent = this.beat ? `${(this.beat.bpm * this.speed()).toFixed(1)} BPM` : '— BPM';
  }

  effectiveBpm() {
    return this.beat ? this.beat.bpm * this.speed() : 0;
  }

  flash(text) {
    this.flashEl.textContent = text;
    this.flashEl.classList.remove('go');
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('go');
  }

  needTrack() {
    toast(`唱盤 ${this.def.name} 還沒有音樂：按「載入音樂」或「示範節拍」`);
  }

  /* ---------------- 載入 ---------------- */

  async loadFile(file) {
    await this.app.start();
    if (this.loading) return;
    this.loading = true;
    this.nameEl.textContent = `讀取中… ${file.name}`;
    try {
      const data = await file.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.applyBuffer(buf, file.name.replace(/\.[^.]+$/, ''), null);
    } catch (err) {
      console.error(err);
      this.nameEl.textContent = this.loaded ? this.name : '無法讀取這個檔案';
      toast(`無法解碼「${file.name}」，請換成 mp3 / wav / m4a / ogg`, 'error');
    } finally {
      this.loading = false;
    }
  }

  async loadDemo() {
    await this.app.start();
    if (this.loading) return;
    this.loading = true;
    const kind = this.def.name;
    this.nameEl.textContent = '合成示範節拍中…';
    try {
      const buf = await renderDemo(kind, this.ctx.sampleRate);
      this.applyBuffer(buf, DEMO_NAMES[kind], { bpm: DEMO_BPM, firstBeat: 0 });
    } catch (err) {
      console.error(err);
      toast('示範節拍產生失敗', 'error');
      this.nameEl.textContent = this.loaded ? this.name : '拖放音樂到這裡，或按「載入音樂」';
    } finally {
      this.loading = false;
    }
  }

  applyBuffer(buf, name, beat) {
    this.playing = false;
    this.hold = { rew: false, ff: false, up: false, down: false };
    this.peaks = computePeaks(buf, PEAKS_PER_SEC);
    this.beat = beat || detectBeat(buf);
    const L = buf.getChannelData(0).slice();
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : null;
    this.node.port.postMessage({ type: 'load', L, R }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.duration = buf.duration;
    this.time = 0;
    this.rate = 0;
    this.reportAt = performance.now();
    this.cue = 0;
    this.loaded = true;
    this.name = name;
    this.nameEl.textContent = name;
    this.nameEl.title = name;
    this.cueEl.textContent = 'CUE 0:00.0';
    this.ovDirty = true;
    this.updateBpmText();
    this.setEchoTime();
    this.updateRate(0.002);
    this.root.classList.add('loaded');
  }

  /* ---------------- 繪圖 ---------------- */

  render() {
    const t = this.currentTime();
    this.vinyl.style.transform = `rotate(${(t * PLATTER_DPS) % 360}deg)`;
    if (this.loaded) {
      const e = fmtTime(t);
      const r = '-' + fmtTime(this.duration - t);
      if (e !== this._e) this.elapsedEl.textContent = this._e = e;
      if (r !== this._r) this.remainEl.textContent = this._r = r;
    }
    this.drawZoom(t);
    this.drawOverview(t);
  }

  drawZoom(t) {
    const { g, w, h } = this.zoomView;
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    const cx = Math.floor(w / 2);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, Math.floor(mid), w, 1);
    if (!this.peaks) {
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.font = '600 12px Orbitron, sans-serif';
      g.textAlign = 'center';
      g.fillText('NO TRACK', w / 2, mid + 4);
      return;
    }
    const { full, low, perSec } = this.peaks;
    const nb = full.length;

    // 節拍格線（每小節第一拍較亮）
    if (this.beat) {
      const period = 60 / this.beat.bpm;
      const t0 = t - cx / ZOOM_PPS;
      const t1 = t + (w - cx) / ZOOM_PPS;
      for (let k = Math.ceil((t0 - this.beat.firstBeat) / period); ; k++) {
        const bt = this.beat.firstBeat + k * period;
        if (bt > t1) break;
        if (bt < 0) continue;
        g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
        g.fillRect(Math.round(cx + (bt - t) * ZOOM_PPS), 0, 1, h);
      }
    }

    if (!this.colF || this.colF.length !== w) {
      this.colF = new Float32Array(w);
      this.colL = new Float32Array(w);
    }
    const colF = this.colF;
    const colL = this.colL;
    for (let x = 0; x < w; x++) {
      let b0 = Math.floor((t + (x - cx) / ZOOM_PPS) * perSec);
      let b1 = Math.floor((t + (x + 1 - cx) / ZOOM_PPS) * perSec);
      colF[x] = 0;
      colL[x] = 0;
      if (b1 < 0 || b0 >= nb) continue;
      b0 = Math.max(0, b0);
      b1 = Math.min(nb - 1, Math.max(b0, b1 - 1));
      let mf = 0;
      let ml = 0;
      for (let b = b0; b <= b1; b++) {
        if (full[b] > mf) mf = full[b];
        if (low[b] > ml) ml = low[b];
      }
      colF[x] = mf;
      colL[x] = ml;
    }
    const amp = mid - 3;
    g.fillStyle = this.def.dim;
    for (let x = 0; x < w; x++) {
      const hh = colF[x] * amp;
      if (hh > 0.3) g.fillRect(x, mid - hh, 1, hh * 2);
    }
    g.fillStyle = this.def.color;
    for (let x = 0; x < w; x++) {
      const hh = colL[x] * amp;
      if (hh > 0.3) g.fillRect(x, mid - hh, 1, hh * 2);
    }

    // 已播放區域略暗
    g.fillStyle = 'rgba(4,6,10,0.35)';
    g.fillRect(0, 0, cx, h);

    // CUE 點
    const cueX = Math.round(cx + (this.cue - t) * ZOOM_PPS);
    if (cueX >= 0 && cueX <= w) {
      g.fillStyle = '#fb923c';
      g.fillRect(cueX, 0, 2, h);
      g.beginPath();
      g.moveTo(cueX - 5, 0);
      g.lineTo(cueX + 7, 0);
      g.lineTo(cueX + 1, 7);
      g.fill();
    }

    // 播放頭
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(cx - 2, 0, 5, h);
    g.fillStyle = '#fff';
    g.fillRect(cx, 0, 1, h);
  }

  renderOverviewCache() {
    const { w, h, dpr } = this.ovView;
    const c = this.ovCache;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { full, low } = this.peaks;
    const nb = full.length;
    const mid = h / 2;
    for (let pass = 0; pass < 2; pass++) {
      const arr = pass ? low : full;
      g.fillStyle = pass ? this.def.color : this.def.dim;
      for (let x = 0; x < w; x++) {
        const b0 = Math.floor((x / w) * nb);
        const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * nb));
        let m = 0;
        for (let b = b0; b < b1 && b < nb; b++) if (arr[b] > m) m = arr[b];
        const hh = m * (mid - 1);
        g.fillRect(x, mid - hh, 1, Math.max(1, hh * 2));
      }
    }
    this.ovDirty = false;
  }

  drawOverview(t) {
    const { g, w, h } = this.ovView;
    g.clearRect(0, 0, w, h);
    if (!this.peaks || !this.duration) return;
    if (this.ovDirty) this.renderOverviewCache();
    g.drawImage(this.ovCache, 0, 0, w, h);
    const x = (t / this.duration) * w;
    g.fillStyle = 'rgba(4,6,10,0.55)';
    g.fillRect(0, 0, x, h);
    g.fillStyle = '#fb923c';
    g.fillRect(Math.round((this.cue / this.duration) * w), 0, 2, h);
    g.fillStyle = '#fff';
    g.fillRect(Math.round(x), 0, 2, h);
  }
}
