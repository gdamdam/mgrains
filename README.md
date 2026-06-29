# mgrains

Capture a moment. Bloom it or break it.

`mgrains` is an in-progress browser granular instrument and live effect. The current repository contains the tested architectural foundation and first interactive vertical slice; the complete product specification is in [`docs/OPUS_BUILD_PROMPT.md`](./docs/OPUS_BUILD_PROMPT.md).

## Current milestone

Implemented:

- Vite, React, strict TypeScript, ESLint, and Vitest scaffold;
- canonical versioned grain-patch and engine-message contracts;
- deterministic fixed-pool granular DSP core;
- AudioWorklet wrapper with coarse telemetry;
- generated stereo demo source and waveform peaks;
- browser file decoding with size/duration limits;
- Bloom/Shatter presentation and mode starting values;
- interactive waveform position, XY surface, and direct Grain Size, Density, Position, and Spray controls;
- responsive, keyboard-readable, reduced-motion-aware foundation UI;
- production-only service-worker registration and an offline-shell web manifest;
- clean timeout/error behavior when browser audio output cannot start.

This is deliberately not presented as the complete v1. Live input, the 20-second circular buffer, Freeze, the true tempo-synced Shatter scheduler, macros, advanced controls, motion recording, step lane, persistence, recording, MIDI, and full offline/update QA remain to be built.

See [`docs/HANDOFF.md`](./docs/HANDOFF.md) for verified status and continuation order, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the real-time boundary.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite and choose **Start audio**. Browser audio requires a user gesture. Use headphones before enabling live input once that feature lands.

## Verification

```bash
npm run lint
npm run test
npm run build
```

Or run all three:

```bash
npm run check
```

## Repository map

```text
src/
  audio/
    contracts.ts             canonical patch/messages and bounds
    AudioEngine.ts           browser audio graph lifecycle
    granular.worklet.ts      real-time worklet adapter
    demoSource.ts            original deterministic source + peaks
    dsp/
      GranularCore.ts        framework-independent grain engine
      rng.ts                 seeded deterministic random source
      windows.ts             grain envelopes
  components/                waveform, XY, and parameter controls
  App.tsx                    current integrated vertical slice
docs/
  ARCHITECTURE.md
  HANDOFF.md
```

## Browser notes

- AudioWorklet requires a secure context in production; localhost is accepted for development.
- The app uses the actual `AudioContext.sampleRate` and does not assume 44.1 or 48 kHz.
- Web MIDI and microphone support will be optional enhancements with permission-aware fallback paths.
- Automated/headless browser environments may expose no audio output. The app times out with an actionable error rather than remaining stuck in a starting state.

## License

No license has been selected yet. The generated demo source is produced by repository code and does not include third-party audio.
