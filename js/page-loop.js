'use strict';
/* Loop Station 頁：6 軌循環錄音，麥克風或匯入音檔 */

const LOOP_PAGE_TRACKS = 6;
const LOOP_UNDO_KEYS = ['Q', 'W', 'E', 'R', 'T', 'Y'];
const LOOP_DIGITS = new RegExp(`^Digit[1-${LOOP_PAGE_TRACKS}]$`);

class LoopApp extends AudioApp {
  setup() {
    this.looper = new LoopStation(this, $('#looper'), { tracks: LOOP_PAGE_TRACKS, undoKeys: LOOP_UNDO_KEYS });
    const box = $('#loopKnobs');
    const mk = (label, value, max, onChange) => {
      const el = document.createElement('div');
      box.appendChild(el);
      return new Knob(el, { min: 0, max, value, bipolar: false, label, format: (v) => `${Math.round(v * 100)}%`, onChange });
    };
    this.knobs = {
      master: mk('MASTER', 1, 1.5, (v) => this.setGain(this.master, v)),
      loop: mk('LOOP', 1.2, 2, (v) => this.setGain(this.looper.out, v)),
      mic: mk('MIC', 1, 4, (v) => this.setGain(this.micBus, v)),
      click: mk('CLICK', 0.6, 1, (v) => this.setGain(this.looper.metroGain, v)),
    };
  }

  setupAudio(ctx) {
    this.looper.initAudio(ctx);
    this.setGain(this.master, this.knobs.master.value);
    this.setGain(this.looper.out, this.knobs.loop.value);
    this.setGain(this.micBus, this.knobs.mic.value);
    this.setGain(this.looper.metroGain, this.knobs.click.value);
    this.addMeter($('#vuMaster'), this.masterAnalyser);
    this.addMeter($('#micMeter'), this.micAnalyser);
  }

  onMicReady(ms) {
    this.looper.suggestLatency(ms);
  }

  undoIndex(code) {
    return code.startsWith('Key') ? LOOP_UNDO_KEYS.indexOf(code.slice(3)) : -1;
  }

  isKey(code) {
    return LOOP_DIGITS.test(code) || this.undoIndex(code) >= 0 || ['Space', 'KeyM', 'KeyP', 'Enter'].includes(code);
  }

  keyDown(code, shift) {
    const lp = this.looper;
    if (LOOP_DIGITS.test(code)) {
      const i = Number(code.slice(5)) - 1;
      if (shift) lp.stopToggle(i);
      else lp.press(i);
      return null;
    }
    const u = this.undoIndex(code);
    if (u >= 0) {
      lp.undo(u);
      return null;
    }
    switch (code) {
      case 'Space':
        lp.toggleAll();
        break;
      case 'Enter':
        lp.post({ type: 'restart' });
        break;
      case 'KeyM':
        lp.setMetro(!lp.metro);
        break;
      case 'KeyP':
        lp.tap();
        break;
    }
    return null;
  }

  render() {
    this.looper.render();
  }
}

const App = new LoopApp();
window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());
