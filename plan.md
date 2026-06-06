# Implementation Plan – Client‑Side Playback Speed

## Goal
- Keep the backend TTS service always called with `speed: 1.0` (default).
- Move all speed control to the client side (the `AudioPlayer`/off‑screen playback layer).
- Slider in the popup continues to set a speed factor, but that factor now adjusts the playback rate of the audio element instead of being sent to the server.

## High‑Level Steps
1. **Add Playback‑Rate API to `AudioPlayer`**
   - Extend `AudioPlayer` with a method `setPlaybackRate(rate: number)` that sets `audioElement.playbackRate` on the off‑screen document.
   - Ensure the off‑screen document exposes a function (e.g. `setRate`) that receives the rate via `chrome.runtime.onMessage`.
2. **Update Off‑screen Document**
   - In `offscreen.js` (or the equivalent file), keep a reference to the `HTMLAudioElement` used for streaming.
   - Add a message handler for a new action type `SET_RATE` that calls `audio.playbackRate = rate`.
   - Validate the rate (positive number, reasonable range 0.5‑2.5).
3. **Modify Background Script**
   - Remove `speed` from the payload sent to the TTS endpoint (line 203 in `background.js`).
   - Always send `speed: 1.0` (or omit the field if the API defaults to 1x).
   - After receiving the audio blob and creating the off‑screen audio element, send a `SET_RATE` message with the user‑selected speed (retrieved from settings).
4. **Update Popup UI Flow**
   - When the user clicks *Play*, include `settings.speed` in the message to the background **only for playback**, not for the fetch request.
   - After the background acknowledges the stream start, immediately forward the speed to the off‑screen document via the new `SET_RATE` action.
5. **Persist Speed Setting** (unchanged) – continue storing the slider value in Chrome storage.
6. **Tests**
   - Unit tests for `AudioPlayer.setPlaybackRate`.
   - Integration test for the message flow: popup → background → off‑screen → audio element.
   - Regression test ensuring the TTS request body always contains `speed: 1.0`.
   - Edge‑case tests for invalid speed values (negative, NaN, out‑of‑range) – should clamp to default 1.0.
7. **Documentation Update**
   - Update `AGENTS.md` section *Code Conventions & Common Patterns* and *Runtime/Tooling Preferences* to reflect the new client‑side speed handling.
   - Add a short note in the *Speed* description of the UI.

## Test Sketches
### 1. `AudioPlayer.setPlaybackRate`
```js
import { AudioPlayer } from './audioPlayer.js';

test('sets playbackRate on offscreen audio element', async () => {
  const mockPort = { postMessage: jest.fn() };
  // Stub chrome.runtime.connect to return mockPort
  global.chrome = { runtime: { connect: () => mockPort } };

  const player = new AudioPlayer();
  await player.init(); // creates offscreen connection
  player.setPlaybackRate(1.5);
  expect(mockPort.postMessage).toHaveBeenCalledWith({ action: 'SET_RATE', rate: 1.5 });
});
```

### 2. Background does not forward speed to TTS
```js
import { startStreamingAudio } from './background.js';

test('always sends speed 1.0 to TTS service', async () => {
  const fetchMock = jest.fn(() => Promise.resolve({ ok: true, blob: () => new Blob() }));
  global.fetch = fetchMock;

  const settings = { serverUrl: 'http://localhost:8000/v1/audio/speech', voice: 'af_bella', speed: 2.0 };
  await startStreamingAudio('hello world', settings);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.speed).toBe(1.0);
});
```

### 3. Off‑screen handler respects rate
```js
// offscreen.test.js (runs in a jsdom environment)
let audioElem;
beforeEach(() => {
  audioElem = document.createElement('audio');
  document.body.appendChild(audioElem);
});

test('SET_RATE message changes playbackRate', () => {
  // simulate message listener registration
  const handler = jest.fn();
  chrome.runtime.onMessage.addListener(handler);
  // invoke the handler with a mock message
  handler({ action: 'SET_RATE', rate: 0.75 }, null, () => {});
  expect(audioElem.playbackRate).toBeCloseTo(0.75);
});
```

### 4. End‑to‑end flow (popup → background → off‑screen)
1. Mock Chrome messaging layers.
2. Simulate user clicking *Play* with speed slider set to `1.8`.
3. Verify that:
   - Background fetch body contains `speed: 1.0`.
   - After the stream is created, a `SET_RATE` message with `1.8` is sent to the off‑screen.
   - The off‑screen audio element’s `playbackRate` becomes `1.8`.

## Parallel Tasks (Task Tool)
| ID | Description | Files Affected |
|----|-------------|----------------|
| task‑player | Extend `audioPlayer.js` with `setPlaybackRate` | `audioPlayer.js` |
| task‑offscreen | Add `SET_RATE` handler, expose rate control | `offscreen.js` |
| task‑background | Remove speed from request, forward rate after stream start | `background.js` |
| task‑popup | Ensure speed only used for playback, not request | `popup.js` |
| task‑tests | Add/adjust Jest tests as sketched above | `__tests__/*` |
| task‑docs | Update `AGENTS.md` to reflect new architecture | `AGENTS.md` |

## Execution Order
1. Implement `AudioPlayer.setPlaybackRate` (task‑player).
2. Add off‑screen `SET_RATE` handling (task‑offscreen).
3. Modify `background.js` request payload and post‑stream rate message (task‑background).
4. Adjust popup flow (task‑popup).
5. Write/adjust tests (task‑tests) – run after each code change to catch regressions.
6. Update documentation (task‑docs).

## Acceptance Criteria
- Backend TTS requests always contain `speed: 1.0` (or no speed field).
- Changing the slider updates the playback speed of the audio element in real time.
- All existing UI functionality (play/pause/stop/seek) works unchanged.
- All new tests pass; existing tests (if any) still pass.
- `AGENTS.md` accurately describes the new client‑side speed handling.
