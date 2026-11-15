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

export class SeismicAudioEngine {
  constructor() {
    this.ctx = null;
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
    this.splitter = null;
    this.analyserLeft = null;
    this.analyserRight = null;
    this.droneMasterGain = null;
    this.droneHighpass = null;
    this.droneAnalyser = null;
    this.noiseBuffer = null;

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

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      this.enabled = true;
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    // Hi-fi Master chain:
    // dryBus -> 24 Hz Subsonic HPF -> Mud-Cut EQ (195 Hz) -> Glue Compressor -> Master Lowpass (1.6 kHz) -> Master Gain -> Brickwall Limiter -> Destination
    // reverbBus -> 95 Hz HPF -> Stereo Convolver -> Reverb Gain -> Mud-Cut EQ (glues cleanly without sub mud or master IMD)
    this.dryBus = this.ctx.createGain();
    this.dryBus.gain.value = 1.0;
    // Keep the master bus explicitly stereo so mono sources upmix to both L/R channels
    // before reaching the ChannelSplitterNode.
    this.dryBus.channelCount = 2;
    this.dryBus.channelCountMode = 'explicit';

    this.reverbBus = this.ctx.createGain();
    this.reverbBus.gain.value = 1.0;

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
    this.masterGain.channelCount = 2;
    this.masterGain.channelCountMode = 'explicit';

    // Brickwall safety limiter to prevent digital overs during dense seismic swarms
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;

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

    this.droneAnalyser = this.ctx.createAnalyser();
    this.droneAnalyser.fftSize = 8192;
    this.droneAnalyser.smoothingTimeConstant = 0.82;

    // Dark subterranean stereo reverb with pre-delay and progressive HF damping
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this._createDarkImpulseResponse(3.4, 2.7);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.42;

    this.dryBus.connect(this.subsonicHighpass);
    this.subsonicHighpass.connect(this.mudCutEQ);

    this.reverbBus.connect(this.reverbHighpass);
    this.reverbHighpass.connect(this.convolver);
    this.convolver.connect(this.reverbGain);
    this.reverbGain.connect(this.mudCutEQ);

    this.mudCutEQ.connect(this.compressor);
    this.compressor.connect(this.masterLowpass);
    this.masterLowpass.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.masterGain.connect(this.splitter);
    this.splitter.connect(this.analyserLeft, 0);
    this.splitter.connect(this.analyserRight, 1);

    this.droneMasterGain.connect(this.droneHighpass);
    this.droneHighpass.connect(this.limiter);
    this.droneMasterGain.connect(this.droneAnalyser);

    this.noiseBuffer = this._createBrownNoiseBuffer(4.0);
    this.enabled = true;

    if (this.droneEnabled) {
      this._startDrone();
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
  triggerQuake(quake, initialPan = null) {
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

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const now = this.ctx.currentTime;

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

    // Frequency-conscious stereo panning:
    // Keep sub-bass fundamental tighter to center (±0.38) for phase-coherent weight,
    // while harmonic body, transients & reverb pan across the full stereo field (±0.85).
    const rawPan = typeof initialPan === 'number' ? initialPan : (quake.lon || 0) / 180;
    const clampedPan = Math.max(-0.85, Math.min(0.85, rawPan));

    const subPanner = this.ctx.createStereoPanner();
    subPanner.pan.value = clampedPan * 0.45;
    subPanner.connect(voiceMasterGain);

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clampedPan;
    panner.connect(voiceMasterGain);

    // Depth-coupled subterranean reverb send: shallow = drier/closer, deep = vast/reverberant
    const reverbSend = this.ctx.createGain();
    reverbSend.gain.value = 0.25 + (1 - depthNorm) * 0.40;
    panner.connect(reverbSend);
    reverbSend.connect(this.reverbBus);

    // Per-voice analog warmth shaper (eliminates master-bus intermodulation distortion)
    const voiceWarmth = this.ctx.createWaveShaper();
    voiceWarmth.curve = this.warmthCurve;
    voiceWarmth.oversample = '2x';
    voiceWarmth.connect(panner);

    const voiceFilter = this.ctx.createBiquadFilter();
    voiceFilter.type = 'lowpass';
    voiceFilter.Q.value = 1.2 + magNorm * 1.8;
    // Shallow quakes open brighter for tactile P-wave detail; deep quakes stay dark
    const cutoffStart = 120 + magNorm * 360 + depthNorm * 90;
    voiceFilter.frequency.setValueAtTime(cutoffStart, now);
    voiceFilter.frequency.exponentialRampToValueAtTime(Math.max(48, cutoffStart * 0.36), now + duration);
    voiceFilter.connect(voiceWarmth);

    const routing = { subDest: subPanner, bodyDest: voiceFilter };

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
      stolen: false,
    };
    if (endAnchor) {
      this._activeVoiceEntries.add(voiceEntry);
      endAnchor.onended = () => {
        if (!voiceEntry.stolen) {
          this._activeVoiceEntries.delete(voiceEntry);
          this.activeVoices = Math.max(0, this.activeVoices - 1);
        }
      };
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
   * Smoothly updates stereo pan of all currently playing voices as the map pans/zooms.
   */
  updatePanning(panResolver) {
    if (!this.ctx || !this.enabled || this._activeVoiceEntries.size === 0) return;
    const now = this.ctx.currentTime;
    for (const entry of this._activeVoiceEntries) {
      const targetPan = Math.max(-0.85, Math.min(0.85, panResolver(entry.lon, entry.lat)));
      entry.panner.pan.setTargetAtTime(targetPan, now, 0.03);
      entry.subPanner.pan.setTargetAtTime(targetPan * 0.45, now, 0.03);
    }
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

  _createDarkImpulseResponse(duration, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const preDelay = Math.floor(rate * 0.012); // 12 ms pre-delay keeps dry transients crisp
    const fadeIn = Math.floor(rate * 0.025);   // 25 ms smooth onset avoids grainy impulse burst
    const impulse = this.ctx.createBuffer(2, length, rate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        if (i < preDelay) {
          data[i] = 0;
          continue;
        }
        const activeIdx = i - preDelay;
        const activeLen = Math.max(1, length - preDelay);
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
}
