// Low-Frequency Seismic Synthesizer (Web Audio API)
// Designed for sub-bass & bass registers (27 Hz - 200 Hz)

const SCALES = {
  dorian: [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19],
  phrygian: [0, 1, 4, 5, 7, 8, 10, 12, 13, 16, 17, 19],
  pentatonic: [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24],
  just: null, // Uses pure harmonic ratios below
};

const JUST_RATIOS = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2, 9 / 4, 5 / 2, 3];

const MAX_POLYPHONY = 14;
const SUPPORTED_CHANNEL_LAYOUTS = [1, 2, 4, 6, 8];
const AUDIO_QUALITY_PRESETS = {
  standard: { bitDepth: 16, oversample: 'none', targetSampleRate: null },
  high: { bitDepth: 24, oversample: '2x', targetSampleRate: null },
  ultra: { bitDepth: 32, oversample: '4x', targetSampleRate: 96000 },
};

export class SeismicAudioEngine {
  constructor() {
    this.ctx = null;
    this.channelCount = 2;
    this.recordingChannelCount = null;
    this.audioQuality = 'high';
    this.maxChannelCount = 2;
    this.dryBus = null;
    this.reverbBus = null;
    this.reverbHighpass = null;
    this.subsonicHighpass = null;
    this.mudCutEQ = null;
    this.masterGain = null;
    this.compressor = null;
    this.limiter = null;
    this.warmthCurve = null;
    this.masterLowpass = null;
    this.convolver = null;
    this.reverbGain = null;
    this.reverbSplitter = null;
    this.reverbMerger = null;
    this.lfeBus = null;
    this.lfeHighpass = null;
    this.lfeLowpass = null;
    this.lfeGain = null;
    this.lfeMerger = null;
    this.vizDownmix = null;
    this.splitter = null;
    this.analyserLeft = null;
    this.analyserRight = null;
    this.droneMasterGain = null;
    this.droneHighpass = null;
    this.droneLfeGain = null;
    this.droneAnalyser = null;
    this.noiseBuffer = null;
    this.recordDest = null;
    this.multichannelClipper = null;
    this._captureNode = null;
    this._captureSink = null;
    this._captureChunks = [];
    this._captureChannels = 0;
    this._captureWorkletLoaded = false;

    // Continuous Earth Drone nodes
    this.droneOsc1 = null;
    this.droneOsc2 = null;
    this.droneNoise = null;
    this.droneLfo = null;
    this.droneGain = null;
    this.droneEnabled = false;

    this.activeVoices = 0;
    this._activeVoiceEntries = new Set();
    this.enabled = false;
    this.volume = 0.8;
    this.rootFreq = 36.7; // D1
    this.scale = 'dorian';
    this.timbre = 'tectonic';
  }

  async init(externalCtx = null) {
    if (this.ctx) {
      if (!externalCtx && this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      this.enabled = true;
      return;
    }

    if (externalCtx) {
      this.ctx = externalCtx;
    } else {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const preset = AUDIO_QUALITY_PRESETS[this.audioQuality] || AUDIO_QUALITY_PRESETS.high;
      if (preset.targetSampleRate) {
        try {
          this.ctx = new AudioCtx({ sampleRate: preset.targetSampleRate, latencyHint: 'playback' });
        } catch {
          this.ctx = new AudioCtx({ latencyHint: 'playback' });
        }
      } else {
        this.ctx = new AudioCtx();
      }
    }
    this.maxChannelCount = Math.max(1, this.ctx.destination.maxChannelCount || 2);
    this.channelCount = this._clampChannelCount(this.channelCount);

    // Hi-fi Master chain:
    // dryBus -> 24 Hz Subsonic HPF -> Mud-Cut EQ (195 Hz) -> Glue Compressor -> Master Lowpass (1.6 kHz) -> Master Gain -> Brickwall Limiter -> Destination
    // reverbBus -> 95 Hz HPF -> 4-ch Convolver -> Reverb Gain -> Mud-Cut EQ (glues cleanly without sub mud or master IMD)
    // lfeBus -> 24 Hz HPF -> 120 Hz LPF -> LFE Gain -> LFE Merger (ch 3) -> Master Gain (5.1 / 7.1 only)
    this.dryBus = this.ctx.createGain();
    this.dryBus.gain.value = 1.0;
    this.dryBus.channelCount = this.channelCount;
    this.dryBus.channelCountMode = 'explicit';
    this.dryBus.channelInterpretation = 'speakers';

    this.reverbBus = this.ctx.createGain();
    this.reverbBus.gain.value = 1.0;
    this.reverbBus.channelCount = 4;
    this.reverbBus.channelCountMode = 'explicit';
    this.reverbBus.channelInterpretation = 'discrete';

    // Keep sub-bass (< 95 Hz) out of the reverb tail for tight, phase-coherent low end
    this.reverbHighpass = this.ctx.createBiquadFilter();
    this.reverbHighpass.type = 'highpass';
    this.reverbHighpass.frequency.value = 95;
    this.reverbHighpass.Q.value = 0.707;

    this.subsonicHighpass = this.ctx.createBiquadFilter();
    this.subsonicHighpass.type = 'highpass';
    this.subsonicHighpass.frequency.value = 24;
    this.subsonicHighpass.Q.value = 0.707;

    // Gentle low-mid carve to remove boxiness and let sub-bass & upper detail breathe
    this.mudCutEQ = this.ctx.createBiquadFilter();
    this.mudCutEQ.type = 'peaking';
    this.mudCutEQ.frequency.value = 195;
    this.mudCutEQ.Q.value = 0.9;
    this.mudCutEQ.gain.value = -2.5;

    // Transparent mastering glue compressor
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 16;
    this.compressor.ratio.value = 3.2;
    this.compressor.attack.value = 0.022;
    this.compressor.release.value = 0.35;

    // Shared soft-saturation curve for per-voice warmth (avoids master-bus IMD)
    this.warmthCurve = this._createWarmthCurve(1.25);

    // Musical high-frequency sculpting that preserves transient definition & harmonic air
    this.masterLowpass = this.ctx.createBiquadFilter();
    this.masterLowpass.type = 'lowpass';
    this.masterLowpass.frequency.value = 1600;
    this.masterLowpass.Q.value = 0.6;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;
    this.masterGain.channelCount = this.channelCount;
    this.masterGain.channelCountMode = 'explicit';
    this.masterGain.channelInterpretation = 'speakers';

    // Brickwall safety limiter to prevent digital overs during dense seismic swarms
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;

    // Dedicated stereo downmix tap so L/R visualizers work across all channel layouts
    this.vizDownmix = this.ctx.createGain();
    this.vizDownmix.channelCount = 2;
    this.vizDownmix.channelCountMode = 'explicit';
    this.vizDownmix.channelInterpretation = 'speakers';

    this.splitter = this.ctx.createChannelSplitter(2);

    this.analyserLeft = this.ctx.createAnalyser();
    this.analyserLeft.fftSize = 8192;
    this.analyserLeft.smoothingTimeConstant = 0.82;

    this.analyserRight = this.ctx.createAnalyser();
    this.analyserRight.fftSize = 8192;
    this.analyserRight.smoothingTimeConstant = 0.82;

    this.droneMasterGain = this.ctx.createGain();
    this.droneMasterGain.gain.value = this.volume;

    this.droneHighpass = this.ctx.createBiquadFilter();
    this.droneHighpass.type = 'highpass';
    this.droneHighpass.frequency.value = 24;
    this.droneHighpass.Q.value = 0.707;

    this.droneLfeGain = this.ctx.createGain();
    this.droneLfeGain.gain.value = 0.65;

    this.droneAnalyser = this.ctx.createAnalyser();
    this.droneAnalyser.fftSize = 8192;
    this.droneAnalyser.smoothingTimeConstant = 0.82;

    // Dedicated LFE sub-bass bus (24 Hz - 120 Hz crossover, routed to ch 3 in 5.1 / 7.1)
    this.lfeBus = this.ctx.createGain();
    this.lfeBus.gain.value = 1.0;

    this.lfeHighpass = this.ctx.createBiquadFilter();
    this.lfeHighpass.type = 'highpass';
    this.lfeHighpass.frequency.value = 24;
    this.lfeHighpass.Q.value = 0.707;

    this.lfeLowpass = this.ctx.createBiquadFilter();
    this.lfeLowpass.type = 'lowpass';
    this.lfeLowpass.frequency.value = 120;
    this.lfeLowpass.Q.value = 0.707;

    this.lfeGain = this.ctx.createGain();
    this.lfeGain.gain.value = this.channelCount >= 6 ? 0.75 : 0;

    // Dark subterranean 4-channel reverb (L, R, Ls, Rs) with pre-delay and progressive HF damping
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this._createDarkImpulseResponse(3.4, 2.7, 4);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.42;
    this.reverbSplitter = this.ctx.createChannelSplitter(4);

    this.dryBus.connect(this.subsonicHighpass);
    this.subsonicHighpass.connect(this.mudCutEQ);

    this.reverbBus.connect(this.reverbHighpass);
    this.reverbHighpass.connect(this.convolver);
    this.convolver.connect(this.reverbGain);
    this.reverbGain.connect(this.reverbSplitter);

    this.mudCutEQ.connect(this.compressor);
    this.compressor.connect(this.masterLowpass);
    this.masterLowpass.connect(this.masterGain);

    this.masterGain.connect(this.vizDownmix);
    this.vizDownmix.connect(this.splitter);
    this.splitter.connect(this.analyserLeft, 0);
    this.splitter.connect(this.analyserRight, 1);

    this.droneMasterGain.connect(this.droneHighpass);
    this.droneHighpass.connect(this.limiter);
    this.droneHighpass.connect(this.droneLfeGain);
    this.droneLfeGain.connect(this.lfeBus);
    this.droneMasterGain.connect(this.droneAnalyser);

    this.lfeBus.connect(this.lfeHighpass);
    this.lfeHighpass.connect(this.lfeLowpass);
    this.lfeLowpass.connect(this.lfeGain);

    this._rebuildOutputRouting();

    this.noiseBuffer = this._createBrownNoiseBuffer(4.0);
    this.enabled = true;

    if (this.droneEnabled) {
      this._startDrone();
    }
  }

  _clampChannelCount(requested) {
    const valid = SUPPORTED_CHANNEL_LAYOUTS.filter((n) => n <= this.maxChannelCount);
    if (valid.length === 0) return 1;
    if (valid.includes(requested)) return requested;
    // Fall back to highest supported layout below requested, or lowest valid
    const below = valid.filter((n) => n <= requested);
    return below.length > 0 ? below[below.length - 1] : valid[0];
  }

  getMaxChannelCount() {
    return this.maxChannelCount;
  }

  setChannelCount(count) {
    const requested = Number(count) || 2;
    if (!this.ctx) {
      this.channelCount = SUPPORTED_CHANNEL_LAYOUTS.includes(requested) ? requested : 2;
      return this.channelCount;
    }
    const clamped = this._clampChannelCount(requested);
    if (clamped === this.channelCount) return this.channelCount;
    this.channelCount = clamped;
    this._rebuildOutputRouting();
    return this.channelCount;
  }

  _getActiveChannelCount() {
    return this.recordingChannelCount ?? this.channelCount;
  }

  setAudioQuality(quality) {
    this.audioQuality = AUDIO_QUALITY_PRESETS[quality] ? quality : 'high';
    if (this.multichannelClipper) {
      this.multichannelClipper.oversample = AUDIO_QUALITY_PRESETS[this.audioQuality].oversample;
    }
    return this.audioQuality;
  }

  setRecordingChannelCount(count) {
    if (count == null) {
      this.recordingChannelCount = null;
    } else {
      const requested = Number(count) || 2;
      this.recordingChannelCount = SUPPORTED_CHANNEL_LAYOUTS.includes(requested) ? requested : 2;
    }
    if (this.ctx) {
      this._rebuildOutputRouting();
      if (this.recordDest) {
        this.recordDest.channelCount = this._getActiveChannelCount();
      }
    }
    return this._getActiveChannelCount();
  }

  _rebuildOutputRouting() {
    if (!this.ctx) return;
    const ch = this._getActiveChannelCount();
    const destCh = this._clampChannelCount(ch);

    this.ctx.destination.channelInterpretation = 'speakers';
    this.ctx.destination.channelCountMode = 'explicit';
    this.ctx.destination.channelCount = destCh;

    this.dryBus.channelCount = ch;
    this.masterGain.channelCount = ch;

    // Bypass 2-ch DynamicsCompressorNode when running >2 discrete channels
    try { this.mudCutEQ.disconnect(); } catch {}
    try { this.compressor.disconnect(); } catch {}
    if (ch > 2) {
      this.mudCutEQ.connect(this.masterLowpass);
    } else {
      this.mudCutEQ.connect(this.compressor);
      this.compressor.connect(this.masterLowpass);
    }

    // Bypass 2-ch brickwall DynamicsCompressorNode limiter when running >2 discrete channels
    // so channels 3..8 (C, LFE, Ls, Rs, Lb, Rb) are preserved cleanly via multichannelClipper.
    try { this.masterGain.disconnect(this.limiter); } catch {}
    if (this.multichannelClipper) {
      try { this.masterGain.disconnect(this.multichannelClipper); } catch {}
      try { this.multichannelClipper.disconnect(this.ctx.destination); } catch {}
      if (this.recordDest) {
        try { this.multichannelClipper.disconnect(this.recordDest); } catch {}
      }
    }
    try { this.limiter.disconnect(this.ctx.destination); } catch {}
    if (this.recordDest) {
      try { this.limiter.disconnect(this.recordDest); } catch {}
    }

    if (ch > 2) {
      this._ensureMultichannelClipper();
      this.multichannelClipper.channelCount = ch;
      this.multichannelClipper.channelCountMode = 'explicit';
      this.multichannelClipper.channelInterpretation = 'discrete';
      this.masterGain.connect(this.multichannelClipper);
      this.multichannelClipper.connect(this.ctx.destination);
      if (this.recordDest) {
        this.multichannelClipper.connect(this.recordDest);
      }
    } else {
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
      if (this.recordDest) {
        this.limiter.connect(this.recordDest);
      }
    }

    // Route drone through masterGain when >2ch so multichannel capture includes it
    try { this.droneHighpass.disconnect(this.limiter); } catch {}
    try { this.droneHighpass.disconnect(this.masterGain); } catch {}
    if (ch > 2) {
      this.droneHighpass.connect(this.masterGain);
    } else {
      this.droneHighpass.connect(this.limiter);
    }

    // Rewire 4-channel reverb (L, R, Ls, Rs) into active channel layout without touching C or LFE
    try { this.reverbSplitter.disconnect(); } catch {}
    if (this.reverbMerger) {
      try { this.reverbMerger.disconnect(); } catch {}
      this.reverbMerger = null;
    }

    this.reverbMerger = this.ctx.createChannelMerger(ch);
    if (ch === 1) {
      this.reverbSplitter.connect(this.reverbMerger, 0, 0);
      this.reverbSplitter.connect(this.reverbMerger, 1, 0);
    } else if (ch === 2) {
      this.reverbSplitter.connect(this.reverbMerger, 0, 0);
      this.reverbSplitter.connect(this.reverbMerger, 1, 1);
    } else if (ch === 4) {
      this.reverbSplitter.connect(this.reverbMerger, 0, 0);
      this.reverbSplitter.connect(this.reverbMerger, 1, 1);
      this.reverbSplitter.connect(this.reverbMerger, 2, 2);
      this.reverbSplitter.connect(this.reverbMerger, 3, 3);
    } else {
      // 5.1 and 7.1: L=0, R=1, C=2 (dry), LFE=3 (dry), Ls=4, Rs=5, (Lb=6, Rb=7)
      this.reverbSplitter.connect(this.reverbMerger, 0, 0);
      this.reverbSplitter.connect(this.reverbMerger, 1, 1);
      this.reverbSplitter.connect(this.reverbMerger, 2, 4);
      this.reverbSplitter.connect(this.reverbMerger, 3, 5);
      if (ch === 8) {
        this.reverbSplitter.connect(this.reverbMerger, 2, 6);
        this.reverbSplitter.connect(this.reverbMerger, 3, 7);
      }
    }
    this.reverbMerger.connect(this.mudCutEQ);

    // Rewire dedicated LFE bus into channel 3 for 5.1 / 7.1
    try { this.lfeGain.disconnect(); } catch {}
    if (this.lfeMerger) {
      try { this.lfeMerger.disconnect(); } catch {}
      this.lfeMerger = null;
    }
    if (ch >= 6) {
      this.lfeGain.gain.setTargetAtTime(0.75, this.ctx.currentTime, 0.02);
      this.lfeMerger = this.ctx.createChannelMerger(ch);
      this.lfeGain.connect(this.lfeMerger, 0, 3);
      this.lfeMerger.connect(this.masterGain);
    } else {
      this.lfeGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    }
  }

  setEnabled(flag) {
    this.enabled = flag;
    if (!this.ctx) return;
    if (flag && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(flag ? this.volume : 0, this.ctx.currentTime, 0.05);
    }
    if (this.droneMasterGain) {
      this.droneMasterGain.gain.setTargetAtTime(flag ? this.volume : 0, this.ctx.currentTime, 0.05);
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.ctx && this.enabled) {
      if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.04);
      }
      if (this.droneMasterGain) {
        this.droneMasterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.04);
      }
    }
  }

  setRootFreq(hz) {
    this.rootFreq = hz;
    if (this.droneOsc1 && this.ctx) {
      this.droneOsc1.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.2);
      this.droneOsc2.frequency.setTargetAtTime(hz * 1.498, this.ctx.currentTime, 0.2);
    }
  }

  setScale(scaleName) {
    this.scale = scaleName;
  }

  setTimbre(timbreName) {
    this.timbre = timbreName;
  }

  setDrone(on) {
    this.droneEnabled = on;
    if (!this.ctx) return;
    if (on) {
      this._startDrone();
    } else {
      this._stopDrone();
    }
  }

  _startDrone() {
    if (!this.ctx || this.droneOsc1) return;
    const now = this.ctx.currentTime;

    this.droneGain = this.ctx.createGain();
    this.droneGain.gain.setValueAtTime(0.0001, now);
    this.droneGain.gain.exponentialRampToValueAtTime(0.15, now + 1.8);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 100;
    filter.Q.value = 0.8;

    this.droneOsc1 = this.ctx.createOscillator();
    this.droneOsc1.type = 'sine';
    this.droneOsc1.frequency.value = this.rootFreq;

    this.droneOsc2 = this.ctx.createOscillator();
    this.droneOsc2.type = 'triangle';
    this.droneOsc2.frequency.value = this.rootFreq * 1.498; // Slight detuned fifth

    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.32;

    // Slow planetary breathing LFO (0.07 Hz) on filter cutoff and amplitude
    this.droneLfo = this.ctx.createOscillator();
    this.droneLfo.type = 'sine';
    this.droneLfo.frequency.value = 0.07;

    const lfoFilterDepth = this.ctx.createGain();
    lfoFilterDepth.gain.value = 30;
    this.droneLfo.connect(lfoFilterDepth);
    lfoFilterDepth.connect(filter.frequency);

    const lfoGainDepth = this.ctx.createGain();
    lfoGainDepth.gain.value = 0.025;
    this.droneLfo.connect(lfoGainDepth);
    lfoGainDepth.connect(this.droneGain.gain);

    this.droneOsc1.connect(filter);
    this.droneOsc2.connect(osc2Gain);
    osc2Gain.connect(filter);

    if (this.noiseBuffer) {
      this.droneNoise = this.ctx.createBufferSource();
      this.droneNoise.buffer = this.noiseBuffer;
      this.droneNoise.loop = true;

      const noiseLP = this.ctx.createBiquadFilter();
      noiseLP.type = 'lowpass';
      noiseLP.frequency.value = 65;

      const noiseGain = this.ctx.createGain();
      noiseGain.gain.value = 0.06;

      this.droneNoise.connect(noiseLP);
      noiseLP.connect(noiseGain);
      noiseGain.connect(filter);
      this.droneNoise.start(now);
    }

    filter.connect(this.droneGain);
    this.droneGain.connect(this.droneMasterGain);

    this.droneOsc1.start(now);
    this.droneOsc2.start(now);
    this.droneLfo.start(now);
  }

  _stopDrone() {
    if (!this.ctx || !this.droneGain) return;
    const now = this.ctx.currentTime;
    const g = this.droneGain;
    const o1 = this.droneOsc1;
    const o2 = this.droneOsc2;
    const lfo = this.droneLfo;
    const noise = this.droneNoise;
    this.droneGain = null;
    this.droneOsc1 = null;
    this.droneOsc2 = null;
    this.droneLfo = null;
    this.droneNoise = null;

    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
    setTimeout(() => {
      try { o1?.stop(); o2?.stop(); lfo?.stop(); noise?.stop(); } catch {}
    }, 750);
  }

  /**
   * Maps earthquake depth & magnitude to a low-frequency musical pitch (Hz)
   */
  computeFrequency(quake) {
    const depth = Math.max(0, Math.min(650, quake.depth ?? 10));
    // Deeper quakes -> lower notes in the scale; shallow quakes -> upper bass notes
    const depthNorm = 1 - depth / 650; // 1 = shallow, 0 = very deep

    if (this.scale === 'just') {
      const idx = Math.min(JUST_RATIOS.length - 1, Math.floor(depthNorm * JUST_RATIOS.length));
      return this.rootFreq * JUST_RATIOS[idx];
    }

    const intervals = SCALES[this.scale] || SCALES.dorian;
    const idx = Math.min(intervals.length - 1, Math.floor(depthNorm * intervals.length));
    const semitones = intervals[idx];
    return this.rootFreq * Math.pow(2, semitones / 12);
  }

  getOutputLatencyMs() {
    if (!this.ctx) return 0;
    const base = Number.isFinite(this.ctx.baseLatency) ? this.ctx.baseLatency : 0;
    const out = Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency : 0;
    return Math.max(0, (base + out) * 1000);
  }

  getAudioTimeMs() {
    if (!this.ctx || !this.enabled || this.ctx.state !== 'running') return null;
    return this.ctx.currentTime * 1000;
  }

  /**
   * Triggers a low-frequency seismic voice for an earthquake event.
   * Returns voice metadata (freq, durationMs, attackMs, sDelayMs, timbre, startAudioTimeMs, latencyMs).
   */
  triggerQuake(quake, initialPan = null, scheduledTimeSec = null) {
    const freq = this.computeFrequency(quake);
    const mag = Math.max(0.2, quake.mag ?? 1.5);
    const magNorm = Math.min(1, Math.max(0, (mag - 0.5) / 6.0)); // 0..1 across M0.5..M6.5
    const depth = Math.max(0, Math.min(650, quake.depth ?? 10));
    const depthNorm = 1 - depth / 650; // 1 = shallow, 0 = very deep

    const duration = 1.1 + magNorm * 5.1;
    const isAbyssal = this.timbre === 'abyssal';
    const isSubpulse = this.timbre === 'subpulse';
    const sDelay = !isAbyssal && !isSubpulse ? 0.06 + (1 - depthNorm) * 0.07 : 0;
    const attack = isAbyssal
      ? 0.38 + magNorm * 0.55
      : isSubpulse
        ? 0.025
        : sDelay + 0.055;
    const totalDuration = isAbyssal ? duration + 1.4 : sDelay + duration;

    if (!this.ctx || !this.enabled) {
      return {
        freq,
        durationMs: totalDuration * 1000,
        attackMs: attack * 1000,
        sDelayMs: sDelay * 1000,
        timbre: this.timbre,
        startAudioTimeMs: null,
        latencyMs: 0,
      };
    }

    if (scheduledTimeSec == null && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const now = scheduledTimeSec != null ? scheduledTimeSec : this.ctx.currentTime;

    if (scheduledTimeSec != null) {
      for (const entry of Array.from(this._activeVoiceEntries)) {
        if (entry.endTime <= now) {
          this._activeVoiceEntries.delete(entry);
          this.activeVoices = Math.max(0, this.activeVoices - 1);
        }
      }
    }

    // Soft voice stealing if polyphony exceeds cap (prevents CPU overload & mud in 900x swarms)
    if (this._activeVoiceEntries.size >= MAX_POLYPHONY) {
      const oldest = this._activeVoiceEntries.values().next().value;
      if (oldest) {
        this._activeVoiceEntries.delete(oldest);
        this.activeVoices = Math.max(0, this.activeVoices - 1);
        oldest.stolen = true;
        oldest.voiceMasterGain.gain.setTargetAtTime(0.0001, now, 0.015);
      }
    }

    // Polyphony-aware gain scaling prevents sub-bass mud during dense streams
    this.activeVoices += 1;
    const polyScale = Math.max(0.32, 1 / Math.sqrt(this.activeVoices));

    const gainLevel = (0.14 + magNorm * 0.46) * polyScale;

    const voiceMasterGain = this.ctx.createGain();
    voiceMasterGain.gain.value = 1.0;
    voiceMasterGain.connect(this.dryBus);

    // Spatial panning relative to the Sun's position:
    // Keep sub-bass fundamental tighter to center (0.45x) for phase-coherent weight,
    // while harmonic body, transients & reverb pan across the full surround/stereo field.
    const rawX =
      initialPan && typeof initialPan === 'object'
        ? initialPan.x
        : typeof initialPan === 'number'
          ? initialPan
          : (quake.lon || 0) / 180;
    const rawY = initialPan && typeof initialPan === 'object' ? initialPan.y : 1;
    const clampedX = Math.max(-0.85, Math.min(0.85, rawX || 0));
    const clampedY = Math.max(-1, Math.min(1, rawY ?? 1));

    const subPanner = this._createSpatialPanner(clampedX * 0.45, clampedY * 0.45);
    subPanner.merger.connect(voiceMasterGain);

    // Dedicated LFE sub-bass send (routed to 24-120 Hz LFE crossover in 5.1 / 7.1)
    const subLfeSend = this.ctx.createGain();
    subLfeSend.gain.value = 0.85;
    subPanner.input.connect(subLfeSend);
    subLfeSend.connect(this.lfeBus);

    const panner = this._createSpatialPanner(clampedX, clampedY);
    panner.merger.connect(voiceMasterGain);

    // Depth-coupled subterranean reverb send: shallow = drier/closer, deep = vast/reverberant
    const reverbSend = this.ctx.createGain();
    reverbSend.gain.value = 0.25 + (1 - depthNorm) * 0.40;
    panner.reverbOutput.connect(reverbSend);
    reverbSend.connect(this.reverbBus);

    // Per-voice analog warmth shaper (eliminates master-bus intermodulation distortion)
    const voiceWarmth = this.ctx.createWaveShaper();
    voiceWarmth.curve = this.warmthCurve;
    voiceWarmth.oversample = '2x';
    voiceWarmth.connect(panner.input);

    const voiceFilter = this.ctx.createBiquadFilter();
    voiceFilter.type = 'lowpass';
    voiceFilter.Q.value = 1.2 + magNorm * 1.8;
    // Shallow quakes open brighter for tactile P-wave detail; deep quakes stay dark
    const cutoffStart = 120 + magNorm * 360 + depthNorm * 90;
    voiceFilter.frequency.setValueAtTime(cutoffStart, now);
    voiceFilter.frequency.exponentialRampToValueAtTime(Math.max(48, cutoffStart * 0.36), now + duration);
    voiceFilter.connect(voiceWarmth);

    const routing = { subDest: subPanner.input, bodyDest: voiceFilter };

    let endAnchor;
    if (this.timbre === 'subpulse') {
      endAnchor = this._playSubPulse(freq, now, duration, gainLevel, magNorm, routing);
    } else if (this.timbre === 'abyssal') {
      endAnchor = this._playAbyssalPad(freq, now, duration, gainLevel, magNorm, routing);
    } else {
      endAnchor = this._playTectonicRumble(freq, now, duration, gainLevel, magNorm, depthNorm, routing);
    }

    const voiceEntry = {
      panner,
      subPanner,
      voiceMasterGain,
      lon: quake.lon || 0,
      lat: quake.lat || 0,
      endTime: now + totalDuration,
      stolen: false,
    };
    if (endAnchor) {
      this._activeVoiceEntries.add(voiceEntry);
      if (scheduledTimeSec == null) {
        endAnchor.onended = () => {
          if (!voiceEntry.stolen) {
            this._activeVoiceEntries.delete(voiceEntry);
            this.activeVoices = Math.max(0, this.activeVoices - 1);
          }
        };
      }
    } else {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }

    return {
      freq,
      durationMs: totalDuration * 1000,
      attackMs: attack * 1000,
      sDelayMs: sDelay * 1000,
      timbre: this.timbre,
      startAudioTimeMs: now * 1000,
      latencyMs: this.getOutputLatencyMs(),
    };
  }

  /**
   * Smoothly updates spatial panning of all currently playing voices.
   */
  updatePanning(panResolver) {
    if (!this.ctx || !this.enabled || this._activeVoiceEntries.size === 0) return;
    const now = this.ctx.currentTime;
    for (const entry of this._activeVoiceEntries) {
      const resolved = panResolver(entry.lon, entry.lat);
      const rawX = resolved && typeof resolved === 'object' ? resolved.x : resolved;
      const rawY = resolved && typeof resolved === 'object' ? resolved.y : 1;
      const targetX = Math.max(-0.85, Math.min(0.85, rawX || 0));
      const targetY = Math.max(-1, Math.min(1, rawY ?? 1));
      entry.panner.setPan(targetX, targetY, now, 0.03);
      entry.subPanner.setPan(targetX * 0.45, targetY * 0.45, now, 0.03);
    }
  }

  _computeChannelGains(x, y, channelCount) {
    const theta = (Math.max(-1, Math.min(1, x)) + 1) * Math.PI * 0.25;
    const l = Math.cos(theta);
    const r = Math.sin(theta);

    if (channelCount === 1) {
      return [1];
    }
    if (channelCount === 2) {
      return [l, r];
    }
    if (channelCount === 4) {
      const front = (Math.max(-1, Math.min(1, y)) + 1) * 0.5;
      const rear = 1 - front;
      const fAmp = Math.sqrt(front);
      const rAmp = Math.sqrt(rear);
      return [l * fAmp, r * fAmp, l * rAmp, r * rAmp];
    }

    // Center channel prominence when near front-center (sun-aligned)
    const centerWeight = Math.cos(Math.min(1, Math.abs(x)) * Math.PI * 0.5) * 0.65;
    const lrScale = Math.sqrt(Math.max(0, 1 - centerWeight * centerWeight));

    if (channelCount === 6) {
      // 5.1 speaker order: L(0), R(1), C(2), LFE(3, routed separately), Ls(4), Rs(5)
      const front = (Math.max(-1, Math.min(1, y)) + 1) * 0.5;
      const rear = 1 - front;
      const fAmp = Math.sqrt(front);
      const rAmp = Math.sqrt(rear);
      return [l * fAmp * lrScale, r * fAmp * lrScale, centerWeight * fAmp, 0, l * rAmp, r * rAmp];
    }

    // 7.1 speaker order: L(0), R(1), C(2), LFE(3), Ls(4), Rs(5), Lb(6), Rb(7)
    const clampedY = Math.max(-1, Math.min(1, y));
    const front = Math.max(0, clampedY);
    const side = 1 - Math.abs(clampedY);
    const back = Math.max(0, -clampedY);
    const fAmp = Math.sqrt(front);
    const sAmp = Math.sqrt(side);
    const bAmp = Math.sqrt(back);
    return [
      l * fAmp * lrScale,
      r * fAmp * lrScale,
      centerWeight * fAmp,
      0,
      l * sAmp,
      r * sAmp,
      l * bAmp,
      r * bAmp,
    ];
  }

  _createSpatialPanner(x, y) {
    const ch = this._getActiveChannelCount();
    const input = this.ctx.createGain();
    const merger = this.ctx.createChannelMerger(ch);
    const gains = [];
    const initial = this._computeChannelGains(x, y, ch);

    for (let i = 0; i < ch; i++) {
      const g = this.ctx.createGain();
      g.gain.value = initial[i] ?? 0;
      input.connect(g);
      g.connect(merger, 0, i);
      gains.push(g);
    }

    let reverbOutput = merger;
    if (ch >= 6) {
      // Feed 4-channel reverb bus strictly from L(0), R(1), Ls(4), Rs(5)
      const revMerger = this.ctx.createChannelMerger(4);
      gains[0].connect(revMerger, 0, 0);
      gains[1].connect(revMerger, 0, 1);
      gains[4].connect(revMerger, 0, 2);
      gains[5].connect(revMerger, 0, 3);
      reverbOutput = revMerger;
    }

    return {
      input,
      merger,
      reverbOutput,
      setPan: (nextX, nextY, now, timeConstant = 0.03) => {
        const nextGains = this._computeChannelGains(nextX, nextY, gains.length);
        for (let i = 0; i < gains.length; i++) {
          gains[i].gain.setTargetAtTime(nextGains[i] ?? 0, now, timeConstant);
        }
      },
    };
  }

  _playTectonicRumble(freq, now, duration, gainLevel, magNorm, depthNorm, routing) {
    const { subDest, bodyDest } = routing;

    // 1. P-wave precursor: crisp, tactile crustal transient before the S-wave body arrives
    const pOsc = this.ctx.createOscillator();
    pOsc.type = 'triangle';
    pOsc.frequency.setValueAtTime(freq * 2.2, now);
    pOsc.frequency.exponentialRampToValueAtTime(Math.max(24, freq * 1.05), now + 0.08);

    const pGain = this.ctx.createGain();
    pGain.gain.setValueAtTime(0.0001, now);
    pGain.gain.linearRampToValueAtTime(gainLevel * 0.28, now + 0.012);
    pGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    pOsc.connect(pGain);
    pGain.connect(bodyDest);
    pOsc.start(now);
    pOsc.stop(now + 0.19);

    // 2. S-wave body: delayed by depth (60..130 ms) with micro-detuned dual sub-bass & gravitational sag
    const sStart = now + 0.06 + (1 - depthNorm) * 0.07;
    const sEnd = sStart + duration;

    const subOsc1 = this._createSagOscillator('sine', freq * (1.12 + magNorm * 0.12), freq, freq * 0.992, sStart, sEnd);
    const subOsc2 = this._createSagOscillator('sine', freq * 1.0025 * (1.12 + magNorm * 0.12), freq * 1.0025, freq * 1.0025 * 0.992, sStart, sEnd);

    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, sStart);
    subGain.gain.linearRampToValueAtTime(gainLevel * 0.65, sStart + 0.055);
    subGain.gain.exponentialRampToValueAtTime(0.0001, sEnd);

    subOsc1.connect(subGain);
    subOsc2.connect(subGain);
    subGain.connect(subDest);
    subOsc1.start(sStart);
    subOsc2.start(sStart);
    subOsc1.stop(sEnd + 0.05);
    subOsc2.stop(sEnd + 0.05);

    // 3. Warm triangle body at fifth or sub-octave (routed through per-voice warmth & stereo pan)
    const bodyFreq = magNorm > 0.55 ? Math.max(24, freq * 0.5) : freq * 1.5;
    const bodyOsc = this._createSagOscillator('triangle', bodyFreq, bodyFreq, bodyFreq * 0.994, sStart, sEnd);

    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, sStart);
    bodyGain.gain.linearRampToValueAtTime(gainLevel * 0.30, sStart + 0.11);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, sStart + duration * 0.85);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(bodyDest);
    bodyOsc.start(sStart);
    bodyOsc.stop(sEnd + 0.05);

    // 4. Evolving lithospheric brown noise rumble (sweeping downward like shifting earth)
    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      noise.loop = true;

      const noiseFilter = this.ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(85 + magNorm * 95, sStart);
      noiseFilter.frequency.exponentialRampToValueAtTime(34, sStart + duration * 0.9);
      noiseFilter.Q.value = 1.4;

      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, sStart);
      noiseGain.gain.linearRampToValueAtTime(0.12 + magNorm * 0.30, sStart + 0.09);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, sStart + duration * 0.9);

      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(bodyDest);
      noise.start(sStart);
      noise.stop(sEnd + 0.05);
    }

    return subOsc1;
  }

  _playSubPulse(freq, now, duration, gainLevel, magNorm, routing) {
    const { subDest, bodyDest } = routing;
    const end = now + duration;
    const osc = this._createSagOscillator('sine', freq * 1.08, freq, freq * 0.994, now, end);

    const subFreq = Math.max(24, freq * 0.5);
    const sub = this._createSagOscillator('sine', subFreq, subFreq, subFreq * 0.994, now, end);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gainLevel * 0.95, now + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.85);

    const subG = this.ctx.createGain();
    subG.gain.setValueAtTime(0.0001, now);
    subG.gain.linearRampToValueAtTime(gainLevel * (0.45 + magNorm * 0.3), now + 0.025);
    subG.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.85);

    osc.connect(g);
    g.connect(bodyDest);

    sub.connect(subG);
    subG.connect(subDest);

    osc.start(now);
    sub.start(now);
    osc.stop(end + 0.03);
    sub.stop(end + 0.03);
    return osc;
  }

  _playAbyssalPad(freq, now, duration, gainLevel, magNorm, routing) {
    const { subDest, bodyDest } = routing;
    const attack = 0.38 + magNorm * 0.55;
    const total = duration + 1.4;
    const end = now + total;

    const osc1 = this._createSagOscillator('sawtooth', freq, freq, freq * 0.995, now, end);
    const osc2 = this._createSagOscillator('triangle', freq * 1.004, freq * 1.004, freq * 1.004 * 0.995, now, end);

    const subFreq = Math.max(24, freq * 0.5);
    const subOsc = this._createSagOscillator('sine', subFreq, subFreq, subFreq * 0.995, now, end);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gainLevel * 0.50, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);

    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(gainLevel * 0.25, now + attack);
    subGain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc1.connect(g);
    osc2.connect(g);
    g.connect(bodyDest);

    subOsc.connect(subGain);
    subGain.connect(subDest);

    osc1.start(now);
    osc2.start(now);
    subOsc.start(now);
    osc1.stop(end + 0.05);
    osc2.stop(end + 0.05);
    subOsc.stop(end + 0.05);
    return osc1;
  }

  /**
   * Creates an oscillator with an onset pitch drop and subtle gravitational pitch sag.
   */
  _createSagOscillator(type, startFreq, settleFreq, tailFreq, startTime, endTime) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, startTime);
    if (startFreq !== settleFreq) {
      osc.frequency.exponentialRampToValueAtTime(settleFreq, startTime + 0.11);
    }
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, tailFreq), endTime);
    return osc;
  }

  _createWarmthCurve(drive = 1.25) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const norm = Math.tanh(drive);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
    return curve;
  }

  _createBrownNoiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const crossfade = Math.min(Math.floor(rate * 0.25), Math.floor(length / 4));
    const totalLen = length + crossfade;
    const raw = new Float32Array(totalLen);

    let lastOut = 0;
    for (let i = 0; i < totalLen; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      raw[i] = lastOut * 3.5;
    }

    // Equal-power crossfade tail into head for a seamless, click-free loop
    const buffer = this.ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      if (i < crossfade) {
        const t = i / crossfade;
        const fadeIn = Math.sin(t * Math.PI * 0.5);
        const fadeOut = Math.cos(t * Math.PI * 0.5);
        data[i] = raw[i] * fadeIn + raw[length + i] * fadeOut;
      } else {
        data[i] = raw[i];
      }
    }
    return buffer;
  }

  _createDarkImpulseResponse(duration, decay, channels = 2) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const preDelay = Math.floor(rate * 0.012); // 12 ms pre-delay keeps dry transients crisp
    const fadeIn = Math.floor(rate * 0.025);   // 25 ms smooth onset avoids grainy impulse burst
    const impulse = this.ctx.createBuffer(channels, length, rate);

    for (let ch = 0; ch < channels; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      // Slightly longer pre-delay for surround channels (ch >= 2) for spacious depth
      const chPreDelay = ch >= 2 ? preDelay + Math.floor(rate * 0.014) : preDelay;
      for (let i = 0; i < length; i++) {
        if (i < chPreDelay) {
          data[i] = 0;
          continue;
        }
        const activeIdx = i - chPreDelay;
        const activeLen = Math.max(1, length - chPreDelay);
        const progress = activeIdx / activeLen;
        const onset = activeIdx < fadeIn ? Math.sin((activeIdx / fadeIn) * Math.PI * 0.5) : 1;
        const env = Math.pow(1 - progress, decay) * onset;
        const white = (Math.random() * 2 - 1) * env;
        // Progressive HF damping: early reflections retain subtle detail, late tail grows darker
        const coeff = 0.14 - 0.10 * progress;
        lp = lp + coeff * (white - lp);
        data[i] = lp * 1.9;
      }
    }
    return impulse;
  }

  /**
   * Returns a MediaStream containing the master audio output
   * tapped from the brickwall limiter for offline/browser MediaRecorder capture.
   * @param {number} [channels] Optional channel count override (1, 2, 4, 6, 8)
   */
  getRecordingStream(channels) {
    if (!this.ctx || !this.limiter) return null;
    if (channels != null) {
      this.setRecordingChannelCount(channels);
    }
    const ch = this._getActiveChannelCount();
    if (!this.recordDest) {
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.recordDest.channelCountMode = 'explicit';
      this.recordDest.channelInterpretation = 'speakers';
      this.recordDest.channelCount = ch;
      this._rebuildOutputRouting();
    } else if (this.recordDest.channelCount !== ch) {
      this.recordDest.channelCount = ch;
      this._rebuildOutputRouting();
    }
    return this.recordDest.stream;
  }

  _ensureMultichannelClipper() {
    if (!this.ctx || this.multichannelClipper) return;
    const n = 2048;
    const curve = new Float32Array(n);
    const norm = Math.tanh(1.1);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = Math.tanh(x * 1.1) / norm;
    }
    this.multichannelClipper = this.ctx.createWaveShaper();
    this.multichannelClipper.curve = curve;
    const preset = AUDIO_QUALITY_PRESETS[this.audioQuality] || AUDIO_QUALITY_PRESETS.high;
    this.multichannelClipper.oversample = preset.oversample;
  }

  async startMultichannelCapture(channels, quality) {
    if (!this.ctx || !this.masterGain) return false;
    await this.stopMultichannelCapture();

    if (quality) this.setAudioQuality(quality);
    const preset = AUDIO_QUALITY_PRESETS[this.audioQuality] || AUDIO_QUALITY_PRESETS.high;
    const bitDepth = preset.bitDepth;

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    const ch = this.setRecordingChannelCount(channels);
    this._ensureMultichannelClipper();
    this._captureChunks = [];
    this._captureChannels = ch;
    this._captureBitDepth = bitDepth;

    if (!this._captureWorkletLoaded && this.ctx.audioWorklet) {
      const processorCode = `
        class MultichannelCaptureProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this._buf = null;
            this._bufFrames = 0;
            this._bufCap = 4096;
            this._bufCh = 0;
            this._bufBits = 0;
            this._stopped = false;
            this.port.onmessage = (ev) => {
              if (ev.data && ev.data.type === 'flush') {
                this._flush();
                this._stopped = true;
                this.port.postMessage({ type: 'flushed' });
              }
            };
          }
          _alloc(frames, numCh, bitDepth) {
            if (bitDepth === 32) return new Float32Array(frames * numCh);
            if (bitDepth === 24) return new Uint8Array(frames * numCh * 3);
            return new Int16Array(frames * numCh);
          }
          _flush() {
            if (!this._buf || this._bufFrames === 0) return;
            let out = this._buf;
            if (this._bufFrames < this._bufCap) {
              const mult = this._bufBits === 24 ? this._bufCh * 3 : this._bufCh;
              out = this._buf.slice(0, this._bufFrames * mult);
            } else {
              this._buf = null;
            }
            this.port.postMessage(out, [out.buffer]);
            this._bufFrames = 0;
          }
          process(inputs, outputs, parameters) {
            if (this._stopped) return false;
            const input = inputs[0];
            if (input && input.length > 0 && input[0].length > 0) {
              const frames = input[0].length;
              const numCh = input.length;
              const bitDepth = Math.round(parameters.bitDepth[0] || 16);
              if (!this._buf || this._bufCh !== numCh || this._bufBits !== bitDepth) {
                this._flush();
                this._buf = this._alloc(this._bufCap, numCh, bitDepth);
                this._bufCh = numCh;
                this._bufBits = bitDepth;
                this._bufFrames = 0;
              }
              if (this._bufFrames + frames > this._bufCap) {
                this._flush();
                if (!this._buf) this._buf = this._alloc(this._bufCap, numCh, bitDepth);
              }
              if (bitDepth === 32) {
                for (let f = 0; f < frames; f++) {
                  const base = (this._bufFrames + f) * numCh;
                  for (let c = 0; c < numCh; c++) {
                    this._buf[base + c] = input[c][f];
                  }
                }
              } else if (bitDepth === 24) {
                let ptr = this._bufFrames * numCh * 3;
                for (let f = 0; f < frames; f++) {
                  for (let c = 0; c < numCh; c++) {
                    const s = input[c][f];
                    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
                    const val = Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff);
                    this._buf[ptr++] = val & 0xff;
                    this._buf[ptr++] = (val >> 8) & 0xff;
                    this._buf[ptr++] = (val >> 16) & 0xff;
                  }
                }
              } else {
                for (let f = 0; f < frames; f++) {
                  const base = (this._bufFrames + f) * numCh;
                  for (let c = 0; c < numCh; c++) {
                    const s = input[c][f];
                    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
                    this._buf[base + c] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
                  }
                }
              }
              this._bufFrames += frames;
              if (this._bufFrames >= this._bufCap) {
                this._flush();
              }
            }
            return true;
          }
          static get parameterDescriptors() {
            return [{ name: 'bitDepth', defaultValue: 16, minValue: 16, maxValue: 32, automationRate: 'k-rate' }];
          }
        }
        registerProcessor('multichannel-capture-processor', MultichannelCaptureProcessor);
      `;
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(url);
        this._captureWorkletLoaded = true;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    this.masterGain.connect(this.multichannelClipper);
    this.multichannelClipper.channelCount = ch;
    this.multichannelClipper.channelCountMode = 'explicit';
    this.multichannelClipper.channelInterpretation = 'discrete';

    const node = new AudioWorkletNode(this.ctx, 'multichannel-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: ch,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      parameterData: { bitDepth },
    });
    node.port.onmessage = (ev) => {
      if (ev.data && ev.data.byteLength) {
        this._captureChunks.push(ev.data);
      }
    };

    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.multichannelClipper.connect(node);
    node.connect(sink);
    sink.connect(this.ctx.destination);

    this._captureNode = node;
    this._captureSink = sink;
    return true;
  }

  async stopMultichannelCapture() {
    if (!this._captureNode) return null;
    const node = this._captureNode;

    // Ask the worklet to flush any buffered frames before disconnecting
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 500);
      const prevOnMessage = node.port.onmessage;
      node.port.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'flushed') {
          done();
        } else if (prevOnMessage) {
          prevOnMessage(ev);
        }
      };
      try {
        node.port.postMessage({ type: 'flush' });
      } catch {
        done();
      }
    });

    try { this.masterGain?.disconnect(this.multichannelClipper); } catch {}
    try { this.multichannelClipper?.disconnect(node); } catch {}
    try { node.disconnect(); } catch {}
    try { this._captureSink?.disconnect(); } catch {}
    node.port.onmessage = null;

    const result = {
      chunks: this._captureChunks,
      sampleRate: this.ctx?.sampleRate || 48000,
      channels: this._captureChannels || 2,
      bitDepth: this._captureBitDepth || 16,
    };
    this._captureNode = null;
    this._captureSink = null;
    this._captureChunks = [];
    this._captureChannels = 0;
    this._captureBitDepth = 16;
    return result;
  }

  /**
   * Deterministically renders an entire seismic event schedule via OfflineAudioContext
   * and returns interleaved PCM/float chunks ready for encodeWavBlob().
   */
  static async renderOffline({
    events = [],
    durationSec = 10,
    channels = 2,
    audioQuality = 'high',
    droneEnabled = false,
    volume = 0.8,
    timbre = 'tectonic',
    scale = 'dorian',
    rootFreq = 36.7,
  } = {}) {
    const preset = AUDIO_QUALITY_PRESETS[audioQuality] || AUDIO_QUALITY_PRESETS.high;
    const sampleRate = preset.targetSampleRate || 48000;
    const bitDepth = preset.bitDepth || 16;
    const validCh = [1, 2, 4, 6, 8].includes(Number(channels)) ? Number(channels) : 2;
    const totalFrames = Math.max(1, Math.ceil(durationSec * sampleRate));

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtx(validCh, totalFrames, sampleRate);

    const engine = new SeismicAudioEngine();
    engine.audioQuality = audioQuality;
    engine.channelCount = validCh;
    engine.recordingChannelCount = validCh;
    engine.droneEnabled = Boolean(droneEnabled);
    engine.volume = volume;
    engine.timbre = timbre;
    engine.scale = scale;
    engine.rootFreq = rootFreq;

    await engine.init(offlineCtx);
    for (const ev of events) {
      if (ev.timeSec >= 0 && ev.timeSec < durationSec) {
        engine.triggerQuake(ev.quake, ev.spatial ?? null, ev.timeSec);
      }
    }

    const rendered = await offlineCtx.startRendering();
    const numCh = rendered.numberOfChannels;
    const len = rendered.length;
    const chData = Array.from({ length: numCh }, (_, c) => rendered.getChannelData(c));

    let packed;
    if (bitDepth === 32) {
      packed = new Float32Array(len * numCh);
      for (let f = 0; f < len; f++) {
        const base = f * numCh;
        for (let c = 0; c < numCh; c++) {
          packed[base + c] = chData[c][f];
        }
      }
    } else if (bitDepth === 24) {
      packed = new Uint8Array(len * numCh * 3);
      let ptr = 0;
      for (let f = 0; f < len; f++) {
        for (let c = 0; c < numCh; c++) {
          const s = chData[c][f];
          const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
          const val = Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff);
          packed[ptr++] = val & 0xff;
          packed[ptr++] = (val >> 8) & 0xff;
          packed[ptr++] = (val >> 16) & 0xff;
        }
      }
    } else {
      packed = new Int16Array(len * numCh);
      for (let f = 0; f < len; f++) {
        const base = f * numCh;
        for (let c = 0; c < numCh; c++) {
          const s = chData[c][f];
          const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
          packed[base + c] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }
      }
    }

    return {
      chunks: [packed],
      sampleRate: rendered.sampleRate,
      channels: numCh,
      bitDepth,
      durationSec: len / rendered.sampleRate,
    };
  }
}
