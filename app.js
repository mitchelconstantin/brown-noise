/**
 * Offline-First Brown Noise PWA
 * Real-time sound sculpting engine for mobile speaker tuning.
 * Pure Gaussian synthesis with zero scratchiness or artificial distortion.
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION_SEC = 25;  // 25-second seamless buffer
  const WARMUP_SEC = 2.0;          // 2s warmup to stabilize leaky integration
  const CROSSFADE_SEC = 3.0;       // 3s equal-power crossfade for seamless looping
  const FADE_IN_SEC = 1.0;
  const FADE_OUT_SEC = 0.8;

  const STORAGE_KEYS = {
    CUTOFF: 'bn_sculpt_cutoff',
    SLOPE: 'bn_sculpt_slope',
    LOW: 'bn_sculpt_low',
    MID: 'bn_sculpt_mid',
    VOLUME: 'bn_sculpt_volume',
    TIMER: 'bn_sculpt_timer'
  };

  // --- DOM Elements ---
  const playBtn = document.getElementById('playBtn');
  const iconPlay = document.getElementById('iconPlay');
  const iconStop = document.getElementById('iconStop');
  const visualizerContainer = document.getElementById('visualizerContainer');
  const playbackStatus = document.getElementById('playbackStatus');

  const cutoffSlider = document.getElementById('cutoffSlider');
  const cutoffValue = document.getElementById('cutoffValue');
  const slopeSlider = document.getElementById('slopeSlider');
  const slopeValue = document.getElementById('slopeValue');
  const lowRumbleSlider = document.getElementById('lowRumbleSlider');
  const lowRumbleValue = document.getElementById('lowRumbleValue');
  const midBodySlider = document.getElementById('midBodySlider');
  const midBodyValue = document.getElementById('midBodyValue');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValue = document.getElementById('volumeValue');

  const configDisplay = document.getElementById('configDisplay');
  const copyConfigBtn = document.getElementById('copyConfigBtn');
  const copyBtnText = document.getElementById('copyBtnText');

  const timerCountdown = document.getElementById('timerCountdown');
  const timerChips = document.querySelectorAll('.timer-chip');
  const offlineBadge = document.getElementById('offlineBadge');

  // --- App State ---
  let isPlaying = false;
  let cutoff = parseInt(localStorage.getItem(STORAGE_KEYS.CUTOFF) || '450', 10);
  let slope = parseInt(localStorage.getItem(STORAGE_KEYS.SLOPE) || '2', 10);
  let lowRumble = parseInt(localStorage.getItem(STORAGE_KEYS.LOW) || '2', 10);
  let midBody = parseInt(localStorage.getItem(STORAGE_KEYS.MID) || '6', 10);
  let volume = parseInt(localStorage.getItem(STORAGE_KEYS.VOLUME) || '85', 10);
  let timerMinutes = parseInt(localStorage.getItem(STORAGE_KEYS.TIMER) || '0', 10);

  let sleepTimerInterval = null;
  let sleepTimerEndTime = null;

  // --- Audio Engine Nodes ---
  let audioCtx = null;
  let sourceNode = null;
  let lpFilter1 = null;
  let lpFilter2 = null;
  let lowShelfFilter = null;
  let midPeakingFilter = null;
  let gainNode = null;
  let streamAudioEl = null;
  let cachedAudioBuffer = null;

  /**
   * Generates pure Gaussian random variable via Box-Muller transform.
   * Completely eliminates the harsh scratchy grit of pseudo-random white noise.
   */
  function gaussianRandom() {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Procedural Audio Buffer Synthesis:
   * 1. Generates pure Gaussian brown noise with leaky integration.
   * 2. DC-blocks baseline wander.
   * 3. 3s equal-power crossfade for sample-accurate gapless looping.
   * 4. NO non-linear saturation or distortion is applied (preserving silky smoothness).
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

    // Seamless loop crossfade
    const tailOffset = warmupSamples + nSamples;
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const wTail = Math.cos(0.5 * Math.PI * t);
      const wHead = Math.sin(0.5 * Math.PI * t);
      outL[i] = left[tailOffset + i] * wTail + left[i] * wHead;
      outR[i] = right[tailOffset + i] * wTail + right[i] * wHead;
    }

    // Clean linear normalization (no distortion clipping)
    let maxPeak = 0;
    for (let i = 0; i < nSamples; i++) {
      const aL = Math.abs(outL[i]);
      const aR = Math.abs(outR[i]);
      if (aL > maxPeak) maxPeak = aL;
      if (aR > maxPeak) maxPeak = aR;
    }
    const scale = maxPeak > 0 ? 0.90 / maxPeak : 1.0;
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

    // 2. Secondary Low-pass filter (controls Slope / Steepness)
    if (!lpFilter2) {
      lpFilter2 = audioCtx.createBiquadFilter();
      lpFilter2.type = 'lowpass';
      lpFilter2.frequency.setValueAtTime(cutoff, audioCtx.currentTime);
      lpFilter2.Q.setValueAtTime(0.707, audioCtx.currentTime);
    }

    // 3. Low-Shelf Filter (Low Rumble 140 Hz)
    if (!lowShelfFilter) {
      lowShelfFilter = audioCtx.createBiquadFilter();
      lowShelfFilter.type = 'lowshelf';
      lowShelfFilter.frequency.setValueAtTime(140, audioCtx.currentTime);
      lowShelfFilter.gain.setValueAtTime(lowRumble, audioCtx.currentTime);
    }

    // 4. Peaking Mid Filter (Phone Loudness Sweet-spot 450 Hz)
    if (!midPeakingFilter) {
      midPeakingFilter = audioCtx.createBiquadFilter();
      midPeakingFilter.type = 'peaking';
      midPeakingFilter.frequency.setValueAtTime(450, audioCtx.currentTime);
      midPeakingFilter.Q.setValueAtTime(1.1, audioCtx.currentTime);
      midPeakingFilter.gain.setValueAtTime(midBody, audioCtx.currentTime);
    }

    // 5. Master Gain
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

      // Connect filter chain: lpFilter1 -> lpFilter2 -> lowShelf -> midPeaking -> gain
      lpFilter1.connect(lpFilter2);
      lpFilter2.connect(lowShelfFilter);
      lowShelfFilter.connect(midPeakingFilter);
      midPeakingFilter.connect(gainNode);

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

    // Apply cutoff to filter 1
    if (lpFilter1) {
      lpFilter1.frequency.setTargetAtTime(cutoff, now, 0.03);
    }

    // Slope calculation:
    // slope 1: second filter wide open (bypassed)
    // slope 2: second filter tracks cutoff (12 dB/oct)
    // slope 3: second filter tighter (18 dB/oct)
    // slope 4: high resonance / 24 dB/oct steep
    if (lpFilter2) {
      if (slope === 1) {
        lpFilter2.frequency.setTargetAtTime(18000, now, 0.03);
      } else if (slope === 2) {
        lpFilter2.frequency.setTargetAtTime(cutoff * 1.3, now, 0.03);
      } else if (slope === 3) {
        lpFilter2.frequency.setTargetAtTime(cutoff, now, 0.03);
      } else {
        lpFilter2.frequency.setTargetAtTime(cutoff * 0.85, now, 0.03);
      }
    }

    // Low rumble gain
    if (lowShelfFilter) {
      lowShelfFilter.gain.setTargetAtTime(lowRumble, now, 0.03);
    }

    // Mid body gain
    if (midPeakingFilter) {
      midPeakingFilter.gain.setTargetAtTime(midBody, now, 0.03);
    }
  }

  function getTargetVolumeGain() {
    return Math.max(0.001, (volume / 100) * 1.6);
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
    sourceNode.loop = true; // Hardware sample-accurate seamless looping
    sourceNode.connect(lpFilter1);
    sourceNode.start(0);

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

  // --- Real-time Parameter Updates ---

  function formatSlopeText(val) {
    if (val === 1) return '1x (Gentle / 6dB)';
    if (val === 2) return '2x (Balanced / 12dB)';
    if (val === 3) return '3x (Deep / 18dB)';
    return '4x (Steep / 24dB)';
  }

  function formatDb(val) {
    return (val > 0 ? `+${val}` : `${val}`) + ' dB';
  }

  function updateConfigString() {
    const configStr = `Cutoff: ${cutoff}Hz | Slope: ${slope}x | Low: ${formatDb(lowRumble)} | Mid: ${formatDb(midBody)} | Vol: ${volume}%`;
    configDisplay.textContent = configStr;
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

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Brown Noise Studio',
      artist: 'Offline Ambient',
      album: 'Custom Tone',
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

  // 1. Cutoff
  cutoffSlider.addEventListener('input', (e) => {
    cutoff = parseInt(e.target.value, 10);
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);
    updateConfigString();
    localStorage.setItem(STORAGE_KEYS.CUTOFF, cutoff.toString());
    applyFilterParameters();
  });

  // 2. Slope
  slopeSlider.addEventListener('input', (e) => {
    slope = parseInt(e.target.value, 10);
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);
    updateConfigString();
    localStorage.setItem(STORAGE_KEYS.SLOPE, slope.toString());
    applyFilterParameters();
  });

  // 3. Low Rumble
  lowRumbleSlider.addEventListener('input', (e) => {
    lowRumble = parseInt(e.target.value, 10);
    lowRumbleValue.textContent = formatDb(lowRumble);
    updateSliderFill(lowRumbleSlider);
    updateConfigString();
    localStorage.setItem(STORAGE_KEYS.LOW, lowRumble.toString());
    applyFilterParameters();
  });

  // 4. Mid Body
  midBodySlider.addEventListener('input', (e) => {
    midBody = parseInt(e.target.value, 10);
    midBodyValue.textContent = formatDb(midBody);
    updateSliderFill(midBodySlider);
    updateConfigString();
    localStorage.setItem(STORAGE_KEYS.MID, midBody.toString());
    applyFilterParameters();
  });

  // 5. Volume
  volumeSlider.addEventListener('input', (e) => {
    volume = parseInt(e.target.value, 10);
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);
    updateConfigString();
    localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
    if (audioCtx && gainNode && isPlaying) {
      gainNode.gain.setTargetAtTime(getTargetVolumeGain(), audioCtx.currentTime, 0.03);
    }
  });

  // Copy Configuration Button
  copyConfigBtn.addEventListener('click', () => {
    const textToCopy = configDisplay.textContent.trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        copyBtnText.textContent = 'Copied to Clipboard!';
        setTimeout(() => {
          copyBtnText.textContent = 'Copy Configuration';
        }, 2200);
      }).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }

    function fallbackCopy() {
      const textarea = document.createElement('textarea');
      textarea.value = textToCopy;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copyBtnText.textContent = 'Copied!';
      setTimeout(() => {
        copyBtnText.textContent = 'Copy Configuration';
      }, 2200);
    }
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
    // 1. Restore Sliders
    cutoffSlider.value = cutoff;
    cutoffValue.textContent = `${cutoff} Hz`;
    updateSliderFill(cutoffSlider);

    slopeSlider.value = slope;
    slopeValue.textContent = formatSlopeText(slope);
    updateSliderFill(slopeSlider);

    lowRumbleSlider.value = lowRumble;
    lowRumbleValue.textContent = formatDb(lowRumble);
    updateSliderFill(lowRumbleSlider);

    midBodySlider.value = midBody;
    midBodyValue.textContent = formatDb(midBody);
    updateSliderFill(midBodySlider);

    volumeSlider.value = volume;
    volumeValue.textContent = `${volume}%`;
    updateSliderFill(volumeSlider);

    updateConfigString();

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
