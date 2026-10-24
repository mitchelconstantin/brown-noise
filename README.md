# Brown Noise PWA

A zero-dependency, offline-first Progressive Web App (PWA) that generates and plays continuous, seamless brown noise indefinitely. Built with pure vanilla HTML5, CSS3, and ES6+ JavaScript.

Designed with an espresso and warm amber dark aesthetic, it runs 100% offline with zero network requests after the first visit and supports uninterrupted background playback on iOS (iPhone / iPad) and Android when the screen is locked or switching apps.

---

## Features

* **Zero Dependencies & No CDNs:** Pure HTML5, CSS3, and modern vanilla JavaScript. No npm packages, no build steps, no Google Fonts, no external icons, and no remote audio files.
* **iOS Background Playback Safe:** Avoids live `AudioContext` pipelines which iOS Safari suspends when locked or backgrounded. Instead, procedurally generates a seamless 16-bit stereo `.wav` file into an in-memory `Blob` and feeds standard HTML5 `<audio loop playsinline>`.
* **Curated Acoustic Presets & Custom Sliders:**
  * **Open (1200 Hz, 1x Slope):** Maximum open, natural, loud acoustic presence.
  * **Warm (800 Hz, 1x Slope):** Smooth, warm ambient room sound.
  * **Deep (500 Hz, 2x Slope):** Balanced, relaxing, classic dark brown noise.
  * **Rumble (250 Hz, 2x Slope):** Heavy, dark sub-rumble for deep sleep.
  * **Custom Sliders:** Real-time **Tone Cutoff** (100 Hz to 1200 Hz) and **Filter Slope** (1x to 4x) sliders for full personalized control.
* **Maximized Hardware Output:** Master volume is permanently locked at the cleanest, loudest possible level (`1.0`), delegating volume control directly to your phone's physical hardware buttons.
* **Pure Gaussian Noise Synthesis:** Employs the Box-Muller transform for true Gaussian noise with zero synthetic distortion, grain, or scratchiness.
* **Seamless Gapless Looping:** Sample-accurate loop architecture with a 25-second high-resolution stereo buffer, DC-blocker filtering, and an equal-power crossfade between the end and beginning of the audio buffer, producing zero clicks, pops, or looping skips.
* **Live Tone Crossfading:** Adjusting the Warmth slider while playing triggers a smooth dual-audio crossfade so the tone shifts seamlessly without dropouts or audio glitches.
* **Studio Smooth Fades:**
  * **Play:** 1500ms smooth volume ramp up.
  * **Stop:** 1200ms smooth volume ramp down before pausing.
* **Media Session API Integration:** Native lock screen, Control Center, and notification audio controls (Play, Pause, and artwork) fully synchronized with app state.
* **Sleep Timer:** Select between Continuous playback or automatic shutoff after 15m, 30m, 45m, or 60m with smooth fade-out.
* **State Persistence:** Warmth, volume, and timer preferences are remembered via `localStorage`.
* **Warm Brown Dark Mode:** Minimalist, soothing UI built on rich espresso (`#16110E`), warm dark umber (`#281F1A`), soft cream (`#EDE3D9`), and glowing amber (`#C88A55`).

---

## Project Structure

```
brown-noise/
├── index.html            # Core semantic markup & PWA metadata
├── styles.css            # Responsive Warm Brown Dark Mode styling
├── app.js                # Procedural audio synthesis & playback controller
├── sw.js                 # Cache-First Service Worker for 100% offline usage
├── manifest.json         # Web App Manifest for standalone installation
├── favicon.ico           # Multi-resolution browser favicon
└── icons/
    ├── icon-192.png      # PWA home screen icon (192x192)
    ├── icon-512.png      # High-res PWA splash icon (512x512)
    ├── apple-touch-icon.png # iOS home screen icon (180x180)
    ├── icon.svg          # Crisp vector icon
    └── favicon.ico       # Favicon asset
```

---

## Running Locally

Because Service Workers require a secure origin (`localhost` or HTTPS), serve the directory with any local HTTP server:

### Python 3
```bash
python3 -m http.server 8080
```
Open [http://localhost:8080](http://localhost:8080) in your browser.

### Node.js (npx)
```bash
npx serve .
```

---

## Deploying to GitHub Pages

The repository strictly uses relative paths (`./`, `./sw.js`, `./manifest.json`, etc.), allowing it to function identically whether served from a root domain or a repository subfolder (e.g., `https://mitchelconstantin.github.io/brown-noise/`).

1. Push this repository to GitHub:
   ```bash
   git push -u origin main
   ```
2. In your GitHub repository:
   * Navigate to **Settings** > **Pages**.
   * Under **Build and deployment**, set **Source** to `Deploy from a branch`.
   * Set **Branch** to `main` and directory to `/ (root)`.
   * Click **Save**.
3. Your PWA will be live at:
   `https://mitchelconstantin.github.io/brown-noise/`

---

## Installing as a PWA

### iOS (iPhone & iPad)
1. Open the app URL in **Safari**.
2. Tap the **Share** button (box with an upward arrow) in the toolbar.
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top right corner.
5. Launch "Brown Noise" directly from your Home Screen for a full-screen, app-like experience with background audio.

### Android (Chrome, Brave, Edge)
1. Open the app URL in **Chrome**.
2. Tap the **"Add Brown Noise to Home screen"** prompt at the bottom, or tap the three dots menu (`⋮`) and select **Install app** / **Add to Home screen**.
3. Tap **Install**.

---

## License

MIT License. Free to use, modify, and distribute.
