/**
 * Offline-First Brown Noise PWA
 * Pure vanilla ES6+ audio synthesizer and playback controller.
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const SAMPLE_RATE = 44100;
  const AUDIO_DURATION_SEC = 20; // 20-second seamless loop buffer
  const CROSSFADE_SEC = 0.25;    // 250ms seamless loop crossfade
  const FADE_IN_MS = 1500;       // 1500ms smooth fade in
  const FADE_OUT_MS = 1200;      // 1200ms smooth fade out
  const TONE_CROSSFADE_MS = 600; // 600ms crossfade when switching tone while playing

  const STORAGE_KEYS = {
    WARMTH: 'brown_noise_warmth',
    VOLUME: 'brown_noise_volume',
    TIMER: 'brown_noise_timer'
  };

  // --- DOM Elements ---
  const playBtn = document.getElementById('playBtn');
  const iconPlay = document.getElementById('iconPlay');
  const iconStop = document.getElementById('iconStop');
  const visualizerContainer = document.getElementById('visualizerContainer');
  const playbackStatus = document.getElementById('playbackStatus');
  const warmthSlider = document.getElementById('warmthSlider');
  const warmthValue = document.getElementById('warmthValue');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValue = document.getElementById('volumeValue');
  const timerCountdown = document.getElementById('timerCountdown');
  const timerChips = document.querySelectorAll('.timer-chip');
  const offlineBadge = document.getElementById('offlineBadge');

  let audioA = document.getElementById('audioA');
  let audioB = document.getElementById('audioB');

  // --- State ---
  let isPlaying = false;
  let warmth = parseInt(localStorage.getItem(STORAGE_KEYS.WARMTH) || '40', 10);
  let volume = parseInt(localStorage.getItem(STORAGE_KEYS.VOLUME) || '80', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  let activeAudio = audioA;
  let standbyAudio = audioB;
  let activeBlobUrl = null;
  let standbyBlobUrl = null;

  let fadeAnimationId = null;
  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;
  let warmthDebounceTimer = null;
  let volumeDebounceTimer = null;

  // Detect if HTMLAudioElement.volume is mutable (false on iOS Safari)
  const isVolumeSupported = (() => {
    try {
      const testAudio = document.createElement('audio');
      testAudio.volume = 0.5;
      return Math.abs(testAudio.volume - 0.5) < 0.05;
    } catch (e) {
      return false;
    }
  })();

  // --- Procedural Brown Noise & WAV Generation ---

  /**
   * Generates a 16-bit PCM WAV Blob of brown noise with seamless looping
   * and one-pole low-pass filtering.
   */
  function generateBrownNoiseWav(warmthSetting, volumeSetting) {
    const N = SAMPLE_RATE * AUDIO_DURATION_SEC;
    const L = Math.floor(SAMPLE_RATE * CROSSFADE_SEC);
    const totalSamples = N + L;

    // Allocate left and right channels
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);

    // 1. Brown noise integration (leaky integrator prevents DC wander)
    let lastL = 0;
    let lastR = 0;
    for (let i = 0; i < totalSamples; i++) {
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;
      lastL = (lastL + 0.02 * whiteL) / 1.02;
      lastR = (lastR + 0.02 * whiteR) / 1.02;
      left[i] = lastL;
      right[i] = lastR;
    }

    // 2. One-pole low-pass filter (Tone / Warmth)
    // Warmth 0: 80Hz (Deep Rumble) -> Warmth 100: 2200Hz (Soft Brown)
    const minCutoff = 80;
    const maxCutoff = 2200;
    const fc = minCutoff * Math.pow(maxCutoff / minCutoff, warmthSetting / 100);
    const dt = 1 / SAMPLE_RATE;
    const rc = 1 / (2 * Math.PI * fc);
    const alpha = dt / (rc + dt);

    let fl = 0;
    let fr = 0;
    for (let i = 0; i < totalSamples; i++) {
      fl += alpha * (left[i] - fl);
      fr += alpha * (right[i] - fr);
      left[i] = fl;
      right[i] = fr;
    }

    // 3. Seamless crossfade looping
    // Blend tail [N, N+L) back into head [0, L) using equal-power crossfade
    for (let i = 0; i < L; i++) {
      const t = i / L;
      const wTail = Math.cos(0.5 * Math.PI * t);
      const wHead = Math.sin(0.5 * Math.PI * t);
      left[i] = left[i + N] * wTail + left[i] * wHead;
      right[i] = right[i + N] * wTail + right[i] * wHead;
    }

    // 4. Normalization and amplitude scaling
    let maxPeak = 0;
    for (let i = 0; i < N; i++) {
      const absL = Math.abs(left[i]);
      const absR = Math.abs(right[i]);
      if (absL > maxPeak) maxPeak = absL;
      if (absR > maxPeak) maxPeak = absR;
    }

    // If audio.volume is locked (iOS Safari), scale PCM amplitude directly
    const volMultiplier = isVolumeSupported ? 1.0 : Math.max(0.01, volumeSetting / 100);
    const targetPeak = 0.85 * volMultiplier;
    const scale = maxPeak > 0 ? (targetPeak / maxPeak) * 32767 : 0;

    // 5. Build 16-bit PCM WAV File Header & Payload
    const pcmByteLength = N * 2 * 2; // N frames * 2 channels * 2 bytes/sample
    const totalWavSize = 44 + pcmByteLength;
    const buffer = new ArrayBuffer(totalWavSize);
    const headerView = new DataView(buffer);

    // RIFF identifier 'RIFF'
    headerView.setUint32(0, 0x52494646, false);
    // File size - 8
    headerView.setUint32(4, 36 + pcmByteLength, true);
    // 'WAVE'
    headerView.setUint32(8, 0x57415645, false);
    // 'fmt ' chunk
    headerView.setUint32(12, 0x666d7420, false);
    headerView.setUint32(16, 16, true);             // Subchunk1Size (16 for PCM)
    headerView.setUint16(20, 1, true);              // AudioFormat (1 = PCM)
    headerView.setUint16(22, 2, true);              // NumChannels (2 = Stereo)
    headerView.setUint32(24, SAMPLE_RATE, true);    // SampleRate
    headerView.setUint32(28, SAMPLE_RATE * 4, true);// ByteRate (SampleRate * 2 channels * 2 bytes)
    headerView.setUint16(32, 4, true);              // BlockAlign (channels * bytesPerSample)
    headerView.setUint16(34, 16, true);             // BitsPerSample (16 bits)
    // 'data' chunk
    headerView.setUint32(36, 0x64617461, false);
    headerView.setUint32(40, pcmByteLength, true);

    // Write interleaved 16-bit PCM samples
    const pcmView = new Int16Array(buffer, 44, N * 2);
    let sampleIdx = 0;
    for (let i = 0; i < N; i++) {
      pcmView[sampleIdx++] = Math.max(-32768, Math.min(32767, Math.round(left[i] * scale)));
      pcmView[sampleIdx++] = Math.max(-32768, Math.min(32767, Math.round(right[i] * scale)));
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // --- Volume Ramping / Fades ---

  function cancelCurrentFade() {
    if (fadeAnimationId) {
      cancelAnimationFrame(fadeAnimationId);
      fadeAnimationId = null;
    }
  }

  /**
   * Smoothly ramps an audio element's volume from startVol to endVol over durationMs.
   */
  function rampVolume(audioEl, startVol, endVol, durationMs, onComplete) {
    if (!isVolumeSupported) {
      if (onComplete) onComplete();
      return;
    }

    cancelCurrentFade();
    const startTime = performance.now();
    audioEl.volume = Math.max(0, Math.min(1, startVol));

    function step(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      
      // Smooth sinusoidal / easeInOut interpolation
      const smooth = 0.5 * (1 - Math.cos(Math.PI * progress));
      const currentVol = startVol + (endVol - startVol) * smooth;
      audioEl.volume = Math.max(0, Math.min(1, currentVol));

      if (progress < 1) {
        fadeAnimationId = requestAnimationFrame(step);
      } else {
        audioEl.volume = Math.max(0, Math.min(1, endVol));
        fadeAnimationId = null;
        if (onComplete) onComplete();
      }
    }

    fadeAnimationId = requestAnimationFrame(step);
  }

  // --- Playback Engine ---

  function getTargetVolume() {
    return isVolumeSupported ? volume / 100 : 1.0;
  }

  function play() {
    if (isPlaying) return;
    isPlaying = true;

    updateUIState(true);
    updateMediaSession();

    const targetVol = getTargetVolume();

    // Prepare active audio element
    if (isVolumeSupported) {
      activeAudio.volume = 0;
    }

    const playPromise = activeAudio.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          playbackStatus.textContent = 'Playing';
          rampVolume(activeAudio, 0, targetVol, FADE_IN_MS);
          if (timerMinutes > 0 && !sleepTimerEndTime) {
            startSleepTimer(timerMinutes);
          }
        })
        .catch((err) => {
          console.warn('Playback error / autoplay blocked:', err);
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

    const currentVol = isVolumeSupported ? activeAudio.volume : 1.0;

    rampVolume(activeAudio, currentVol, 0, FADE_OUT_MS, () => {
      activeAudio.pause();
      playbackStatus.textContent = 'Ready to play';
      if (isVolumeSupported) {
        activeAudio.volume = getTargetVolume();
      }
    });

    // Reset sleep timer if running
    clearSleepTimer();
  }

  function togglePlay() {
    if (isPlaying) {
      stop();
    } else {
      play();
    }
  }

  // --- Live Warmth / Tone Updates with Crossfading ---

  function applyWarmthUpdate() {
    localStorage.setItem(STORAGE_KEYS.WARMTH, warmth.toString());

    if (!isPlaying) {
      // Audio is paused: cleanly regenerate and update active audio source
      playbackStatus.textContent = 'Updating tone...';
      setTimeout(() => {
        const newBlob = generateBrownNoiseWav(warmth, volume);
        if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);
        activeBlobUrl = URL.createObjectURL(newBlob);
        activeAudio.src = activeBlobUrl;
        playbackStatus.textContent = 'Ready to play';
      }, 10);
      return;
    }

    // Audio is currently playing: smooth crossfade to new audio element
    playbackStatus.textContent = 'Harmonizing tone...';
    const newBlob = generateBrownNoiseWav(warmth, volume);
    if (standbyBlobUrl) URL.revokeObjectURL(standbyBlobUrl);
    standbyBlobUrl = URL.createObjectURL(newBlob);

    standbyAudio.src = standbyBlobUrl;
    standbyAudio.loop = true;
    if (isVolumeSupported) {
      standbyAudio.volume = 0;
    }

    const onCanPlay = () => {
      standbyAudio.removeEventListener('canplaythrough', onCanPlay);

      standbyAudio.play().then(() => {
        const targetVol = getTargetVolume();

        if (isVolumeSupported) {
          const crossfadeStart = performance.now();
          const initialActiveVol = activeAudio.volume;

          function crossfadeStep(now) {
            const progress = Math.min(1, (now - crossfadeStart) / TONE_CROSSFADE_MS);
            activeAudio.volume = Math.max(0, initialActiveVol * (1 - progress));
            standbyAudio.volume = Math.min(targetVol, targetVol * progress);

            if (progress < 1) {
              requestAnimationFrame(crossfadeStep);
            } else {
              activeAudio.pause();
              if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);

              // Swap audio references
              const tempAudio = activeAudio;
              activeAudio = standbyAudio;
              standbyAudio = tempAudio;

              activeBlobUrl = standbyBlobUrl;
              standbyBlobUrl = null;

              playbackStatus.textContent = 'Playing';
            }
          }
          requestAnimationFrame(crossfadeStep);
        } else {
          // iOS Safari without audio.volume support: swap immediately
          activeAudio.pause();
          if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);

          const tempAudio = activeAudio;
          activeAudio = standbyAudio;
          standbyAudio = tempAudio;

          activeBlobUrl = standbyBlobUrl;
          standbyBlobUrl = null;

          playbackStatus.textContent = 'Playing';
        }
      }).catch(console.warn);
    };

    standbyAudio.addEventListener('canplaythrough', onCanPlay);
  }

  // --- Live Volume Updates ---

  function applyVolumeUpdate() {
    localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());

    if (isVolumeSupported) {
      // Dynamic hardware/software volume adjustment
      if (isPlaying && !fadeAnimationId) {
        activeAudio.volume = volume / 100;
      }
    } else {
      // iOS Safari: regenerate WAV with modified PCM amplitude (debounced)
      clearTimeout(volumeDebounceTimer);
      volumeDebounceTimer = setTimeout(() => {
        applyWarmthUpdate();
      }, 250);
    }
  }

  // --- Sleep Timer Logic ---

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

  // --- UI Update Utilities ---

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

  function formatWarmthLabel(val) {
    if (val < 25) return 'Deep Rumble';
    if (val < 50) return 'Warm Umber';
    if (val < 75) return 'Mellow Brown';
    return 'Soft Brown';
  }

  // --- Media Session API ---

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Brown Noise',
      artist: 'Offline Ambient',
      album: 'Deep Warmth',
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

  // Warmth Slider
  warmthSlider.addEventListener('input', (e) => {
    warmth = parseInt(e.target.value, 10);
    warmthValue.textContent = formatWarmthLabel(warmth);
    updateSliderFill(warmthSlider);

    clearTimeout(warmthDebounceTimer);
    warmthDebounceTimer = setTimeout(applyWarmthUpdate, 180);
  });

  // Volume Slider
  volumeSlider.addEventListener('input', (e) => {
    volume = parseInt(e.target.value, 10);
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);
    applyVolumeUpdate();
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

  // Network Offline / Online status reflection
  window.addEventListener('online', () => {
    offlineBadge.title = 'Works 100% offline (Online)';
  });

  window.addEventListener('offline', () => {
    offlineBadge.title = 'Offline mode active';
  });

  // --- Initial Setup & Service Worker Registration ---

  function initializeApp() {
    // 1. Restore slider states
    warmthSlider.value = warmth;
    warmthValue.textContent = formatWarmthLabel(warmth);
    updateSliderFill(warmthSlider);

    volumeSlider.value = volume;
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);

    // 2. Restore timer chip
    timerChips.forEach((chip) => {
      const mins = parseInt(chip.getAttribute('data-minutes') || '0', 10);
      if (mins === timerMinutes) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
    timerCountdown.textContent = timerMinutes === 0 ? 'Continuous' : `${timerMinutes}m`;

    // 3. Synthesize initial brown noise audio buffer
    playbackStatus.textContent = 'Generating sound...';
    setTimeout(() => {
      const initialBlob = generateBrownNoiseWav(warmth, volume);
      activeBlobUrl = URL.createObjectURL(initialBlob);
      activeAudio.src = activeBlobUrl;
      activeAudio.loop = true;
      activeAudio.playsInline = true;
      if (isVolumeSupported) {
        activeAudio.volume = getTargetVolume();
      }
      playbackStatus.textContent = 'Ready to play';
    }, 10);

    // 4. Setup Media Session
    updateMediaSession();

    // 5. Register Service Worker
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

  // Launch!
  initializeApp();
})();
