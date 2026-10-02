'use strict';
/* 合成工具：biquad 濾波與單一音色算繪；示範節拍與打擊墊音色共用 */

/** RBJ biquad 係數（寫入 out：b0 b1 b2 a1 a2，已除以 a0） */
function biquadCoefs(type, freq, q, sr, out) {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
  const cs = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = b0;
  } else if (type === 'highpass') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  out[0] = b0 / a0;
  out[1] = b1 / a0;
  out[2] = b2 / a0;
  out[3] = (-2 * cs) / a0;
  out[4] = (1 - alpha) / a0;
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * 算繪單一音色（單聲道 Float32Array）。o 的欄位：
 *   dur     長度（秒）
 *   oscs    [{ type: 'sine' | 'tri' | 'saw' | 'square' | 'noise', f, fTo, fTau, g, phase }]
 *           有 fTo 時頻率從 f 以時間常數 fTau 滑向 fTo（大鼓、筒鼓、雷射音效）
 *   filter  'lowpass' | 'highpass' | 'bandpass'，cutFrom → cutTo 指數掃頻，q 為共振
 *   attack  起音秒數；hold（0–1）維持比例；tau 衰減時間常數（不填則在結尾衰減到 -80 dB）
 *   peak    音量；drive 為 tanh 飽和量
 */
function renderVoice(sr, o) {
  const n = Math.max(1, Math.round(o.dur * sr));
  const out = new Float32Array(n);
  const oscs = o.oscs;
  const phases = oscs.map((x) => x.phase ?? (x.type === 'saw' || x.type === 'square' ? Math.random() : 0));
  const attack = o.attack ?? 0.003;
  const h = Math.max(attack, (o.hold || 0) * o.dur);
  const tail = Math.max(1e-3, o.dur - h);
  const fadeN = Math.min(n, Math.round(0.003 * sr));
  const coef = new Float64Array(5);
  const cutTo = o.cutTo ?? o.cutFrom;
  const drive = o.drive || 0;
  const dn = drive ? Math.tanh(drive) : 1;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (o.filter && (i & 15) === 0) biquadCoefs(o.filter, o.cutFrom * Math.pow(cutTo / o.cutFrom, i / n), o.q || 0.707, sr, coef);
    let x = 0;
    for (let k = 0; k < oscs.length; k++) {
      const os = oscs[k];
      if (os.type === 'noise') {
        x += (Math.random() * 2 - 1) * os.g;
        continue;
      }
      const f = os.fTo !== undefined ? os.fTo + (os.f - os.fTo) * Math.exp(-t / os.fTau) : os.f;
      let p = phases[k] + f / sr;
      if (p >= 1) p -= Math.floor(p);
      phases[k] = p;
      let v;
      switch (os.type) {
        case 'saw':
          v = 2 * p - 1;
          break;
        case 'square':
          v = p < 0.5 ? 1 : -1;
          break;
        case 'tri':
          v = 1 - 4 * Math.abs(p - 0.5);
          break;
        default:
          v = Math.sin(2 * Math.PI * p);
      }
      x += v * os.g;
    }
    let y = x;
    if (o.filter) {
      y = coef[0] * x + coef[1] * x1 + coef[2] * x2 - coef[3] * y1 - coef[4] * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
    }
    if (drive) y = Math.tanh(y * drive) / dn;
    let env = t < attack ? t / attack : t < h ? 1 : o.tau ? Math.exp(-(t - h) / o.tau) : Math.exp((-9.2 * (t - h)) / tail);
    if (i >= n - fadeN) env *= (n - i) / fadeN;
    out[i] = y * env * (o.peak ?? 1);
  }
  return out;
}

/** 多層疊加（每層可用 at 指定延遲秒數），最後正規化到 level */
function renderLayers(sr, layers, level = 0.9) {
  const parts = layers.map((l) => ({ off: Math.round((l.at || 0) * sr), data: renderVoice(sr, l) }));
  const n = Math.max(...parts.map((p) => p.off + p.data.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.data.length; i++) out[p.off + i] += p.data[i];
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) {
    const k = level / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
  }
  return out;
}

/** Float32Array（單聲道）或 [L, R] 轉成 AudioBuffer */
function toAudioBuffer(sr, data) {
  const chans = Array.isArray(data) ? data : [data];
  const buf = new AudioBuffer({ length: chans[0].length, numberOfChannels: chans.length, sampleRate: sr });
  chans.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}
