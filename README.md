# Changes Since Original Release

The following features and improvements have been added since the original (baseline) version of Local TTS Reader:

## Real-Time Streaming Playback
- Audio begins playing as soon as the first chunk arrives from the TTS server — no more waiting for the full response before playback starts.
- Text is split into sentence-bounded chunks (default 400 chars), each synthesized and streamed independently.
- Uses an `audio` element with lazy WAV-blob swapping: new PCM data is appended to the current blob only when the playback head nears the end, eliminating stutter.
- Full transport controls during streaming: **play**, **pause**, **stop** (aborts in-flight requests), and **speed changes** — all handled client-side at 1× server output.

## Long-Text Audio Support
- Replaced the original `Array.concat(...chunks)` approach (which hit V8's argument limit) with a safe batched `concatAll` for combining large audio responses.
- Chunk size reduced to 256 KB to stay under Chrome's `runtime.sendMessage` payload limit; audio is sent incrementally with progress logging.
- Offscreen document liveness is verified via `ping` before sending; dead documents are automatically recreated.

## Output Format Selector
- Choose the TTS response format: **MP3**, **WAV**, or **PCM** (configurable in the popup UI).
- Raw PCM responses are automatically wrapped in a WAV container so browsers can play them natively.

## Multi-Backend Voice Discovery
- Voice list is now fetched from multiple endpoint patterns (`/v1/audio/voices` for Kokoro/OpenAI-compatible backends, `/v1/voices` for Omnivoice) in priority order — the first successful response wins.
- Voice payload is normalised across backends (string arrays, `{id, name}` objects, etc.).

## Robust Offscreen Audio Context
- Offscreen document is pinged before every audio transfer; stale or killed contexts are detected and recreated automatically.
- Streaming playback uses debounced blob swaps, deferred `onpause`/`onended` handlers, and a `streamSwappingSrc` guard to prevent spurious state transitions.

---


# Local TTS Reader - Chrome Extension

A sleek Chrome extension that converts webpage text to speech using a local OpenAI-compatible TTS server. Features include voice selection, speed control, and the ability to save audio files.


## Features

- 🎯 Read selected text or entire webpage
- 🎭 Multiple voice options compatible with OpenAI voice mappings
- ⚡ Adjustable playback speed (0.25x to 4.0x)
- 💾 Option to save audio for download
- 🔧 Backend now always receives `speed: 1.0` (or no speed field); the UI slider controls playback rate client‑side.
- 📦 Audio data is sent in 4 MiB chunks to stay under Chrome’s 64 MiB `runtime.sendMessage` limit.
- 🧹 Text preprocessing (optional) now also strips numeric citation marks (e.g., “prompt1”) and rewrites dash‑separated version numbers (e.g., “GPT-4.5” → “GPT 5.5”).
- ⏯️ Play/Pause/Stop/Seek controls
- 🎨 Clean, modern interface
- 🔧 Configurable server URL
- 🌐 Works with Tailscale/local network TTS servers

## Installation

1. Clone this repository:
```bash
git clone https://github.com/phildougherty/local_tts_reader.git
```

2. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right
   - Click "Load unpacked"
   - Select the cloned repository folder

## Usage

1. Click the extension icon in your Chrome toolbar
2. Configure your settings:
   - Select your preferred voice
   - Adjust the playback speed using the slider
- Toggle "Preprocess text" to clean up markdown, citations, and version strings before TTS.
   - Check "Save audio for download" if you want to download the audio
   - Enter your local TTS server URL

3. On any webpage:
   - Select specific text to read just that portion
   - Or don't select anything to read the entire page
   - Click play to start TTS
   - Use pause/stop controls as needed
   - Download the audio if recording was enabled

## Voice Options

The extension supports the following voices:
- Adam (Alloy) - `am_adam`
- Nicole (Ash) - `af_nicole`
- Emma (Coral) - `bf_emma`
- Bella (Echo) - `af_bella`
- Sarah (Fable) - `af_sarah`
- George (Onyx) - `bm_george`
- Isabella (Nova) - `bf_isabella`
- Michael (Sage) - `am_michael`
- Sky (Shimmer) - `af_sky`

## Server Requirements

Your local TTS server should:
- Be OpenAI API compatible
- Accept POST requests to `/v1/audio/speech`
- Accept JSON payload in the format:
\\```json
{
  "model": "tts-1",
  "voice": "af_bella",
  "input": "text to speak",
  "speed": 1.0
}
\\```
- Return audio data (mp3/wav)

Default server URL: `http://localhost:8000/v1/audio/speech`

## Development

The extension consists of three main files:
- `manifest.json`: Extension configuration
- `popup.html`: UI layout and styles
- `popup.js`: Core functionality and event handlers

To modify the extension:
1. Make your changes
2. Reload the extension in `chrome://extensions/`
3. Click the refresh icon on the extension card

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT


## Configuration

- `serverUrl` now expects **only the base URL** (e.g., `http://localhost:8000`). The extension builds the speech and voices endpoints (`/v1/audio/speech` and `/v1/audio/voices`) automatically.
- Existing installations that stored full endpoint URLs will still work; the base part is extracted and the paths are appended.