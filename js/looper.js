'use strict';
/* Loop Station：介面與控制（實際錄放在 processors.js 的 LooperProcessor） */

const LOOP_TRACKS = 4;
const LOOP_STATE_TEXT = {
  empty: '空軌',
  countin: '預備拍',
  first: '錄音中',
  rec: '錄音中',
  play: '播放中',
  dub: '疊錄中',
  stop: '已停止',
};
const LOOP_MAIN_TEXT = {
  empty: '● 錄音',
  countin: '✕ 取消',
  first: '■ 完成',
  rec: '■ 完成',
  play: '● 疊錄',
  dub: '■ 完成疊錄',
  stop: '▶ 播放',
};

class LoopStation {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.ctx = null;
    this.node = null;
    this.status = null;
    this.statusAt = 0;
    this.source = 'mic';
    this.bpm = 120;
    this.quant = 'off';
    this.metro = false;
    this.latencyMs = 0;
    this.latencyTouched = false;
    this.vols = new Array(LOOP_TRACKS).fill(1);
    this.peaks = new Array(LOOP_TRACKS).fill(null);
    this.taps = [];
    this.reqId = 0;
    this.pending = new Map();
    this.tracks = [];
    this.buildUI();
  }

  /* ---------------- 介面 ---------------- */

  buildUI() {
    const root = this.root;

    $$('#lpSource button', root).forEach((b) =>
      b.addEventListener('click', () => {
        this.setSource(b.dataset.v);
        if (b.dataset.v !== 'deck' && !this.app.micReady && this.app.started) this.app.enableMic();
      })
    );
    $('#micBtn', root).addEventListener('click', async () => {
      await this.app.start();
      this.app.enableMic();
    });
    $('#micMonitor', root).addEventListener('change', (e) => this.app.setMicMonitor(e.target.checked));

    this.bpmInput = $('#lpBpm', root);
    this.bpmInput.addEventListener('change', () => this.setBpm(parseFloat(this.bpmInput.value)));
    $('#tapBtn', root).addEventListener('click', () => this.tap());
    $('#bpmFromA', root).addEventListener('click', () => this.bpmFromDeck(0));
    $('#bpmFromB', root).addEventListener('click', () => this.bpmFromDeck(1));
    $('#lpMetro', root).addEventListener('change', (e) => {
      this.metro = e.target.checked;
      if (this.metro && this.quant === 'off') {
        this.quant = 'bar';
        $('#lpQuant', root).value = 'bar';
      }
      this.sendConfig();
    });
    $('#lpQuant', root).addEventListener('change', (e) => {
      this.quant = e.target.value;
      e.target.blur();
      this.sendConfig();
    });
    this.latInput = $('#lpLatency', root);
    this.latInput.addEventListener('change', () => {
      this.latencyTouched = true;
      this.latencyMs = clamp(parseFloat(this.latInput.value) || 0, 0, 1000);
      this.latInput.value = this.latencyMs;
      this.sendConfig();
    });
    $('#lpRestart', root).addEventListener('click', () => this.post({ type: 'restart' }));
    $('#lpAll', root).addEventListener('click', () => this.post({ type: 'toggleAll' }));
    $('#lpExportMix', root).addEventListener('click', () => this.exportMix());

    const wrap = $('#lpTracks', root);
    for (let i = 0; i < LOOP_TRACKS; i++) {
      const el = document.createElement('div');
      el.className = 'lp-track';
      el.dataset.state = 'empty';
      el.innerHTML = `
        <div class="lp-top">
          <kbd data-key="Digit${i + 1}">${i + 1}</kbd>
          <span class="lp-state">空軌</span>
          <span class="lp-len"></span>
        </div>
        <canvas class="lp-wave"></canvas>
        <div class="lp-vol"></div>
        <div class="lp-btns">
          <button type="button" class="btn small lp-main" title="錄音 → 播放 → 疊錄（按鍵 ${i + 1}）">● 錄音</button>
          <button type="button" class="btn icon lp-stop" title="停止／播放（Shift+${i + 1}）">■</button>
          <button type="button" class="btn icon lp-undo" title="復原／重做上一次疊錄">↶</button>
          <label class="btn icon lp-import" title="匯入音檔到這一軌">⬆<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" hidden></label>
          <button type="button" class="btn icon lp-export" title="匯出這一軌（WAV）">⬇</button>
          <button type="button" class="btn icon lp-clear" title="清除這一軌">✕</button>
        </div>`;
      wrap.appendChild(el);
      const tr = { el, state: 'empty', stateEl: $('.lp-state', el), lenEl: $('.lp-len', el), mainBtn: $('.lp-main', el) };
      tr.view = new CanvasView($('.lp-wave', el));
      tr.vol = new Fader($('.lp-vol', el), {
        vertical: false,
        min: 0,
        max: 1.2,
        value: 1,
        cap: 18,
        title: `第 ${i + 1} 軌音量（雙擊歸位）`,
        onChange: (v) => {
          this.vols[i] = v;
          this.post({ type: 'vol', i, v });
        },
      });
      tr.mainBtn.addEventListener('click', () => this.press(i));
      $('.lp-stop', el).addEventListener('click', () => this.post({ type: 'stop', i }));
      $('.lp-undo', el).addEventListener('click', () => this.post({ type: 'undo', i }));
      $('.lp-export', el).addEventListener('click', () => this.exportTrack(i));
      const clearBtn = $('.lp-clear', el);
      clearBtn.addEventListener('click', () => {
        // 按兩下才清除，避免誤觸
        if (clearBtn.classList.contains('confirm')) {
          clearBtn.classList.remove('confirm');
          clearBtn.textContent = '✕';
          this.post({ type: 'clear', i });
        } else {
          clearBtn.classList.add('confirm');
          clearBtn.textContent = '確定?';
          setTimeout(() => {
            clearBtn.classList.remove('confirm');
            clearBtn.textContent = '✕';
          }, 2000);
        }
      });
      const fileInput = $('input[type=file]', el);
      fileInput.addEventListener('change', () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (f) this.importFile(i, f);
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('drag');
      });
      el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget)) el.classList.remove('drag');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f) this.importFile(i, f);
      });
      this.tracks.push(tr);
    }
    this.lenInfo = $('#lpLenInfo', root);
    this.posInfo = $('#lpPosInfo', root);
    this.setSource(this.source);
  }

  /* ---------------- 音訊 ---------------- */

  initAudio(ctx) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, 'dj-looper', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [2, 2],
      processorOptions: { tracks: LOOP_TRACKS },
    });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    this.micSend = ctx.createGain();
    this.deckSend = ctx.createGain();
    this.app.micBus.connect(this.micSend).connect(this.node, 0, 0);
    this.app.deckBus.connect(this.deckSend).connect(this.node, 0, 1);
    this.out = ctx.createGain();
    this.node.connect(this.out, 0);
    this.out.connect(this.app.master);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    // 節拍器直接送到喇叭，不會被錄進混音或 Loop
    this.metroGain = ctx.createGain();
    this.metroGain.gain.value = 0.6;
    this.node.connect(this.metroGain, 1);
    this.metroGain.connect(ctx.destination);
    this.setSource(this.source);
    this.sendConfig();
  }

  post(m, transfer) {
    if (this.node) this.node.port.postMessage(m, transfer || []);
  }

  sendConfig() {
    this.post({ type: 'config', bpm: this.bpm, quant: this.quant, metro: this.metro, micLat: this.latencyMs / 1000 });
  }

  setSource(src) {
    this.source = src;
    $$('#lpSource button', this.root).forEach((b) => b.classList.toggle('on', b.dataset.v === src));
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.micSend.gain.setTargetAtTime(src === 'deck' ? 0 : 1, t, 0.01);
    this.deckSend.gain.setTargetAtTime(src === 'mic' ? 0 : 1, t, 0.01);
  }

  setBpm(v) {
    if (!isFinite(v)) v = this.bpm;
    this.bpm = Math.round(clamp(v, 40, 240) * 10) / 10;
    this.bpmInput.value = this.bpm;
    this.sendConfig();
  }

  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length >= 2) {
      const span = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.setBpm(60000 / span);
    }
  }

  bpmFromDeck(i) {
    const bpm = this.app.decks[i].effectiveBpm();
    if (!bpm) {
      toast(`唱盤 ${DECK_DEFS[i].name} 沒有偵測到 BPM`);
      return;
    }
    this.setBpm(bpm);
    toast(`Loop BPM 設為 ${this.bpm}（來自唱盤 ${DECK_DEFS[i].name}）`);
  }

  /** 開啟麥克風後自動估算延遲補償（使用者手動改過就不覆蓋） */
  suggestLatency(ms) {
    if (this.latencyTouched) return;
    this.latencyMs = ms;
    this.latInput.value = ms;
    this.sendConfig();
  }

  async press(i) {
    await this.app.start();
    const st = this.status ? this.status.tracks[i].s : 'empty';
    if (st === 'empty' && this.source !== 'deck' && !this.app.micReady) {
      const ok = await this.app.enableMic();
      if (!ok) return;
    }
    this.post({ type: 'press', i });
  }

  stopToggle(i) {
    this.post({ type: 'stop', i });
  }

  async importFile(i, file) {
    await this.app.start();
    if (this.status && this.status.tracks.some((t) => t.s === 'first' || t.s === 'countin')) {
      toast('第一個 Loop 錄音中，請先完成再匯入');
      return;
    }
    const tr = this.tracks[i];
    tr.stateEl.textContent = '讀取中…';
    try {
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      const L = buf.getChannelData(0).slice();
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : null;
      this.post({ type: 'import', i, L, R }, R ? [L.buffer, R.buffer] : [L.buffer]);
      toast(`已匯入「${file.name}」到第 ${i + 1} 軌`);
    } catch (err) {
      console.error(err);
      toast(`無法解碼「${file.name}」`, 'error');
    }
    tr.state = null; // 強制刷新狀態文字
  }

  request(i) {
    const id = ++this.reqId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: 'export', i, id });
    });
  }

  async exportTrack(i) {
    if (!this.node) return;
    const d = await this.request(i);
    if (!d.L) {
      toast('這一軌是空的');
      return;
    }
    const sr = this.ctx.sampleRate;
    this.app.addExport(makeWav(d.L, d.R, sr), `loop-${i + 1}-${stamp()}.wav`, d.L.length / sr, true);
  }

  /** 把所有正在播放的軌道混成一段可無縫循環的 WAV */
  async exportMix() {
    const s = this.status;
    if (!s || !s.loopLen) {
      toast('還沒有任何 Loop 可以匯出');
      return;
    }
    const parts = [];
    for (let i = 0; i < LOOP_TRACKS; i++) {
      const st = s.tracks[i].s;
      if (st !== 'play' && st !== 'dub' && st !== 'rec') continue;
      const d = await this.request(i);
      if (d.L) parts.push({ L: d.L, R: d.R, vol: this.vols[i] });
    }
    if (!parts.length) {
      toast('沒有正在播放的 Loop（被停止的軌道不會匯出）');
      return;
    }
    const base = s.loopLen;
    let mult = 1;
    for (const p of parts) mult = lcm(mult, Math.max(1, Math.round(p.L.length / base)));
    mult = Math.min(mult, 16);
    const len = base * mult;
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    for (const p of parts) {
      const n = p.L.length;
      for (let j = 0; j < len; j++) {
        L[j] += p.L[j % n] * p.vol;
        R[j] += p.R[j % n] * p.vol;
      }
    }
    let peak = 0;
    for (let j = 0; j < len; j++) peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j]));
    if (peak > 0.99) {
      const k = 0.99 / peak;
      for (let j = 0; j < len; j++) {
        L[j] *= k;
        R[j] *= k;
      }
    }
    const sr = this.ctx.sampleRate;
    this.app.addExport(makeWav(L, R, sr), `loop-mix-${stamp()}.wav`, len / sr, true);
  }

  onMessage(m) {
    if (m.type === 'status') {
      this.status = m;
      this.statusAt = performance.now();
      m.tracks.forEach((t, i) => {
        if (t.peaks) this.peaks[i] = t.peaks;
        const tr = this.tracks[i];
        if (tr.state !== t.s) {
          tr.state = t.s;
          tr.el.dataset.state = t.s;
          tr.stateEl.textContent = LOOP_STATE_TEXT[t.s];
          tr.mainBtn.textContent = LOOP_MAIN_TEXT[t.s];
        }
        const lenText = t.len ? `${(t.len / this.ctx.sampleRate).toFixed(2)} 秒` + (m.loopLen && t.len > m.loopLen ? ` ×${Math.round(t.len / m.loopLen)}` : '') : '';
        if (lenText !== tr.lenText) tr.lenEl.textContent = tr.lenText = lenText;
        tr.el.classList.toggle('has-undo', !!t.undo);
      });
      const info = m.loopLen ? this.describeLength(m.loopLen) : 'Loop 長度：尚未錄製（第一個 Loop 決定長度）';
      if (info !== this._info) this.lenInfo.textContent = this._info = info;
    } else if (m.type === 'export') {
      const fn = this.pending.get(m.id);
      if (fn) {
        this.pending.delete(m.id);
        fn(m);
      }
    }
  }

  describeLength(frames) {
    const sec = frames / this.ctx.sampleRate;
    const beats = (sec * this.bpm) / 60;
    const nice = Math.abs(beats - Math.round(beats)) < 0.05;
    return `Loop 長度：${sec.toFixed(2)} 秒` + (nice ? `（${Math.round(beats)} 拍 @ ${this.bpm} BPM）` : '');
  }

  /* ---------------- 繪圖 ---------------- */

  render() {
    const s = this.status;
    if (!s) return;
    const sr = this.ctx.sampleRate;
    const elapsed = s.running ? ((performance.now() - this.statusAt) / 1000) * sr : 0;
    const counter = s.counter + Math.min(elapsed, sr * 0.1);
    const beatLen = (sr * 60) / this.bpm;

    let pos = '';
    if (s.loopLen && counter >= 0) {
      const p = counter % s.loopLen;
      const b = Math.floor(p / beatLen);
      pos = `${Math.floor(b / 4) + 1}.${(b % 4) + 1}`;
    }
    if (pos !== this._pos) this.posInfo.textContent = this._pos = pos ? `位置 ${pos}` : '';

    this.tracks.forEach((tr, i) => {
      const info = s.tracks[i];
      const { g, w, h } = tr.view;
      g.clearRect(0, 0, w, h);
      const mid = h / 2;
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, Math.floor(mid), w, 1);
      g.textAlign = 'center';
      g.font = '700 15px Orbitron, sans-serif';

      if (info.s === 'countin') {
        const left = Math.max(1, Math.ceil((s.startAt - counter) / beatLen));
        g.fillStyle = '#fbbf24';
        g.fillText(`${left}…`, w / 2, mid + 5);
        return;
      }
      if (info.s === 'first') {
        const secs = (info.rec + elapsed) / sr;
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
        g.fillStyle = `rgba(244,63,94,${0.15 + pulse * 0.2})`;
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fda4af';
        g.fillText(`REC ${secs.toFixed(1)}s`, w / 2, mid + 5);
        return;
      }
      const peaks = this.peaks[i];
      if (!info.len || !peaks) {
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.font = '600 11px Orbitron, sans-serif';
        g.fillText('EMPTY', w / 2, mid + 4);
        return;
      }
      const live = info.s !== 'stop';
      const color = info.s === 'rec' || info.s === 'dub' ? '#fb7185' : live ? '#fbbf24' : '#64748b';
      const bw = w / peaks.length;
      g.fillStyle = color;
      for (let b = 0; b < peaks.length; b++) {
        const hh = Math.min(1, peaks[b]) * (mid - 2);
        g.fillRect(b * bw, mid - hh, Math.max(1, bw - 1), Math.max(1, hh * 2));
      }
      // 每一拍的格線
      if (s.loopLen) {
        const beats = info.len / beatLen;
        if (beats <= 64 && Math.abs(beats - Math.round(beats)) < 0.05) {
          for (let k = 1; k < Math.round(beats); k++) {
            g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
            g.fillRect(Math.round((k / beats) * w), 0, 1, h);
          }
        }
      }
      if (counter >= 0) {
        const x = ((counter % info.len) / info.len) * w;
        g.fillStyle = 'rgba(4,6,10,0.4)';
        g.fillRect(0, 0, x, h);
        g.fillStyle = '#fff';
        g.fillRect(Math.round(x), 0, 2, h);
      }
    });
  }
}
