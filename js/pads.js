'use strict';
/* 4×4 打擊墊：力度、Note Repeat、16 軌 × 64 步音序器、即時錄入、取樣錄音、效果、匯出 */

const PAD_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
const PAD_CAPS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
const SEQ_ORDER = [8, 9, 10, 11, 12, 13, 14, 15, 4, 5, 6, 7, 0, 1, 2, 3]; // 音序器列順序：鼓組在上
const MAX_STEPS = 64;
const REPEAT_RATES = { 2: '1/8', 3: '1/8T', 4: '1/16', 6: '1/16T', 8: '1/32' };
const PM_STORE = 'djdtb-pads-v1';
const CUSTOM_COLOR = '#e2e8f0';

class PadMachine {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.ctx = null;
    this.kitId = 'electro';
    this.pads = Array.from({ length: 16 }, (_, i) => ({
      i,
      name: '',
      color: '#888',
      choke: null,
      buffer: null,
      rev: null,
      custom: false,
      vol: 0.85,
      pitch: 0,
      pan: 0,
      reverse: false,
      mute: false,
      solo: false,
      lit: 0,
    }));
    this.steps = Array.from({ length: 16 }, () => new Float32Array(MAX_STEPS));
    this.length = 16;
    this.page = 0;
    this.follow = true;
    this.bpm = 120;
    this.swing = 0;
    this.fx = { filter: 0, delay: 0.15, reverb: 0.15, volume: 0.9 };
    this.playing = false;
    this.recArm = false;
    this.metro = false;
    this.repeat = false;
    this.repeatDiv = 4;
    this.velMode = 'fixed';
    this.selected = 8;
    this.holders = Array.from({ length: 16 }, () => new Set());
    this.repeats = new Map();
    this.voices = [];
    this.flashes = [];
    this.log = [];
    this.skip = new Set();
    this.stepQueue = [];
    this.curStep = -1;
    this.undoSnap = null;
    this.taps = [];
    this.lastHit = null;
    this.sampling = null;
    this.restored = this.restore();
    this.applyKitNames();
    this.buildUI();
  }

  /* ---------------- 儲存 ---------------- */

  restore() {
    try {
      const s = JSON.parse(localStorage.getItem(PM_STORE) || 'null');
      if (!s) return false;
      if (KITS[s.kitId]) this.kitId = s.kitId;
      this.bpm = clamp(+s.bpm || 120, 40, 240);
      this.swing = clamp(+s.swing || 0, 0, 0.5);
      this.length = [16, 32, 48, 64].includes(s.length) ? s.length : 16;
      this.repeatDiv = REPEAT_RATES[s.repeatDiv] ? s.repeatDiv : 4;
      this.velMode = s.velMode === 'position' ? 'position' : 'fixed';
      Object.assign(this.fx, s.fx || {});
      (s.steps || []).forEach((row, i) => row.forEach((v, j) => i < 16 && j < MAX_STEPS && (this.steps[i][j] = +v || 0)));
      (s.pads || []).forEach((p, i) => {
        if (!this.pads[i]) return;
        for (const k of ['vol', 'pitch', 'pan']) if (typeof p[k] === 'number') this.pads[i][k] = p[k];
        for (const k of ['reverse', 'mute', 'solo']) this.pads[i][k] = !!p[k];
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        const steps = this.steps.map((row) => Array.from(row, (v) => Math.round(v * 100) / 100));
        const pads = this.pads.map((p) => ({ vol: p.vol, pitch: p.pitch, pan: p.pan, reverse: p.reverse, mute: p.mute, solo: p.solo }));
        localStorage.setItem(
          PM_STORE,
          JSON.stringify({ kitId: this.kitId, bpm: this.bpm, swing: this.swing, length: this.length, repeatDiv: this.repeatDiv, velMode: this.velMode, fx: this.fx, steps, pads })
        );
      } catch (err) {
        /* 無痕模式或儲存空間被封鎖：不影響使用 */
      }
    }, 400);
  }

  /** 第一次開啟時的示範節奏 */
  loadStarterPattern() {
    const set = (pad, steps, v = 0.9) => steps.forEach((s) => (this.steps[pad][s] = v));
    set(8, [0, 4, 8, 12]); // Kick
    set(12, [4, 12]); // Clap
    set(10, [2, 6, 10, 14]); // Hi-Hat
    set(10, [1, 5, 9, 13], 0.45);
    set(11, [14], 0.7); // Open Hat
    set(0, [3], 0.7); // Stab Cm
    set(1, [11], 0.7); // Stab Ab
  }

  /* ---------------- 介面 ---------------- */

  buildUI() {
    const root = this.root;
    if (!this.restored) this.loadStarterPattern();

    // 4×4 打擊墊
    const padsEl = $('#pmPads', root);
    this.padEls = this.pads.map((p, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pp';
      el.dataset.key = PAD_KEYS[i];
      el.innerHTML = `<span class="pp-name"></span><span class="pp-foot"><kbd>${PAD_CAPS[i]}</kbd><i class="pp-flag"></i></span>`;
      padsEl.appendChild(el);
      el.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.padDown(i, this.velocityFrom(e, el), 'p' + e.pointerId);
      });
      const up = (e) => this.padUp(i, 'p' + e.pointerId);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('drag');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f) this.loadFile(i, f);
      });
      return el;
    });

    // 效果旋鈕
    const knobBox = $('#pmKnobs', root);
    const mk = (label, opts) => {
      const el = document.createElement('div');
      knobBox.appendChild(el);
      return new Knob(el, { label, ...opts });
    };
    this.knobs = {
      filter: mk('FILTER', {
        min: -1,
        max: 1,
        value: this.fx.filter,
        format: (v) => (Math.abs(v) < 0.02 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`),
        onChange: (v) => this.setFx('filter', v),
      }),
      delay: mk('DELAY', { min: 0, max: 1, value: this.fx.delay, bipolar: false, format: pct, onChange: (v) => this.setFx('delay', v) }),
      reverb: mk('REVERB', { min: 0, max: 1, value: this.fx.reverb, bipolar: false, format: pct, onChange: (v) => this.setFx('reverb', v) }),
      swing: mk('SWING', { min: 0, max: 0.5, value: this.swing, bipolar: false, format: (v) => `${Math.round(50 + v * 50)}%`, onChange: (v) => this.setSwing(v) }),
      volume: mk('VOLUME', { min: 0, max: 1.2, value: this.fx.volume, bipolar: false, format: pct, onChange: (v) => this.setFx('volume', v) }),
    };
    function pct(v) {
      return `${Math.round(v * 100)}%`;
    }

    // 播放控制
    this.playBtn = $('#pmPlay', root);
    this.recBtn = $('#pmRec', root);
    this.metroBtn = $('#pmMetro', root);
    this.repeatBtn = $('#pmRepeat', root);
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.recBtn.addEventListener('click', () => this.toggleRec());
    this.metroBtn.addEventListener('click', () => this.toggleMetro());
    this.repeatBtn.addEventListener('click', () => this.toggleRepeat());
    this.bpmInput = $('#pmBpm', root);
    this.bpmInput.value = this.bpm;
    this.bpmInput.addEventListener('change', () => this.setBpm(parseFloat(this.bpmInput.value)));
    $('#pmBpmDown', root).addEventListener('click', () => this.setBpm(this.bpm - 1));
    $('#pmBpmUp', root).addEventListener('click', () => this.setBpm(this.bpm + 1));
    $('#pmTap', root).addEventListener('click', () => this.tap());

    const kitSel = $('#pmKit', root);
    kitSel.innerHTML = Object.entries(KITS)
      .map(([id, k]) => `<option value="${id}">${k.name}</option>`)
      .join('');
    kitSel.value = this.kitId;
    kitSel.addEventListener('change', () => this.loadKit(kitSel.value));
    const rateSel = $('#pmRate', root);
    rateSel.innerHTML = Object.entries(REPEAT_RATES)
      .map(([d, l]) => `<option value="${d}">${l}</option>`)
      .join('');
    rateSel.value = String(this.repeatDiv);
    rateSel.addEventListener('change', () => {
      this.repeatDiv = Number(rateSel.value);
      this.save();
    });
    const velSel = $('#pmVel', root);
    velSel.value = this.velMode;
    velSel.addEventListener('change', () => {
      this.velMode = velSel.value;
      this.save();
    });

    this.buildEditor();
    this.buildSequencer();
    this.refreshPads();
    this.select(this.selected);
    this.updateTransport();
  }

  buildEditor() {
    const root = this.root;
    this.peWave = new CanvasView($('#peWave', root), () => this.drawSample());
    const box = $('#peKnobs', root);
    const mk = (label, opts) => {
      const el = document.createElement('div');
      box.appendChild(el);
      return new Knob(el, { label, ...opts });
    };
    this.peKnobs = {
      vol: mk('VOL', { min: 0, max: 1.2, value: 0.85, bipolar: false, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => this.setPadParam('vol', v) }),
      pitch: mk('PITCH', { min: -12, max: 12, value: 0, step: 1, format: (v) => `${v > 0 ? '+' : ''}${v} 半音`, onChange: (v) => this.setPadParam('pitch', v) }),
      pan: mk('PAN', { min: -1, max: 1, value: 0, format: (v) => (Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`), onChange: (v) => this.setPadParam('pan', v) }),
    };
    $('#peReverse', root).addEventListener('click', () => this.setPadParam('reverse', !this.pads[this.selected].reverse));
    $('#peMute', root).addEventListener('click', () => this.toggleMute(this.selected));
    $('#peSolo', root).addEventListener('click', () => this.toggleSolo(this.selected));
    const file = $('#peFile', root);
    file.addEventListener('change', () => {
      const f = file.files[0];
      file.value = '';
      if (f) this.loadFile(this.selected, f);
    });
    this.sampleBtn = $('#peRecord', root);
    this.sampleBtn.addEventListener('click', () => this.toggleSampling());
    $('#peReset', root).addEventListener('click', () => this.resetPad(this.selected));
    this.clearPadBtn = $('#peClearSteps', root);
    this.clearPadBtn.addEventListener('click', () =>
      confirmTwice(this.clearPadBtn, () => {
        this.snapshot();
        this.steps[this.selected].fill(0);
        this.refreshGrid();
        this.save();
      })
    );
  }

  buildSequencer() {
    const root = this.root;
    const grid = $('#seqGrid', root);
    this.cells = Array.from({ length: 16 }, () => []);
    this.rowEls = [];
    for (const i of SEQ_ORDER) {
      const row = document.createElement('div');
      row.className = 'seq-row';
      row.dataset.i = i;
      row.innerHTML = `
        <div class="seq-label">
          <button type="button" class="seq-name" title="選擇這個 pad"><i></i><span></span><kbd>${PAD_CAPS[i]}</kbd></button>
          <button type="button" class="seq-ms m" title="靜音">M</button>
          <button type="button" class="seq-ms s" title="獨奏">S</button>
        </div>
        <div class="seq-cells">${Array.from({ length: 16 }, (_, c) => `<button type="button" class="sc${c % 4 === 0 ? ' beat' : ''}" data-i="${i}" data-c="${c}"></button>`).join('')}</div>`;
      grid.appendChild(row);
      $('.seq-name', row).addEventListener('click', () => this.select(i));
      $('.seq-ms.m', row).addEventListener('click', () => this.toggleMute(i));
      $('.seq-ms.s', row).addEventListener('click', () => this.toggleSolo(i));
      this.cells[i] = $$('.sc', row);
      this.rowEls[i] = row;
    }

    // 點格子切換；滑鼠可拖曳連續畫；觸控只在沒有捲動時才切換
    let paint = null;
    let pending = null;
    const apply = (cell, mode) => {
      const i = Number(cell.dataset.i);
      const s = this.page * 16 + Number(cell.dataset.c);
      if (s >= this.length) return;
      this.steps[i][s] = mode;
      this.paintCell(i, Number(cell.dataset.c));
    };
    const modeFor = (cell, shift) => {
      const i = Number(cell.dataset.i);
      const cur = this.steps[i][this.page * 16 + Number(cell.dataset.c)];
      return cur > 0 ? 0 : shift ? 0.45 : 0.9;
    };
    grid.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.sc');
      if (!cell) return;
      if (e.pointerType === 'mouse') {
        e.preventDefault();
        this.snapshot();
        paint = { mode: modeFor(cell, e.shiftKey), last: cell };
        apply(cell, paint.mode);
        grid.setPointerCapture(e.pointerId);
      } else {
        pending = { cell, x: e.clientX, y: e.clientY, id: e.pointerId, shift: e.shiftKey };
      }
    });
    grid.addEventListener('pointermove', (e) => {
      if (paint) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const cell = el && el.closest('.sc');
        if (cell && cell !== paint.last && grid.contains(cell)) {
          paint.last = cell;
          apply(cell, paint.mode);
        }
      } else if (pending && pending.id === e.pointerId && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 10) {
        pending = null;
      }
    });
    const end = (e) => {
      if (pending && pending.id === e.pointerId && e.type === 'pointerup') {
        this.snapshot();
        apply(pending.cell, modeFor(pending.cell, pending.shift));
      }
      if (paint || pending) this.save();
      paint = null;
      pending = null;
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);

    $$('#seqLen button', root).forEach((b) => b.addEventListener('click', () => this.setLength(Number(b.dataset.v))));
    $$('#seqPage button', root).forEach((b) =>
      b.addEventListener('click', () => {
        this.follow = false;
        $('#seqFollow', root).checked = false;
        this.setPage(Number(b.dataset.v));
      })
    );
    $('#seqFollow', root).addEventListener('change', (e) => (this.follow = e.target.checked));
    this.undoBtn = $('#seqUndo', root);
    this.undoBtn.addEventListener('click', () => this.undo());
    const clearBtn = $('#seqClear', root);
    clearBtn.addEventListener('click', () =>
      confirmTwice(clearBtn, () => {
        this.snapshot();
        this.steps.forEach((r) => r.fill(0));
        this.refreshGrid();
        this.save();
        toast('已清除整個 Pattern（可按「復原」救回）');
      })
    );
    $('#seqExport', root).addEventListener('click', () => this.exportPattern());
    this.setLength(this.length, true);
  }

  applyKitNames() {
    const kit = KITS[this.kitId];
    this.pads.forEach((p, i) => {
      if (p.custom) return;
      p.name = kit.pads[i].name;
      p.color = kit.pads[i].color;
      p.choke = kit.pads[i].choke || null;
    });
  }

  refreshPads() {
    this.pads.forEach((p, i) => {
      const el = this.padEls[i];
      el.style.setProperty('--c', p.color);
      $('.pp-name', el).textContent = p.name;
      el.classList.toggle('muted', p.mute);
      el.classList.toggle('soloed', p.solo);
      el.classList.toggle('custom', p.custom);
      el.title = `${p.name}（${PAD_CAPS[i]}）`;
      const row = this.rowEls[i];
      row.style.setProperty('--c', p.color);
      $('.seq-name span', row).textContent = p.name;
      $('.seq-ms.m', row).classList.toggle('on', p.mute);
      $('.seq-ms.s', row).classList.toggle('on', p.solo);
      row.classList.toggle('muted', !this.audible(i));
    });
    $('#scrKit', this.root).textContent = KITS[this.kitId].name;
  }

  select(i) {
    this.selected = i;
    const p = this.pads[i];
    this.padEls.forEach((el, k) => el.classList.toggle('selected', k === i));
    this.rowEls.forEach((el, k) => el && el.classList.toggle('selected', k === i));
    const root = this.root;
    $('#peSwatch', root).style.background = p.color;
    $('#peName', root).textContent = p.name;
    $('#peSub', root).textContent = `${p.custom ? '自訂取樣' : KITS[this.kitId].name} · 鍵 ${PAD_CAPS[i]}`;
    this.peKnobs.vol.set(p.vol, false);
    this.peKnobs.pitch.set(p.pitch, false);
    this.peKnobs.pan.set(p.pan, false);
    $('#peReverse', root).classList.toggle('on', p.reverse);
    $('#peMute', root).classList.toggle('on', p.mute);
    $('#peSolo', root).classList.toggle('on', p.solo);
    $('#peReset', root).disabled = !p.custom;
    $('#pmEditor', root).style.setProperty('--c', p.color);
    this.drawSample();
    this.paintScreenSteps();
  }

  drawSample() {
    if (!this.peWave) return;
    const { g, w, h } = this.peWave;
    g.clearRect(0, 0, w, h);
    const p = this.pads[this.selected];
    const buf = p && (p.reverse ? this.reversed(p) : p.buffer);
    if (!buf) {
      g.fillStyle = 'rgba(255,255,255,0.2)';
      g.font = '600 11px Orbitron, sans-serif';
      g.textAlign = 'center';
      g.fillText('NO SAMPLE', w / 2, h / 2 + 4);
      return;
    }
    const data = buf.getChannelData(0);
    const mid = h / 2;
    g.fillStyle = p.color;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * data.length);
      const b = Math.max(a + 1, Math.floor(((x + 1) / w) * data.length));
      let m = 0;
      for (let k = a; k < b; k++) m = Math.max(m, Math.abs(data[k]));
      const hh = Math.max(0.5, m * (mid - 2));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = '600 10px Orbitron, sans-serif';
    g.textAlign = 'right';
    g.fillText(`${buf.duration.toFixed(2)}s`, w - 6, 13);
  }

  /* ---------------- 音訊 ---------------- */

  initAudio(ctx) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = Math.min(20000, ctx.sampleRate * 0.45);
    this.out = ctx.createGain();
    this.bus.connect(this.hp).connect(this.lp).connect(this.out).connect(this.app.master);
    this.delaySend = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.4;
    this.lp.connect(this.delaySend).connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);
    this.delay.connect(this.out);
    this.revSend = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(ctx.sampleRate);
    this.lp.connect(this.revSend).connect(this.reverb).connect(this.out);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    this.metroGain = ctx.createGain();
    this.metroGain.gain.value = 0.5;
    this.metroGain.connect(ctx.destination); // 節拍器不進錄音
    this.clicks = [1760, 1175].map((f) => toAudioBuffer(ctx.sampleRate, renderVoice(ctx.sampleRate, { dur: 0.04, oscs: [{ type: 'sine', f, g: 1 }], attack: 0.001, tau: 0.01, peak: 0.6 })));

    this.padOut = this.pads.map((p) => {
      const g = ctx.createGain();
      g.gain.value = p.vol;
      const pan = ctx.createStereoPanner();
      pan.pan.value = p.pan;
      g.connect(pan).connect(this.bus);
      return { g, pan };
    });

    for (const k of ['filter', 'delay', 'reverb', 'volume']) this.setFx(k, this.fx[k]);
    this.loadKit(this.kitId);
    this.timer = setInterval(() => this.tick(), 25);
  }

  makeImpulse(sr) {
    const n = Math.round(sr * 2.4);
    const pre = Math.round(sr * 0.012);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = pre; i < n; i++) {
      const e = Math.exp(-(i - pre) / (sr * 0.45));
      L[i] = (Math.random() * 2 - 1) * e;
      R[i] = (Math.random() * 2 - 1) * e;
    }
    return toAudioBuffer(sr, [L, R]);
  }

  loadKit(id) {
    if (!KITS[id]) return;
    this.kitId = id;
    this.applyKitNames();
    if (this.ctx) {
      const sr = this.ctx.sampleRate;
      KITS[id].pads.forEach((def, i) => {
        const p = this.pads[i];
        if (p.custom) return;
        p.buffer = toAudioBuffer(sr, def.make(sr));
        p.rev = null;
      });
    }
    $('#pmKit', this.root).value = id;
    this.refreshPads();
    this.select(this.selected);
    this.save();
  }

  setFx(name, v) {
    this.fx[name] = v;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      if (name === 'filter') {
        const top = Math.min(20000, this.ctx.sampleRate * 0.45);
        const lp = v < -0.02 ? top * Math.pow(150 / top, (-v - 0.02) / 0.98) : top;
        const hp = v > 0.02 ? 10 * Math.pow(600, (v - 0.02) / 0.98) : 10;
        this.lp.frequency.setTargetAtTime(lp, t, 0.02);
        this.hp.frequency.setTargetAtTime(hp, t, 0.02);
        this.lp.Q.setTargetAtTime(Math.abs(v) > 0.02 ? 1.4 : 0.707, t, 0.02);
        this.hp.Q.setTargetAtTime(Math.abs(v) > 0.02 ? 1.4 : 0.707, t, 0.02);
      } else if (name === 'delay') {
        this.delaySend.gain.setTargetAtTime(v * 0.7, t, 0.02);
        this.updateDelayTime();
      } else if (name === 'reverb') {
        this.revSend.gain.setTargetAtTime(v * 0.9, t, 0.02);
      } else if (name === 'volume') {
        this.out.gain.setTargetAtTime(v, t, 0.02);
      }
    }
    this.save();
  }

  /** 回音 = 3/16 拍（3 個 16 分音符） */
  updateDelayTime() {
    if (this.ctx) this.delay.delayTime.setTargetAtTime(Math.min(1.9, this.stepDur() * 3), this.ctx.currentTime, 0.05);
  }

  setPadParam(name, v) {
    const i = this.selected;
    const p = this.pads[i];
    p[name] = v;
    if (this.ctx && (name === 'vol' || name === 'pan')) {
      const t = this.ctx.currentTime;
      if (name === 'vol') this.padOut[i].g.gain.setTargetAtTime(v, t, 0.01);
      else this.padOut[i].pan.pan.setTargetAtTime(v, t, 0.01);
    }
    if (name === 'reverse') {
      $('#peReverse', this.root).classList.toggle('on', v);
      this.drawSample();
    }
    this.save();
  }

  toggleMute(i) {
    this.pads[i].mute = !this.pads[i].mute;
    this.afterMuteSolo(i);
  }

  toggleSolo(i) {
    this.pads[i].solo = !this.pads[i].solo;
    this.afterMuteSolo(i);
  }

  afterMuteSolo(i) {
    this.refreshPads();
    if (i === this.selected) this.select(i);
    this.save();
  }

  /** 靜音／獨奏只影響音序器播放，手動打 pad 永遠有聲音 */
  audible(i) {
    if (this.pads.some((p) => p.solo)) return this.pads[i].solo;
    return !this.pads[i].mute;
  }

  reversed(p) {
    if (!p.buffer) return null;
    if (!p.rev) {
      const b = p.buffer;
      p.rev = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
      for (let c = 0; c < b.numberOfChannels; c++) p.rev.copyToChannel(b.getChannelData(c).slice().reverse(), c);
    }
    return p.rev;
  }

  /** 在 when（AudioContext 時間）播放第 i 個 pad */
  trigger(i, vel, when) {
    const ctx = this.ctx;
    const p = this.pads[i];
    const buf = p.reverse ? this.reversed(p) : p.buffer;
    if (!ctx || !buf) return;
    when = Math.max(when, ctx.currentTime);
    // 同一個 pad 幾乎同時被觸發兩次（即時錄入＋音序器）時只播一次
    if (this.voices.some((v) => v.pad === i && Math.abs(v.start - when) < 0.004)) return;
    if (p.choke) {
      for (const v of this.voices) {
        if (v.choke === p.choke && v.start < when + 0.001) {
          v.g.gain.setTargetAtTime(0, when, 0.008);
          try {
            v.src.stop(when + 0.06);
          } catch (err) {
            /* 已經停止 */
          }
        }
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, p.pitch / 12);
    const g = ctx.createGain();
    g.gain.value = Math.pow(clamp(vel, 0.05, 1), 1.6);
    src.connect(g).connect(this.padOut[i].g);
    src.start(when);
    const voice = { src, g, pad: i, choke: p.choke, start: when };
    this.voices.push(voice);
    src.onended = () => {
      g.disconnect();
      const k = this.voices.indexOf(voice);
      if (k >= 0) this.voices.splice(k, 1);
    };
    if (this.voices.length > 96) {
      const old = this.voices.shift();
      try {
        old.src.stop();
      } catch (err) {
        /* 已經停止 */
      }
    }
    this.flashes.push({ i, vel, t: when });
  }

  velocityFrom(e, el) {
    if (e.pointerType === 'pen' && e.pressure > 0) return clamp(e.pressure * 1.2, 0.15, 1);
    if (this.velMode === 'position') {
      const r = el.getBoundingClientRect();
      return clamp(0.3 + 0.7 * (1 - (e.clientY - r.top) / r.height), 0.15, 1);
    }
    return 0.9;
  }

  padDown(i, vel, holder) {
    if (!this.ctx) {
      this.app.start();
      return;
    }
    if (this.selected !== i) this.select(i);
    const now = this.ctx.currentTime;
    this.trigger(i, vel, now);
    this.recordHit(i, vel, now, true);
    this.lastHit = { i, vel };
    this.holders[i].add(holder);
    if (this.repeat && !this.repeats.has(i)) this.repeats.set(i, { vel, next: this.nextRepeatTime(now) });
  }

  padUp(i, holder) {
    const h = this.holders[i];
    if (!h.has(holder)) return;
    h.delete(holder);
    if (!h.size) this.repeats.delete(i);
  }

  /* ---------------- 音序器 ---------------- */

  stepDur() {
    return 60 / this.bpm / 4;
  }

  repeatDur() {
    return 60 / this.bpm / this.repeatDiv;
  }

  swingOffset(step) {
    return step % 2 ? this.swing * this.stepDur() : 0;
  }

  nextRepeatTime(now) {
    const rd = this.repeatDur();
    if (!this.playing) return now + rd;
    let next = this.gridTime + Math.ceil((now + 0.01 - this.gridTime) / rd) * rd;
    if (next <= now + 0.01) next += rd;
    return next;
  }

  tick() {
    const ctx = this.ctx;
    const horizon = ctx.currentTime + 0.12;
    if (this.playing) {
      if (this.step >= this.length) this.step = 0;
      while (this.gridTime + this.swingOffset(this.step) < horizon) {
        const t = this.gridTime + this.swingOffset(this.step);
        this.scheduleStep(this.step, t);
        this.gridTime += this.stepDur();
        this.step = (this.step + 1) % this.length;
      }
    }
    for (const [i, r] of this.repeats) {
      while (r.next < horizon) {
        this.trigger(i, r.vel, r.next);
        this.recordHit(i, r.vel, r.next, false);
        r.next += this.repeatDur();
      }
    }
  }

  scheduleStep(step, t) {
    for (let i = 0; i < 16; i++) {
      const v = this.steps[i][step];
      if (v > 0 && this.audible(i)) {
        if (this.skip.delete(i * 100 + step)) continue;
        this.trigger(i, v, t);
      }
    }
    if (this.metro && step % 4 === 0) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.clicks[step % 16 === 0 ? 0 : 1];
      src.connect(this.metroGain);
      src.start(t);
    }
    this.log.push({ step, time: t });
    if (this.log.length > 32) this.log.shift();
    this.stepQueue.push({ step, t });
  }

  /** 錄入模式：把打擊對齊到最近的 16 分音符 */
  recordHit(i, vel, t, live) {
    if (!this.recArm || !this.playing) return;
    const target = live ? t - this.app.outputLatency() : t;
    let best = null;
    let bd = Infinity;
    for (const e of this.log) {
      const d = Math.abs(e.time - target);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    const nextT = this.gridTime + this.swingOffset(this.step);
    if (Math.abs(nextT - target) < bd) best = { step: this.step, pending: true };
    if (!best) return;
    const wasOn = this.steps[i][best.step] > 0;
    this.steps[i][best.step] = Math.max(this.steps[i][best.step], vel);
    if (best.pending && !wasOn && live) this.skip.add(i * 100 + best.step);
    const c = best.step - this.page * 16;
    if (c >= 0 && c < 16) this.paintCell(i, c);
    if (i === this.selected) this.paintScreenSteps();
    this.save();
  }

  togglePlay() {
    if (!this.ctx) return;
    if (this.playing) this.stop();
    else this.play();
  }

  play() {
    this.playing = true;
    this.step = 0;
    this.gridTime = this.ctx.currentTime + 0.06;
    this.log = [];
    this.skip.clear();
    this.updateTransport();
  }

  stop() {
    this.playing = false;
    this.stepQueue = [];
    this.setCurStep(-1);
    this.updateTransport();
  }

  toggleRec() {
    if (!this.ctx) return;
    this.recArm = !this.recArm;
    if (this.recArm) {
      this.snapshot();
      if (!this.playing) this.play();
      toast('錄入中：邊播放邊打 pad，會自動對齊到 16 分音符');
    }
    this.updateTransport();
  }

  toggleMetro() {
    this.metro = !this.metro;
    this.updateTransport();
  }

  toggleRepeat() {
    this.repeat = !this.repeat;
    if (!this.repeat) this.repeats.clear();
    else if (this.ctx) {
      const now = this.ctx.currentTime;
      this.holders.forEach((h, i) => h.size && this.repeats.set(i, { vel: 0.9, next: this.nextRepeatTime(now) }));
    }
    this.updateTransport();
  }

  updateTransport() {
    this.playBtn.classList.toggle('on', this.playing);
    $('span', this.playBtn).textContent = this.playing ? '■ 停止' : '▶ 播放';
    this.recBtn.classList.toggle('on', this.recArm);
    this.metroBtn.classList.toggle('on', this.metro);
    this.repeatBtn.classList.toggle('on', this.repeat);
    $('span', this.repeatBtn).textContent = `連打 ${REPEAT_RATES[this.repeatDiv]}`;
    this.root.classList.toggle('is-playing', this.playing);
    this.root.classList.toggle('is-rec', this.recArm);
  }

  setBpm(v) {
    if (!isFinite(v)) v = this.bpm;
    this.bpm = Math.round(clamp(v, 40, 240) * 10) / 10;
    this.bpmInput.value = this.bpm;
    this.updateDelayTime();
    this.save();
  }

  setSwing(v) {
    this.swing = v;
    this.save();
  }

  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length >= 2) this.setBpm(60000 / ((this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1)));
  }

  setLength(n, init) {
    this.length = n;
    $$('#seqLen button', this.root).forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === n));
    $$('#seqPage button', this.root).forEach((b) => (b.disabled = Number(b.dataset.v) * 16 >= n));
    if (this.page * 16 >= n) this.page = 0;
    this.setPage(this.page);
    if (!init) this.save();
  }

  setPage(p) {
    p = clamp(p, 0, this.length / 16 - 1);
    this.page = p;
    $$('#seqPage button', this.root).forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === p));
    this.refreshGrid();
  }

  refreshGrid() {
    for (let i = 0; i < 16; i++) for (let c = 0; c < 16; c++) this.paintCell(i, c);
    this.markColumn();
    this.paintScreenSteps();
  }

  paintCell(i, c) {
    const v = this.steps[i][this.page * 16 + c];
    const el = this.cells[i][c];
    el.classList.toggle('on', v > 0);
    el.classList.toggle('soft', v > 0 && v < 0.6);
  }

  setCurStep(s) {
    this.curStep = s;
    if (s >= 0 && this.follow && this.length > 16 && Math.floor(s / 16) !== this.page) this.setPage(Math.floor(s / 16));
    this.markColumn();
    this.paintScreenSteps();
  }

  markColumn() {
    const col = this.curStep >= 0 && Math.floor(this.curStep / 16) === this.page ? this.curStep % 16 : -1;
    if (col === this._col) return;
    if (this._col >= 0) for (let i = 0; i < 16; i++) this.cells[i][this._col].classList.remove('now');
    if (col >= 0) for (let i = 0; i < 16; i++) this.cells[i][col].classList.add('now');
    this._col = col;
  }

  /** 螢幕上的 16 格：顯示選中 pad 在這一頁的音符與播放位置（就像硬體的 16 個步進鍵） */
  paintScreenSteps() {
    const box = $('#scrSteps', this.root);
    if (!box.children.length) box.innerHTML = '<i></i>'.repeat(16);
    const row = this.steps[this.selected];
    [...box.children].forEach((el, c) => {
      const s = this.page * 16 + c;
      el.className = (row[s] > 0 ? 'on' : '') + (s === this.curStep ? ' now' : '') + (s >= this.length ? ' off' : '');
    });
  }

  snapshot() {
    this.undoSnap = this.steps.map((r) => r.slice());
    this.undoBtn.disabled = false;
  }

  /** 復原與重做：和上一次的快照互換 */
  undo() {
    if (!this.undoSnap) return;
    const cur = this.steps.map((r) => r.slice());
    this.undoSnap.forEach((r, i) => this.steps[i].set(r));
    this.undoSnap = cur;
    this.refreshGrid();
    this.save();
  }

  /* ---------------- 取樣與音色 ---------------- */

  async loadFile(i, file) {
    await this.app.start();
    try {
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.assignBuffer(i, buf, file.name.replace(/\.[^.]+$/, '').slice(0, 18));
      toast(`已載入「${file.name}」到 pad ${PAD_CAPS[i]}`);
    } catch (err) {
      console.error(err);
      toast(`無法解碼「${file.name}」`, 'error');
    }
  }

  assignBuffer(i, buf, name) {
    const p = this.pads[i];
    p.buffer = buf;
    p.rev = null;
    p.custom = true;
    p.name = name;
    p.color = CUSTOM_COLOR;
    p.choke = null;
    this.refreshPads();
    this.select(i);
  }

  resetPad(i) {
    const p = this.pads[i];
    p.custom = false;
    const def = KITS[this.kitId].pads[i];
    p.name = def.name;
    p.color = def.color;
    p.choke = def.choke || null;
    if (this.ctx) p.buffer = toAudioBuffer(this.ctx.sampleRate, def.make(this.ctx.sampleRate));
    p.rev = null;
    this.refreshPads();
    this.select(i);
  }

  async toggleSampling() {
    if (this.sampling) {
      if (!this.sampling.stopping) this.stopSampling();
      return;
    }
    const ok = await this.app.enableMic();
    if (!ok) return;
    if (!this.sampler) {
      this.sampler = new AudioWorkletNode(this.ctx, 'dj-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.sampler.port.onmessage = (e) => this.onSamplerMessage(e.data);
      this.app.micBus.connect(this.sampler);
      this.sampler.connect(this.ctx.destination); // 輸出是靜音
    }
    this.sampling = { pad: this.selected, L: [], R: [], frames: 0, start: performance.now() };
    this.sampler.port.postMessage({ type: 'start' });
    this.sampleBtn.classList.add('on');
  }

  stopSampling() {
    this.sampling.stopping = true;
    this.sampler.port.postMessage({ type: 'stop' });
  }

  onSamplerMessage(m) {
    const s = this.sampling;
    if (!s) return;
    if (m.type === 'data') {
      s.L.push(m.L);
      s.R.push(m.R);
      s.frames += m.L.length;
      return;
    }
    if (m.type !== 'stopped') return;
    this.sampling = null;
    this.sampleBtn.classList.remove('on');
    this.sampleBtn.textContent = '錄音取樣';
    const join = (parts) => {
      const out = new Float32Array(s.frames);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    };
    const L = join(s.L);
    const R = join(s.R);
    let peak = 0;
    for (let k = 0; k < L.length; k++) peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
    if (peak < 0.003) {
      toast('沒有錄到聲音，請檢查麥克風', 'error');
      return;
    }
    // 去掉頭尾的靜音並正規化
    const th = Math.max(0.01, peak * 0.06);
    const sr = this.ctx.sampleRate;
    let a = 0;
    while (a < L.length && Math.abs(L[a]) < th && Math.abs(R[a]) < th) a++;
    let b = L.length - 1;
    while (b > a && Math.abs(L[b]) < th && Math.abs(R[b]) < th) b--;
    a = Math.max(0, a - Math.round(0.005 * sr));
    b = Math.min(L.length, b + Math.round(0.08 * sr));
    const k = 0.9 / peak;
    const cl = L.slice(a, b).map((v) => v * k);
    const cr = R.slice(a, b).map((v) => v * k);
    this.sampleCount = (this.sampleCount || 0) + 1;
    this.assignBuffer(s.pad, toAudioBuffer(sr, [cl, cr]), `錄音 ${this.sampleCount}`);
    toast(`取樣完成，已放到 pad ${PAD_CAPS[s.pad]}（${((b - a) / sr).toFixed(2)} 秒）`, 'ok');
  }

  /* ---------------- 匯出 ---------------- */

  /** 把 Pattern 算成一段可無縫循環的 WAV：算兩圈、取第二圈，讓回音與殘響尾巴接回開頭 */
  async exportPattern() {
    await this.app.start();
    const any = this.steps.some((r, i) => this.audible(i) && r.subarray(0, this.length).some((v) => v > 0));
    if (!any) {
      toast('Pattern 是空的');
      return;
    }
    const btn = $('#seqExport', this.root);
    btn.disabled = true;
    btn.textContent = '算繪中…';
    try {
      const sr = this.ctx.sampleRate;
      const d = this.stepDur();
      const cycle = this.length * d;
      const N = Math.round(cycle * sr);
      const oc = new OfflineAudioContext(2, N * 2, sr);
      const hp = oc.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = this.hp.frequency.value;
      hp.Q.value = this.hp.Q.value;
      const lp = oc.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = this.lp.frequency.value;
      lp.Q.value = this.lp.Q.value;
      const out = oc.createGain();
      out.gain.value = this.fx.volume;
      const bus = oc.createGain();
      bus.connect(hp).connect(lp).connect(out).connect(oc.destination);
      const ds = oc.createGain();
      ds.gain.value = this.fx.delay * 0.7;
      const dl = oc.createDelay(2);
      dl.delayTime.value = Math.min(1.9, d * 3);
      const fb = oc.createGain();
      fb.gain.value = 0.4;
      lp.connect(ds).connect(dl);
      dl.connect(fb).connect(dl);
      dl.connect(out);
      const rs = oc.createGain();
      rs.gain.value = this.fx.reverb * 0.9;
      const rv = oc.createConvolver();
      rv.buffer = this.reverb.buffer;
      lp.connect(rs).connect(rv).connect(out);
      const padOut = this.pads.map((p) => {
        const g = oc.createGain();
        g.gain.value = p.vol;
        const pan = oc.createStereoPanner();
        pan.pan.value = p.pan;
        g.connect(pan).connect(bus);
        return g;
      });
      const lastInGroup = {};
      for (let c = 0; c < 2; c++) {
        for (let s = 0; s < this.length; s++) {
          const t = c * cycle + s * d + this.swingOffset(s);
          for (let i = 0; i < 16; i++) {
            const v = this.steps[i][s];
            const p = this.pads[i];
            const buf = p.reverse ? this.reversed(p) : p.buffer;
            if (!(v > 0) || !buf || !this.audible(i)) continue;
            const src = oc.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = Math.pow(2, p.pitch / 12);
            const g = oc.createGain();
            g.gain.value = Math.pow(v, 1.6);
            src.connect(g).connect(padOut[i]);
            src.start(t);
            if (p.choke) {
              const prev = lastInGroup[p.choke];
              if (prev) prev.gain.setTargetAtTime(0, t, 0.008);
              lastInGroup[p.choke] = g;
            }
          }
        }
      }
      const rendered = await oc.startRendering();
      const L = rendered.getChannelData(0).slice(N, N * 2);
      const R = rendered.getChannelData(1).slice(N, N * 2);
      let peak = 0;
      for (let k = 0; k < N; k++) peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
      if (peak > 0.99) {
        const k = 0.99 / peak;
        for (let j = 0; j < N; j++) {
          L[j] *= k;
          R[j] *= k;
        }
      }
      this.app.addExport(makeWav(L, R, sr), `pattern-${this.bpm}bpm-${stamp()}.wav`, cycle, true);
    } catch (err) {
      console.error(err);
      toast('匯出失敗：' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ 匯出 Pattern';
    }
  }

  /* ---------------- 畫面 ---------------- */

  render(dt) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    while (this.stepQueue.length && this.stepQueue[0].t <= now) this.setCurStep(this.stepQueue.shift().step);
    for (let k = this.flashes.length - 1; k >= 0; k--) {
      const f = this.flashes[k];
      if (f.t <= now) {
        this.pads[f.i].lit = Math.max(this.pads[f.i].lit, 0.35 + 0.65 * f.vel);
        this.flashes.splice(k, 1);
      }
    }
    this.pads.forEach((p, i) => {
      const held = this.holders[i].size > 0;
      const target = held ? Math.max(p.lit, 0.55) : p.lit;
      p.lit = Math.max(0, p.lit - dt * 3.2);
      const v = Math.round(target * 50) / 50;
      if (v !== p._shown) {
        p._shown = v;
        this.padEls[i].style.setProperty('--lit', v);
      }
    });

    const scr = (id, text) => {
      if (this['_' + id] !== text) {
        this['_' + id] = text;
        $('#' + id, this.root).textContent = text;
      }
    };
    scr('scrBpm', this.bpm.toFixed(1));
    scr('scrMode', this.recArm ? '● REC' : this.playing ? '▶ PLAY' : '■ STOP');
    scr('scrStep', `STEP ${this.curStep >= 0 ? String(this.curStep + 1).padStart(2, '0') : '--'}/${this.length}`);
    scr('scrHit', this.lastHit ? `${this.pads[this.lastHit.i].name} · ${Math.round(this.lastHit.vel * 127)}` : '—');

    if (this.sampling && !this.sampling.stopping) {
      const secs = (performance.now() - this.sampling.start) / 1000;
      this.sampleBtn.textContent = `■ 停止（${secs.toFixed(1)}s）`;
      if (secs >= 10) this.stopSampling();
    }
  }
}

/** 第一次按把按鈕變成「確定?」，2 秒內再按一次才執行 */
function confirmTwice(btn, fn) {
  if (btn.classList.contains('confirm')) {
    btn.classList.remove('confirm');
    btn.textContent = btn.dataset.label;
    clearTimeout(btn._ct);
    fn();
    return;
  }
  btn.dataset.label = btn.textContent;
  btn.classList.add('confirm');
  btn.textContent = '確定?';
  btn._ct = setTimeout(() => {
    btn.classList.remove('confirm');
    btn.textContent = btn.dataset.label;
  }, 2000);
}
