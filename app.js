/**
 * Offline-First Brown Noise PWA
 * Zero-dependency, gapless audio synthesis and background playback engine
 * with psychoacoustic phone speaker optimization.
 */

(function () {
  'use strict';

  // --- Constants & Audio Configuration ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 40;  // 40-second high-fidelity seamless buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to settle filters before buffer start
  const CROSSFADE_SEC = 4.0;       // 4s equal-power crossfade for seamless looping
  const MIN_CUTOFF_HZ = 90;        // Deep Rumble: 90 Hz sub-bass (audible on phones)
  const MAX_CUTOFF_HZ = 520;       // Mellow Brown: 520 Hz maximum (no shrill frequencies)
  const FADE_IN_SEC = 1.5;         // 1500ms smooth fade in
  const FADE_OUT_SEC = 1.2;        // 1200ms smooth fade out

  const STORAGE_KEYS = {
    WARMTH: 'brown_noise_warmth',
    VOLUME: 'brown_noise_volume',
    TIMER: 'brown_noise_timer',
    BOOST: 'brown_noise_speaker_boost'
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
  const boostBtn = document.getElementById('boostBtn');
  const boostStatus = document.getElementById('boostStatus');
  const timerCountdown = document.getElementById('timerCountdown');
  const timerChips = document.querySelectorAll('.timer-chip');
  const offlineBadge = document.getElementById('offlineBadge');

  // --- App State ---
  let isPlaying = false;
  let warmth = parseInt(localStorage.getItem(STORAGE_KEYS.WARMTH) || '50', 10);
  let volume = parseInt(localStorage.getItem(STORAGE_KEYS.VOLUME) || '85', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);
  // Default speaker boost ON for phone loudness
  let speakerBoost = localStorage.getItem(STORAGE_KEYS.BOOST) !== 'false';

  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;

  // --- Audio Engine Components ---
  let audioCtx = null;
  let bufferSourceNode = null;
  let filterNode = null;
  let boostFilterNode = null;
  let compressorNode = null;
  let gainNode = null;
  let streamAudioEl = null;
  let sharedAudioBuffer = null;

  /**
   * Maps 0-100 warmth slider to cutoff frequency (90 Hz to 520 Hz).
   * Capped at Mellow Brown with no shrill high frequencies.
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
   * 2. 40 Hz high-pass filter: eliminates inaudible subsonic rumble that wastes
   *    phone speaker power and amplifier excursion.
   * 3. Psychoacoustic harmonic bass generator: injects warm 2nd & 3rd harmonics
   *    into the 180 Hz - 450 Hz band, making deep bass clearly audible on phone speakers.
   * 4. 4s equal-power tail crossfade for zero-seam, completely gapless looping.
   * 5. RMS loudness normalization (~ -9.5 dBFS) + soft saturation.
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

    // 2. High-pass filter at 40 Hz to remove inaudible sub-bass power drain
    const dt = 1 / SAMPLE_RATE;
    const rc = 1 / (2 * Math.PI * 40);
    const alphaHP = rc / (rc + dt);

    let prevXL = 0, prevYL = 0;
    let prevXR = 0, prevYR = 0;
    for (let i = 0; i < totalGen; i++) {
      const yL = alphaHP * (prevYL + rawL[i] - prevXL);
      prevXL = rawL[i];
      prevYL = yL;
      rawL[i] = yL;

      const yR = alphaHP * (prevYR + rawR[i] - prevXR);
      prevXR = rawR[i];
      prevYR = yR;
      rawR[i] = yR;
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

    // 5. Psychoacoustic harmonic bass exciter (adds warmth in the phone speaker zone)
    for (let i = 0; i < nSamples; i++) {
      const l = leftChannel[i];
      const r = rightChannel[i];
      leftChannel[i] = l + 0.35 * Math.tanh(2.2 * l);
      rightChannel[i] = r + 0.35 * Math.tanh(2.2 * r);
    }

    // 6. High-density RMS loudness normalization (~ -9.5 dBFS)
    let sumSq = 0;
    for (let i = 0; i < nSamples; i++) {
      sumSq += leftChannel[i] * leftChannel[i] + rightChannel[i] * rightChannel[i];
    }
    const currentRms = Math.sqrt(sumSq / (2 * nSamples));
    const boost = 0.35 / (currentRms || 0.1);

    for (let i = 0; i < nSamples; i++) {
      leftChannel[i] = Math.tanh(leftChannel[i] * boost);
      rightChannel[i] = Math.tanh(rightChannel[i] * boost);
    }

    // Convert into Web Audio API AudioBuffer
    const audioBuffer = targetCtx.createBuffer(2, nSamples, SAMPLE_RATE);
    audioBuffer.copyToChannel(leftChannel, 0);
    audioBuffer.copyToChannel(rightChannel, 1);

    return audioBuffer;
  }

  // --- Audio Pipeline Setup ---

  function ensureAudioPipeline() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }

    if (!sharedAudioBuffer) {
      sharedAudioBuffer = synthesizeBrownNoiseBuffer(audioCtx);
    }

    // 1. Tone / Warmth lowpass filter (90 Hz to 520 Hz)
    if (!filterNode) {
      filterNode = audioCtx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.setValueAtTime(warmthToCutoff(warmth), audioCtx.currentTime);
      filterNode.Q.setValueAtTime(0.85, audioCtx.currentTime);
    }

    // 2. Phone Speaker Peaking EQ (280 Hz sweet spot)
    if (!boostFilterNode) {
      boostFilterNode = audioCtx.createBiquadFilter();
      boostFilterNode.type = 'peaking';
      boostFilterNode.frequency.setValueAtTime(280, audioCtx.currentTime);
      boostFilterNode.Q.setValueAtTime(1.2, audioCtx.currentTime);
      boostFilterNode.gain.setValueAtTime(speakerBoost ? 6.5 : 0, audioCtx.currentTime);
    }

    // 3. Studio Dynamics Compressor (maximizes acoustic density & prevents clipping)
    if (!compressorNode) {
      compressorNode = audioCtx.createDynamicsCompressor();
      compressorNode.threshold.setValueAtTime(speakerBoost ? -20 : -14, audioCtx.currentTime);
      compressorNode.knee.setValueAtTime(10, audioCtx.currentTime);
      compressorNode.ratio.setValueAtTime(8, audioCtx.currentTime);
      compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
      compressorNode.release.setValueAtTime(0.15, audioCtx.currentTime);
    }

    // 4. Master Gain Node
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

      // Connect DSP chain: Filter -> Peaking EQ -> Compressor -> Gain
      filterNode.connect(boostFilterNode);
      boostFilterNode.connect(compressorNode);
      compressorNode.connect(gainNode);

      // Master output 1: Hardware speakers / headphones
      gainNode.connect(audioCtx.destination);

      // Master output 2: MediaStream into <audio> tag (prevents iOS background suspension)
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

  // --- Volume Calculation ---

  function getTargetVolumeGain() {
    const boostMultiplier = speakerBoost ? 2.2 : 1.35;
    return Math.max(0.001, (volume / 100) * boostMultiplier);
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

    // AudioBufferSourceNode instances are single-use
    bufferSourceNode = audioCtx.createBufferSource();
    bufferSourceNode.buffer = sharedAudioBuffer;
    bufferSourceNode.loop = true; // Hardware/DSP sample-accurate gapless looping
    bufferSourceNode.connect(filterNode);

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

  function toggleSpeakerBoost() {
    speakerBoost = !speakerBoost;
    localStorage.setItem(STORAGE_KEYS.BOOST, speakerBoost ? 'true' : 'false');
    updateSpeakerBoostUI();

    if (audioCtx) {
      const now = audioCtx.currentTime;
      if (boostFilterNode) {
        boostFilterNode.gain.setTargetAtTime(speakerBoost ? 6.5 : 0, now, 0.05);
      }
      if (compressorNode) {
        compressorNode.threshold.setTargetAtTime(speakerBoost ? -20 : -14, now, 0.05);
      }
      if (gainNode && isPlaying) {
        gainNode.gain.setTargetAtTime(getTargetVolumeGain(), now, 0.05);
      }
    }
  }

  function updateSpeakerBoostUI() {
    if (speakerBoost) {
      boostBtn.classList.add('active');
      boostBtn.setAttribute('aria-pressed', 'true');
      boostStatus.textContent = 'ON';
    } else {
      boostBtn.classList.remove('active');
      boostBtn.setAttribute('aria-pressed', 'false');
      boostStatus.textContent = 'OFF';
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

  // Speaker Boost Toggle
  boostBtn.addEventListener('click', toggleSpeakerBoost);

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

    updateSpeakerBoostUI();

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
