// In-Browser & Headless Stream Recorder for Seismic Resonance
// Composites map, solar dial, stereo spectrum analyzers, and HUD metadata
// with Web Audio sub-bass output via MediaRecorder.

export const RESOLUTION_PRESETS = {
  '720p': { width: 1280, height: 720, label: '720p (1280×720)' },
  '1080p': { width: 1920, height: 1080, label: '1080p (1920×1080)' },
  '4k': { width: 3840, height: 2160, label: '4K UHD (3840×2160)' },
  '8k': { width: 7680, height: 4320, label: '8K UHD (7680×4320)' },
};

export const QUALITY_BITRATES = {
  low: 4_000_000,
  medium: 10_000_000,
  high: 22_000_000,
  lossless: 45_000_000,
};

const CHANNEL_MASKS = {
  1: 0x0004, // FC
  2: 0x0003, // FL | FR
  4: 0x0033, // FL | FR | BL | BR (Quad)
  6: 0x003f, // FL | FR | FC | LFE | BL | BR (5.1)
  8: 0x063f, // FL | FR | FC | LFE | BL | BR | SL | SR (7.1)
};

export function encodeWavBlob(chunks, sampleRate, numChannels, bitDepth = 16) {
  let dataBytes = 0;
  for (const chunk of chunks) dataBytes += chunk.byteLength;
  const bytesPerSample = bitDepth / 8;
  const isFloat = bitDepth === 32;
  const useExtensible = numChannels > 2;
  const fmtSize = useExtensible ? 40 : 16;
  const headerSize = 12 + 8 + fmtSize + 8;
  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, headerSize - 8 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, useExtensible ? 0xfffe : isFloat ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // blockAlign
  view.setUint16(34, bitDepth, true); // bitsPerSample

  if (useExtensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bitDepth, true); // wValidBitsPerSample
    view.setUint32(40, CHANNEL_MASKS[numChannels] ?? 0, true); // dwChannelMask
    // KSDATAFORMAT_SUBTYPE_PCM (0x01) or KSDATAFORMAT_SUBTYPE_IEEE_FLOAT (0x03)
    view.setUint32(44, isFloat ? 0x00000003 : 0x00000001, true);
    view.setUint16(48, 0x0000, true);
    view.setUint16(50, 0x0010, true);
    const tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    tail.forEach((b, i) => view.setUint8(52 + i, b));
  }

  const dataOff = 20 + fmtSize;
  writeStr(dataOff, 'data');
  view.setUint32(dataOff + 4, dataBytes, true);

  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

export function pickSupportedMimeType(preferredFormat = 'webm') {
  const candidates =
    preferredFormat === 'mp4'
      ? [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/mp4',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ]
      : [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
          'video/mp4',
        ];

  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

export class SeismicRecorder {
  constructor(app) {
    this.app = app;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.chunks = [];
    this.compositeCanvas = null;
    this.compositeCtx = null;
    this.compositeTimer = null;
    this.displayStream = null;
    this.canvasStream = null;
    this.startedAt = 0;
    this.options = {};
    this._stopPromiseResolve = null;
    this._progressInterval = null;
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
  }

  /**
   * Starts recording a single stream pass (or manual stop).
   * @param {object} opts
   * @param {number} [opts.width=1920]
   * @param {number} [opts.height=1080]
   * @param {number} [opts.fps=30]
   * @param {string} [opts.quality='high']
   * @param {number} [opts.channels] Audio channel count (1, 2, 4, 6, 8)
   * @param {string} [opts.captureMode='canvas'] 'canvas' (clean cinema) | 'tab' (full DOM via getDisplayMedia)
   * @param {string} [opts.filename]
   * @param {boolean} [opts.autoDownload=true]
   * @param {boolean} [opts.stopOnCycleEnd=true]
   */
  async start(opts = {}) {
    if (this.isRecording) {
      throw new Error('Recording is already in progress.');
    }

    const width = Math.max(320, Number(opts.width) || 1920);
    const height = Math.max(240, Number(opts.height) || 1080);
    const fps = Math.max(15, Math.min(240, Number(opts.fps) || 30));
    const quality = opts.quality || 'high';
    const audioQuality = opts.audioQuality || 'high';
    const channels = opts.channels != null ? Number(opts.channels) : undefined;
    const captureMode = opts.captureMode || 'canvas';
    const stopOnCycleEnd = opts.stopOnCycleEnd !== false;
    const autoDownload = opts.autoDownload !== false;

    this.options = {
      width,
      height,
      fps,
      quality,
      audioQuality,
      channels,
      captureMode,
      filename: opts.filename || this._defaultFilename(),
      autoDownload,
      stopOnCycleEnd,
    };

    // Ensure Web Audio is initialized & running so audio is captured
    await this.app.ensureAudioStartedForRecording(channels, audioQuality);

    let videoStream = null;
    if (captureMode === 'tab' && navigator.mediaDevices?.getDisplayMedia) {
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps },
        audio: false,
        preferCurrentTab: true,
      });
      videoStream = this.displayStream;
      const [track] = this.displayStream.getVideoTracks();
      if (track) {
        track.addEventListener('ended', () => {
          if (this.isRecording) this.stop();
        });
      }
    } else {
      const encW = Math.round(width / 2) * 2;
      const encH = Math.round(height / 2) * 2;

      this.compositeCanvas = document.createElement('canvas');
      this.compositeCanvas.width = encW;
      this.compositeCanvas.height = encH;
      this.compositeCtx = this.compositeCanvas.getContext('2d', { alpha: false });
      this.compositeCtx.imageSmoothingEnabled = true;
      this.compositeCtx.imageSmoothingQuality = 'high';

      this._drawCompositeFrame();
      const intervalMs = Math.max(4, Math.round(1000 / fps));
      const scheduleNextFrame = () => {
        if (!this.compositeCanvas) return;
        const t0 = performance.now();
        this._drawCompositeFrame();
        const elapsed = performance.now() - t0;
        const delay = Math.max(4, intervalMs - elapsed);
        this.compositeTimer = setTimeout(scheduleNextFrame, delay);
      };
      this.compositeTimer = setTimeout(scheduleNextFrame, intervalMs);
      this.canvasStream = this.compositeCanvas.captureStream(fps);
      videoStream = this.canvasStream;
    }

    const combined = new MediaStream();
    for (const vt of videoStream.getVideoTracks()) {
      combined.addTrack(vt);
    }

    const audioStream = this.app.audio.getRecordingStream(channels);
    if (audioStream) {
      for (const at of audioStream.getAudioTracks()) {
        combined.addTrack(at);
      }
    }

    const mimeType = pickSupportedMimeType(opts.preferredFormat || 'webm');
    const videoBitsPerSecond = QUALITY_BITRATES[quality] || QUALITY_BITRATES.high;
    const recChannels = channels || this.app.audio.recordingChannelCount || this.app.audio.channelCount || 2;
    const audioBitrateTable = {
      standard: recChannels <= 1 ? 128_000 : recChannels <= 2 ? 192_000 : recChannels <= 6 ? 384_000 : 512_000,
      high: recChannels <= 1 ? 192_000 : recChannels <= 2 ? 320_000 : recChannels <= 6 ? 512_000 : 768_000,
      ultra: recChannels <= 1 ? 256_000 : recChannels <= 2 ? 510_000 : recChannels <= 6 ? 768_000 : 1_024_000,
    };
    const audioBitsPerSecond = audioBitrateTable[audioQuality] || audioBitrateTable.high;
    const needsWavMaster = recChannels > 2 || audioQuality === 'ultra';
    const recOpts = {
      videoBitsPerSecond,
      audioBitsPerSecond,
    };
    if (mimeType) {
      recOpts.mimeType = mimeType;
    }

    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(combined, recOpts);
    this.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
      }
    };

    this.mediaRecorder.onerror = async (ev) => {
      const err = ev.error || new Error('MediaRecorder error');
      await this.app.audio.stopMultichannelCapture?.();
      this._cleanupStreams();
      this.isRecording = false;
      this.onError?.(err);
      if (this._stopPromiseResolve) {
        this._stopPromiseResolve(null);
        this._stopPromiseResolve = null;
      }
    };

    this.mediaRecorder.onstop = async () => {
      const finalMime = this.mediaRecorder?.mimeType || mimeType || 'video/webm';
      const blob = new Blob(this.chunks, { type: finalMime });
      this.chunks = [];

      let wavBlob = null;
      let wavFilename = null;
      let wavBitDepth = 0;
      let wavSampleRate = 0;
      if (needsWavMaster && this.app.audio.stopMultichannelCapture) {
        const cap = await this.app.audio.stopMultichannelCapture();
        if (cap && cap.chunks && cap.chunks.length > 0) {
          wavBitDepth = cap.bitDepth || 16;
          wavSampleRate = cap.sampleRate || 48000;
          wavBlob = encodeWavBlob(cap.chunks, wavSampleRate, cap.channels, wavBitDepth);
          const tag = cap.channels > 2 ? `${cap.channels}ch` : 'hifi';
          wavFilename = this.options.filename.replace(/\.(mp4|webm|wav)$/i, '') + `_${tag}.wav`;
        }
      }

      this._cleanupStreams();
      this.isRecording = false;

      if (this.options.autoDownload && blob.size > 0) {
        this._triggerDownload(blob, this.options.filename, finalMime);
        if (wavBlob && wavBlob.size > 0) {
          setTimeout(() => this._triggerDownload(wavBlob, wavFilename, 'audio/wav'), 250);
        }
      }
      this.onComplete?.(blob, {
        mimeType: finalMime,
        filename: this.options.filename,
        durationMs: performance.now() - this.startedAt,
        sizeBytes: blob.size,
        wavBlob,
        wavFilename,
        wavSizeBytes: wavBlob?.size || 0,
        wavChannels: wavBlob ? recChannels : 0,
        wavBitDepth,
        wavSampleRate,
      });

      if (this._stopPromiseResolve) {
        this._stopPromiseResolve({ blob, mimeType: finalMime, wavBlob, wavFilename });
        this._stopPromiseResolve = null;
      }
    };

    if (needsWavMaster && this.app.audio.startMultichannelCapture) {
      await this.app.audio.startMultichannelCapture(recChannels, audioQuality);
    }

    // Reset stream to start of filtered dataset for a clean 1-cycle pass
    this.app.mode = 'stream';
    this.app._resetStreamCursor();
    this.isRecording = true;
    this.startedAt = performance.now();
    this.mediaRecorder.start(1000);

    this._progressInterval = setInterval(() => {
      this._emitProgress();
    }, 250);
    this._emitProgress();
  }

  stop() {
    if (!this.isRecording && !this.mediaRecorder) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this._stopPromiseResolve = resolve;
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        try {
          this.mediaRecorder.stop();
        } catch (err) {
          this._cleanupStreams();
          this.isRecording = false;
          resolve(null);
        }
      } else {
        this._cleanupStreams();
        this.isRecording = false;
        resolve(null);
      }
    });
  }

  handleStreamCycleComplete() {
    if (this.isRecording && this.options.stopOnCycleEnd) {
      this.stop();
    }
  }

  _emitProgress() {
    if (!this.isRecording) return;
    const progress = this.app.getStreamProgress();
    this.onProgress?.({
      ...progress,
      elapsedMs: performance.now() - this.startedAt,
    });
  }

  _cleanupStreams() {
    if (this.compositeTimer) {
      clearTimeout(this.compositeTimer);
      this.compositeTimer = null;
    }
    if (this._progressInterval) {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
    }
    if (this.canvasStream) {
      this.canvasStream.getTracks().forEach((t) => t.stop());
      this.canvasStream = null;
    }
    if (this.displayStream) {
      this.displayStream.getTracks().forEach((t) => t.stop());
      this.displayStream = null;
    }
    this.compositeCanvas = null;
    this.compositeCtx = null;
  }

  _drawCompositeFrame() {
    const ctx = this.compositeCtx;
    const canvas = this.compositeCanvas;
    if (!ctx || !canvas) return;

    const W = canvas.width;
    const H = canvas.height;
    const s = Math.max(0.5, H / 1080);

    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, W, H);

    // 1. Full-bleed map canvas (cover fit preserving aspect ratio)
    const mapCanvas = this.app.mapCanvas;
    if (mapCanvas && mapCanvas.width > 0 && mapCanvas.height > 0) {
      this._drawCover(ctx, mapCanvas, 0, 0, W, H);
    }

    // 2. Top bar (.brand + .header-stats matching asides-hidden, with USGS Replay & yellow indicator)
    this._drawTopBarHud(ctx, W, H, s);

    // 3. Right-side legend header + floating .hud-event-list cards
    const bottomReserve = 108 * s;
    this._drawRightHud(ctx, W, H, s, bottomReserve);

    // 4. Bottom stereo spectrum bars
    this._drawBottomHud(ctx, W, H, s);
  }

  _drawTopBarHud(ctx, W, H, s) {
    const margin = 14 * s;
    const barH = 58 * s;
    const barY = margin;
    const radius = 12 * s;

    // Left: .brand pill (SEISMIC RESONANCE only — no subtitle, no help ?, no REC button)
    ctx.save();
    const titleFont = `700 ${14 * s}px "Inter", sans-serif`;
    ctx.font = titleFont;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${0.14 * 14 * s}px`;
    const titleText = 'SEISMIC RESONANCE';
    const titleW = ctx.measureText(titleText).width;
    const brandPadX = 18 * s;
    const brandW = titleW + brandPadX * 2;
    this._drawGlassBox(ctx, margin, barY, brandW, barH, radius, 'rgba(11, 16, 24, 0.78)', 'rgba(148, 163, 184, 0.14)');
    ctx.fillStyle = '#f8fafc';
    ctx.textBaseline = 'middle';
    ctx.fillText(titleText, margin + brandPadX, barY + barH / 2);
    ctx.restore();

    // Right: .header-stats container with two .stat-pill boxes
    const dsLabel = (document.getElementById('stat-dataset-label')?.textContent || 'PAST').trim();
    const dsValue = (this.app.statDatasetValue?.textContent || '24H (All)').trim();
    const evCount = (this.app.statEventCount?.textContent || '0').trim();

    const labelFont = `600 ${10 * s}px "Inter", sans-serif`;
    const valFont = `600 ${12 * s}px "Inter", sans-serif`;
    const monoValFont = `600 ${12 * s}px "JetBrains Mono", monospace`;
    const sepFont = `400 ${11 * s}px "Inter", sans-serif`;

    // Measure Pill 1: [yellow pulsing dot] FEED  USGS Replay (no .stat-audio-icon)
    const pillPadX = 11 * s;
    const pillGap = 8 * s;
    const dotSize = 11 * s;
    const feedStatusText = 'USGS Replay';

    ctx.save();
    ctx.font = labelFont;
    const feedLabelW = ctx.measureText('FEED').width;
    ctx.font = valFont;
    const feedValW = ctx.measureText(feedStatusText).width;
    const pill1W = pillPadX * 2 + dotSize + pillGap + feedLabelW + pillGap + feedValW;

    // Measure Pill 2: PAST 24H (All) | EVENTS 0 (DT hidden per body.asides-hidden)
    ctx.font = labelFont;
    const dsLabelW = ctx.measureText(dsLabel).width;
    const evLabelW = ctx.measureText('EVENTS').width;
    ctx.font = monoValFont;
    const dsValW = ctx.measureText(dsValue).width;
    const evValW = ctx.measureText(evCount).width;
    ctx.font = sepFont;
    const sepW = ctx.measureText('|').width;
    const pill2W = pillPadX * 2 + dsLabelW + pillGap + dsValW + pillGap + sepW + pillGap + evLabelW + pillGap + evValW;

    const pillH = 32 * s;
    const pillY = barY + (barH - pillH) / 2;
    const statsPadX = 12 * s;
    const statsGap = 10 * s;
    const statsW = statsPadX * 2 + pill1W + statsGap + pill2W;
    const statsX = W - margin - statsW;

    this._drawGlassBox(ctx, statsX, barY, statsW, barH, radius, 'rgba(11, 16, 24, 0.78)', 'rgba(148, 163, 184, 0.14)');

    // Draw Pill 1
    const p1X = statsX + statsPadX;
    this._drawGlassBox(ctx, p1X, pillY, pill1W, pillH, 8 * s, 'rgba(255, 255, 255, 0.03)', 'rgba(255, 255, 255, 0.06)');

    // Flashing yellow #live-indicator (--accent-gold #f7b801, 2.2s ease-in-out pulse)
    const phase = (performance.now() % 2200) / 2200;
    const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const pulseOpacity = 1 - 0.55 * wave;
    const pulseScale = 1 - 0.18 * wave;
    const dotCx = p1X + pillPadX + dotSize / 2;
    const dotCy = pillY + pillH / 2;

    ctx.save();
    ctx.globalAlpha = pulseOpacity;
    ctx.fillStyle = '#f7b801';
    ctx.shadowColor = '#f7b801';
    ctx.shadowBlur = 12 * s;
    ctx.beginPath();
    ctx.arc(dotCx, dotCy, (dotSize / 2) * pulseScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    let cx = p1X + pillPadX + dotSize + pillGap;
    ctx.textBaseline = 'middle';
    ctx.font = labelFont;
    ctx.fillStyle = '#8494a7';
    ctx.fillText('FEED', cx, dotCy);
    cx += feedLabelW + pillGap;
    ctx.font = valFont;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(feedStatusText, cx, dotCy);

    // Draw Pill 2
    const p2X = p1X + pill1W + statsGap;
    this._drawGlassBox(ctx, p2X, pillY, pill2W, pillH, 8 * s, 'rgba(255, 255, 255, 0.03)', 'rgba(255, 255, 255, 0.06)');

    cx = p2X + pillPadX;
    ctx.font = labelFont;
    ctx.fillStyle = '#8494a7';
    ctx.fillText(dsLabel, cx, dotCy);
    cx += dsLabelW + pillGap;

    ctx.font = monoValFont;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(dsValue, cx, dotCy);
    cx += dsValW + pillGap;

    ctx.font = sepFont;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.fillText('|', cx, dotCy);
    cx += sepW + pillGap;

    ctx.font = labelFont;
    ctx.fillStyle = '#8494a7';
    ctx.fillText('EVENTS', cx, dotCy);
    cx += evLabelW + pillGap;

    ctx.font = monoValFont;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(evCount, cx, dotCy);
    ctx.restore();
  }

  _drawRightHud(ctx, W, H, s, bottomReserve) {
    const margin = 14 * s;
    const panelW = 286 * s;
    const panelX = W - margin - panelW;
    let curY = 84 * s; // 14 + 58 + 12

    // .panel-right-header
    const pad = 14 * s;
    const legendCanvas = this.app.depthLegendCanvas;
    const legendAspect = (legendCanvas && legendCanvas.width > 0 && legendCanvas.height > 0)
      ? legendCanvas.height / legendCanvas.width
      : 0.28;
    const legendW = panelW - pad * 2;
    const legendH = Math.round(legendW * legendAspect);
    const titleH = 14 * s;
    const headerGap = 10 * s;
    const dtText = this.app.statDatetimeEl?.textContent?.trim();
    const dtH = dtText ? 14 * s : 0;
    const hasLegend = Boolean(legendCanvas && legendCanvas.width > 0);
    const headerH = pad * 2 + titleH
      + (hasLegend ? headerGap + legendH : 0)
      + (dtText ? headerGap + dtH : 0);

    this._drawGlassBox(ctx, panelX, curY, panelW, headerH, 12 * s, 'rgba(11, 16, 24, 0.78)', 'rgba(148, 163, 184, 0.14)');

    ctx.save();
    ctx.font = `600 ${11 * s}px "Inter", sans-serif`;
    ctx.fillStyle = '#8494a7';
    ctx.textBaseline = 'top';
    ctx.fillText('RECENT SEISMIC EVENTS & DEPTHS', panelX + pad, curY + pad);
    let innerY = curY + pad + titleH;
    if (hasLegend && legendCanvas.height > 0) {
      innerY += headerGap;
      ctx.drawImage(legendCanvas, panelX + pad, innerY, legendW, legendH);
      innerY += legendH;
    }
    if (dtText) {
      innerY += headerGap;
      ctx.font = `600 ${12 * s}px "JetBrains Mono", monospace`;
      ctx.fillStyle = '#f1f5f9';
      ctx.textAlign = 'right';
      ctx.fillText(dtText, panelX + panelW - pad, innerY);
    }
    ctx.restore();

    curY += headerH + 10 * s;

    // .hud-event-list floating cards
    const hudList = this.app.hudEventListEl;
    if (!hudList || !hudList.children.length) return;

    const maxY = H - bottomReserve;
    const cardGap = 6 * s;
    const cardPadX = 10 * s;
    const cardPadY = 8 * s;
    const badgeW = 42 * s;
    const badgeH = 30 * s;
    const innerGap = 10 * s;
    const textMaxW = panelW - cardPadX * 2 - badgeW - innerGap;

    for (const card of hudList.children) {
      const opacity = parseFloat(card.style.getPropertyValue('--hud-opacity') || '1');
      if (!Number.isFinite(opacity) || opacity <= 0.01) continue;

      const badgeEl = card.querySelector('.mag-badge');
      const placeEl = card.querySelector('.event-place');
      const timeEl = card.querySelector('.event-time');
      const metaSpans = card.querySelectorAll('.event-meta > span');
      const rightMetaEl = metaSpans.length > 1 ? metaSpans[1] : null;

      const magText = badgeEl?.textContent?.trim() || '';
      const placeText = placeEl?.textContent?.trim() || '';
      const timeText = timeEl?.textContent?.trim() || '';
      const rightMetaText = rightMetaEl?.textContent?.trim() || '';

      let badgeColor = '#ff6b35';
      if (badgeEl?.classList.contains('mag-mid')) badgeColor = '#f7b801';
      else if (badgeEl?.classList.contains('mag-deep')) badgeColor = '#38bdf8';

      const depthRgb = card.style.getPropertyValue('--depth-rgb').trim() || '255, 107, 53';
      const isRippling = card.classList.contains('rippling');
      const waveProgress = parseFloat(card.style.getPropertyValue('--wave-progress') || '0');
      const waveAlpha = parseFloat(card.style.getPropertyValue('--wave-alpha') || '0');

      ctx.save();
      ctx.font = `500 ${12 * s}px "Inter", sans-serif`;
      const placeLines = this._wrapCanvasText(ctx, placeText, textMaxW, 2);
      const lineH = 15 * s;
      const metaH = 13 * s;
      const contentH = Math.max(badgeH, placeLines.length * lineH + 2 * s + metaH);
      const cardH = cardPadY * 2 + contentH;

      if (curY + cardH > maxY) {
        ctx.restore();
        break;
      }

      ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

      const borderCol = isRippling
        ? `rgba(${depthRgb}, ${(0.25 + 0.65 * waveAlpha).toFixed(3)})`
        : 'rgba(148, 163, 184, 0.14)';

      this._drawGlassBox(ctx, panelX, curY, panelW, cardH, 8 * s, 'rgba(11, 16, 24, 0.78)', borderCol);

      if (isRippling && waveAlpha > 0.01) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(panelX, curY, panelW, cardH, 8 * s);
        ctx.clip();
        const gx = panelX + panelW * (0.12 + 0.88 * waveProgress);
        const gy = curY + cardH / 2;
        const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, panelW * 0.7);
        grad.addColorStop(0, `rgba(${depthRgb}, ${(0.32 * waveAlpha).toFixed(3)})`);
        grad.addColorStop(0.48, `rgba(${depthRgb}, ${(0.16 * waveAlpha).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${depthRgb}, ${(0.05 * waveAlpha).toFixed(3)})`);
        ctx.fillStyle = grad;
        ctx.fillRect(panelX, curY, panelW, cardH);
        ctx.restore();
      }

      // Mag badge
      const bx = panelX + cardPadX;
      const by = curY + (cardH - badgeH) / 2;
      ctx.fillStyle = badgeColor;
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 6 * s);
      ctx.fill();

      ctx.font = `700 ${12 * s}px "JetBrains Mono", monospace`;
      ctx.fillStyle = '#06090e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(magText, bx + badgeW / 2, by + badgeH / 2);

      // Place + meta
      const tx = bx + badgeW + innerGap;
      let ty = curY + cardPadY;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `500 ${12 * s}px "Inter", sans-serif`;
      ctx.fillStyle = '#f1f5f9';
      for (const line of placeLines) {
        ctx.fillText(line, tx, ty);
        ty += lineH;
      }

      ty += 2 * s;
      ctx.font = `400 ${10.5 * s}px "JetBrains Mono", monospace`;
      ctx.fillStyle = '#8494a7';
      ctx.fillText(timeText, tx, ty);

      if (rightMetaText) {
        ctx.textAlign = 'right';
        ctx.fillText(rightMetaText, panelX + panelW - cardPadX, ty);
      }

      ctx.restore();
      curY += cardH + cardGap;
    }
  }

  _drawBottomHud(ctx, W, H, s) {
    const asideOffset = 312 * s;
    const shift = (asideOffset / 3) - 28 * s; // 76*s
    const barLeft = asideOffset;
    const barWidth = Math.max(240 * s, W - asideOffset * 2);
    const halfW = (barWidth - 84 * s) / 2;
    const barH = 68 * s;
    const specY = H - 14 * s - barH;
    const leftX = Math.max(14 * s, barLeft - shift);
    const rightX = Math.min(W - 14 * s - halfW, barLeft + barWidth - halfW + shift);
    const padX = 12 * s;
    const padY = 10 * s;

    const leftSpec = this.app.audioCanvasLeft;
    const rightSpec = this.app.audioCanvasRight;
    if (leftSpec && leftSpec.width > 0) {
      this._drawGlassBox(ctx, leftX, specY, halfW, barH, 12 * s, 'rgba(11, 16, 24, 0.56)', 'rgba(255, 255, 255, 0.10)');
      ctx.drawImage(leftSpec, leftX + padX, specY + padY, halfW - padX * 2, barH - padY * 2);
    }
    if (rightSpec && rightSpec.width > 0) {
      this._drawGlassBox(ctx, rightX, specY, halfW, barH, 12 * s, 'rgba(11, 16, 24, 0.56)', 'rgba(255, 255, 255, 0.10)');
      ctx.drawImage(rightSpec, rightX + padX, specY + padY, halfW - padX * 2, barH - padY * 2);
    }
  }

  _wrapCanvasText(ctx, text, maxWidth, maxLines = 2) {
    if (!text) return [''];
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
        if (lines.length === maxLines - 1) break;
      }
    }
    if (current) lines.push(current);
    if (lines.length > maxLines) lines.length = maxLines;
    return lines;
  }

  _drawCover(ctx, src, dx, dy, dw, dh) {
    const sw = src.width;
    const sh = src.height;
    const scale = Math.max(dw / sw, dh / sh);
    const rw = sw * scale;
    const rh = sh * scale;
    const ox = dx + (dw - rw) / 2;
    const oy = dy + (dh - rh) / 2;
    ctx.drawImage(src, ox, oy, rw, rh);
  }

  _drawGlassBox(ctx, x, y, w, h, r, fill = 'rgba(10, 15, 24, 0.72)', stroke = 'rgba(148, 163, 184, 0.22)') {
    ctx.save();
    ctx.beginPath();
    const radius = Math.min(r, w / 2, h / 2);
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.restore();
  }

  _defaultFilename() {
    const now = new Date();
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return `seismic_${d}_${this.app.speedMultiplier}x.webm`;
  }

  _triggerDownload(blob, filename, mimeType) {
    let ext = '.webm';
    if (mimeType.includes('wav')) {
      ext = '.wav';
    } else if (mimeType.includes('mp4')) {
      ext = '.mp4';
    }
    const safeName = filename.replace(/\.(mp4|webm|wav)$/i, '') + ext;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
