Now I have the complete picture. Let me analyze both issues against the actual code paths.

## Analysis

### Issue #1: Uint8Array ArrayBuffer Detachment — **Unlikely to be the cause**

In `background.js` line 336, the chunk is created and sent:

```js
const chunk = audioBytes.slice(start, end);  // NEW Uint8Array with its own ArrayBuffer
chrome.runtime.sendMessage({ type: 'audioChunk', chunk: chunk, ... });
```

Per the [structured clone algorithm spec](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm), when a `Uint8Array` is a **property of an object** (not the top-level transferred value), its backing `ArrayBuffer` is **copied**, not transferred. Chrome's `chrome.runtime.sendMessage` has no transfer list parameter, so the ArrayBuffer is always copied.

The receiver (`offscreen.js`) should get a valid `Uint8Array` with a non-detached buffer. This is well-established behavior — the ArrayBuffer detachment only happens when you explicitly use `window.postMessage(data, [transferList])` with the buffer in the transfer list.

**Verdict:** This is almost certainly a red herring. The `Uint8Array` arrives intact at the offscreen document.

### Issue #2: `[].concat(...audioChunks)` argument limit — **Real, but only for large files**

`offscreen.js` line 183:
```js
const combined = [].concat(...audioChunks);
```

This spreads every byte of every `Uint8Array` chunk as an individual function argument. For a 1 MiB audio file, that's ~1,048,576 arguments. V8's practical limit is ~65,536 (older) to ~655,360 (newer). This **will** throw a `RangeError: Maximum call stack size exceeded` for large audio.

**But this doesn't explain "no audio at all, regardless of how short the text is."** A 100-byte audio chunk produces 100 arguments — trivially within limits. Short text should play fine if this were the only issue.

### The Real Culprit: A Third Issue — PCM MIME type mismatch

Looking at the refactor diff, the critical change is:

**background.js** now requests `response_format: 'pcm'`:
```js
body: JSON.stringify({
  model: settings.model,
  voice: settings.voice,
  input: text,
  response_format: 'pcm'    // ← NEW
})
```

Then the audio blob's MIME type comes from the server:
```js
const audioBlob = await response.blob();
mimeType = audioBlob.type || 'audio/mpeg';   // ← Falls back to 'audio/mpeg'!
```

**Here's the problem:** When a TTS server returns raw PCM, `response.blob()` often produces a blob with `type: ''` (empty string), because the `Content-Type` header may be `audio/raw`, `audio/L16`, or absent entirely. The code falls back to `'audio/mpeg'`.

This `'audio/mpeg'` MIME type then flows through `sendAudioChunks` → offscreen document → `processAudioData`:

```js
// offscreen.js line 65
if (mimeType && mimeType.includes('pcm')) {
  finalBytes = pcmToWav(uint8Array, 24000);
  finalMimeType = 'audio/wav';
}
```

**`'audio/mpeg'.includes('pcm')` is `false`.** So raw PCM bytes are wrapped in a Blob with `type: 'audio/mpeg'` — the browser tries to decode raw PCM as MP3, fails silently, and plays nothing.

This explains **all** symptoms:
- **No audio at all, any length** — PCM is never wrapped in WAV, browser can't decode it
- **Speech is "still generated"** — the TTS server returns data successfully; the problem is purely in playback
- **Worked before the refactor** — the old code didn't request PCM format, so the server returned MP3/OGG which the `<audio>` element could decode directly

### Summary

| Issue | Real? | Explains "no audio at all"? |
|-------|-------|------|
| #1: ArrayBuffer detachment | **No** — structured clone copies, doesn't transfer | N/A |
| #2: concat argument limit | **Yes** — but only for files >64–655KB | **No** — small files fine |
| **#3: PCM MIME type mismatch** | **Yes** — `audioBlob.type` is empty, falls back to `audio/mpeg`, PCM-to-WAV conversion is skipped | **Yes** — affects ALL audio |

Want me to fix all three issues (the real MIME type bug plus the concat argument limit defense)?