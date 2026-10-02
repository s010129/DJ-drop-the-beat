'use strict';
/* 示範節拍：直接在 Float32Array 裡合成鼓組、貝斯與和弦，沒有音檔也能馬上玩 */

const DEMO_BPM = 124;
const DEMO_NAMES = { A: 'Demo A · Neon House', B: 'Demo B · Midnight Acid' };

async function renderDemo(kind, sr) {
  await new Promise((r) => setTimeout(r, 20)); // 先讓「合成中…」顯示出來
  const beat = 60 / DEMO_BPM;
  const step = beat / 4;
  const bars = 32;
  const length = Math.ceil((bars * 16 * step + 1.5) * sr);
  const buf = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: sr });
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const S = new Float32Array(length); // 回音 send
  const hz = midiHz;

  /** 把算好的音色加進立體聲緩衝（等功率聲像，send 送進回音） */
  function mixIn(data, t, pan = 0, send = 0) {
    const s0 = Math.round(t * sr);
    const n = Math.min(data.length, length - s0);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      L[s0 + i] += v * gl;
      R[s0 + i] += v * gr;
      if (send) S[s0 + i] += v * send;
    }
  }

  const kick = (t, peak = 1) =>
    mixIn(renderVoice(sr, { dur: 0.45, oscs: [{ type: 'sine', f: 155, fTo: 46, fTau: 0.028, g: 1 }], attack: 0.002, tau: 0.13, peak: peak * 0.9 }), t);
  const voice = (o) => mixIn(renderVoice(sr, o), o.t, o.pan || 0, o.send || 0);

  const noiseOsc = [{ type: 'noise', g: 1 }];
  const hat = (t, open, peak = 0.26) =>
    voice({ t, dur: open ? 0.22 : 0.05, oscs: noiseOsc, filter: 'highpass', cutFrom: 7600, q: 0.8, peak: open ? peak * 0.8 : peak, attack: 0.001, pan: 0.22 });
  function clap(t) {
    for (let k = 0; k < 3; k++) voice({ t: t + k * 0.012, dur: 0.03, oscs: noiseOsc, filter: 'bandpass', cutFrom: 1400, q: 1.2, peak: 1.4, attack: 0.001, pan: -0.12 });
    voice({ t: t + 0.036, dur: 0.2, oscs: noiseOsc, filter: 'bandpass', cutFrom: 1250, q: 0.9, peak: 1.1, attack: 0.001, pan: -0.12 });
  }
  const bass = (t, midi, dur, bright = 700) =>
    voice({
      t,
      dur,
      oscs: [
        { type: 'saw', f: hz(midi), g: 1 },
        { type: 'sine', f: hz(midi), g: 0.6 },
      ],
      filter: 'lowpass',
      cutFrom: bright,
      cutTo: 140,
      q: 5,
      peak: 0.42,
      attack: 0.006,
      hold: 0.6,
    });
  const stab = (t, notes, dur, peak = 0.14) =>
    voice({
      t,
      dur,
      oscs: notes.flatMap((m) => [-8, 8].map((c) => ({ type: 'saw', f: hz(m) * Math.pow(2, c / 1200), g: 1 }))),
      filter: 'lowpass',
      cutFrom: 3400,
      cutTo: 600,
      q: 2,
      peak,
      attack: 0.004,
      send: 1,
    });
  const acid = (t, midi, dur, cutoff, peak = 0.11) =>
    voice({
      t,
      dur,
      oscs: [{ type: 'saw', f: hz(midi), g: 1 }],
      filter: 'lowpass',
      cutFrom: cutoff,
      cutTo: Math.max(180, cutoff * 0.25),
      q: 11,
      peak,
      attack: 0.003,
      send: 1,
    });

  if (kind === 'A') {
    // A 小調 house：Am7 – Fmaj7 – C – G，每 8 小節一段（前奏／律動／Breakdown／Drop）
    const roots = [33, 29, 36, 31];
    const chords = [
      [57, 60, 64, 67],
      [53, 57, 60, 64],
      [55, 60, 64, 67],
      [55, 59, 62, 67],
    ];
    for (let bar = 0; bar < bars; bar++) {
      const t0 = bar * 16 * step;
      const sec = Math.floor(bar / 8);
      const root = roots[bar % 4];
      const chord = chords[bar % 4];
      const drums = sec !== 2;
      for (let s = 0; s < 16; s++) {
        const t = t0 + s * step;
        if (s % 4 === 0 && drums) kick(t);
        if (sec === 2 && bar % 8 === 7 && s % 2 === 0) kick(t, 0.25 + s / 24);
        if (s % 4 === 2) hat(t, sec === 1 || sec === 3);
        if (sec === 3 && s % 2 === 1) hat(t, false, 0.12);
        if ((s === 4 || s === 12) && (bar >= 4 || sec > 0) && drums) clap(t);
        if ((sec === 1 || sec === 3) && s % 4 === 2) bass(t, root, step * 1.7, sec === 3 ? 1100 : 750);
        if ((sec === 1 || sec === 3) && (s === 3 || s === 6 || s === 11)) stab(t, chord, 0.2);
      }
      if (sec === 2) stab(t0, chord, beat * 3.5, 0.09);
    }
  } else {
    // D 小調 acid：16 分音符滾動貝斯 + 共振濾波的 acid 旋律
    const seq = [62, 62, 74, 62, 65, 62, 72, 69, 62, 62, 74, 62, 77, 74, 72, 69];
    const bassNotes = [38, 38, 41, 36];
    for (let bar = 0; bar < bars; bar++) {
      const t0 = bar * 16 * step;
      const sec = Math.floor(bar / 8);
      const drums = sec !== 2;
      const sweep = 400 + 2600 * (0.5 - 0.5 * Math.cos(((bar % 8) / 8) * Math.PI * 2));
      for (let s = 0; s < 16; s++) {
        const t = t0 + s * step;
        if (s % 4 === 0 && drums) kick(t);
        if (sec === 2 && bar % 8 >= 6 && s % (bar % 8 === 7 ? 1 : 2) === 0) kick(t, 0.2 + s / 30);
        hat(t, s % 4 === 2 && sec >= 1, s % 4 === 2 ? 0.24 : 0.1);
        if ((s === 4 || s === 12) && sec >= 1 && drums) clap(t);
        if (s % 4 !== 0 && drums && bar >= 4) bass(t, bassNotes[bar % 4], step * 0.9, 500);
        if (sec >= 1) acid(t, seq[s] - (bar % 4 === 3 ? 2 : 0), step * 0.9, sweep, sec === 3 ? 0.13 : 0.1);
      }
    }
  }

  // 回音（3/16 拍的回授延遲）
  const D = Math.round(step * 3 * sr);
  const E = new Float32Array(length);
  for (let i = D; i < length; i++) {
    E[i] = S[i - D] + 0.38 * E[i - D];
    L[i] += E[i] * 0.4;
    R[i] += E[i] * 0.4;
  }

  // 正規化 + 柔和飽和
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak > 0 ? 1.3 / peak : 1;
  const norm = Math.tanh(1.3);
  for (let i = 0; i < length; i++) {
    L[i] = (Math.tanh(L[i] * k) / norm) * 0.89;
    R[i] = (Math.tanh(R[i] * k) / norm) * 0.89;
  }
  return buf;
}
