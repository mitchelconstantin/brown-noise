/**
 * Offline-First Brown Noise PWA
 * Pure Gaussian real-time Web Audio engine with zero looping jitter,
 * instantaneous parameter response, and native Android/iOS lock-screen media controls.
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 25;  // 25-second seamless loop buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to stabilize leaky integration
  const CROSSFADE_SEC = 3.0;       // 3s equal-power crossfade for seamless looping
  const FADE_IN_SEC = 1.0;
  const FADE_OUT_SEC = 0.8;

  const STORAGE_KEYS = {
    PRESET: 'bn_active_preset_v3',
    CUTOFF: 'bn_cutoff_hz_v3',
    SLOPE: 'bn_slope_val_v3',
    TIMER: 'bn_sleep_timer',
    CUSTOM_PRESETS: 'bn_custom_presets_v3'
  };

  const BUILTIN_PRESETS = {
    open: { name: 'Open (1200 Hz)', cutoff: 1200, slope: 1 },
    warm: { name: 'Warm (800 Hz)', cutoff: 800, slope: 1 },
    deep: { name: 'Deep (500 Hz)', cutoff: 500, slope: 2 },
    rumble: { name: 'Rumble (250 Hz)', cutoff: 250, slope: 2 }
  };
  const PRESET_ORDER = ['open', 'warm', 'deep', 'rumble'];

  // --- DOM Elements ---
  const playBtn = document.getElementById('playBtn');
  const iconPlay = document.getElementById('iconPlay');
  const iconStop = document.getElementById('iconStop');
  const visualizerContainer = document.getElementById('visualizerContainer');
  const playbackStatus = document.getElementById('playbackStatus');

  const presetChipsContainer = document.getElementById('presetChipsContainer');
  const presetValue = document.getElementById('presetValue');
  const saveCustomBtn = document.getElementById('saveCustomBtn');

  const cutoffSlider = document.getElementById('cutoffSlider');
  const cutoffValue = document.getElementById('cutoffValue');
  const slopeSlider = document.getElementById('slopeSlider');
  const slopeValue = document.getElementById('slopeValue');

  const saveModal = document.getElementById('saveModal');
  const modalDesc = document.getElementById('modalDesc');
  const presetNameInput = document.getElementById('presetNameInput');
  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const confirmSaveBtn = document.getElementById('confirmSaveBtn');

  const timerCountdown = document.getElementById('timerCountdown');
  const timerChips = document.querySelectorAll('.timer-chip');
  const offlineBadge = document.getElementById('offlineBadge');
  const bgMedia = document.getElementById('bgMedia');

  // --- App State ---
  let isPlaying = false;
  let activePresetKey = localStorage.getItem(STORAGE_KEYS.PRESET) || 'open';
  let cutoff = parseInt(localStorage.getItem(STORAGE_KEYS.CUTOFF) || '1200', 10);
  let slope = parseInt(localStorage.getItem(STORAGE_KEYS.SLOPE) || '1', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  let customPresets = [];
  try {
    customPresets = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_PRESETS) || '[]');
  } catch (e) {
    customPresets = [];
  }

  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;

  // --- Web Audio Graph ---
  let audioCtx = null;
  let sourceNode = null;
  let lpFilter1 = null;
  let lpFilter2 = null;
  let gainNode = null;
  let cachedAudioBuffer = null;
  let silentBlobUrl = null;

  /**
   * Generates a valid 30-second silent WAV file with actual PCM duration.
   * Chrome for Android requires an active media element with duration > 5s
   * to spawn the lock screen notification player and grant background audio focus.
   */
  function create30sSilentWavBlobUrl() {
    if (silentBlobUrl) return silentBlobUrl;

    const rate = 8000;
    const dur = 30; // 30 seconds
    const numSamples = rate * dur;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);

    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + numSamples, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, numSamples, true);

    const u8 = new Uint8Array(buffer, 44, numSamples);
    u8.fill(128); // 8-bit unsigned PCM silence

    const blob = new Blob([buffer], { type: 'audio/wav' });
    silentBlobUrl = URL.createObjectURL(blob);
    return silentBlobUrl;
  }

  /**
   * Generates pure Gaussian random noise via Box-Muller transform.
   * Completely eliminates the harsh scratchy grit of pseudo-random uniform white noise.
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
   * Zero saturation clipping (silky, scratch-free).
   */
  function createPureBrownNoiseBuffer(targetCtx) {
    if (cachedAudioBuffer) return cachedAudioBuffer;

    const warmupSamples = Math.floor(SAMPLE_RATE * WARMUP_SEC);
    const nSamples = Math.floor(SAMPLE_RATE * BUFFER_DURATION_SEC);
    const crossfadeSamples = Math.floor(SAMPLE_RATE * CROSSFADE_SEC);
    const totalGen = warmupSamples + nSamples + crossfadeSamples;

    const left = new Float32Array(totalGen);
    const right = new Float32Array(totalGen);

    let l = 0, r = 0;
    for (let i = 0; i < totalGen; i++) {
      l = (l + 0.02 * gaussianRandom()) / 1.02;
      r = (r + 0.02 * gaussianRandom()) / 1.02;
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

    // Clean linear normalization (0.95 peak, zero distortion)
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

      // Guard against Android background context suspension
      audioCtx.onstatechange = () => {
        if (isPlaying && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(console.warn);
        }
      };
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

    // 3. Master Gain Node (Locked at maximum clean output: 1.0)
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

      lpFilter1.connect(lpFilter2);
      lpFilter2.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    }

    applyFilterParameters();
  }

  function applyFilterParameters() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;

    // Cutoff updates instantaneously without clicks or delays
    if (lpFilter1) {
      lpFilter1.frequency.setTargetAtTime(cutoff, now, 0.02);
    }

    // Slope calculation
    if (lpFilter2) {
      if (slope === 1) {
        // Slope 1: Gentle 6 dB/octave (secondary filter wide open)
        lpFilter2.frequency.setTargetAtTime(18000, now, 0.02);
      } else if (slope === 2) {
        // Slope 2: Standard 12 dB/octave
        lpFilter2.frequency.setTargetAtTime(cutoff * 1.25, now, 0.02);
      } else if (slope === 3) {
        // Slope 3: Deep 18 dB/octave
        lpFilter2.frequency.setTargetAtTime(cutoff, now, 0.02);
      } else {
        // Slope 4: Steep 24 dB/octave
        lpFilter2.frequency.setTargetAtTime(cutoff * 0.85, now, 0.02);
      }
    }
  }

  // --- Playback Control ---

  function play() {
    if (isPlaying) return;
    isPlaying = true;

    updateUIState(true);
    playbackStatus.textContent = 'Playing';

    ensureAudioPipeline();

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    // 1. Play background media element (triggers Android Chrome lock screen & notification player)
    if (bgMedia) {
      bgMedia.volume = 1.0;
      bgMedia.loop = true;
      const playPromise = bgMedia.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => updateMediaSession())
          .catch((e) => console.warn('bgMedia play:', e));
      }
    }

    // 2. Play sample-accurate gapless buffer source node
    if (!sourceNode) {
      sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = cachedAudioBuffer;
      sourceNode.loop = true; // Hardware DSP sample-accurate loop: ZERO JITTER
      sourceNode.connect(lpFilter1);
      sourceNode.start(0);
    }

    // Smooth studio fade-in to maximum clean output (1.0)
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(1.0, now + FADE_IN_SEC);

    updateMediaSession();

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

    if (bgMedia) {
      bgMedia.pause();
    }

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

  // --- Preset & Custom Preset Logic ---

  function formatSlopeText(val) {
    if (val === 1) return '1x (Gentle / 6 dB)';
    if (val === 2) return '2x (Balanced / 12 dB)';
    if (val === 3) return '3x (Deep / 18 dB)';
    return '4x (Steep / 24 dB)';
  }

  function renderPresetChips() {
    presetChipsContainer.innerHTML = '';

    // 1. Built-in presets
    for (const [key, p] of Object.entries(BUILTIN_PRESETS)) {
      const chip = document.createElement('button');
      chip.className = `preset-chip ${activePresetKey === key ? 'active' : ''}`;
      chip.setAttribute('data-preset', key);
      chip.textContent = key.charAt(0).toUpperCase() + key.slice(1);
      chip.addEventListener('click', () => selectPreset(key));
      presetChipsContainer.appendChild(chip);
    }

    // 2. User-saved custom presets
    customPresets.forEach((cp, idx) => {
      const chip = document.createElement('button');
      const isCur = activePresetKey === `custom_${idx}`;
      chip.className = `preset-chip custom-chip ${isCur ? 'active' : ''}`;
      chip.setAttribute('data-preset', `custom_${idx}`);
      chip.innerHTML = `<span>★ ${cp.name}</span><span class="chip-del" title="Delete preset">&times;</span>`;

      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('chip-del')) {
          e.stopPropagation();
          deleteCustomPreset(idx);
          return;
        }
        selectCustomPreset(idx);
      });

      presetChipsContainer.appendChild(chip);
    });
  }

  function selectPreset(key) {
    const p = BUILTIN_PRESETS[key];
    if (!p) return;

    activePresetKey = key;
    cutoff = p.cutoff;
    slope = p.slope;

    localStorage.setItem(STORAGE_KEYS.PRESET, key);
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());

    presetValue.textContent = p.name;
    saveCustomBtn.classList.add('hidden');

    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    renderPresetChips();
    applyFilterParameters();
    updateMediaSession();
  }

  function selectCustomPreset(idx) {
    const cp = customPresets[idx];
    if (!cp) return;

    activePresetKey = `custom_${idx}`;
    cutoff = cp.cutoff;
    slope = cp.slope;

    localStorage.setItem(STORAGE_KEYS.PRESET, activePresetKey);
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());

    presetValue.textContent = `★ ${cp.name} (${cutoff} Hz, ${slope}x)`;
    saveCustomBtn.classList.add('hidden');

    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    renderPresetChips();
    applyFilterParameters();
    updateMediaSession();
  }

  function onSliderDrag() {
    let matchedKey = null;
    for (const [key, p] of Object.entries(BUILTIN_PRESETS)) {
      if (p.cutoff === cutoff && p.slope === slope) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      customPresets.forEach((cp, idx) => {
        if (cp.cutoff === cutoff && cp.slope === slope) {
          matchedKey = `custom_${idx}`;
        }
      });
    }

    activePresetKey = matchedKey || 'custom';
    localStorage.setItem(STORAGE_KEYS.PRESET, activePresetKey);
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());

    if (matchedKey && BUILTIN_PRESETS[matchedKey]) {
      presetValue.textContent = BUILTIN_PRESETS[matchedKey].name;
      saveCustomBtn.classList.add('hidden');
    } else if (matchedKey && matchedKey.startsWith('custom_')) {
      const idx = parseInt(matchedKey.split('_')[1], 10);
      presetValue.textContent = `★ ${customPresets[idx].name} (${cutoff} Hz, ${slope}x)`;
      saveCustomBtn.classList.add('hidden');
    } else {
      presetValue.textContent = `Custom (${cutoff} Hz, ${slope}x) — Tap to save`;
      saveCustomBtn.classList.remove('hidden');
    }

    renderPresetChips();
    applyFilterParameters();
    updateMediaSession();
  }

  function cyclePreset(forward) {
    const allKeys = [...PRESET_ORDER, ...customPresets.map((_, i) => `custom_${i}`)];
    let curIdx = allKeys.indexOf(activePresetKey);
    if (curIdx === -1) curIdx = 0;

    let nextIdx = forward ? (curIdx + 1) % allKeys.length : (curIdx - 1 + allKeys.length) % allKeys.length;
    const nextKey = allKeys[nextIdx];

    if (nextKey.startsWith('custom_')) {
      selectCustomPreset(parseInt(nextKey.split('_')[1], 10));
    } else {
      selectPreset(nextKey);
    }
  }

  // --- Custom Preset Modal ---

  function openSaveModal() {
    modalDesc.textContent = `Cutoff: ${cutoff} Hz • Slope: ${slope}x (${formatSlopeText(slope)})`;
    presetNameInput.value = '';
    saveModal.classList.remove('hidden');
    setTimeout(() => presetNameInput.focus(), 50);
  }

  function closeSaveModal() {
    saveModal.classList.add('hidden');
  }

  function saveCurrentAsCustom() {
    const name = presetNameInput.value.trim() || `My Tone ${customPresets.length + 1}`;
    customPresets.push({ name, cutoff, slope });

    localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(customPresets));
    activePresetKey = `custom_${customPresets.length - 1}`;
    localStorage.setItem(STORAGE_KEYS.PRESET, activePresetKey);

    closeSaveModal();
    presetValue.textContent = `★ ${name} (${cutoff} Hz, ${slope}x)`;
    saveCustomBtn.classList.add('hidden');
    renderPresetChips();
    updateMediaSession();
  }

  function deleteCustomPreset(idx) {
    customPresets.splice(idx, 1);
    localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(customPresets));
    selectPreset('open');
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

  // --- Media Session API ---

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;

    let trackTitle = 'Open (1200 Hz)';
    if (BUILTIN_PRESETS[activePresetKey]) {
      trackTitle = BUILTIN_PRESETS[activePresetKey].name;
    } else if (activePresetKey.startsWith('custom_')) {
      const idx = parseInt(activePresetKey.split('_')[1], 10);
      if (customPresets[idx]) trackTitle = `★ ${customPresets[idx].name}`;
    } else {
      trackTitle = `Custom (${cutoff} Hz)`;
    }

    // Android Chrome strictly requires fully-qualified absolute URLs for artwork
    const origin = window.location.origin;
    const pathname = window.location.pathname.replace(/\/[^/]*$/, '/');
    const baseUrl = `${origin}${pathname}`;
    const icon192 = new URL('icons/icon-192.png', baseUrl).href;
    const icon512 = new URL('icons/icon-512.png', baseUrl).href;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${trackTitle} - Brown Noise`,
      artist: 'Offline Ambient',
      album: 'Pure Sound',
      artwork: [
        { src: icon192, sizes: '192x192', type: 'image/png' },
        { src: icon512, sizes: '512x512', type: 'image/png' }
      ]
    });

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

    try {
      navigator.mediaSession.setActionHandler('play', () => play());
      navigator.mediaSession.setActionHandler('pause', () => stop());
      navigator.mediaSession.setActionHandler('stop', () => stop());
      navigator.mediaSession.setActionHandler('nexttrack', () => cyclePreset(true));
      navigator.mediaSession.setActionHandler('previoustrack', () => cyclePreset(false));
    } catch (e) {
      console.warn('MediaSession handler error:', e);
    }
  }

  // --- Event Listeners ---

  playBtn.addEventListener('click', togglePlay);

  // Cutoff Slider (updates audio instantaneously)
  cutoffSlider.addEventListener('input', (e) => {
    cutoff = parseInt(e.target.value, 10);
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);
    onSliderDrag();
  });

  // Slope Slider (updates audio instantaneously)
  slopeSlider.addEventListener('input', (e) => {
    slope = parseInt(e.target.value, 10);
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);
    onSliderDrag();
  });

  // Preset Label Tap & Save Modal
  presetValue.addEventListener('click', () => {
    if (activePresetKey === 'custom') openSaveModal();
  });
  saveCustomBtn.addEventListener('click', openSaveModal);
  cancelModalBtn.addEventListener('click', closeSaveModal);
  confirmSaveBtn.addEventListener('click', saveCurrentAsCustom);
  presetNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveCurrentAsCustom();
    if (e.key === 'Escape') closeSaveModal();
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

  // Keep AudioContext resumed whenever visibility changes or state shifts
  document.addEventListener('visibilitychange', () => {
    if (isPlaying && audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(console.warn);
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
    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    renderPresetChips();

    if (BUILTIN_PRESETS[activePresetKey]) {
      presetValue.textContent = BUILTIN_PRESETS[activePresetKey].name;
      saveCustomBtn.classList.add('hidden');
    } else if (activePresetKey.startsWith('custom_')) {
      const idx = parseInt(activePresetKey.split('_')[1], 10);
      if (customPresets[idx]) {
        presetValue.textContent = `★ ${customPresets[idx].name} (${cutoff} Hz, ${slope}x)`;
      }
      saveCustomBtn.classList.add('hidden');
    } else {
      presetValue.textContent = `Custom (${cutoff} Hz, ${slope}x) — Tap to save`;
      saveCustomBtn.classList.remove('hidden');
    }

    // Pre-create 30s silent audio Blob URL and load into bgMedia element
    if (bgMedia) {
      bgMedia.src = create30sSilentWavBlobUrl();
      bgMedia.loop = true;
      bgMedia.volume = 1.0;
      bgMedia.load();
    }

    // Sleep Timer
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
