/*
 * AudioWorklet 處理器：唱盤、Loop Station、混音錄音器。
 *
 * 整個函式會在 core.js 以 Function.prototype.toString() 轉成字串，
 * 包成 Blob URL 後交給 audioWorklet.addModule()，
 * 所以直接雙擊 index.html（file://）也能運作。
 * 注意：函式內不可引用任何外部變數。
 */
function djProcessorsModule() {
  'use strict';

  const PEAKS = 160; // Loop 軌道縮圖的波形格數
  const CHUNK = 16384; // 錄第一個 Loop 時每一塊的長度（frame）
  const AUTO_TARGET = 0.7; // 自動音量：新錄音的峰值拉到約 -3 dBFS
  const AUTO_MAX = 10; // 自動音量最多放大 10 倍（+20 dB），只放大不縮小

  /* ------------------------------------------------------------------
   * 唱盤：可任意變速（含倒轉）的播放器。
   * 速率會平滑趨近目標值，做出黑膠煞車／啟動、倒帶、加速、刷碟的手感。
   * ------------------------------------------------------------------ */
  class DeckProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.L = null;
      this.R = null;
      this.len = 0;
      this.pos = 0; // 播放位置（frame，可為小數）
      this.rate = 0; // 目前速率，負值代表倒轉
      this.target = 0; // 目標速率
      this.coef = 1; // 每個 frame 往目標靠近的比例
      this.amp = 0; // 依轉速決定的音量：停住時靜音，避免直流與爆音
      this.ampCoef = 1 - Math.exp(-1 / (0.004 * sampleRate));
      this.fade = 1; // 跳點時的短淡出淡入
      this.fadeStep = 1 / Math.max(1, Math.round(0.004 * sampleRate));
      this.seekTo = -1;
      this.ended = false;
      this.since = 0;
      this.reportEvery = Math.round(sampleRate / 60);
      this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
      switch (m.type) {
        case 'load':
          this.L = m.L;
          this.R = m.R || m.L;
          this.len = m.L.length;
          this.pos = 0;
          this.rate = 0;
          this.target = 0;
          this.amp = 0;
          this.fade = 1;
          this.seekTo = -1;
          this.ended = false;
          break;
        case 'rate':
          this.target = m.target;
          this.coef = m.tau > 0 ? 1 - Math.exp(-1 / (m.tau * sampleRate)) : 1;
          break;
        case 'seek': {
          const p = Math.min(Math.max(0, m.time * sampleRate), Math.max(0, this.len - 2));
          if (this.amp * this.fade > 0.001) this.seekTo = p;
          else this.pos = p;
          this.ended = false;
          break;
        }
      }
    }

    process(inputs, outputs) {
      const out = outputs[0];
      const oL = out[0];
      const oR = out[1] || out[0];
      const n = oL.length;
      const L = this.L;
      const R = this.R;
      const last = this.len - 1;
      if (L && last > 2) {
        const target = this.target;
        const coef = this.coef;
        const ampCoef = this.ampCoef;
        const fadeStep = this.fadeStep;
        let pos = this.pos;
        let rate = this.rate;
        let amp = this.amp;
        let fade = this.fade;
        for (let i = 0; i < n; i++) {
          rate += (target - rate) * coef;
          if (this.seekTo >= 0) {
            fade -= fadeStep;
            if (fade <= 0) {
              fade = 0;
              pos = this.seekTo;
              this.seekTo = -1;
            }
          } else if (fade < 1) {
            fade = Math.min(1, fade + fadeStep);
          }
          const speed = rate < 0 ? -rate : rate;
          amp += ((speed >= 0.05 ? 1 : speed * 20) - amp) * ampCoef;

          let sL = 0;
          let sR = 0;
          if (pos >= 0 && pos < last) {
            // Catmull-Rom 三次內插
            const i1 = pos | 0;
            const t = pos - i1;
            const i0 = i1 > 0 ? i1 - 1 : 0;
            const i2 = i1 + 1;
            const i3 = i2 < last ? i2 + 1 : last;
            let a = L[i0];
            let b = L[i1];
            let c = L[i2];
            let d = L[i3];
            sL = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
            a = R[i0];
            b = R[i1];
            c = R[i2];
            d = R[i3];
            sR = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
          }
          const g = amp * fade;
          oL[i] = sL * g;
          oR[i] = sR * g;

          pos += rate;
          if (pos >= last) {
            pos = last;
            if (rate > 0) rate = 0;
            if (!this.ended) {
              this.ended = true;
              this.port.postMessage({ type: 'ended' });
            }
          } else if (pos < 0) {
            pos = 0;
            if (rate < 0) rate = 0;
          }
        }
        this.pos = pos;
        this.rate = rate;
        this.amp = amp;
        this.fade = fade;
      }
      this.since += n;
      if (this.since >= this.reportEvery) {
        this.since = 0;
        this.port.postMessage({ type: 'pos', time: this.pos / sampleRate, rate: this.rate });
      }
      return true;
    }
  }

  /* ------------------------------------------------------------------
   * Loop Station：多軌循環錄音（錄音 → 播放 → 疊錄），共用一個全域時鐘。
   * 第一個 Loop 決定長度，之後每一軌都以這個長度（或整數倍）對齊。
   * 輸入 0 = 麥克風、輸入 1 = DJ 盤；輸出 0 = Loop 混音、輸出 1 = 節拍器。
   * ------------------------------------------------------------------ */
  class LooperProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const count = (options && options.processorOptions && options.processorOptions.tracks) || 4;
      this.tracks = [];
      for (let i = 0; i < count; i++) this.tracks.push(this.blankTrack(1));
      this.loopLen = 0; // 主 Loop 長度（frame），0 = 尚未決定
      this.counter = 0; // 全域時鐘（frame）
      this.running = false;
      this.first = -1; // 正在錄第一個 Loop 的軌道
      this.startAt = 0; // 預備拍結束、正式開錄的時鐘位置
      this.closeAt = -1; // 第一個 Loop 預定收尾的時鐘位置
      this.closeLen = 0;
      this.afterClose = 'play';
      this.bpm = 120;
      this.metro = false;
      this.autoGain = true;
      this.quant = 'off';
      this.micLat = 0; // 麥克風延遲補償（frame）
      this.since = 0;
      this.reportEvery = Math.round(sampleRate / 30);
      this.port.onmessage = (e) => this.onMessage(e.data);
    }

    blankTrack(vol) {
      return {
        state: 'empty',
        len: 0,
        L: null,
        R: null,
        uL: null,
        uR: null,
        undo: false,
        vol,
        inGain: 1, // 自動音量的倍數，之後疊錄也用同一個倍數
        recLeft: 0,
        chunks: null,
        fill: 0,
        recorded: 0,
        peaks: new Float32Array(PEAKS),
        dirty: true,
      };
    }

    beatFrames() {
      return (sampleRate * 60) / this.bpm;
    }

    quantUnit() {
      if (this.quant === 'beat') return this.beatFrames();
      if (this.quant === 'bar') return this.beatFrames() * 4;
      return 0;
    }

    onMessage(m) {
      const t = this.tracks[m.i];
      switch (m.type) {
        case 'press':
          this.press(m.i);
          break;
        case 'stop':
          this.stopToggle(m.i);
          break;
        case 'undo':
          this.undo(m.i);
          break;
        case 'clear':
          this.clear(m.i);
          break;
        case 'vol':
          t.vol = m.v;
          break;
        case 'import':
          this.importClip(m.i, m.L, m.R || m.L);
          break;
        case 'export':
          this.port.postMessage({
            type: 'export',
            id: m.id,
            i: m.i,
            L: t && t.L ? t.L.slice() : null,
            R: t && t.R ? t.R.slice() : null,
          });
          break;
        case 'config':
          if (m.bpm) this.bpm = m.bpm;
          if (m.quant) this.quant = m.quant;
          if (typeof m.micLat === 'number') this.micLat = Math.round(m.micLat * sampleRate);
          if (typeof m.metro === 'boolean') this.setMetro(m.metro);
          if (typeof m.autoGain === 'boolean') this.autoGain = m.autoGain;
          break;
        case 'restart':
          if (this.first < 0) this.counter = 0;
          break;
        case 'toggleAll':
          this.toggleAll();
          break;
      }
      this.since = this.reportEvery; // 下一個 block 立刻回報新狀態
    }

    setMetro(on) {
      this.metro = on;
      if (on && !this.running) {
        this.running = true;
        this.counter = 0;
      }
      if (!on && this.loopLen === 0 && this.first < 0) {
        this.running = false;
        this.counter = 0;
      }
    }

    press(i) {
      const t = this.tracks[i];
      switch (t.state) {
        case 'empty':
          if (this.first >= 0) this.finishFirst();
          else if (this.loopLen === 0) this.startFirst(i);
          else this.startRec(i);
          break;
        case 'countin':
          this.cancelFirst();
          break;
        case 'first':
          this.finishFirst();
          break;
        case 'rec':
          this.finishRec(t, 'play');
          break;
        case 'dub':
          t.state = 'play';
          break;
        case 'play':
          this.saveUndo(t);
          t.state = 'dub';
          break;
        case 'stop':
          t.state = 'play';
          break;
      }
    }

    startFirst(i) {
      const t = this.tracks[i];
      t.chunks = [{ L: new Float32Array(CHUNK), R: new Float32Array(CHUNK) }];
      t.fill = 0;
      t.recorded = 0;
      t.peaks.fill(0);
      t.dirty = true;
      this.first = i;
      this.closeAt = -1;
      this.afterClose = 'play';
      if (this.metro && this.running) {
        // 跟著節拍器：等到下一個小節的第一拍才開錄
        const bar = this.beatFrames() * 4;
        this.startAt = Math.ceil(this.counter / bar) * bar;
        t.state = 'countin';
      } else {
        this.running = true;
        this.counter = 0;
        this.startAt = 0;
        t.state = 'first';
      }
    }

    finishFirst() {
      const i = this.first;
      if (i < 0) return;
      const t = this.tracks[i];
      if (t.state === 'countin') {
        this.cancelFirst();
        return;
      }
      if (this.closeAt >= 0) return;
      const c = this.counter;
      const unit = this.quantUnit();
      let len = c;
      if (unit > 0) len = Math.round(Math.max(1, Math.round(c / unit)) * unit);
      if (len < Math.round(0.1 * sampleRate)) {
        this.cancelFirst(); // 太短，當作誤觸
        return;
      }
      this.closeLen = len;
      // 量化後若比目前長，就繼續錄到那個點；若比較短，多錄的部分會疊回開頭
      this.closeAt = Math.max(c, len);
    }

    closeFirst() {
      const t = this.tracks[this.first];
      const len = this.closeLen;
      const total = t.recorded;
      const L = new Float32Array(len);
      const R = new Float32Array(len);
      let j = 0;
      for (const ch of t.chunks) {
        const m = Math.min(CHUNK, total - j);
        for (let k = 0; k < m; k++, j++) {
          const d = j < len ? j : j % len;
          L[d] += ch.L[k];
          R[d] += ch.R[k];
        }
        if (j >= total) break;
      }
      t.L = L;
      t.R = R;
      t.len = len;
      t.chunks = null;
      t.undo = false;
      t.state = this.afterClose;
      this.loopLen = len;
      this.first = -1;
      this.closeAt = -1;
      this.autoLevel(t);
      this.computePeaks(t);
    }

    /** 新軌錄完一圈（或被按停）：套用自動音量後切換狀態 */
    finishRec(t, state) {
      t.state = state;
      this.autoLevel(t);
      this.computePeaks(t);
    }

    /** 自動音量：把剛錄好的內容放大到目標峰值，並記住倍數給之後的疊錄使用 */
    autoLevel(t) {
      if (!this.autoGain || !t.len) return;
      const L = t.L;
      const R = t.R;
      let peak = 0;
      for (let j = 0; j < t.len; j++) {
        const a = L[j] < 0 ? -L[j] : L[j];
        const b = R[j] < 0 ? -R[j] : R[j];
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      if (peak < 1e-4) return;
      const g = Math.min(AUTO_MAX, AUTO_TARGET / peak);
      if (g <= 1.05) return;
      for (let j = 0; j < t.len; j++) {
        L[j] *= g;
        R[j] *= g;
      }
      t.inGain *= g;
    }

    cancelFirst() {
      const i = this.first;
      if (i < 0) return;
      this.tracks[i] = this.blankTrack(this.tracks[i].vol);
      this.first = -1;
      this.closeAt = -1;
      if (this.loopLen === 0 && !this.metro) {
        this.running = false;
        this.counter = 0;
      }
    }

    startRec(i) {
      const t = this.tracks[i];
      const len = this.loopLen;
      t.L = new Float32Array(len);
      t.R = new Float32Array(len);
      t.len = len;
      t.recLeft = len; // 新軌錄滿一圈後自動轉為播放
      t.undo = false;
      t.peaks.fill(0);
      t.dirty = true;
      t.state = 'rec';
    }

    saveUndo(t) {
      if (!t.uL || t.uL.length !== t.len) {
        t.uL = new Float32Array(t.len);
        t.uR = new Float32Array(t.len);
      }
      t.uL.set(t.L);
      t.uR.set(t.R);
      t.undo = true;
    }

    undo(i) {
      const t = this.tracks[i];
      if (t.state === 'rec' || t.state === 'first' || t.state === 'countin') {
        this.clear(i);
        return;
      }
      if (!t.undo) return;
      // 與備份互換：再按一次就是「重做」
      let tmp = t.L;
      t.L = t.uL;
      t.uL = tmp;
      tmp = t.R;
      t.R = t.uR;
      t.uR = tmp;
      if (t.state === 'dub') t.state = 'play';
      this.computePeaks(t);
    }

    clear(i) {
      if (i === this.first) {
        this.cancelFirst();
        return;
      }
      this.tracks[i] = this.blankTrack(this.tracks[i].vol);
      if (this.tracks.every((t) => t.state === 'empty')) {
        this.loopLen = 0;
        if (!this.metro) {
          this.running = false;
          this.counter = 0;
        }
      }
    }

    stopToggle(i) {
      const t = this.tracks[i];
      switch (t.state) {
        case 'rec':
          this.finishRec(t, 'stop');
          break;
        case 'play':
        case 'dub':
          t.state = 'stop';
          break;
        case 'stop':
          t.state = 'play';
          break;
        case 'countin':
          this.cancelFirst();
          break;
        case 'first':
          this.afterClose = 'stop';
          this.finishFirst();
          break;
      }
    }

    toggleAll() {
      const live = (s) => s === 'play' || s === 'dub' || s === 'rec';
      const anyLive = this.tracks.some((t) => live(t.state));
      for (const t of this.tracks) {
        if (anyLive && t.state === 'rec') this.finishRec(t, 'stop');
        else if (anyLive && live(t.state)) t.state = 'stop';
        else if (!anyLive && t.state === 'stop') t.state = 'play';
      }
    }

    importClip(i, L, R) {
      if (this.first >= 0) return;
      const t = this.tracks[i];
      const n = L.length;
      const others = this.tracks.some((o, j) => j !== i && o.state !== 'empty');
      if (!others) {
        // 沒有其他 Loop：這個音檔就決定 Loop 長度
        t.L = L;
        t.R = R === L ? L.slice() : R;
        t.len = n;
        this.loopLen = n;
        this.counter = 0;
        this.running = true;
      } else {
        // 對齊到主 Loop 長度的整數倍（太長截斷、太短補靜音）
        const k = Math.max(1, Math.round(n / this.loopLen));
        const len = k * this.loopLen;
        const m = Math.min(n, len);
        t.L = new Float32Array(len);
        t.R = new Float32Array(len);
        t.L.set(L.subarray(0, m));
        t.R.set(R.subarray(0, m));
        t.len = len;
      }
      t.state = 'play';
      t.undo = false;
      t.uL = null;
      t.uR = null;
      t.inGain = 1; // 匯入的音檔維持原本音量
      this.computePeaks(t);
    }

    computePeaks(t) {
      const p = t.peaks;
      p.fill(0);
      const len = t.len;
      if (!len) return;
      const L = t.L;
      const R = t.R;
      const scale = PEAKS / len;
      for (let j = 0; j < len; j++) {
        const b = (j * scale) | 0;
        const l = L[j] < 0 ? -L[j] : L[j];
        const r = R[j] < 0 ? -R[j] : R[j];
        const v = l > r ? l : r;
        if (v > p[b]) p[b] = v;
      }
      t.dirty = true;
    }

    process(inputs, outputs) {
      const oL = outputs[0][0];
      const oR = outputs[0][1] || oL;
      const kL = outputs[1][0];
      const kR = outputs[1][1] || kL;
      const n = oL.length;
      if (this.running) {
        const mic = inputs[0] || [];
        const dk = inputs[1] || [];
        const mL = mic[0] || null;
        const mR = mic[1] || mL;
        const dL = dk[0] || null;
        const dR = dk[1] || dL;
        const tracks = this.tracks;
        const nt = tracks.length;
        const beat = this.beatFrames();
        const click = Math.round(0.03 * sampleRate);
        const micLat = this.micLat;

        for (let s = 0; s < n; s++) {
          if (this.first >= 0) {
            const ft = tracks[this.first];
            if (ft.state === 'countin' && this.counter >= this.startAt) {
              ft.state = 'first';
              this.counter = 0;
            } else if (this.closeAt >= 0 && this.counter >= this.closeAt) {
              this.closeFirst();
            }
          }
          const c = this.counter;
          const inML = mL ? mL[s] : 0;
          const inMR = mR ? mR[s] : 0;
          const inDL = dL ? dL[s] : 0;
          const inDR = dR ? dR[s] : 0;
          let outL = 0;
          let outR = 0;

          for (let k = 0; k < nt; k++) {
            const t = tracks[k];
            const st = t.state;
            if (st === 'empty' || st === 'stop' || st === 'countin') continue;
            if (st === 'first') {
              if (t.fill >= CHUNK) {
                t.chunks.push({ L: new Float32Array(CHUNK), R: new Float32Array(CHUNK) });
                t.fill = 0;
              }
              const ch = t.chunks[t.chunks.length - 1];
              ch.L[t.fill] = inML + inDL;
              ch.R[t.fill] = inMR + inDR;
              t.fill++;
              t.recorded++;
              continue;
            }
            const len = t.len;
            const L = t.L;
            const R = t.R;
            const j = c % len;
            outL += L[j] * t.vol;
            outR += R[j] * t.vol;
            if (st === 'rec' || st === 'dub') {
              // DJ 盤訊號在內部，時間完全對齊；麥克風要扣掉輸出＋輸入延遲
              const g = t.inGain;
              L[j] += inDL * g;
              R[j] += inDR * g;
              let jm = j;
              if (micLat) {
                jm = (c - micLat) % len;
                if (jm < 0) jm += len;
              }
              L[jm] += inML * g;
              R[jm] += inMR * g;
              const sc = PEAKS / len;
              const p = t.peaks;
              let b = (j * sc) | 0;
              let v = Math.max(Math.abs(L[j]), Math.abs(R[j]));
              if (v > p[b]) p[b] = v;
              b = (jm * sc) | 0;
              v = Math.max(Math.abs(L[jm]), Math.abs(R[jm]));
              if (v > p[b]) p[b] = v;
              t.dirty = true;
              if (st === 'rec' && --t.recLeft <= 0) this.finishRec(t, 'play');
            }
          }
          oL[s] = outL;
          oR[s] = outR;

          if (this.metro) {
            let ph = c % beat;
            if (ph < 0) ph += beat;
            if (ph < click) {
              const idx = Math.floor(c / beat);
              const accent = ((idx % 4) + 4) % 4 === 0;
              const env = 1 - ph / click;
              const v =
                Math.sin((2 * Math.PI * (accent ? 1760 : 1175) * ph) / sampleRate) *
                env *
                env *
                (accent ? 0.5 : 0.32);
              kL[s] = v;
              kR[s] = v;
            }
          }
          this.counter++;
        }
      }
      this.since += n;
      if (this.since >= this.reportEvery) {
        this.since = 0;
        this.report();
      }
      return true;
    }

    report() {
      const tracks = this.tracks.map((t) => {
        const o = { s: t.state, len: t.len, undo: t.undo, rec: t.recorded };
        if (t.dirty) {
          o.peaks = t.peaks.slice();
          t.dirty = false;
        }
        return o;
      });
      this.port.postMessage({
        type: 'status',
        counter: this.counter,
        loopLen: this.loopLen,
        running: this.running,
        startAt: this.startAt,
        tracks,
      });
    }
  }

  /* ------------------------------------------------------------------
   * 混音錄音器：把主輸出切成小塊傳回主執行緒，最後編成 WAV。
   * ------------------------------------------------------------------ */
  class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.on = false;
      this.size = 16384;
      this.L = null;
      this.R = null;
      this.fill = 0;
      this.port.onmessage = (e) => {
        if (e.data.type === 'start') {
          this.alloc();
          this.on = true;
        } else if (e.data.type === 'stop') {
          if (this.on) this.flush();
          this.on = false;
          this.port.postMessage({ type: 'stopped' });
        }
      };
    }

    alloc() {
      this.L = new Float32Array(this.size);
      this.R = new Float32Array(this.size);
      this.fill = 0;
    }

    flush() {
      if (this.fill > 0) {
        this.port.postMessage(
          { type: 'data', L: this.L.subarray(0, this.fill), R: this.R.subarray(0, this.fill) },
          [this.L.buffer, this.R.buffer]
        );
      }
      this.alloc();
    }

    process(inputs) {
      if (this.on) {
        const inp = inputs[0] || [];
        const a = inp[0];
        const b = inp[1] || a;
        const n = a ? a.length : 128;
        for (let i = 0; i < n; i++) {
          this.L[this.fill] = a ? a[i] : 0;
          this.R[this.fill] = b ? b[i] : 0;
          if (++this.fill >= this.size) this.flush();
        }
      }
      return true;
    }
  }

  registerProcessor('dj-deck', DeckProcessor);
  registerProcessor('dj-looper', LooperProcessor);
  registerProcessor('dj-recorder', RecorderProcessor);
}
