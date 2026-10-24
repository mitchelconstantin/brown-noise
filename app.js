/**
 * Offline-First Brown Noise PWA
 * Multi-profile organic noise synthesis and background playback engine.
 */

(function () {
  'use strict';

  // --- Constants & Audio Configuration ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 30;  // 30-second high-fidelity seamless buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to settle filters before buffer start
  const CROSSFADE_SEC = 3.5;       // 3.5s equal-power crossfade for seamless looping
  const MIN_CUTOFF_HZ = 120;       // Deep Rumble lower cutoff
  const MAX_CUTOFF_HZ = 750;       // Mellow Brown upper cutoff (warm, zero shrill highs)
  const FADE_IN_SEC = 1.2;         // 1200ms smooth fade in
  const FADE_OUT_SEC = 1.0;        // 1000ms smooth fade out

  const STORAGE_KEYS = {
    WARMTH: 'brown_noise_warmth',
    VOLUME: 'brown_noise_volume',
    TIMER: 'brown_noise_timer',
    PROFILE: 'brown_noise_profile'
  };

  const PROFILES = {
    cabin: {
      name: 'Airplane Cabin',
      desc: 'Deep cruising jet cabin airflow. Loud & soothing on phone speakers.'
    },
    waterfall: {
      name: 'Dark Waterfall',
      desc: 'Dense, full-bodied roaring torrent. Maximum natural volume.'
    },
    downpour: {
      name: 'Warm Downpour',
      desc: 'Continuous gentle rain on a roof. Relaxing and mellow.'
    },
    ocean: {
      name: 'Ocean Surf',
      desc: 'Deep rolling ocean waves. Heavy, calming low-mid body.'
    },
    classic: {
      name: 'Pure Sub-Rumble',
      desc: 'Classic -6 dB/octave brown noise for deep sub-bass lovers.'
    }
  };

  // --- DOM Elements ---
  const playBtn = document.getElementById('playBtn');
  const iconPlay = document.getElementById('iconPlay');
  const iconStop = document.getElementById('iconStop');
  const visualizerContainer = document.getElementById('visualizerContainer');
  const playbackStatus = document.getElementById('playbackStatus');
  const profileChips = document.querySelectorAll('.profile-chip');
  const profileValue = document.getElementById('profileValue');
  const warmthSlider = document.getElementById('warmthSlider');
  const warmthValue = document.getElementById('warmthValue');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValue = document.getElementById('volumeValue');
  const timerCountdown = document.getElementById('timerCountdown');
  const timerChips = document.querySelectorAll('.timer-chip');
  const offlineBadge = document.getElementById('offlineBadge');

  // --- App State ---
  let isPlaying = false;
  let activeProfileKey = localStorage.getItem(STORAGE_KEYS.PROFILE) || 'cabin';
  let warmth = parseInt(localStorage.getItem(STORAGE_KEYS.WARMTH) || '50', 10);
  let volume = parseInt(localStorage.getItem(STORAGE_KEYS.VOLUME) || '85', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;

  // Cache for synthesized AudioBuffers so switching is instant
  const bufferCache = new Map();

  // --- Audio Engine Components ---
  let audioCtx = null;
  let currentSourceNode = null;
  let filterNode = null;
  let gainNode = null;
  let streamAudioEl = null;

  /**
   * Maps 0-100 warmth slider to cutoff frequency (120 Hz to 750 Hz).
   * Capped to avoid any shrill frequencies.
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
   * Generates organic multi-pole noise textures without synthetic distortion.
   * Profiles like Cabin, Waterfall, and Downpour possess natural acoustic energy
   * in the 250 Hz - 750 Hz zone where smartphone speakers naturally resonate.
   */
  function synthesizeProfileBuffer(profileKey, targetCtx) {
    if (bufferCache.has(profileKey)) {
      return bufferCache.get(profileKey);
    }

    const warmupSamples = Math.floor(SAMPLE_RATE * WARMUP_SEC);
    const nSamples = Math.floor(SAMPLE_RATE * BUFFER_DURATION_SEC);
    const crossfadeSamples = Math.floor(SAMPLE_RATE * CROSSFADE_SEC);
    const totalGen = warmupSamples + nSamples + crossfadeSamples;

    const left = new Float32Array(totalGen);
    const right = new Float32Array(totalGen);

    let l0 = 0, l1 = 0, l2 = 0;
    let r0 = 0, r1 = 0, r2 = 0;

    for (let i = 0; i < totalGen; i++) {
      const wL = Math.random() * 2 - 1;
      const wR = Math.random() * 2 - 1;

      let sL = 0;
      let sR = 0;

      if (profileKey === 'cabin') {
        // Airplane Cabin: Multi-pole acoustic airflow (-4.2 dB/oct slope)
        // Naturally very loud and soothing on smartphone speakers without harshness
        l0 = 0.992 * l0 + wL * 0.052;
        l1 = 0.965 * l1 + wL * 0.038;
        l2 = 0.880 * l2 + wL * 0.022;
        sL = l0 + l1 + l2;

        r0 = 0.992 * r0 + wR * 0.052;
        r1 = 0.965 * r1 + wR * 0.038;
        r2 = 0.880 * r2 + wR * 0.022;
        sR = r0 + r1 + r2;
      } else if (profileKey === 'waterfall') {
        // Dark Waterfall: Dense, full-bodied roaring torrent (-4.6 dB/oct slope)
        l0 = 0.997 * l0 + wL * 0.058;
        l1 = 0.960 * l1 + wL * 0.034;
        l2 = 0.820 * l2 + wL * 0.018;
        sL = l0 + l1 + l2;

        r0 = 0.997 * r0 + wR * 0.058;
        r1 = 0.960 * r1 + wR * 0.034;
        r2 = 0.820 * r2 + wR * 0.018;
        sR = r0 + r1 + r2;
      } else if (profileKey === 'downpour') {
        // Warm Downpour: Gentle heavy rain on a roof (280 Hz - 700 Hz warmth)
        l0 = 0.985 * l0 + wL * 0.046;
        l1 = 0.940 * l1 + wL * 0.038;
        l2 = 0.780 * l2 + wL * 0.026;
        sL = l0 + l1 + l2;

        r0 = 0.985 * r0 + wR * 0.046;
        r1 = 0.940 * r1 + wR * 0.038;
        r2 = 0.780 * r2 + wR * 0.026;
        sR = r0 + r1 + r2;
      } else if (profileKey === 'ocean') {
        // Deep Ocean Surf: Rolling low-mid waves (180 Hz - 500 Hz)
        l0 = 0.998 * l0 + wL * 0.045;
        l1 = 0.975 * l1 + wL * 0.028;
        l2 = 0.910 * l2 + wL * 0.015;
        sL = l0 + l1 + l2;

        r0 = 0.998 * r0 + wR * 0.045;
        r1 = 0.975 * r1 + wR * 0.028;
        r2 = 0.910 * r2 + wR * 0.015;
        sR = r0 + r1 + r2;
      } else {
        // Pure Sub-Rumble: Classic brown noise (-6 dB/octave leaky integration)
        l0 = (l0 + 0.025 * wL) / 1.02;
        sL = l0;
        r0 = (r0 + 0.025 * wR) / 1.02;
        sR = r0;
      }

      left[i] = sL;
      right[i] = sR;
    }

    // 1. High-pass DC-blocker (25 Hz)
    const dt = 1 / SAMPLE_RATE;
    const rc = 1 / (2 * Math.PI * 25);
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

    // 2. Extract steady-state window (after 2s warmup)
    const outL = new Float32Array(nSamples);
    const outR = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      outL[i] = left[i + warmupSamples];
      outR[i] = right[i + warmupSamples];
    }

    // 3. Equal-power tail crossfade for zero-seam looping
    const tailOffset = warmupSamples + nSamples;
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const wTail = Math.cos(0.5 * Math.PI * t);
      const wHead = Math.sin(0.5 * Math.PI * t);
      outL[i] = left[tailOffset + i] * wTail + left[i] * wHead;
      outR[i] = right[tailOffset + i] * wTail + right[i] * wHead;
    }

    // 4. Natural RMS Loudness Normalization (~ -10 dBFS)
    let sumSq = 0;
    for (let i = 0; i < nSamples; i++) {
      sumSq += outL[i] * outL[i] + outR[i] * outR[i];
    }
    const currentRms = Math.sqrt(sumSq / (2 * nSamples));
    const targetGain = 0.32 / (currentRms || 0.1);

    for (let i = 0; i < nSamples; i++) {
      outL[i] = Math.tanh(outL[i] * targetGain);
      outR[i] = Math.tanh(outR[i] * targetGain);
    }

    const audioBuffer = targetCtx.createBuffer(2, nSamples, SAMPLE_RATE);
    audioBuffer.copyToChannel(outL, 0);
    audioBuffer.copyToChannel(outR, 1);

    bufferCache.set(profileKey, audioBuffer);
    return audioBuffer;
  }

  // --- Audio Pipeline Setup ---

  function ensureAudioPipeline() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }

    // 1. Low-pass tone shaping filter (120 Hz to 750 Hz)
    if (!filterNode) {
      filterNode = audioCtx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.setValueAtTime(warmthToCutoff(warmth), audioCtx.currentTime);
      filterNode.Q.setValueAtTime(0.707, audioCtx.currentTime);
    }

    // 2. Master Gain Node
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

      filterNode.connect(gainNode);

      // Hardware output
      gainNode.connect(audioCtx.destination);

      // MediaStream bridge to <audio> tag for iOS lock-screen background audio
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

  function getTargetVolumeGain() {
    return Math.max(0.001, (volume / 100) * 1.5);
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

    const buffer = synthesizeProfileBuffer(activeProfileKey, audioCtx);

    currentSourceNode = audioCtx.createBufferSource();
    currentSourceNode.buffer = buffer;
    currentSourceNode.loop = true; // Hardware/DSP gapless sample-accurate loop
    currentSourceNode.connect(filterNode);
    currentSourceNode.start(0);

    if (streamAudioEl) {
      streamAudioEl.play().catch(() => {});
    }

    // Smooth studio fade-in
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

    // Smooth studio fade-out
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT_SEC);

    setTimeout(() => {
      if (!isPlaying && currentSourceNode) {
        try {
          currentSourceNode.stop();
          currentSourceNode.disconnect();
          currentSourceNode = null;
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

  // --- Profile Switching with Smooth Crossfade ---

  function selectProfile(profileKey) {
    if (activeProfileKey === profileKey && currentSourceNode) return;

    activeProfileKey = profileKey;
    localStorage.setItem(STORAGE_KEYS.PROFILE, profileKey);

    profileChips.forEach((chip) => {
      if (chip.getAttribute('data-profile') === profileKey) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    const prof = PROFILES[profileKey] || PROFILES.cabin;
    profileValue.textContent = prof.name;

    if (!isPlaying) return;

    // Smooth real-time crossfade to new profile
    ensureAudioPipeline();
    const newBuffer = synthesizeProfileBuffer(profileKey, audioCtx);

    const oldSource = currentSourceNode;
    const newSource = audioCtx.createBufferSource();
    newSource.buffer = newBuffer;
    newSource.loop = true;

    // Create temporary gain node for new source
    const crossGain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    crossGain.gain.setValueAtTime(0.0001, now);
    crossGain.gain.linearRampToValueAtTime(1.0, now + 0.35);

    newSource.connect(crossGain);
    crossGain.connect(filterNode);
    newSource.start(0);

    currentSourceNode = newSource;

    // Fade out and disconnect old source
    if (oldSource) {
      setTimeout(() => {
        try {
          oldSource.stop();
          oldSource.disconnect();
        } catch (e) {}
      }, 400);
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

    const prof = PROFILES[activeProfileKey] || PROFILES.cabin;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${prof.name} - Brown Noise`,
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

  // Profile Chips
  profileChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.getAttribute('data-profile');
      if (key) selectProfile(key);
    });
  });

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
    // 1. Restore Profile
    if (!PROFILES[activeProfileKey]) activeProfileKey = 'cabin';
    profileChips.forEach((chip) => {
      if (chip.getAttribute('data-profile') === activeProfileKey) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
    profileValue.textContent = (PROFILES[activeProfileKey] || PROFILES.cabin).name;

    // 2. Restore Sliders
    warmthSlider.value = warmth;
    warmthValue.textContent = formatWarmthLabel(warmth);
    updateSliderFill(warmthSlider);

    volumeSlider.value = volume;
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);

    // 3. Restore Timer
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
