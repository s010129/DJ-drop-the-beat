'use strict';
/* 打擊墊音色組：全部即時合成。順序是畫面上的 4×4，由左上到右下 */

const PAD_COLORS = {
  kick: '#f43f5e',
  snare: '#fb923c',
  hat: '#facc15',
  perc: '#34d399',
  tom: '#22d3ee',
  cym: '#fde68a',
  fx: '#a78bfa',
  synth: '#f472b6',
  bass: '#60a5fa',
};

const NOISE = [{ type: 'noise', g: 1 }];
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => ({ type: 'square', f, g: 0.4 }));
const detuned = (notes, cents = 8, type = 'saw') =>
  notes.flatMap((m) => [-cents, cents].map((c) => ({ type, f: midiHz(m) * Math.pow(2, c / 1200), g: 1 })));

const SOUND = {
  kick: (sr) =>
    renderLayers(sr, [
      { dur: 0.55, oscs: [{ type: 'sine', f: 165, fTo: 48, fTau: 0.032, g: 1 }], attack: 0.001, tau: 0.15 },
      { dur: 0.012, oscs: NOISE, filter: 'highpass', cutFrom: 3000, attack: 0.0005, tau: 0.003, peak: 0.3 },
    ], 0.95),
  kick808: (sr) =>
    renderLayers(sr, [{ dur: 1.3, oscs: [{ type: 'sine', f: 120, fTo: 48, fTau: 0.06, g: 1 }], attack: 0.001, tau: 0.42, drive: 1.4 }], 0.95),
  snare: (sr) =>
    renderLayers(sr, [
      { dur: 0.25, oscs: [{ type: 'sine', f: 220, fTo: 180, fTau: 0.04, g: 1 }], attack: 0.001, tau: 0.07, peak: 0.7 },
      { dur: 0.3, oscs: NOISE, filter: 'bandpass', cutFrom: 2500, q: 0.6, attack: 0.001, tau: 0.09, peak: 0.9 },
    ], 0.8),
  snare808: (sr) =>
    renderLayers(sr, [
      { dur: 0.3, oscs: [{ type: 'sine', f: 238, g: 1 }, { type: 'sine', f: 476, g: 0.5 }], attack: 0.001, tau: 0.08, peak: 0.7 },
      { dur: 0.35, oscs: NOISE, filter: 'highpass', cutFrom: 1800, attack: 0.001, tau: 0.12, peak: 0.8 },
    ], 0.8),
  clap: (sr, tail = 0.09) =>
    renderLayers(sr, [
      ...[0, 0.011, 0.022].map((at) => ({ at, dur: 0.03, oscs: NOISE, filter: 'bandpass', cutFrom: 1400, q: 1.2, attack: 0.0005 })),
      { at: 0.033, dur: tail * 3.5, oscs: NOISE, filter: 'bandpass', cutFrom: 1250, q: 0.9, attack: 0.001, tau: tail, peak: 0.9 },
    ], 0.8),
  hat: (sr) => renderLayers(sr, [{ dur: 0.08, oscs: NOISE, filter: 'highpass', cutFrom: 7500, q: 0.8, attack: 0.0005, tau: 0.018 }], 0.55),
  openHat: (sr) => renderLayers(sr, [{ dur: 0.5, oscs: NOISE, filter: 'highpass', cutFrom: 6800, q: 0.8, attack: 0.001, tau: 0.14 }], 0.5),
  hat808: (sr) => renderLayers(sr, [{ dur: 0.08, oscs: METAL, filter: 'highpass', cutFrom: 7000, q: 1, attack: 0.0005, tau: 0.018 }], 0.5),
  openHat808: (sr) => renderLayers(sr, [{ dur: 0.7, oscs: METAL, filter: 'highpass', cutFrom: 7000, q: 1, attack: 0.001, tau: 0.2 }], 0.45),
  cymbal: (sr) =>
    renderLayers(sr, [
      { dur: 2.2, oscs: METAL, filter: 'highpass', cutFrom: 5500, attack: 0.001, tau: 0.7 },
      { dur: 2.2, oscs: NOISE, filter: 'highpass', cutFrom: 6000, attack: 0.001, tau: 0.6, peak: 0.4 },
    ], 0.45),
  crash: (sr) => renderLayers(sr, [{ dur: 1.8, oscs: NOISE, filter: 'highpass', cutFrom: 4500, attack: 0.002, tau: 0.55 }], 0.45),
  rim: (sr) =>
    renderLayers(sr, [
      { dur: 0.05, oscs: [{ type: 'sine', f: 1700, g: 1 }], attack: 0.0005, tau: 0.012 },
      { dur: 0.03, oscs: NOISE, filter: 'bandpass', cutFrom: 3000, q: 2, attack: 0.0005, tau: 0.006, peak: 0.6 },
    ], 0.6),
  rimshot: (sr) =>
    renderLayers(sr, [
      { dur: 0.08, oscs: [{ type: 'sine', f: 1700, g: 1 }, { type: 'sine', f: 500, g: 0.6 }], attack: 0.0005, tau: 0.016 },
      { dur: 0.04, oscs: NOISE, filter: 'highpass', cutFrom: 3000, attack: 0.0005, tau: 0.01, peak: 0.5 },
    ], 0.6),
  shaker: (sr) => renderLayers(sr, [{ dur: 0.14, oscs: NOISE, filter: 'bandpass', cutFrom: 6500, q: 1.2, attack: 0.015, tau: 0.035 }], 0.5),
  maracas: (sr) => renderLayers(sr, [{ dur: 0.07, oscs: NOISE, filter: 'highpass', cutFrom: 8500, attack: 0.004, tau: 0.02 }], 0.5),
  cowbell: (sr, tau = 0.11) =>
    renderLayers(sr, [
      { dur: tau * 4, oscs: [{ type: 'square', f: 540, g: 0.5 }, { type: 'square', f: 800, g: 0.5 }], filter: 'bandpass', cutFrom: 900, q: 1.5, attack: 0.001, tau },
    ], 0.55),
  clave: (sr) => renderLayers(sr, [{ dur: 0.1, oscs: [{ type: 'sine', f: 2500, g: 1 }, { type: 'sine', f: 5000, g: 0.2 }], attack: 0.0005, tau: 0.02 }], 0.6),
  conga: (sr, f) =>
    renderLayers(sr, [{ dur: 0.35, oscs: [{ type: 'sine', f: f * 1.18, fTo: f, fTau: 0.02, g: 1 }], attack: 0.001, tau: 0.12 }], 0.75),
  tom: (sr, f) =>
    renderLayers(sr, [
      { dur: 0.6, oscs: [{ type: 'sine', f, fTo: f * 0.65, fTau: 0.09, g: 1 }], attack: 0.001, tau: 0.2 },
      { dur: 0.01, oscs: NOISE, filter: 'bandpass', cutFrom: 4000, attack: 0.0005, tau: 0.003, peak: 0.3 },
    ], 0.8),
  zap: (sr) =>
    renderLayers(sr, [
      { dur: 0.35, oscs: [{ type: 'sine', f: 2600, fTo: 140, fTau: 0.035, g: 1 }], attack: 0.001, tau: 0.09 },
      { dur: 0.3, oscs: [{ type: 'square', f: 1300, fTo: 70, fTau: 0.03, g: 0.3 }], filter: 'lowpass', cutFrom: 3000, attack: 0.001, tau: 0.07 },
    ], 0.6),
  stab: (sr, notes) =>
    renderLayers(sr, [{ dur: 0.45, oscs: detuned(notes), filter: 'lowpass', cutFrom: 3400, cutTo: 700, q: 2, attack: 0.004, tau: 0.14 }], 0.7),
  chord: (sr, notes) =>
    renderLayers(sr, [
      { dur: 1.4, oscs: [...detuned(notes, 10), ...notes.map((m) => ({ type: 'tri', f: midiHz(m), g: 0.8 }))], filter: 'lowpass', cutFrom: 2600, cutTo: 900, q: 1, attack: 0.02, hold: 0.1, tau: 0.5 },
    ], 0.7),
  pluck: (sr, m) =>
    renderLayers(sr, [
      { dur: 0.7, oscs: [{ type: 'saw', f: midiHz(m), g: 1 }, { type: 'square', f: midiHz(m) * 2, g: 0.25 }], filter: 'lowpass', cutFrom: 5000, cutTo: 500, q: 4, attack: 0.002, tau: 0.16 },
    ], 0.75),
  bass: (sr, m) =>
    renderLayers(sr, [
      { dur: 0.9, oscs: [{ type: 'saw', f: midiHz(m), g: 1 }, { type: 'sine', f: midiHz(m), g: 0.8 }], filter: 'lowpass', cutFrom: 700, cutTo: 160, q: 3, attack: 0.004, tau: 0.28 },
    ], 0.9),
  bass808: (sr, m) =>
    renderLayers(sr, [{ dur: 1.4, oscs: [{ type: 'sine', f: midiHz(m) * 1.6, fTo: midiHz(m), fTau: 0.015, g: 1 }], attack: 0.002, tau: 0.45, drive: 1.6 }], 0.95),
};

const pad = (name, color, make, choke) => ({ name, color: PAD_COLORS[color], make, choke });

const KITS = {
  electro: {
    name: 'Electro 電子鼓',
    pads: [
      pad('Stab Cm', 'synth', (sr) => SOUND.stab(sr, [60, 63, 67, 72])),
      pad('Stab Ab', 'synth', (sr) => SOUND.stab(sr, [56, 60, 63, 68])),
      pad('Stab Bb', 'synth', (sr) => SOUND.stab(sr, [58, 62, 65, 70])),
      pad('Zap', 'fx', SOUND.zap),
      pad('Tom Low', 'tom', (sr) => SOUND.tom(sr, 130)),
      pad('Tom Mid', 'tom', (sr) => SOUND.tom(sr, 185)),
      pad('Tom High', 'tom', (sr) => SOUND.tom(sr, 260)),
      pad('Cowbell', 'perc', (sr) => SOUND.cowbell(sr)),
      pad('Kick', 'kick', SOUND.kick),
      pad('Snare', 'snare', SOUND.snare),
      pad('Hi-Hat', 'hat', SOUND.hat, 'hh'),
      pad('Open Hat', 'hat', SOUND.openHat, 'hh'),
      pad('Clap', 'snare', (sr) => SOUND.clap(sr)),
      pad('Rim', 'perc', SOUND.rim),
      pad('Shaker', 'perc', SOUND.shaker),
      pad('Crash', 'cym', SOUND.crash),
    ],
  },
  tr808: {
    name: '808 經典鼓機',
    pads: [
      pad('808 C', 'bass', (sr) => SOUND.bass808(sr, 36)),
      pad('808 E♭', 'bass', (sr) => SOUND.bass808(sr, 39)),
      pad('808 F', 'bass', (sr) => SOUND.bass808(sr, 41)),
      pad('808 G', 'bass', (sr) => SOUND.bass808(sr, 43)),
      pad('Conga Low', 'tom', (sr) => SOUND.conga(sr, 190)),
      pad('Conga High', 'tom', (sr) => SOUND.conga(sr, 290)),
      pad('Clave', 'perc', SOUND.clave),
      pad('Cowbell', 'perc', (sr) => SOUND.cowbell(sr, 0.16)),
      pad('808 Kick', 'kick', SOUND.kick808),
      pad('808 Snare', 'snare', SOUND.snare808),
      pad('808 Hat', 'hat', SOUND.hat808, 'hh'),
      pad('808 Open', 'hat', SOUND.openHat808, 'hh'),
      pad('808 Clap', 'snare', (sr) => SOUND.clap(sr, 0.16)),
      pad('Rimshot', 'perc', SOUND.rimshot),
      pad('Maracas', 'perc', SOUND.maracas),
      pad('Cymbal', 'cym', SOUND.cymbal),
    ],
  },
  melodic: {
    name: '旋律 C 小調五聲',
    pads: [
      pad('Cm7', 'synth', (sr) => SOUND.chord(sr, [60, 63, 67, 70])),
      pad('A♭maj7', 'synth', (sr) => SOUND.chord(sr, [56, 60, 63, 67])),
      pad('B♭', 'synth', (sr) => SOUND.chord(sr, [58, 62, 65, 70])),
      pad('Gm7', 'synth', (sr) => SOUND.chord(sr, [55, 58, 62, 65])),
      pad('B♭4', 'fx', (sr) => SOUND.pluck(sr, 70)),
      pad('C5', 'fx', (sr) => SOUND.pluck(sr, 72)),
      pad('E♭5', 'fx', (sr) => SOUND.pluck(sr, 75)),
      pad('F5', 'fx', (sr) => SOUND.pluck(sr, 77)),
      pad('C4', 'tom', (sr) => SOUND.pluck(sr, 60)),
      pad('E♭4', 'tom', (sr) => SOUND.pluck(sr, 63)),
      pad('F4', 'tom', (sr) => SOUND.pluck(sr, 65)),
      pad('G4', 'tom', (sr) => SOUND.pluck(sr, 67)),
      pad('Bass C', 'bass', (sr) => SOUND.bass(sr, 36)),
      pad('Bass E♭', 'bass', (sr) => SOUND.bass(sr, 39)),
      pad('Bass F', 'bass', (sr) => SOUND.bass(sr, 41)),
      pad('Bass G', 'bass', (sr) => SOUND.bass(sr, 43)),
    ],
  },
};
