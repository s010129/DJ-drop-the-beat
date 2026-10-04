'use strict';
/* 共用工具：DOM、格式化、旋鈕與推桿元件、Canvas、WAV 編碼、提示訊息 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dbToGain = (db) => Math.pow(10, db / 20);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;

function fmtTime(sec, tenths = true) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  if (tenths) {
    const t = Math.floor(sec * 10);
    const m = Math.floor(t / 600);
    const s = (t % 600) / 10;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------------- WAV ---------------- */

function wavHeader(frames, sampleRate, channels = 2) {
  const bytes = frames * channels * 2;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, bytes, true);
  return buf;
}

/** 兩個聲道的 Float32 交錯成 16-bit PCM */
function floatsToInt16(L, R) {
  const n = L.length;
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const l = clamp(L[i], -1, 1);
    const r = clamp(R[i], -1, 1);
    out[2 * i] = l < 0 ? l * 0x8000 : l * 0x7fff;
    out[2 * i + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }
  return out;
}

/** 峰值超過 0.99 時整段縮小，避免匯出的 WAV 破音 */
function normalizePeak(L, R) {
  let peak = 0;
  for (let j = 0; j < L.length; j++) peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j]));
  if (peak <= 0.99) return;
  const k = 0.99 / peak;
  for (let j = 0; j < L.length; j++) {
    L[j] *= k;
    R[j] *= k;
  }
}

function makeWav(L, R, sampleRate) {
  return new Blob([wavHeader(L.length, sampleRate), floatsToInt16(L, R)], { type: 'audio/wav' });
}

function pickRecorderMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function mimeExt(mime) {
  if (mime.startsWith('audio/ogg')) return 'ogg';
  if (mime.startsWith('audio/mp4')) return 'm4a';
  return 'webm';
}

/* ---------------- Canvas（自動處理尺寸與 devicePixelRatio） ---------------- */

class CanvasView {
  constructor(canvas, onResize) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.onResize = onResize;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.onResize) this.onResize(this);
  }
}

/* ---------------- 旋鈕 ---------------- */

class Knob {
  constructor(root, opts) {
    this.root = root;
    this.min = opts.min ?? -1;
    this.max = opts.max ?? 1;
    this.def = opts.value ?? 0;
    this.value = this.def;
    this.step = opts.step || 0;
    this.bipolar = opts.bipolar ?? (this.min < 0 && this.max > 0);
    this.onChange = opts.onChange || (() => {});
    this.format = opts.format || ((v) => v.toFixed(2));
    this.label = opts.label || '';
    root.classList.add('knob');
    root.innerHTML = `<div class="knob-ring"><div class="knob-dial"><i></i></div></div><div class="knob-label"></div>`;
    root.title = `${opts.title || this.label}（上下拖曳調整、滾輪微調、雙擊歸位）`;
    this.ring = $('.knob-ring', root);
    this.dial = $('.knob-dial', root);
    this.labelEl = $('.knob-label', root);
    this.labelEl.textContent = this.label;

    let startY = 0;
    let startV = 0;
    this.ring.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.ring.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startV = this.value;
      root.classList.add('active');
      this.showValue(true);
    });
    this.ring.addEventListener('pointermove', (e) => {
      if (!this.ring.hasPointerCapture(e.pointerId)) return;
      const sens = e.shiftKey ? 600 : 160;
      this.set(startV + ((startY - e.clientY) / sens) * (this.max - this.min));
    });
    const end = () => {
      root.classList.remove('active');
      this.showValue(false);
    };
    this.ring.addEventListener('pointerup', end);
    this.ring.addEventListener('pointercancel', end);
    this.ring.addEventListener('dblclick', () => this.set(this.def));
    this.ring.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.set(this.value - Math.sign(e.deltaY) * Math.max(this.step, (this.max - this.min) / 50));
        this.showValue(true);
        clearTimeout(this._wt);
        this._wt = setTimeout(() => this.showValue(false), 700);
      },
      { passive: false }
    );
    this.render();
  }

  showValue(on) {
    this.labelEl.textContent = on ? this.format(this.value) : this.label;
    this.root.classList.toggle('show-value', on);
  }

  set(v, emit = true) {
    v = clamp(v, this.min, this.max);
    if (this.step) v = Math.round(v / this.step) * this.step;
    // 雙極旋鈕靠近中央時吸附到 0
    if (this.bipolar && Math.abs(v) < (this.max - this.min) * 0.015) v = 0;
    if (v === this.value) return;
    this.value = v;
    this.render();
    if (this.root.classList.contains('show-value')) this.labelEl.textContent = this.format(v);
    if (emit) this.onChange(v);
  }

  render() {
    const f = (this.value - this.min) / (this.max - this.min);
    const ang = -135 + f * 270;
    this.dial.style.transform = `rotate(${ang}deg)`;
    let a0 = -135;
    let a1 = ang;
    if (this.bipolar) {
      const z = -135 + ((0 - this.min) / (this.max - this.min)) * 270;
      a0 = Math.min(z, ang);
      a1 = Math.max(z, ang);
    }
    this.ring.style.setProperty('--a0', a0 + 'deg');
    this.ring.style.setProperty('--a1', a1 - a0 + 'deg');
  }
}

/* ---------------- 推桿（直式／橫式） ---------------- */

class Fader {
  constructor(root, opts) {
    this.root = root;
    this.vertical = opts.vertical ?? true;
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 1;
    this.def = opts.value ?? 0;
    this.value = this.def;
    this.onChange = opts.onChange || (() => {});
    this.cap = opts.cap || 26;
    root.classList.add('fader', this.vertical ? 'fader-v' : 'fader-h');
    root.style.setProperty('--cap', this.cap + 'px');
    root.innerHTML = `<div class="fader-slot"></div>${opts.centerTick ? '<div class="fader-tick"></div>' : ''}<div class="fader-cap"></div>`;
    if (opts.title) root.title = opts.title;

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      root.setPointerCapture(e.pointerId);
      root.classList.add('active');
      this.fromPointer(e);
    });
    root.addEventListener('pointermove', (e) => {
      if (root.hasPointerCapture(e.pointerId)) this.fromPointer(e);
    });
    const end = () => root.classList.remove('active');
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('dblclick', () => this.set(this.def));
    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const d = (this.vertical ? -Math.sign(e.deltaY) : Math.sign(e.deltaY || e.deltaX)) * ((this.max - this.min) / 60);
        this.set(this.value + d);
      },
      { passive: false }
    );
    this.render();
  }

  fromPointer(e) {
    const r = this.root.getBoundingClientRect();
    const f = this.vertical
      ? 1 - (e.clientY - r.top - this.cap / 2) / Math.max(1, r.height - this.cap)
      : (e.clientX - r.left - this.cap / 2) / Math.max(1, r.width - this.cap);
    this.set(this.min + clamp(f, 0, 1) * (this.max - this.min));
  }

  setRange(min, max) {
    this.min = min;
    this.max = max;
    this.set(clamp(this.value, min, max), true, true);
  }

  set(v, emit = true, force = false) {
    v = clamp(v, this.min, this.max);
    if (v === this.value && !force) return;
    this.value = v;
    this.render();
    if (emit) this.onChange(v);
  }

  render() {
    this.root.style.setProperty('--f', (this.value - this.min) / (this.max - this.min));
  }
}

/* ---------------- 音量表 ---------------- */

class Meter {
  constructor(el, analyser) {
    this.el = el;
    this.analyser = analyser;
    this.buf = new Float32Array(analyser.fftSize);
    this.level = 0;
    this.peak = 0;
    this.peakHold = 0;
    if (!el.firstChild) el.innerHTML = '<div class="meter-fill"></div><div class="meter-peak"></div>';
    this.fill = $('.meter-fill', el);
    this.peakEl = $('.meter-peak', el);
  }

  update(dt) {
    this.analyser.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const a = Math.abs(this.buf[i]);
      if (a > p) p = a;
    }
    const db = 20 * Math.log10(p + 1e-9);
    const v = clamp((db + 48) / 48, 0, 1);
    this.level = Math.max(v, this.level - dt * 1.6);
    if (v >= this.peak) {
      this.peak = v;
      this.peakHold = 0.8;
    } else if ((this.peakHold -= dt) <= 0) {
      this.peak = Math.max(this.level, this.peak - dt * 0.5);
    }
    this.el.style.setProperty('--lv', this.level.toFixed(3));
    this.el.style.setProperty('--pk', this.peak.toFixed(3));
    this.el.classList.toggle('clip', db > -0.5);
  }
}
