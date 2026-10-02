'use strict';
/* DJ 控制台頁：兩台唱盤 + 混音台 + 4 軌 Loop Station */

/* 鍵盤對照：唱盤按鍵來自 DECK_DEFS */
const KEY_ACTIONS = {};
DECK_DEFS.forEach((def, deck) => {
  for (const [act, code] of Object.entries(def.keys)) KEY_ACTIONS[code] = { deck, act };
});
const XF_KEYS = { ArrowLeft: -1, ArrowRight: 1 };

class DjApp extends AudioApp {
  constructor() {
    super();
    this.decks = [];
    this.looper = null;
    this.vinyl = true;
    this.xf = 0.5;
    this.xfDir = 0;
  }

  setup() {
    this.decks = [new Deck(this, 0, $('#deckA')), new Deck(this, 1, $('#deckB'))];
    this.looper = new LoopStation(this, $('#looper'), { tracks: 4 });
    this.buildMixer();
    $('#vinylMode').addEventListener('change', (e) => (this.vinyl = e.target.checked));
  }

  setupAudio(ctx) {
    this.deckBus = ctx.createGain();
    this.deckBus.connect(this.master);
    this.decks.forEach((d) => d.initAudio(ctx, this.deckBus));
    this.looper.initAudio(ctx);
    this.applyMixer();
    this.addMeter($('#vuA'), this.decks[0].analyser);
    this.addMeter($('#vuB'), this.decks[1].analyser);
    this.addMeter($('#vuMaster'), this.masterAnalyser);
    this.addMeter($('#micMeter'), this.micAnalyser);
  }

  onMicReady(ms) {
    this.looper.suggestLatency(ms);
  }

  /* ---------------- 混音台 ---------------- */

  buildMixer() {
    const eqFmt = (v) => {
      if (v <= -0.99) return 'KILL';
      const db = v < 0 ? v * 36 : v * 8;
      return `${db > 0 ? '+' : ''}${db.toFixed(1)}dB`;
    };
    const knobDefs = [
      { k: 'gain', label: 'GAIN', min: -12, max: 12, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB` },
      { k: 'hi', label: 'HI', fmt: eqFmt },
      { k: 'mid', label: 'MID', fmt: eqFmt },
      { k: 'low', label: 'LOW', fmt: eqFmt },
      { k: 'filter', label: 'FILTER', fmt: (v) => (Math.abs(v) < 0.02 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`) },
      { k: 'echo', label: 'ECHO', min: 0, max: 1, value: 0, bipolar: false, fmt: (v) => `${Math.round(v * 100)}%` },
    ];
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
    const mk = (label, value, max, onChange) => {
      const el = document.createElement('div');
      center.appendChild(el);
      return new Knob(el, { min: 0, max, value, bipolar: false, label, format: (v) => `${Math.round(v * 100)}%`, onChange });
    };
    this.masterKnob = mk('MASTER', 0.8, 1.2, (v) => this.setGain(this.master, v));
    this.loopKnob = mk('LOOP', 1, 1.5, (v) => this.setGain(this.looper.out, v));
    this.micKnob = mk('MIC', 1, 2, (v) => this.setGain(this.micBus, v));
    this.clickKnob = mk('CLICK', 0.6, 1, (v) => this.setGain(this.looper.metroGain, v));
  }

  applyMixer() {
    this.setGain(this.master, this.masterKnob.value);
    this.setGain(this.looper.out, this.loopKnob.value);
    this.setGain(this.micBus, this.micKnob.value);
    this.setGain(this.looper.metroGain, this.clickKnob.value);
    this.setXfader(this.xf);
  }

  /** Crossfader：中間兩邊都是全音量，往一側推時另一側淡出 */
  setXfader(x, fromKeys) {
    this.xf = x;
    if (fromKeys) this.xfader.set(x, false);
    const a = x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI);
    const b = x >= 0.5 ? 1 : Math.sin(x * Math.PI);
    this.decks[0].setParam('xf', a);
    this.decks[1].setParam('xf', b);
  }

  /* ---------------- 鍵盤 ---------------- */

  isKey(code) {
    return !!KEY_ACTIONS[code] || /^Digit[1-4]$/.test(code) || code in XF_KEYS || code === 'ArrowDown';
  }

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
  }

  render(dt) {
    if (this.xfDir) this.setXfader(clamp(this.xf + this.xfDir * dt * 1.6, 0, 1), true);
    for (const d of this.decks) d.render();
    this.looper.render();
  }
}

const App = new DjApp();
window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());
