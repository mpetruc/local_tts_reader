// ── Batched concat to avoid V8's ~655K argument limit ──
function concatAll(chunks) {
  const BATCH = 65536;
  let totalLen = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]) totalLen += chunks[i].length;
  }
  const result = new Array(totalLen);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i]) continue;
    const src = chunks[i];
    for (let j = 0; j < src.length; j++) {
      result[offset++] = src[j];
    }
  }
  return result;
}

// ── Non-streaming (legacy) state ──
let audioElement = null;
let isPlaying = false;
let audioChunks = [];

// ── Streaming state (audioElement-based, preserves pitch) ──
let streamAudio = null;           // <audio> element for streaming
let streamChunks = [];            // raw PCM chunks (Uint8Array[], concat only on swap)
let streamBlobUrl = null;         // current blob URL
let streamBlobDuration = 0;       // duration of current blob (seconds)
let streamBlobBytes = 0;          // PCM bytes in current blob
let streamIsPlaying = false;      // user-intended playing state
let streamIsPaused = false;       // user-intended paused state
let streamComplete = false;       // all chunks received
let streamPlaybackRate = 1;       // requested playback rate
let streamSwappingSrc = false;    // guard against spurious pause events during src swap
let streamLastSwapTime = 0;        // wall-clock ms of last blob swap
let streamEndDeferred = null;      // timeout ID to prevent recursive onended
let streamPauseDeferred = null;    // timeout ID to defer onpause (let onended win)
const SAMPLE_RATE = 24000;        // TTS server sample rate
const SWAP_MARGIN = 4.0;          // swap blob when within this many seconds of buffer end (seconds)
const SWAP_MIN_INTERVAL = 1500;   // minimum ms between swaps (debounce)
const START_THRESHOLD = 2.0;      // minimum buffered seconds before starting playback (seconds)
// Send diagnostic info to background console
function sendDiagnostic(msg) {
  console.log('[OFFSCREEN]', msg);
  chrome.runtime.sendMessage({ type: 'streamingDiagnostic', msg });
}

// ── Non-streaming helpers ──

function initAudio() {
  if (!audioElement) {
    audioElement = document.getElementById('audioElement');
    if (!audioElement) {
      audioElement = document.createElement('audio');
      audioElement.id = 'audioElement';
      document.body.appendChild(audioElement);
    }
  }
}

function processAudioData(audioDataArray, mimeType, rate) {
  try {
    initAudio();
    const uint8Array = new Uint8Array(audioDataArray);
    const blob = new Blob([uint8Array], { type: mimeType });
    const audioUrl = URL.createObjectURL(blob);
    playAudioUrl(audioUrl, rate);
    chrome.runtime.sendMessage({ type: 'audioReady' });
  } catch (error) {
    console.error('Error processing audio data:', error);
    chrome.runtime.sendMessage({ type: 'streamError', error: error.message });
  }
}

function playAudioUrl(audioUrl, rate) {
  try {
    console.log('[OFFSCREEN] Playing audio URL:', audioUrl);
    audioElement.src = audioUrl;
    if (rate && !isNaN(rate) && rate > 0) {
      audioElement.playbackRate = rate;
      console.log('[OFFSCREEN] Playback rate set to:', rate);
    }
    audioElement.onplay = () => {
      isPlaying = true;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing' });
    };
    audioElement.onpause = () => {
      isPlaying = false;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
    };
    audioElement.onended = () => {
      isPlaying = false;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
      chrome.runtime.sendMessage({ type: 'streamComplete' });
    };
    audioElement.ontimeupdate = () => {
      chrome.runtime.sendMessage({
        type: 'timeUpdate',
        timeInfo: { currentTime: audioElement.currentTime, duration: audioElement.duration }
      });
    };
    audioElement.play().catch(err => {
      console.error('Play error:', err);
      chrome.runtime.sendMessage({ type: 'streamError', error: err.message });
    });
  } catch (error) {
    console.error('Error playing audio:', error);
    chrome.runtime.sendMessage({ type: 'streamError', error: error.message });
  }
}

// ── Streaming helpers (audioElement + WAV blob) ──

// Wrap raw 16-bit LE mono PCM bytes in a minimal RIFF WAV container.
function pcmToWavBlob(pcmBytes) {
  const dataLen = pcmBytes.length;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  let o = 0;
  // RIFF header
  v.setUint32(o, 0x52494646, false); o += 4; // "RIFF"
  v.setUint32(o, 36 + dataLen, true); o += 4; // file size - 8
  v.setUint32(o, 0x57415645, false); o += 4; // "WAVE"
  // fmt chunk
  v.setUint32(o, 0x666d7420, false); o += 4; // "fmt "
  v.setUint32(o, 16, true); o += 4;          // chunk size
  v.setUint16(o, 1, true); o += 2;           // PCM
  v.setUint16(o, 1, true); o += 2;           // mono
  v.setUint32(o, SAMPLE_RATE, true); o += 4; // sample rate
  v.setUint32(o, SAMPLE_RATE * 2, true); o += 4; // byte rate
  v.setUint16(o, 2, true); o += 2;           // block align
  v.setUint16(o, 16, true); o += 2;          // bits per sample
  // data chunk
  v.setUint32(o, 0x64617461, false); o += 4; // "data"
  v.setUint32(o, dataLen, true); o += 4;     // data size
  new Uint8Array(buf, o).set(pcmBytes);
  return new Blob([buf], { type: 'audio/wav' });
}

// Ensure the streaming audio element exists.
function initStreamingAudio() {
  if (!streamAudio) {
    streamAudio = document.createElement('audio');
    streamAudio.id = 'streamAudio';
    document.body.appendChild(streamAudio);

    streamAudio.onplay = () => {
      // Note: no streamSwappingSrc guard here — we always need to broadcast
      // 'playing' state when playback starts or resumes after a blob swap
      if (streamIsPlaying && !streamIsPaused) return; // idempotent guard
      streamIsPlaying = true;
      streamIsPaused = false;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing' });
    };

    streamAudio.onpause = () => {
      if (streamSwappingSrc) return;
      // Defer state change so onended (which fires right after pause at end) can win
      if (streamPauseDeferred) clearTimeout(streamPauseDeferred);
      streamPauseDeferred = setTimeout(() => {
        streamPauseDeferred = null;
        if (!streamIsPlaying) return;
        streamIsPlaying = false;
        streamIsPaused = true;
        chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
      }, 50);
    };

    streamAudio.onended = () => {
      // Cancel deferred onpause so onended wins the race
      if (streamPauseDeferred) { clearTimeout(streamPauseDeferred); streamPauseDeferred = null; }
      // Blob ended — if more chunks accumulated, swap and keep playing
      // Guard: prevent recursive onended during swap only
      if (streamSwappingSrc) return;
      const totalBytes = streamChunks.reduce((s, c) => s + c.length, 0);
      if (totalBytes > streamBlobBytes && !streamComplete) {
        sendDiagnostic('onended — more data available (' + totalBytes + ' > ' + streamBlobBytes + ') — continuing');
        swapStreamingBlob();
        // swapStreamingBlob won't call play() because streamAudio.paused is true on onended
        // So we must resume playback explicitly
        streamSwappingSrc = true;
        streamAudio.play().catch(() => {});
        setTimeout(() => { streamSwappingSrc = false; }, 0);
        return;
      }

      streamIsPlaying = false;
      streamIsPaused = false;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
    };

    streamAudio.onstalled = () => {
      // Resume if the browser paused due to buffering but we want to play
      if (streamIsPlaying && streamAudio.paused && !streamSwappingSrc) {
        streamAudio.play().catch(() => {});
      }
    };

    streamAudio.onwaiting = () => {
      // Audio element ran out of data — force swap with accumulated chunks
      const totalBytes = streamChunks.reduce((s, c) => s + c.length, 0);
      if (streamIsPlaying && totalBytes > streamBlobBytes && !streamSwappingSrc) {
        sendDiagnostic('waiting event — forcing blob swap');
        swapStreamingBlob();
      }
    };
  }
}

// ── Streaming helpers (audioElement + WAV blob, lazy swap) ──

// Concat accumulated chunks into a single Uint8Array.
function concatStreamChunks() {
  let totalLen = 0;
  for (let i = 0; i < streamChunks.length; i++) totalLen += streamChunks[i].length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (let i = 0; i < streamChunks.length; i++) {
    result.set(streamChunks[i], off);
    off += streamChunks[i].length;
  }
  return result;
}

// Check if we need to swap the blob (playback head near buffer edge).
function needsSwap() {
  if (!streamAudio || !streamBlobUrl) {
    // First swap: only create blob when enough data is buffered
    const totalBytes = streamChunks.reduce((s, c) => s + c.length, 0);
    return (totalBytes / 2 / SAMPLE_RATE) >= START_THRESHOLD;
  }
  // Debounce: don't swap too frequently
  if (Date.now() - streamLastSwapTime < SWAP_MIN_INTERVAL) return false;
  // Only swap if there's actually new data to add
  const totalBytes = streamChunks.reduce((s, c) => s + c.length, 0);
  if (totalBytes <= streamBlobBytes) return false;
  const pos = streamAudio.currentTime;
  const remain = streamBlobDuration - pos;
  // Account for playback rate: at 2x speed, 4s of buffer drains in 2s wall-clock
  const effectiveRemain = remain * streamPlaybackRate;
  return effectiveRemain <= SWAP_MARGIN;
}

// Create a new WAV blob URL and swap it into the streaming audio element.
// Preserves playback position, rate, and play/pause state.
function swapStreamingBlob() {
  initStreamingAudio();
  streamLastSwapTime = Date.now();

  const currentTime = streamAudio.currentTime;
  const wasPlaying = streamIsPlaying && !streamIsPaused && !streamAudio.paused;

  // Set new src BEFORE revoking old blob to avoid spurious events
  const pcm = concatStreamChunks();
  const newBlobUrl = URL.createObjectURL(pcmToWavBlob(pcm));
  streamBlobDuration = pcm.length / 2 / SAMPLE_RATE;
  streamBlobBytes = pcm.length;

  streamAudio.src = newBlobUrl;
  streamAudio.currentTime = currentTime;
  streamAudio.playbackRate = streamPlaybackRate;

  // Now safe to revoke old blob
  if (streamBlobUrl) {
    URL.revokeObjectURL(streamBlobUrl);
  }
  streamBlobUrl = newBlobUrl;

  if (wasPlaying) {
    streamSwappingSrc = true;
    streamAudio.play().catch(() => {});
    setTimeout(() => { streamSwappingSrc = false; }, 0);
  }
}

// Start streaming playback.
function playStreaming() {
  initStreamingAudio();
  if (!streamBlobUrl) return;
  streamIsPlaying = true;
  streamIsPaused = false;
  streamAudio.playbackRate = streamPlaybackRate;
  streamSwappingSrc = true;
  streamAudio.play().catch(() => {});
  setTimeout(() => { streamSwappingSrc = false; }, 0);
}

// Pause streaming playback.
function pauseStreaming() {
  initStreamingAudio();
  if (!streamIsPlaying) return;
  streamIsPlaying = false;
  streamIsPaused = true;
  streamAudio.pause();
  chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
}

// Stop streaming playback completely.
function stopStreaming() {
  initStreamingAudio();
  streamIsPlaying = false;
  streamIsPaused = false;
  streamComplete = false;
  streamAudio.pause();
  streamAudio.src = '';
  streamAudio.currentTime = 0;
  if (streamBlobUrl) {
    URL.revokeObjectURL(streamBlobUrl);
    streamBlobUrl = null;
  }
  streamChunks = [];
  streamBlobDuration = 0;
  streamBlobBytes = 0;
  streamPlaybackRate = 1;
  streamLastSwapTime = 0;
  if (streamEndDeferred) { clearTimeout(streamEndDeferred); streamEndDeferred = null; }
  if (streamPauseDeferred) { clearTimeout(streamPauseDeferred); streamPauseDeferred = null; }
}

// Reset streaming state before a new session.
function resetStreaming() {
  sendDiagnostic('Resetting streaming state');
  stopStreaming();
}

// ── Shared helpers ──

function getPlayerState() {
  if (streamChunks.length > 0 && streamAudio && streamAudio.src) {
    return streamIsPaused ? 'paused' : (streamIsPlaying ? 'playing' : 'stopped');
  }
  if (!audioElement) return 'stopped';
  if (audioElement.paused) {
    return audioElement.currentTime > 0 && audioElement.currentTime < audioElement.duration ? 'paused' : 'stopped';
  }
  return 'playing';
}

function getTimeInfo() {
  if (streamChunks.length > 0 && streamAudio && streamAudio.src) {
    return {
      currentTime: streamAudio.currentTime,
      duration: streamAudio.duration || 0
    };
  }
  if (!audioElement) return null;
  return {
    currentTime: audioElement.currentTime,
    duration: audioElement.duration
  };
}

function seekTo(time) {
  if (streamChunks.length > 0 && streamAudio && streamAudio.src) {
    const maxTime = streamAudio.duration || 0;
    streamAudio.currentTime = Math.max(0, Math.min(time, maxTime));
    return true;
  }
  if (!audioElement) return false;
  try {
    audioElement.currentTime = time;
    return true;
  } catch (error) {
    console.error('Error seeking:', error);
    return false;
  }
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received message:', message.type);

  switch (message.type) {
    case 'ping':
      sendResponse({ ok: true });
      return true;

    case 'clearChunks':
      audioChunks = [];
      break;

    case 'audioChunk':
      audioChunks[message.index] = message.chunk;
      if (message.isLast) {
        const combined = concatAll(audioChunks);
        console.log('[OFFSCREEN] Combined array length:', combined.length);
        processAudioData(combined, message.mimeType, message.rate);
        audioChunks = [];
      }
      break;

    case 'resetStreaming':
      resetStreaming();
      break;

    case 'streamingChunk':
      sendDiagnostic('streamingChunk received, size: ' + message.chunk.length + ' rate: ' + message.rate);
      if (streamChunks.length === 0) {
        initStreamingAudio();
        streamChunks = [];
        streamPlaybackRate = (message.rate && !isNaN(message.rate) && message.rate > 0) ? message.rate : 1;
        sendDiagnostic('Streaming initialized, playbackRate: ' + streamPlaybackRate);
      }
      streamChunks.push(new Uint8Array(message.chunk));
      const totalBytes = streamChunks.reduce((s, c) => s + c.length, 0);
      sendDiagnostic('Buffer: chunks=' + streamChunks.length + ' bytes=' + totalBytes + ' duration=' + (totalBytes / 2 / SAMPLE_RATE).toFixed(2) + 's');

      // Lazy swap: only create new blob when playback is catching up
      if (needsSwap()) {
        swapStreamingBlob();
      }

      // Auto-play once we have enough initial buffer
      if (!streamIsPlaying && !streamIsPaused && totalBytes / 2 / SAMPLE_RATE >= START_THRESHOLD) {
        sendDiagnostic('Starting streaming playback (' + (totalBytes / 2 / SAMPLE_RATE).toFixed(2) + 's buffered)');
        playStreaming();
      }
      break;

    case 'streamComplete':
      streamComplete = true;
      sendDiagnostic('Stream complete, total duration=' + (streamChunks.length > 0 ? (streamChunks.reduce((s, c) => s + c.length, 0) / 2 / SAMPLE_RATE).toFixed(2) : 'N/A') + 's');
      break;

    case 'processAudioData':
      if (message.audioData) {
        processAudioData(message.audioData, message.mimeType);
      }
      break;

    case 'offscreenReady':
      sendResponse({ ready: true });
      return true;

    case 'play':
      if (streamChunks.length > 0 && streamAudio && streamAudio.src) {
        if (streamIsPaused || !streamIsPlaying) {
          playStreaming();
        }
      } else if (audioElement) {
        audioElement.play();
      }
      break;

    case 'pause':
      if (streamIsPlaying) {
        pauseStreaming();
      } else if (audioElement) {
        audioElement.pause();
      }
      break;

    case 'stop':
      stopStreaming();
      if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
        audioElement.src = '';
      }
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
      break;

    case 'seek':
      sendResponse({ success: seekTo(message.time) });
      return true;

    case 'setRate':
      {
        const rate = parseFloat(message.rate);
        if (!isNaN(rate) && rate > 0) {
          if (streamAudio) {
            streamPlaybackRate = rate;
            streamAudio.playbackRate = rate;
          } else if (audioElement) {
            audioElement.playbackRate = rate;
          }
        }
      }
      break;

    case 'getState':
      sendResponse({ state: getPlayerState() });
      return true;

    case 'getTimeInfo':
      sendResponse({ timeInfo: getTimeInfo() });
      return true;
  }
});

// Initialize when the document loads
document.addEventListener('DOMContentLoaded', () => {
  console.log('Offscreen document loaded');
  audioElement = document.createElement('audio');
  audioElement.id = 'audioElement';
  document.body.appendChild(audioElement);
  console.log('Offscreen document initialized');
});
