/**
 * Offline-First Brown Noise PWA
 * Clean Gaussian brown noise with real-time Tone Cutoff & Slope controls,
 * 4 curated presets, and hardware physical volume control.
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 25;  // 25-second seamless loop buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to stabilize leaky integration
  const CROSSFADE_SEC = 3.0;       // 3s equal-power crossfade for seamless looping
  const FADE_IN_SEC = 1.2;
  const FADE_OUT_SEC = 1.0;

  const STORAGE_KEYS = {
    PRESET: 'bn_active_preset',
    CUTOFF: 'bn_cutoff_hz',
    SLOPE: 'bn_slope_val',
    TIMER: 'bn_sleep_timer'
  };

  const PRESETS = {
    open: {
      name: 'Open (1200 Hz)',
      cutoff: 1200,
      slope: 1
    },
    warm: {
      name: 'Warm (800 Hz)',
      cutoff: 800,
      slope: 1
    },
    deep: {
      name: 'Deep (500 Hz)',
      cutoff: 500,
      slope: 2
    },
    rumble: {
      name: 'Rumble (250 Hz)',
      cutoff: 250,
      slope: 2
    }
  };

  // --- DOM Elements ---
  const playBtn = document.getElementById('playBtn');
  const iconPlay = document.getElementById('iconPlay');
  const iconStop = document.getElementById('iconStop');
  const visualizerContainer = document.getElementById('visualizerContainer');
  const playbackStatus = document.getElementById('playbackStatus');

  const presetChips = document.querySelectorAll('.preset-chip');
  const presetValue = document.getElementById('presetValue');

  const cutoffSlider = document.getElementById('cutoffSlider');
  const cutoffValue = document.getElementById('cutoffValue');
  const slopeSlider = document.getElementById('slopeSlider');
  const slopeValue = document.getElementById('slopeValue');

  const timerCountdown = document.getElementById('timerCountdown');
  const timerChips = document.querySelectorAll('.timer-chip');
  const offlineBadge = document.getElementById('offlineBadge');

  // --- App State ---
  let isPlaying = false;
  let activePresetKey = localStorage.getItem(STORAGE_KEYS.PRESET) || 'open';
  let cutoff = parseInt(localStorage.getItem(STORAGE_KEYS.CUTOFF) || '1200', 10);
  let slope = parseInt(localStorage.getItem(STORAGE_KEYS.SLOPE) || '1', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;

  // --- Audio Nodes ---
  let audioCtx = null;
  let sourceNode = null;
  let lpFilter1 = null;
  let lpFilter2 = null;
  let gainNode = null;
  let streamAudioEl = null;
  let cachedAudioBuffer = null;

  /**
   * Generates pure Gaussian random noise via Box-Muller transform.
   * Eliminates the harsh scratchy grit of pseudo-random uniform white noise.
   */
  function gaussianRandom() {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Procedural Audio Synthesis:
   * Pure Gaussian brown noise with leaky integration and DC blocking.
   * Completely linear synthesis with zero saturation clipping (silky, scratch-free).
   */
  function createPureBrownNoiseBuffer(targetCtx) {
    if (cachedAudioBuffer) return cachedAudioBuffer;

    const warmupSamples = Math.floor(SAMPLE_RATE * WARMUP_SEC);
    const nSamples = Math.floor(SAMPLE_RATE * BUFFER_DURATION_SEC);
    const crossfadeSamples = Math.floor(SAMPLE_RATE * CROSSFADE_SEC);
    const totalGen = warmupSamples + nSamples + crossfadeSamples;

    const left = new Float32Array(totalGen);
    const right = new Float32Array(totalGen);

    let l = 0;
    let r = 0;
    for (let i = 0; i < totalGen; i++) {
      const gL = gaussianRandom();
      const gR = gaussianRandom();
      l = (l + 0.02 * gL) / 1.02;
      r = (r + 0.02 * gR) / 1.02;
      left[i] = l;
      right[i] = r;
    }

    // DC blocker filter (20 Hz)
    const dt = 1 / SAMPLE_RATE;
    const rc = 1 / (2 * Math.PI * 20);
    const alphaHP = rc / (rc + dt);

    let prevXL = 0, prevYL = 0;
    let prevXR = 0, prevYR = 0;
    for (let i = 0; i < totalGen; i++) {
      const yL = alphaHP * (prevYL + left[i] - prevXL);
      prevXL = left[i];
      prevYL = yL;
      left[i] = yL;

      const yR = alphaHP * (prevYR + right[i] - prevXR);
      prevXR = right[i];
      prevYR = yR;
      right[i] = yR;
    }

    // Extract steady-state portion
    const outL = new Float32Array(nSamples);
    const outR = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      outL[i] = left[i + warmupSamples];
      outR[i] = right[i + warmupSamples];
    }

    // Equal-power tail crossfade for zero-seam looping
    const tailOffset = warmupSamples + nSamples;
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const wTail = Math.cos(0.5 * Math.PI * t);
      const wHead = Math.sin(0.5 * Math.PI * t);
      outL[i] = left[tailOffset + i] * wTail + left[i] * wHead;
      outR[i] = right[tailOffset + i] * wTail + right[i] * wHead;
    }

    // Clean linear normalization to 0.95 peak (loudest possible clean output)
    let maxPeak = 0;
    for (let i = 0; i < nSamples; i++) {
      const aL = Math.abs(outL[i]);
      const aR = Math.abs(outR[i]);
      if (aL > maxPeak) maxPeak = aL;
      if (aR > maxPeak) maxPeak = aR;
    }
    const scale = maxPeak > 0 ? 0.95 / maxPeak : 1.0;
    for (let i = 0; i < nSamples; i++) {
      outL[i] *= scale;
      outR[i] *= scale;
    }

    const audioBuffer = targetCtx.createBuffer(2, nSamples, SAMPLE_RATE);
    audioBuffer.copyToChannel(outL, 0);
    audioBuffer.copyToChannel(outR, 1);

    cachedAudioBuffer = audioBuffer;
    return audioBuffer;
  }

  // --- Real-time Audio Graph Setup ---

  function ensureAudioPipeline() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }

    if (!cachedAudioBuffer) {
      createPureBrownNoiseBuffer(audioCtx);
    }

    // 1. Primary Low-pass filter (Cutoff)
    if (!lpFilter1) {
      lpFilter1 = audioCtx.createBiquadFilter();
      lpFilter1.type = 'lowpass';
      lpFilter1.frequency.setValueAtTime(cutoff, audioCtx.currentTime);
      lpFilter1.Q.setValueAtTime(0.707, audioCtx.currentTime);
    }

    // 2. Secondary Low-pass filter (Slope steepness)
    if (!lpFilter2) {
      lpFilter2 = audioCtx.createBiquadFilter();
      lpFilter2.type = 'lowpass';
      lpFilter2.frequency.setValueAtTime(cutoff, audioCtx.currentTime);
      lpFilter2.Q.setValueAtTime(0.707, audioCtx.currentTime);
    }

    // 3. Master Output Gain (Kept at loudest possible clean level: 1.0)
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

      lpFilter1.connect(lpFilter2);
      lpFilter2.connect(gainNode);

      // Hardware output
      gainNode.connect(audioCtx.destination);

      // MediaStream background audio bridge
      if (audioCtx.createMediaStreamDestination) {
        try {
          const streamDest = audioCtx.createMediaStreamDestination();
          gainNode.connect(streamDest);

          if (!streamAudioEl) {
            streamAudioEl = document.createElement('audio');
            streamAudioEl.autoplay = true;
            streamAudioEl.playsInline = true;
            streamAudioEl.setAttribute('playsinline', '');
            streamAudioEl.setAttribute('webkit-playsinline', '');
            streamAudioEl.muted = false;
            document.body.appendChild(streamAudioEl);
          }
          streamAudioEl.srcObject = streamDest.stream;
        } catch (err) {
          console.warn('MediaStreamDestination fallback:', err);
        }
      }
    }

    applyFilterParameters();
  }

  function applyFilterParameters() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;

    if (lpFilter1) {
      lpFilter1.frequency.setTargetAtTime(cutoff, now, 0.03);
    }

    if (lpFilter2) {
      if (slope === 1) {
        // Slope 1: 6 dB/oct gentle slope (second filter wide open)
        lpFilter2.frequency.setTargetAtTime(18000, now, 0.03);
      } else if (slope === 2) {
        // Slope 2: 12 dB/oct standard slope
        lpFilter2.frequency.setTargetAtTime(cutoff * 1.25, now, 0.03);
      } else if (slope === 3) {
        // Slope 3: 18 dB/oct deep slope
        lpFilter2.frequency.setTargetAtTime(cutoff, now, 0.03);
      } else {
        // Slope 4: 24 dB/oct steep slope
        lpFilter2.frequency.setTargetAtTime(cutoff * 0.85, now, 0.03);
      }
    }
  }

  // --- Playback Control ---

  function play() {
    if (isPlaying) return;
    isPlaying = true;

    updateUIState(true);
    updateMediaSession();
    playbackStatus.textContent = 'Playing';

    ensureAudioPipeline();

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = cachedAudioBuffer;
    sourceNode.loop = true; // Hardware sample-accurate gapless loop
    sourceNode.connect(lpFilter1);
    sourceNode.start(0);

    if (streamAudioEl) {
      streamAudioEl.play().catch(() => {});
    }

    // Smooth fade-in to loudest clean output (1.0)
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(1.0, now + FADE_IN_SEC);

    if (timerMinutes > 0 && !sleepTimerEndTime) {
      startSleepTimer(timerMinutes);
    }
  }

  function stop() {
    if (!isPlaying) return;
    isPlaying = false;

    updateUIState(false);
    updateMediaSession();
    playbackStatus.textContent = 'Fading out...';

    if (!audioCtx || !gainNode) {
      playbackStatus.textContent = 'Ready to play';
      return;
    }

    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT_SEC);

    setTimeout(() => {
      if (!isPlaying && sourceNode) {
        try {
          sourceNode.stop();
          sourceNode.disconnect();
          sourceNode = null;
        } catch (e) {}
        playbackStatus.textContent = 'Ready to play';
      }
    }, FADE_OUT_SEC * 1000 + 50);

    clearSleepTimer();
  }

  function togglePlay() {
    if (isPlaying) {
      stop();
    } else {
      play();
    }
  }

  // --- Preset & Slider Logic ---

  function selectPreset(key) {
    const p = PRESETS[key];
    if (!p) return;

    activePresetKey = key;
    cutoff = p.cutoff;
    slope = p.slope;

    localStorage.setItem(STORAGE_KEYS.PRESET, key);
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());

    // Update UI chips
    presetChips.forEach((chip) => {
      if (chip.getAttribute('data-preset') === key) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    presetValue.textContent = p.name;

    // Update Sliders
    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    applyFilterParameters();
  }

  function onManualSliderChange() {
    // Check if current values match any known preset
    let matchedKey = null;
    for (const [key, p] of Object.entries(PRESETS)) {
      if (p.cutoff === cutoff && p.slope === slope) {
        matchedKey = key;
        break;
      }
    }

    activePresetKey = matchedKey || 'custom';
    localStorage.setItem(STORAGE_KEYS.PRESET, activePresetKey);

    presetChips.forEach((chip) => {
      if (chip.getAttribute('data-preset') === activePresetKey) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    if (matchedKey) {
      presetValue.textContent = PRESETS[matchedKey].name;
    } else {
      presetValue.textContent = `Custom (${cutoff} Hz, ${slope}x)`;
    }

    applyFilterParameters();
  }

  function formatSlopeText(val) {
    if (val === 1) return '1x (Gentle / 6 dB)';
    if (val === 2) return '2x (Balanced / 12 dB)';
    if (val === 3) return '3x (Deep / 18 dB)';
    return '4x (Steep / 24 dB)';
  }

  // --- Sleep Timer ---

  function startSleepTimer(minutes) {
    clearSleepTimer();
    if (minutes <= 0) {
      timerCountdown.textContent = 'Continuous';
      return;
    }

    sleepTimerEndTime = Date.now() + minutes * 60 * 1000;
    updateTimerDisplay();

    sleepTimerInterval = setInterval(() => {
      const remainingMs = sleepTimerEndTime - Date.now();
      if (remainingMs <= 0) {
        clearSleepTimer();
        timerCountdown.textContent = 'Continuous';
        stop();
      } else {
        updateTimerDisplay();
      }
    }, 1000);
  }

  function clearSleepTimer() {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    sleepTimerEndTime = null;
  }

  function updateTimerDisplay() {
    if (!sleepTimerEndTime) {
      timerCountdown.textContent = 'Continuous';
      return;
    }
    const totalSecs = Math.max(0, Math.ceil((sleepTimerEndTime - Date.now()) / 1000));
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    timerCountdown.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs} remaining`;
  }

  // --- UI Helpers ---

  function updateUIState(playing) {
    if (playing) {
      iconPlay.classList.add('hidden');
      iconStop.classList.remove('hidden');
      visualizerContainer.classList.add('playing');
      playBtn.setAttribute('aria-label', 'Stop brown noise');
    } else {
      iconPlay.classList.remove('hidden');
      iconStop.classList.add('hidden');
      visualizerContainer.classList.remove('playing');
      playBtn.setAttribute('aria-label', 'Play brown noise');
    }
  }

  function updateSliderFill(slider) {
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const val = parseFloat(slider.value) || 0;
    const pct = ((val - min) / (max - min)) * 100;
    slider.style.setProperty('--slider-fill', `linear-gradient(to right, #8c582f 0%, #c88a55 ${pct}%, #1b1410 ${pct}%)`);
  }

  // --- Media Session ---

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;

    const titleText = PRESETS[activePresetKey] ? PRESETS[activePresetKey].name : `Custom (${cutoff} Hz)`;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${titleText} - Brown Noise`,
      artist: 'Offline Ambient',
      album: 'Deep Sound',
      artwork: [
        { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: './icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
      ]
    });

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

    try {
      navigator.mediaSession.setActionHandler('play', () => play());
      navigator.mediaSession.setActionHandler('pause', () => stop());
      navigator.mediaSession.setActionHandler('stop', () => stop());
    } catch (e) {
      console.warn('MediaSession handler error:', e);
    }
  }

  // --- Event Listeners ---

  playBtn.addEventListener('click', togglePlay);

  // Preset Chips
  presetChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.getAttribute('data-preset');
      if (key) selectPreset(key);
    });
  });

  // Cutoff Slider
  cutoffSlider.addEventListener('input', (e) => {
    cutoff = parseInt(e.target.value, 10);
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    onManualSliderChange();
  });

  // Slope Slider
  slopeSlider.addEventListener('input', (e) => {
    slope = parseInt(e.target.value, 10);
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());
    onManualSliderChange();
  });

  // Sleep Timer Chips
  timerChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      timerChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');

      timerMinutes = parseInt(chip.getAttribute('data-minutes') || '0', 10);
      localStorage.setItem(STORAGE_KEYS.TIMER, timerMinutes.toString());

      if (isPlaying) {
        startSleepTimer(timerMinutes);
      } else {
        timerCountdown.textContent = timerMinutes === 0 ? 'Continuous' : `${timerMinutes}m`;
      }
    });
  });

  // Resume context if app re-enters foreground
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioCtx && audioCtx.state === 'suspended' && isPlaying) {
      audioCtx.resume();
    }
  });

  // Network Offline / Online status
  window.addEventListener('online', () => {
    offlineBadge.title = 'Works 100% offline (Online)';
  });
  window.addEventListener('offline', () => {
    offlineBadge.title = 'Offline mode active';
  });

  // --- App Initialization ---

  function initializeApp() {
    // 1. Restore Preset or Custom
    if (PRESETS[activePresetKey]) {
      selectPreset(activePresetKey);
    } else {
      cutoffSlider.value = cutoff;
      cutoffValue.textContent = `${cutoff} Hz`;
      updateSliderFill(cutoffSlider);

      slopeSlider.value = slope;
      slopeValue.textContent = formatSlopeText(slope);
      updateSliderFill(slopeSlider);

      presetValue.textContent = `Custom (${cutoff} Hz, ${slope}x)`;
      presetChips.forEach((chip) => chip.classList.remove('active'));
    }

    // 2. Restore Timer
    timerChips.forEach((chip) => {
      const mins = parseInt(chip.getAttribute('data-minutes') || '0', 10);
      if (mins === timerMinutes) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
    timerCountdown.textContent = timerMinutes === 0 ? 'Continuous' : `${timerMinutes}m`;

    updateMediaSession();

    // Register Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((reg) => {
            console.log('ServiceWorker registered with scope:', reg.scope);
          })
          .catch((err) => {
            console.warn('ServiceWorker registration failed:', err);
          });
      });
    }
  }

  initializeApp();
})();
