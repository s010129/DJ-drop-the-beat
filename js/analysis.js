'use strict';
/* 音訊分析：波形峰值、BPM 與第一拍位置估計 */

/** 每秒 perSec 格的峰值（全頻 full 與低頻 low），供波形顯示 */
function computePeaks(buffer, perSec) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const hop = sr / perSec;
  const count = Math.ceil(n / hop);
  const full = new Float32Array(count);
  const low = new Float32Array(count);
  const a = 1 - Math.exp((-2 * Math.PI * 200) / sr);
  let y1 = 0;
  let y2 = 0;
  let i = 0;
  let max = 0;
  for (let b = 0; b < count; b++) {
    const end = Math.min(n, Math.round((b + 1) * hop));
    let mf = 0;
    let ml = 0;
    for (; i < end; i++) {
      const m = (L[i] + R[i]) * 0.5;
      y1 += a * (m - y1);
      y2 += a * (y1 - y2);
      const am = m < 0 ? -m : m;
      if (am > mf) mf = am;
      const al = y2 < 0 ? -y2 : y2;
      if (al > ml) ml = al;
    }
    full[b] = mf;
    low[b] = ml;
    if (mf > max) max = mf;
  }
  // 正規化，小聲的檔案也看得清楚；低頻稍微放大讓大鼓更明顯
  const k = max > 0 ? 1 / max : 1;
  for (let b = 0; b < count; b++) {
    full[b] *= k;
    low[b] = Math.min(full[b], low[b] * k * 1.5);
  }
  return { perSec, full, low };
}

/**
 * 估計 BPM 與第一拍時間。
 * 作法：低頻＋全頻能量的 onset 曲線 → 自相關找週期 → 梳狀比對微調週期與相位。
 * 回傳 { bpm, firstBeat }，無法判斷時回傳 null。
 */
function detectBeat(buffer) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  if (n < sr * 8) return null;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const fps = 250;
  const hop = sr / fps;
  const start = n > sr * 70 ? Math.floor(n * 0.12) : 0;
  const end = Math.min(n, start + sr * 80);
  const frames = Math.floor((end - start) / hop);
  if (frames < fps * 6) return null;

  const eLow = new Float32Array(frames);
  const eAll = new Float32Array(frames);
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  let y1 = 0;
  let y2 = 0;
  let i = start;
  for (let f = 0; f < frames; f++) {
    const stop = start + Math.round((f + 1) * hop);
    let sl = 0;
    let sa = 0;
    for (; i < stop; i++) {
      const m = (L[i] + R[i]) * 0.5;
      y1 += a * (m - y1);
      y2 += a * (y1 - y2);
      sl += y2 * y2;
      sa += m * m;
    }
    eLow[f] = Math.log(1e-9 + sl);
    eAll[f] = Math.log(1e-9 + sa);
  }

  const onset = new Float32Array(frames);
  for (const e of [eLow, eAll]) {
    const d = new Float32Array(frames);
    let mean = 0;
    for (let f = 1; f < frames; f++) {
      const v = e[f] - e[f - 1];
      d[f] = v > 0 ? v : 0;
      mean += d[f];
    }
    mean /= frames;
    let sd = 0;
    for (let f = 0; f < frames; f++) sd += (d[f] - mean) * (d[f] - mean);
    sd = Math.sqrt(sd / frames) || 1;
    for (let f = 0; f < frames; f++) onset[f] += (d[f] - mean) / sd;
  }
  // 輕微平滑，讓梳狀比對容忍些微誤差
  const sm = new Float32Array(frames);
  for (let f = 1; f < frames - 1; f++) sm[f] = onset[f] * 0.5 + (onset[f - 1] + onset[f + 1]) * 0.25;

  const minBpm = 70;
  const maxBpm = 180;
  const lagMin = Math.floor((fps * 60) / maxBpm);
  const lagMax = Math.ceil((fps * 60) / minBpm);
  const lagTop = Math.min(lagMax * 2, frames - 1);
  const acf = new Float32Array(lagTop + 1);
  for (let lag = lagMin; lag <= lagTop; lag++) {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += sm[f] * sm[f + lag];
    acf[lag] = s / (frames - lag);
  }

  let best = 0;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.55, 2));
    let score = acf[lag] + 0.5 * (acf[lag * 2] || 0);
    score = score > 0 ? score * (0.55 + 0.45 * prior) : score;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (!best || bestScore <= 0) return null;

  // 微調：在 ±1.5 frame 內找最能對齊 onset 的週期與相位
  let bestP = best;
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let P = best - 1.5; P <= best + 1.5; P += 0.02) {
    const beats = Math.floor((frames - 1) / P);
    for (let ph = 0; ph < P; ph++) {
      let s = 0;
      for (let k = 0; k < beats; k++) {
        const idx = Math.round(ph + k * P);
        if (idx >= frames) break;
        s += sm[idx];
      }
      if (s > bestSum) {
        bestSum = s;
        bestP = P;
        bestPhase = ph;
      }
    }
  }

  let bpm = (60 * fps) / bestP;
  while (bpm < 78) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  bpm = Math.abs(bpm - Math.round(bpm)) < 0.12 ? Math.round(bpm) : Math.round(bpm * 10) / 10;
  const period = 60 / bpm;
  let firstBeat = (start + (bestPhase + 0.5) * hop) / sr;
  firstBeat = ((firstBeat % period) + period) % period;
  return { bpm, firstBeat };
}
