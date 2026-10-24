/**
 * Offline-First Brown Noise PWA
 * Zero-dependency, gapless audio synthesis and background playback engine.
 */

(function () {
  'use strict';

  // --- Constants & Audio Configuration ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 40;  // 40-second high-fidelity seamless buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to settle filters before buffer start
  const CROSSFADE_SEC = 4.0;       // 4s equal-power crossfade for seamless looping
  const MIN_CUTOFF_HZ = 65;        // Deep Rumble: 65 Hz sub-bass
  const MAX_CUTOFF_HZ = 500;       // Mellow Brown: 500 Hz maximum (no shrill frequencies)
  const FADE_IN_SEC = 1.5;         // 1500ms smooth fade in
  const FADE_OUT_SEC = 1.2;        // 1200ms smooth fade out

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
  const fallbackAudio = document.getElementById('audioA');

  // --- App State ---
  let isPlaying = false;
  let warmth = parseInt(localStorage.getItem(STORAGE_KEYS.WARMTH) || '50', 10);
  let volume = parseInt(localStorage.getItem(STORAGE_KEYS.VOLUME) || '80', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;

  // --- Audio Engine Components ---
  let audioCtx = null;
  let bufferSourceNode = null;
  let filterNode = null;
  let gainNode = null;
  let streamAudioEl = null;
  let sharedAudioBuffer = null;
  let fallbackBlobUrl = null;

  /**
   * Maps 0-100 warmth slider to cutoff frequency (65 Hz to 500 Hz).
   * Caps out at Mellow Brown with no shrill high-frequencies.
   */
  function warmthToCutoff(val) {
    const clamped = Math.max(0, Math.min(100, val));
    return MIN_CUTOFF_HZ * Math.pow(MAX_CUTOFF_HZ / MIN_CUTOFF_HZ, clamped / 100);
  }

  function formatWarmthLabel(val) {
    if (val < 35) return 'Deep Rumble';
    if (val < 70) return 'Warm Umber';
    return 'Mellow Brown';
  }

  /**
   * Procedural Audio Synthesis:
   * Generates a 40-second stereo brown noise buffer with:
   * 1. 2s warmup to stabilize leaky integration & DC blocker.
   * 2. High-pass DC blocker (15 Hz) preventing baseline wander.
   * 3. 4s equal-power crossfade for completely seamless, gapless looping.
   * 4. RMS loudness normalization (~ -12 dBFS) + soft saturation for rich, full, loud sound.
   */
  function synthesizeBrownNoiseBuffer(targetCtx) {
    const warmupSamples = Math.floor(SAMPLE_RATE * WARMUP_SEC);
    const nSamples = Math.floor(SAMPLE_RATE * BUFFER_DURATION_SEC);
    const crossfadeSamples = Math.floor(SAMPLE_RATE * CROSSFADE_SEC);
    const totalGen = warmupSamples + nSamples + crossfadeSamples;

    const rawL = new Float32Array(totalGen);
    const rawR = new Float32Array(totalGen);

    // 1. Brown noise leaky integration
    let lastL = 0;
    let lastR = 0;
    for (let i = 0; i < totalGen; i++) {
      lastL = (lastL + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      lastR = (lastR + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      rawL[i] = lastL;
      rawR[i] = lastR;
    }

    // 2. DC-blocking filter (15 Hz) to eliminate baseline wander
    const R = 0.998;
    let dcL = 0, prevXL = 0;
    let dcR = 0, prevXR = 0;
    for (let i = 0; i < totalGen; i++) {
      const xL = rawL[i];
      dcL = xL - prevXL + R * dcL;
      prevXL = xL;
      rawL[i] = dcL;

      const xR = rawR[i];
      dcR = xR - prevXR + R * dcR;
      prevXR = xR;
      rawR[i] = dcR;
    }

    // 3. Extract steady-state portion
    const leftChannel = new Float32Array(nSamples);
    const rightChannel = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      leftChannel[i] = rawL[i + warmupSamples];
      rightChannel[i] = rawR[i + warmupSamples];
    }

    // 4. Equal-power tail crossfade for zero-seam looping
    const tailOffset = warmupSamples + nSamples;
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const wTail = Math.cos(0.5 * Math.PI * t);
      const wHead = Math.sin(0.5 * Math.PI * t);
      leftChannel[i] = rawL[tailOffset + i] * wTail + leftChannel[i] * wHead;
      rightChannel[i] = rawR[tailOffset + i] * wTail + rightChannel[i] * wHead;
    }

    // 5. RMS Loudness Normalization + Transparent Soft Saturation
    let sumSq = 0;
    for (let i = 0; i < nSamples; i++) {
      sumSq += leftChannel[i] * leftChannel[i] + rightChannel[i] * rightChannel[i];
    }
    const currentRms = Math.sqrt(sumSq / (2 * nSamples));

    // Target RMS ~0.26 (-12 dBFS RMS) for studio loud, rich presence
    const boost = 0.26 / (currentRms || 0.1);
    for (let i = 0; i < nSamples; i++) {
      leftChannel[i] = Math.tanh(leftChannel[i] * boost);
      rightChannel[i] = Math.tanh(rightChannel[i] * boost);
    }

    // Convert into Web Audio API AudioBuffer
    const audioBuffer = targetCtx.createBuffer(2, nSamples, SAMPLE_RATE);
    audioBuffer.copyToChannel(leftChannel, 0);
    audioBuffer.copyToChannel(rightChannel, 1);

    return { audioBuffer, leftChannel, rightChannel, nSamples };
  }

  /**
   * Generates a 16-bit PCM WAV Blob as a secondary fallback.
   */
  function encodeWavBlob(left, right, numSamples) {
    const pcmBytes = numSamples * 2 * 2;
    const buffer = new ArrayBuffer(44 + pcmBytes);
    const view = new DataView(buffer);

    view.setUint32(0, 0x52494646, false); // RIFF
    view.setUint32(4, 36 + pcmBytes, true);
    view.setUint32(8, 0x57415645, false); // WAVE
    view.setUint32(12, 0x666d7420, false); // fmt
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 2, true); // Stereo
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false); // data
    view.setUint32(40, pcmBytes, true);

    const pcm = new Int16Array(buffer, 44, numSamples * 2);
    let idx = 0;
    for (let i = 0; i < numSamples; i++) {
      pcm[idx++] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
      pcm[idx++] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // --- Audio Pipeline Setup ---

  function ensureAudioPipeline() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }

    if (!sharedAudioBuffer) {
      const synth = synthesizeBrownNoiseBuffer(audioCtx);
      sharedAudioBuffer = synth.audioBuffer;

      // Prepare fallback WAV Blob
      try {
        const blob = encodeWavBlob(synth.leftChannel, synth.rightChannel, synth.nSamples);
        if (fallbackBlobUrl) URL.revokeObjectURL(fallbackBlobUrl);
        fallbackBlobUrl = URL.createObjectURL(blob);
      } catch (e) {
        console.warn('Fallback WAV generation skipped:', e);
      }
    }

    if (!filterNode) {
      filterNode = audioCtx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.setValueAtTime(warmthToCutoff(warmth), audioCtx.currentTime);
      filterNode.Q.setValueAtTime(0.707, audioCtx.currentTime);
    }

    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

      // 1. Direct hardware output
      gainNode.connect(audioCtx.destination);

      // 2. Route to MediaStream destination -> HTML5 <audio> tag
      // This is the key trick that prevents iOS Safari from suspending background playback
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
          console.warn('MediaStreamDestination not supported:', err);
        }
      }
    }
  }

  // --- Playback Control ---

  function getTargetVolumeGain() {
    // Generous, loud, full-bodied gain curve
    return Math.max(0.001, (volume / 100) * 1.25);
  }

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

    // Create a new buffer source node (AudioBufferSourceNode instances are single-use)
    bufferSourceNode = audioCtx.createBufferSource();
    bufferSourceNode.buffer = sharedAudioBuffer;
    bufferSourceNode.loop = true; // Hardware/DSP sample-accurate gapless looping
    bufferSourceNode.connect(filterNode);
    filterNode.connect(gainNode);

    bufferSourceNode.start(0);

    if (streamAudioEl) {
      streamAudioEl.play().catch(() => {});
    }

    // Smooth studio fade-in (1500ms)
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(getTargetVolumeGain(), now + FADE_IN_SEC);

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

    // Smooth studio fade-out (1200ms)
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT_SEC);

    setTimeout(() => {
      if (!isPlaying && bufferSourceNode) {
        try {
          bufferSourceNode.stop();
          bufferSourceNode.disconnect();
          bufferSourceNode = null;
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

  // --- Real-Time Controls ---

  function onWarmthChange() {
    localStorage.setItem(STORAGE_KEYS.WARMTH, warmth.toString());
    const cutoff = warmthToCutoff(warmth);

    if (audioCtx && filterNode) {
      // Instant, smooth parameter ramping without audio glitches
      filterNode.frequency.setTargetAtTime(cutoff, audioCtx.currentTime, 0.04);
    }
  }

  function onVolumeChange() {
    localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());

    if (audioCtx && gainNode && isPlaying) {
      const targetGain = getTargetVolumeGain();
      gainNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.03);
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

  // --- UI Utilities ---

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
    onWarmthChange();
  });

  // Volume Slider
  volumeSlider.addEventListener('input', (e) => {
    volume = parseInt(e.target.value, 10);
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);
    onVolumeChange();
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
    warmthSlider.value = warmth;
    warmthValue.textContent = formatWarmthLabel(warmth);
    updateSliderFill(warmthSlider);

    volumeSlider.value = volume;
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);

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
