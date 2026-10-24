/**
 * Offline-First Brown Noise PWA
 * In-Memory WAV synthesis with native HTML5 <audio> engine for full
 * Android & iOS background playback and lock-screen media notifications.
 * Pure Gaussian synthesis with zero scratchiness or distortion.
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 30;  // 30-second high-resolution seamless loop buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to stabilize leaky integration & filter
  const CROSSFADE_SEC = 3.5;       // 3.5s equal-power crossfade for seamless looping
  const FADE_IN_MS = 1200;
  const FADE_OUT_MS = 1000;
  const TONE_SWAP_CROSSFADE_MS = 400;

  const STORAGE_KEYS = {
    PRESET: 'bn_active_preset',
    CUTOFF: 'bn_cutoff_hz',
    SLOPE: 'bn_slope_val',
    TIMER: 'bn_sleep_timer',
    CUSTOM_PRESETS: 'bn_custom_presets_v1'
  };

  const BUILTIN_PRESETS = {
    open: { name: 'Open (1200 Hz)', cutoff: 1200, slope: 1 },
    warm: { name: 'Warm (800 Hz)', cutoff: 800, slope: 1 },
    deep: { name: 'Deep (500 Hz)', cutoff: 500, slope: 2 },
    rumble: { name: 'Rumble (250 Hz)', cutoff: 250, slope: 2 }
  };

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

  let audioA = document.getElementById('audioA');
  let audioB = document.getElementById('audioB');

  // --- App State ---
  let isPlaying = false;
  let activePresetKey = localStorage.getItem(STORAGE_KEYS.PRESET) || 'open';
  let cutoff = parseInt(localStorage.getItem(STORAGE_KEYS.CUTOFF) || '1200', 10);
  let slope = parseInt(localStorage.getItem(STORAGE_KEYS.SLOPE) || '1', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  // Custom user-saved presets
  let customPresets = [];
  try {
    customPresets = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_PRESETS) || '[]');
  } catch (e) {
    customPresets = [];
  }

  let activeAudio = audioA;
  let standbyAudio = audioB;
  let activeBlobUrl = null;
  let standbyBlobUrl = null;

  let fadeIntervalId = null;
  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;
  let debounceWavTimer = null;

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
   * Synthesizes 16-bit PCM WAV Blob with Cutoff & Slope baked in:
   * 1. Pure Gaussian brown noise with leaky integration.
   * 2. Lowpass filtering with 1x to 4x slope poles.
   * 3. DC blocking filter (20 Hz).
   * 4. Equal-power tail crossfade for completely seamless, gapless looping.
   * 5. Clean linear peak normalization to 0.95 (loudest clean hardware output).
   */
  function synthesizeBrownNoiseWav(cutoffHz, slopeVal) {
    const warmupSamples = Math.floor(SAMPLE_RATE * WARMUP_SEC);
    const nSamples = Math.floor(SAMPLE_RATE * BUFFER_DURATION_SEC);
    const crossfadeSamples = Math.floor(SAMPLE_RATE * CROSSFADE_SEC);
    const totalGen = warmupSamples + nSamples + crossfadeSamples;

    const left = new Float32Array(totalGen);
    const right = new Float32Array(totalGen);

    // 1. Pure Gaussian leaky integration
    let l = 0, r = 0;
    for (let i = 0; i < totalGen; i++) {
      l = (l + 0.02 * gaussianRandom()) / 1.02;
      r = (r + 0.02 * gaussianRandom()) / 1.02;
      left[i] = l;
      right[i] = r;
    }

    // 2. Multi-pole Low-pass Filtering
    // Slope 1: 1 pole (gentle 6 dB/oct)
    // Slope 2: 2 poles (12 dB/oct)
    // Slope 3: 3 poles (18 dB/oct)
    // Slope 4: 4 poles (24 dB/oct)
    const dt = 1 / SAMPLE_RATE;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = dt / (rc + dt);

    const poles = Math.max(1, Math.min(4, slopeVal));
    for (let p = 0; p < poles; p++) {
      let flL = 0, flR = 0;
      for (let i = 0; i < totalGen; i++) {
        flL += alpha * (left[i] - flL);
        flR += alpha * (right[i] - flR);
        left[i] = flL;
        right[i] = flR;
      }
    }

    // 3. DC Blocker Filter (20 Hz)
    const dtDC = 1 / SAMPLE_RATE;
    const rcDC = 1 / (2 * Math.PI * 20);
    const alphaHP = rcDC / (rcDC + dtDC);

    let pXL = 0, pYL = 0, pXR = 0, pYR = 0;
    for (let i = 0; i < totalGen; i++) {
      const yL = alphaHP * (pYL + left[i] - pXL);
      pXL = left[i]; pYL = yL; left[i] = yL;

      const yR = alphaHP * (pYR + right[i] - pXR);
      pXR = right[i]; pYR = yR; right[i] = yR;
    }

    // 4. Extract Steady-State Portion
    const outL = new Float32Array(nSamples);
    const outR = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      outL[i] = left[i + warmupSamples];
      outR[i] = right[i + warmupSamples];
    }

    // 5. Equal-power Tail Crossfade for Zero-Seam Looping
    const tailOffset = warmupSamples + nSamples;
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const wTail = Math.cos(0.5 * Math.PI * t);
      const wHead = Math.sin(0.5 * Math.PI * t);
      outL[i] = left[tailOffset + i] * wTail + left[i] * wHead;
      outR[i] = right[tailOffset + i] * wTail + right[i] * wHead;
    }

    // 6. Clean Linear Peak Normalization (0.95 peak, zero distortion)
    let maxPeak = 0;
    for (let i = 0; i < nSamples; i++) {
      const aL = Math.abs(outL[i]);
      const aR = Math.abs(outR[i]);
      if (aL > maxPeak) maxPeak = aL;
      if (aR > maxPeak) maxPeak = aR;
    }
    const scale = (0.95 / (maxPeak || 1.0)) * 32767;

    // 7. RIFF WAV Encoding
    const pcmBytes = nSamples * 4;
    const buffer = new ArrayBuffer(44 + pcmBytes);
    const view = new DataView(buffer);

    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + pcmBytes, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 2, true);          // Stereo
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, pcmBytes, true);

    const pcm = new Int16Array(buffer, 44, nSamples * 2);
    let idx = 0;
    for (let i = 0; i < nSamples; i++) {
      pcm[idx++] = Math.max(-32768, Math.min(32767, Math.round(outL[i] * scale)));
      pcm[idx++] = Math.max(-32768, Math.min(32767, Math.round(outR[i] * scale)));
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // --- Smooth Volume Fades ---

  function rampVolume(el, fromVol, toVol, durationMs, onDone) {
    if (fadeIntervalId) {
      clearInterval(fadeIntervalId);
      fadeIntervalId = null;
    }

    const steps = 30;
    const stepTime = durationMs / steps;
    let step = 0;
    el.volume = Math.max(0, Math.min(1, fromVol));

    fadeIntervalId = setInterval(() => {
      step++;
      const progress = Math.min(1, step / steps);
      // Smooth sinusoidal interpolation
      const smooth = 0.5 * (1 - Math.cos(Math.PI * progress));
      el.volume = Math.max(0, Math.min(1, fromVol + (toVol - fromVol) * smooth));

      if (progress >= 1) {
        clearInterval(fadeIntervalId);
        fadeIntervalId = null;
        if (onDone) onDone();
      }
    }, stepTime);
  }

  // --- Playback Control ---

  function play() {
    if (isPlaying) return;
    isPlaying = true;

    updateUIState(true);
    updateMediaSession();
    playbackStatus.textContent = 'Playing';

    activeAudio.loop = true;
    activeAudio.playsInline = true;

    const playPromise = activeAudio.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          rampVolume(activeAudio, 0, 1.0, FADE_IN_MS);
          if (timerMinutes > 0 && !sleepTimerEndTime) {
            startSleepTimer(timerMinutes);
          }
        })
        .catch((err) => {
          console.warn('Playback error:', err);
          isPlaying = false;
          updateUIState(false);
          playbackStatus.textContent = 'Tap to play';
        });
    }
  }

  function stop() {
    if (!isPlaying) return;
    isPlaying = false;

    updateUIState(false);
    updateMediaSession();
    playbackStatus.textContent = 'Fading out...';

    rampVolume(activeAudio, activeAudio.volume, 0, FADE_OUT_MS, () => {
      activeAudio.pause();
      playbackStatus.textContent = 'Ready to play';
      activeAudio.volume = 1.0;
    });

    clearSleepTimer();
  }

  function togglePlay() {
    if (isPlaying) {
      stop();
    } else {
      play();
    }
  }

  // --- Live Sound Regeneration & Crossfading ---

  function applyToneUpdate() {
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());

    if (!isPlaying) {
      // Audio is stopped: regenerate and update source
      playbackStatus.textContent = 'Updating tone...';
      setTimeout(() => {
        const newBlob = synthesizeBrownNoiseWav(cutoff, slope);
        if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);
        activeBlobUrl = URL.createObjectURL(newBlob);
        activeAudio.src = activeBlobUrl;
        playbackStatus.textContent = 'Ready to play';
      }, 10);
      return;
    }

    // Audio is currently playing: smooth crossfade to standbyAudio
    playbackStatus.textContent = 'Updating tone...';
    const newBlob = synthesizeBrownNoiseWav(cutoff, slope);
    if (standbyBlobUrl) URL.revokeObjectURL(standbyBlobUrl);
    standbyBlobUrl = URL.createObjectURL(newBlob);

    standbyAudio.src = standbyBlobUrl;
    standbyAudio.loop = true;
    standbyAudio.playsInline = true;
    standbyAudio.volume = 0;

    const onCanPlay = () => {
      standbyAudio.removeEventListener('canplaythrough', onCanPlay);

      standbyAudio.play().then(() => {
        // Crossfade over 400ms
        rampVolume(activeAudio, activeAudio.volume, 0, TONE_SWAP_CROSSFADE_MS, () => {
          activeAudio.pause();
          if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);

          // Swap audio pointers
          const temp = activeAudio;
          activeAudio = standbyAudio;
          standbyAudio = temp;

          activeBlobUrl = standbyBlobUrl;
          standbyBlobUrl = null;

          playbackStatus.textContent = 'Playing';
          updateMediaSession();
        });
        rampVolume(standbyAudio, 0, 1.0, TONE_SWAP_CROSSFADE_MS);
      }).catch(console.warn);
    };

    standbyAudio.addEventListener('canplaythrough', onCanPlay);
  }

  function debounceToneUpdate() {
    clearTimeout(debounceWavTimer);
    debounceWavTimer = setTimeout(applyToneUpdate, 180);
  }

  // --- Preset & Custom Management ---

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
    presetValue.textContent = `${p.name}`;
    saveCustomBtn.classList.add('hidden');

    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    renderPresetChips();
    debounceToneUpdate();
  }

  function selectCustomPreset(idx) {
    const cp = customPresets[idx];
    if (!cp) return;

    activePresetKey = `custom_${idx}`;
    cutoff = cp.cutoff;
    slope = cp.slope;

    localStorage.setItem(STORAGE_KEYS.PRESET, activePresetKey);
    presetValue.textContent = `★ ${cp.name} (${cutoff} Hz, ${slope}x)`;
    saveCustomBtn.classList.add('hidden');

    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    renderPresetChips();
    debounceToneUpdate();
  }

  function onSliderDrag() {
    // Check if current values match any known preset
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
    debounceToneUpdate();
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
    customPresets.push({
      name,
      cutoff,
      slope
    });

    localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(customPresets));
    activePresetKey = `custom_${customPresets.length - 1}`;
    localStorage.setItem(STORAGE_KEYS.PRESET, activePresetKey);

    closeSaveModal();
    presetValue.textContent = `★ ${name} (${cutoff} Hz, ${slope}x)`;
    saveCustomBtn.classList.add('hidden');
    renderPresetChips();
  }

  function deleteCustomPreset(idx) {
    customPresets.splice(idx, 1);
    localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(customPresets));
    activePresetKey = 'open';
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
      if (customPresets[idx]) trackTitle = customPresets[idx].name;
    } else {
      trackTitle = `Custom (${cutoff} Hz)`;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${trackTitle} - Brown Noise`,
      artist: 'Offline Ambient',
      album: 'Seamless Audio',
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

  // Audio Element Media Events
  [audioA, audioB].forEach((a) => {
    a.addEventListener('play', () => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    });
    a.addEventListener('pause', () => {
      if ('mediaSession' in navigator && !isPlaying) navigator.mediaSession.playbackState = 'paused';
    });
  });

  // Cutoff Slider
  cutoffSlider.addEventListener('input', (e) => {
    cutoff = parseInt(e.target.value, 10);
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);
    onSliderDrag();
  });

  // Slope Slider
  slopeSlider.addEventListener('input', (e) => {
    slope = parseInt(e.target.value, 10);
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);
    onSliderDrag();
  });

  // Preset Label Tap & Save Button
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

  // Network Offline / Online status
  window.addEventListener('online', () => {
    offlineBadge.title = 'Works 100% offline (Online)';
  });
  window.addEventListener('offline', () => {
    offlineBadge.title = 'Offline mode active';
  });

  // --- Initial Setup ---

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

    // Synthesize initial audio WAV
    playbackStatus.textContent = 'Generating sound...';
    setTimeout(() => {
      const initialBlob = synthesizeBrownNoiseWav(cutoff, slope);
      activeBlobUrl = URL.createObjectURL(initialBlob);
      activeAudio.src = activeBlobUrl;
      activeAudio.loop = true;
      activeAudio.playsInline = true;
      activeAudio.volume = 1.0;
      playbackStatus.textContent = 'Ready to play';
    }, 10);

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
