# Plan: Fix Audio Playback Regression

## Background

After a recent refactor (commits `dd8d555` → `18d1449`), the extension no longer plays **any** audio, regardless of text length. Speech is generated successfully by the TTS server, but the `<audio>` element in the offscreen document plays nothing.

Two issues are confirmed bugs; the third (ArrayBuffer detachment) may also be real — see below.

---

## Root Cause: PCM MIME Type Mismatch (Primary — affects ALL audio)

### What changed

Commit `dd8d555` added `response_format: 'pcm'` to the standard speech endpoint request in `background.js` line 437. This means the server now returns **raw PCM bytes** instead of a self-decoding format like MP3.

Commit `18d1449` added `pcmToWav()` in `offscreen.js` to wrap raw PCM in a WAV header so the browser `<audio>` element can decode it. The conversion is gated on:

```js
// offscreen.js, line 65
if (mimeType && mimeType.includes('pcm')) {
  finalBytes = pcmToWav(uint8Array, 24000);
  finalMimeType = 'audio/wav';
}
```

### The bug

In `background.js` line 446:

```js
const audioBlob = await response.blob();
mimeType = audioBlob.type || 'audio/mpeg';
```

When the server returns raw PCM, `response.blob()` produces a blob whose `.type` is either:
- `''` (empty string) — if the `Content-Type` header is missing or unrecognized
- `'audio/L16'`, `'audio/raw'`, or some other PCM subtype — none of which contain the substring `'pcm'`

In both cases, the code falls back to `'audio/mpeg'`, which does **not** contain `'pcm'`. The guard in `offscreen.js` is never true, so raw PCM bytes are fed directly into `new Blob([pcmBytes], { type: 'audio/mpeg' })`. The browser tries to decode raw PCM as MP3, fails silently, and plays nothing.

### Fix

**File: `background.js`, line 446**

Replace the MIME type inference so that when `response_format: 'pcm'` is requested, the mimeType is explicitly set to a value that triggers the PCM→WAV conversion in the offscreen document.

Two acceptable approaches:

**Option A (recommended):** Set `mimeType` explicitly based on the `response_format` requested, since we know what we asked for:

```js
const audioBlob = await response.blob();
mimeType = audioBlob.type || 'audio/pcm';   // use 'audio/pcm' so offscreen detects it
```

Or more explicitly:

```js
const audioBlob = await response.blob();
mimeType = audioBlob.type || 'audio/pcm';
```

The string `'audio/pcm'` contains `'pcm'`, so `mimeType.includes('pcm')` in `offscreen.js` will be `true`, and `pcmToWav()` will execute.

**Option B (more robust):** Check the `Content-Type` response header directly instead of relying on `blob.type`:

```js
const contentType = response.headers.get('content-type') || '';
const audioBlob = await response.blob();
mimeType = contentType || 'audio/pcm';
```

Either option is acceptable. Option A is simpler and sufficient.

### Verification

After the fix:
1. Load the unpacked extension in Chrome.
2. Select any short text on a page and click "Read Aloud" from the context menu.
3. Confirm audio plays. Check the offscreen DevTools console for no errors.
4. Test with longer text (> 1 MiB audio) — see secondary issue below.

---

## Secondary Issue: `[].concat(...audioChunks)` — Chunk buffer integrity (affects large audio, possibly all)
#### The bug
**File: `offscreen.js`, line 183**
```js
const combined = [].concat(...audioChunks);
```
`audioChunks` is an array of `Uint8Array` objects received via `chrome.runtime.onMessage`. The `...audioChunks` spread expands every byte as an individual function argument. For 1 MiB of audio that's ~1,048,576 arguments — beyond V8's limit (~655,360), throwing `RangeError: Maximum call stack size exceeded`.
#### Why `Uint8Array.set()` was tried and failed
The obvious fix — pre-allocate a `Uint8Array` and copy each chunk with `combined.set(chunk, offset)` — **was attempted and did not work**. This is significant because it means the problem is not just the argument limit; it's about **how the chunk data survives Chrome's structured clone serialization**.
Both `[].concat(...chunk)` and `combined.set(chunk, offset)` read from the chunk's underlying `ArrayBuffer`. If structured clone compromises that buffer (detaches it, zeroes it, or converts the `Uint8Array` to a plain array of doubles), **both approaches fail** — one loudly (RangeError for large data), the other silently (garbage/zeros in the output).
The fact that `set()` failed means we cannot trust the binary buffer of any `Uint8Array` that has passed through `chrome.runtime.sendMessage`. The fix must **avoid reading the structured-clone buffer entirely**.
#### Fix: Encode chunks as base64 strings (sender), decode to fresh buffers (receiver)
Strings are immune to ArrayBuffer detachment. By encoding on the sender side and decoding on the receiver side, each chunk gets a **brand-new** `ArrayBuffer` created by `atob()` — no structured clone involvement.
**File: `background.js`, function `sendAudioChunks` (lines 326–346)**
1. Add a helper to encode `Uint8Array` → base64 string (the existing `uint8ArrayToBase64()` at line 317 can be reused).
2. Change the chunk sent in the message from the raw `Uint8Array` to a base64 string:
```js
// background.js, sendAudioChunks() — replace lines 336–344
const chunk = audioBytes.slice(start, end);
const chunkB64 = uint8ArrayToBase64(chunk);
chrome.runtime.sendMessage({
  type: 'audioChunk',
  chunk: chunkB64,        // base64 string, not Uint8Array
  index: i,
  isLast: i === totalChunks - 1,
  mimeType: mimeType,
  isRecording: isRecording
});
```
3. Reduce `CHUNK_SIZE` from 4 MiB to ~3 MiB to account for base64's 4/3 size inflation (a 3 MiB binary chunk → ~4 MiB base64 string, staying under Chrome's message size limit).
**File: `offscreen.js`, `audioChunk` handler (lines 178–186)**
Replace the handler to decode base64 → fresh `Uint8Array`, then combine with `set()` (which now operates on buffers created by `atob()`, not by structured clone):
```js
// offscreen.js, replace lines 178–186
case 'audioChunk':
  // Decode base64 string to a fresh Uint8Array (new ArrayBuffer, no structured clone)
  const binaryStr = atob(message.chunk);
  const chunkBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    chunkBytes[i] = binaryStr.charCodeAt(i);
  }
  audioChunks[message.index] = chunkBytes;
  if (message.isLast) {
    // Combine all chunks — safe because each chunkBytes has a fresh buffer
    const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of audioChunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    processAudioData(combined, message.mimeType);
    audioChunks = [];
  }
  break;
```
This pattern (base64 decode → `Uint8Array`) already works correctly in the captioned-speech path (`background.js` lines 392–396), confirming it's a valid approach in this codebase.
#### Verification
1. After both fixes, test with text that produces > 65 KB of PCM audio (~2,650+ tokens).
2. Confirm audio plays without errors in the offscreen console.
3. Test with very long text (> 4 MiB audio, multiple chunks) to verify chunking still works.

---

## Third Issue: Uint8Array ArrayBuffer Detachment (possibly real — addressed by the base64 fix)
Originally dismissed as a red herring based on the structured clone spec (which says ArrayBuffers nested in objects are copied, not transferred). However, the fact that `Uint8Array.set()` failed on received chunks suggests Chrome's implementation **may** detach or otherwise compromise the buffer during serialization — at least for large messages.
The base64-encoding fix for the secondary issue **also resolves this concern**: by encoding to strings on the sender and decoding with `atob()` on the receiver, we never rely on structured clone to preserve binary buffer integrity. No separate fix is needed.

---

## Summary of Required Changes

| # | File | Line(s) | Change |
|---|------|---------|--------|
| 1 | `background.js` | 446 | Change `audioBlob.type \|\| 'audio/mpeg'` → `audioBlob.type \|\| 'audio/pcm'` (or use `response.headers.get('content-type')`) |
| 2 | `background.js` | 327, 336–344 | Encode audio chunks as base64 strings before sending (reuse `uint8ArrayToBase64()`); reduce `CHUNK_SIZE` from 4 MiB to ~3 MiB |
| 3 | `offscreen.js` | 178–186 | Decode base64 chunks to fresh `Uint8Array` with `atob()`, then combine with `Uint8Array.set()` loop |

## Testing Checklist

- [ ] Short text (< 1 KB audio) plays correctly
- [ ] Long text (> 65 KB audio, ~2,650+ tokens) plays correctly
- [ ] Very long text (> 4 MiB audio, multiple chunks) plays correctly
- [ ] PCM→WAV conversion produces valid WAV (check offscreen console for no decode errors)
- [ ] Highlighting path (captioned speech endpoint) still works — it uses a separate code path that decodes base64 audio and sends `data.audio_format` as the MIME type
- [ ] Stop/pause/resume/seek controls work during playback
- [ ] No errors in background service worker or offscreen DevTools console
