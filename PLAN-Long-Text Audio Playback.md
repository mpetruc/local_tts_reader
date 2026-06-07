# Plan: Fix Long-Text Audio Playback (>2649 tokens)

## Background

The extension currently plays audio correctly for short texts (≤2649 tokens). For longer texts, audio fails silently because the audio data exceeds ~4 MiB, triggering the chunking mechanism which has two bugs.

**Starting point:** `ebda6a8` baseline — audio works for short texts via MP3 format. The PCM refactor (`dd8d555`, `18d1449`) was reverted and is out of scope.

---

## The Bug: `[].concat(...audioChunks)` Argument Limit

### What happens

When audio exceeds 4 MiB, `sendAudioChunks()` in `background.js` splits it into multiple chunks and sends each via `chrome.runtime.sendMessage`. The offscreen document collects chunks and combines them:

```js
// offscreen.js, line 138
const combined = [].concat(...audioChunks);
```

This spreads every element of every chunk as a function argument. For 2 chunks × 4 MiB = ~8,388,608 arguments — far beyond V8's limit (~655,360), throwing `RangeError: Maximum call stack size exceeded`.

### Why `Uint8Array.set()` won't work

Pre-allocating a `Uint8Array` and using `combined.set(chunk, offset)` is the obvious fix, but it was tried and failed. The reason: the current code sends `Uint8Array` slices through `chrome.runtime.sendMessage`, and Chrome's structured clone may detach or compromise the underlying `ArrayBuffer` during serialization. Both `concat()` and `set()` read from that compromised buffer, so both fail.

This was confirmed when the `Array.from` → `slice` change (which sends `Uint8Array` instead of plain `Array`) broke playback for **all** audio lengths — including short ones that fit in a single chunk.

### Fix: Keep `Array.from()` on sender, fix `concat()` on receiver

The current code already uses `Array.from()` on the sender side, which converts the `Uint8Array` into a plain `Array` of numbers. These survive structured clone reliably (they're just primitives). The only problem is the receiver's `concat(...)` spread.

**File: `offscreen.js`, line 138**

Replace the spread-concat with a loop that avoids argument limits:

```js
// offscreen.js, replace line 138:
//   const combined = [].concat(...audioChunks);
// With:
const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
const combined = new Array(totalLength);
let offset = 0;
for (const c of audioChunks) {
  for (let i = 0; i < c.length; i++) {
    combined[offset + i] = c[i];
  }
  offset += c.length;
}
```

This is O(n) in time, uses no argument spreading, and operates on plain arrays (not `Uint8Array` buffers from structured clone).

**Alternative (slightly faster):** Since each chunk is already a plain `Array`, use `Array.prototype.push` with a temporary accumulator:

```js
const combined = [];
for (const c of audioChunks) {
  for (let i = 0; i < c.length; i++) {
    combined.push(c[i]);
  }
}
```

Or use a helper that splits the spread into manageable batches:

```js
function concatAll(arrays) {
  const result = [];
  for (const arr of arrays) {
    // Push in batches of 64K to stay under V8's argument limit
    const BATCH = 65536;
    for (let i = 0; i < arr.length; i += BATCH) {
      result.push(...arr.slice(i, i + BATCH));
    }
  }
  return result;
}
// Then: const combined = concatAll(audioChunks);
```

The batched-spread approach keeps the same downstream behavior (plain `Array` → `new Uint8Array()` in `processAudioData`) and is the minimal change.

### Verification

1. Test with text that produces > 4 MiB of audio (>2649 tokens).
2. Confirm audio plays without errors in the offscreen console.
3. Verify short text (< 1 KB audio) still works (regression check).

---

## Summary of Required Changes

| # | File | Line(s) | Change |
|---|------|---------|--------|
| 1 | `offscreen.js` | 138 | Replace `[].concat(...audioChunks)` with a batched-spread or loop-based combine |

## Testing Checklist

- [ ] Short text (< 1 KB audio) plays correctly (regression check)
- [ ] Medium text (~2649 tokens, just under 4 MiB) plays correctly
- [ ] Long text (> 2649 tokens, > 4 MiB, multiple chunks) plays correctly
- [ ] Very long text (> 8 MiB, 3+ chunks) plays correctly
- [ ] Stop/pause/resume/seek controls work during playback
- [ ] No errors in background service worker or offscreen DevTools console
