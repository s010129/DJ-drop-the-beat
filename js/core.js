'use strict';
/* 三個頁面共用的音訊核心：AudioContext、AudioWorklet、主輸出、麥克風、錄製混音與匯出、鍵盤分派 */

/**
 * 把 processors.js 的函式轉成模組載入 AudioWorklet。
 * 先用 Blob URL；直接開檔（file://）時 Chrome 會拒絕 Blob，改用 data: URL。
 */
async function loadProcessors(ctx) {
  const src = `(${djProcessorsModule.toString()})();`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch (err) {
    await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 每個頁面繼承這個類別，覆寫：
 *   setup()            建立頁面介面（還沒有音訊）
 *   setupAudio(ctx)    建立頁面的音訊節點（接到 this.master）
 *   render(dt)         每一格畫面更新
 *   isKey(code)        這個按鍵是否由頁面處理
 *   keyDown(code, shift) 執行動作，回傳放開時要呼叫的函式（或 null）
 *   onMicReady(ms)     麥克風開啟後，傳入估計的延遲（毫秒）
 */
class AudioApp {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.starting = null;
    this.micReady = false;
    this.meters = [];
    this.held = new Map();
    this.rec = null;
    this.lastFrame = 0;
  }

  init() {
    this.setup();
    this.bindCommon();
    this.bindKeyboard();
  }

  setup() {}
  setupAudio() {}
  render() {}
  isKey() {
    return false;
  }
  keyDown() {
    return null;
  }
  onMicReady() {}

  bindCommon() {
    // 避免把檔案拖到空白處時瀏覽器直接開啟檔案
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    // 觸控長按時不要跳出選單
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.no-menu, button, .pad, .pp, .platter, .knob, .fader, canvas, kbd')) e.preventDefault();
    });
    // 用滑鼠／觸控點過的按鈕不要留著焦點，否則按 Space / Enter 會再按一次它
    document.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && e.detail > 0) b.blur();
    });
    document.addEventListener('change', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') e.target.blur();
    });
    $('#startBtn').addEventListener('click', () => this.start());

    const recBtn = $('#recBtn');
    if (recBtn) {
      this.recLabel = $('.rec-label', recBtn).textContent;
      recBtn.addEventListener('click', async () => {
        await this.start();
        this.toggleRecord();
      });
      $('#recFormat').addEventListener('change', (e) => e.target.blur());
    }
    const dlg = $('#help');
    if (dlg) {
      $('#helpBtn').addEventListener('click', () => (dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '')));
      $('#helpClose').addEventListener('click', () => (dlg.close ? dlg.close() : dlg.removeAttribute('open')));
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close();
      });
    }
    $$('.mic-btn').forEach((b) =>
      b.addEventListener('click', async () => {
        await this.start();
        this.enableMic();
      })
    );
  }

  /** 第一次互動時建立 AudioContext（瀏覽器規定要有使用者操作） */
  start() {
    if (!this.starting) {
      this.starting = this.boot().catch((err) => {
        console.error(err);
        this.starting = null;
        $('#startError').textContent = `無法啟動音訊：${err.message || err}`;
      });
    }
    return this.starting;
  }

  async boot() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.AudioWorkletNode) throw new Error('這個瀏覽器不支援 AudioWorklet，請改用最新版 Chrome / Edge / Firefox / Safari');
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.resume();
    await loadProcessors(ctx);

    // 主輸出：master 音量 → 限幅器 → 喇叭／錄音
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    this.master.connect(this.limiter).connect(this.masterOut).connect(ctx.destination);
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterOut.connect(this.masterAnalyser);

    this.recorder = new AudioWorkletNode(ctx, 'dj-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.recorder.port.onmessage = (e) => this.onRecorderMessage(e.data);
    this.masterOut.connect(this.recorder);
    this.recorder.connect(ctx.destination); // 輸出是靜音，只是讓節點持續運作

    this.micBus = ctx.createGain();
    this.micMonitor = ctx.createGain();
    this.micMonitor.gain.value = 0;
    this.micBus.connect(this.micMonitor).connect(this.master);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micBus.connect(this.micAnalyser);

    await this.setupAudio(ctx);

    this.started = true;
    document.body.classList.add('started');
    $('#startOverlay').classList.add('hidden');
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  setGain(node, v) {
    if (node && this.ctx) node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  addMeter(el, analyser) {
    if (el && analyser) this.meters.push(new Meter(el, analyser));
  }

  /* ---------------- 麥克風 ---------------- */

  setMicMonitor(on) {
    this.setGain(this.micMonitor, on ? 1 : 0);
    if (on) toast('監聽開啟：麥克風會出現在喇叭與混音錄音中（請戴耳機避免回授）');
  }

  async enableMic() {
    if (this.micReady) return true;
    await this.start();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('無法使用麥克風：請用 https 網址或 localhost 開啟', 'error');
      return false;
    }
    const btns = $$('.mic-btn');
    btns.forEach((b) => (b.textContent = '要求權限中…'));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micBus);
      const settings = stream.getAudioTracks()[0].getSettings();
      const inLat = typeof settings.latency === 'number' ? settings.latency : 0.01;
      const outLat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
      this.micReady = true;
      btns.forEach((b) => {
        b.textContent = '麥克風已啟用';
        b.classList.add('on');
        b.disabled = true;
      });
      this.onMicReady(Math.round((inLat + outLat) * 1000));
      return true;
    } catch (err) {
      console.error(err);
      btns.forEach((b) => (b.textContent = '啟用麥克風'));
      toast('沒有取得麥克風權限：' + (err.message || err.name), 'error');
      return false;
    }
  }

  /** 使用者聽到聲音到按下按鍵之間的輸出延遲（秒） */
  outputLatency() {
    return this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
  }

  /* ---------------- 錄製混音 & 匯出 ---------------- */

  toggleRecord() {
    if (this.rec) {
      if (!this.rec.stopping) this.stopRecord();
    } else {
      this.startRecord();
    }
  }

  startRecord() {
    const fmt = $('#recFormat').value;
    const prefix = document.body.dataset.exportPrefix || 'mix';
    if (fmt === 'wav') {
      this.rec = { fmt, chunks: [], frames: 0, start: performance.now(), prefix };
      this.recorder.port.postMessage({ type: 'start' });
    } else {
      const mime = pickRecorderMime();
      if (!mime) {
        toast('這個瀏覽器不支援壓縮錄音，改用 WAV');
        $('#recFormat').value = 'wav';
        this.startRecord();
        return;
      }
      if (!this.streamDest) {
        this.streamDest = this.ctx.createMediaStreamDestination();
        this.masterOut.connect(this.streamDest);
      }
      const mr = new MediaRecorder(this.streamDest.stream, { mimeType: mime, audioBitsPerSecond: 256000 });
      const parts = [];
      const rec = { fmt, mr, mime, start: performance.now(), prefix };
      mr.ondataavailable = (e) => e.data.size && parts.push(e.data);
      mr.onstop = () => {
        const dur = (performance.now() - rec.start) / 1000;
        this.rec = null;
        this.addExport(new Blob(parts, { type: mime }), `${prefix}-${stamp()}.${mimeExt(mime)}`, dur, false);
      };
      mr.start(1000);
      this.rec = rec;
    }
    document.body.classList.add('recording');
    $('#recBtn .rec-label').textContent = '停止錄製';
    toast('開始錄製（節拍器不會被錄進去）');
  }

  stopRecord() {
    const r = this.rec;
    r.stopping = true;
    r.end = performance.now();
    document.body.classList.remove('recording');
    $('#recBtn .rec-label').textContent = this.recLabel;
    if (r.fmt === 'wav') this.recorder.port.postMessage({ type: 'stop' });
    else r.mr.stop();
  }

  onRecorderMessage(m) {
    const r = this.rec;
    if (!r || r.fmt !== 'wav') return;
    if (m.type === 'data') {
      r.chunks.push(floatsToInt16(m.L, m.R));
      r.frames += m.L.length;
    } else if (m.type === 'stopped') {
      this.rec = null;
      const sr = this.ctx.sampleRate;
      const blob = new Blob([wavHeader(r.frames, sr), ...r.chunks], { type: 'audio/wav' });
      this.addExport(blob, `${r.prefix}-${stamp()}.wav`, r.frames / sr, false);
    }
  }

  addExport(blob, name, duration, autoDownload) {
    const url = URL.createObjectURL(blob);
    const li = document.createElement('li');
    li.className = 'export-item';
    li.innerHTML = `
      <div class="ex-info"><div class="ex-name"></div><div class="ex-meta">${fmtTime(duration, false)} · ${fmtSize(blob.size)}</div></div>
      <audio controls preload="metadata"></audio>
      <a class="btn small primary">⬇ 下載</a>
      <button type="button" class="btn icon ghost" title="從清單移除">✕</button>`;
    $('.ex-name', li).textContent = name;
    $('audio', li).src = url;
    const a = $('a', li);
    a.href = url;
    a.download = name;
    $('button', li).addEventListener('click', () => {
      URL.revokeObjectURL(url);
      li.remove();
      if (!$('#exportList').children.length) $('#exports').hidden = true;
    });
    $('#exportList').prepend(li);
    $('#exports').hidden = false;
    if (autoDownload) a.click();
    toast(`已匯出：${name}`, 'ok');
    if (!autoDownload) $('#exports').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------------- 鍵盤 ---------------- */

  bindKeyboard() {
    const isField = (el) =>
      el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range'].includes(el.type)));

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isField(e.target)) {
        if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
        return;
      }
      const code = e.code;
      const known = this.isKey(code);
      if (!this.started) {
        if (known || code === 'Space' || code === 'Enter') {
          e.preventDefault();
          this.start();
        }
        return;
      }
      if (!known) return;
      e.preventDefault();
      if (e.repeat || this.held.has(code)) return;
      this.held.set(code, this.keyDown(code, e.shiftKey));
      $$(`[data-key="${code}"]`).forEach((el) => el.classList.add('is-down'));
    });

    window.addEventListener('keyup', (e) => this.keyUp(e.code));
    // 切換視窗時放開所有按鍵，避免卡在按住的狀態
    window.addEventListener('blur', () => [...this.held.keys()].forEach((c) => this.keyUp(c)));
  }

  keyUp(code) {
    if (!this.held.has(code)) return;
    const release = this.held.get(code);
    this.held.delete(code);
    $$(`[data-key="${code}"]`).forEach((el) => el.classList.remove('is-down'));
    if (release) release();
  }

  /* ---------------- 畫面更新 ---------------- */

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.render(dt, now);
    for (const m of this.meters) m.update(dt);
    if (this.rec) {
      const secs = ((this.rec.end || now) - this.rec.start) / 1000;
      let text = fmtTime(secs, false);
      if (this.rec.fmt === 'wav') text += ` · ${fmtSize(this.rec.frames * 4)}`;
      if (text !== this._recText) $('#recTime').textContent = this._recText = text;
    }
    requestAnimationFrame((t) => this.frame(t));
  }
}
