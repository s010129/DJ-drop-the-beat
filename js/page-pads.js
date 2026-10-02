'use strict';
/* 打擊墊頁：4×4 打擊墊 + 16 軌音序器 */

const PADS_PAGE_KEYS = ['Space', 'Enter', 'KeyM', 'KeyN', 'KeyT', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

class PadsApp extends AudioApp {
  setup() {
    this.machine = new PadMachine(this, $('#padMachine'));
  }

  setupAudio(ctx) {
    this.machine.initAudio(ctx);
    this.addMeter($('#vuMaster'), this.masterAnalyser);
  }

  isKey(code) {
    return PAD_KEYS.includes(code) || PADS_PAGE_KEYS.includes(code);
  }

  keyDown(code, shift) {
    const m = this.machine;
    const i = PAD_KEYS.indexOf(code);
    if (i >= 0) {
      m.padDown(i, shift ? 0.45 : 0.9, code);
      return () => m.padUp(i, code);
    }
    switch (code) {
      case 'Space':
        m.togglePlay();
        break;
      case 'Enter':
        m.toggleRec();
        break;
      case 'KeyM':
        m.toggleMetro();
        break;
      case 'KeyN':
        m.toggleRepeat();
        break;
      case 'KeyT':
        m.tap();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const pages = m.length / 16;
        m.follow = false;
        $('#seqFollow').checked = false;
        m.setPage((m.page + (code === 'ArrowRight' ? 1 : -1) + pages) % pages);
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        m.setBpm(m.bpm + (code === 'ArrowUp' ? 1 : -1) * (shift ? 10 : 1));
        break;
    }
    return null;
  }

  render(dt) {
    this.machine.render(dt);
  }
}

const App = new PadsApp();
window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());
