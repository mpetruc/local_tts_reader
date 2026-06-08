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
let streamPcm = null;             // Uint8Array accumulator (raw 16-bit LE PCM)
let streamBlobUrl = null;         // current blob URL
let streamIsPlaying = false;      // user-intended playing state
let streamIsPaused = false;       // user-intended paused state
let streamComplete = false;       // all chunks received
let streamPlaybackRate = 1;       // requested playback rate
let streamSwappingSrc = false;    // guard against spurious pause events during src swap
const SAMPLE_RATE = 24000;        // TTS server sample rate

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
      if (streamSwappingSrc) return;
      streamIsPlaying = true;
      streamIsPaused = false;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing' });
    };

    streamAudio.onpause = () => {
      if (streamSwappingSrc) return;
      // Don't override state if we're still supposed to be playing
      // (browser may pause briefly during buffer operations)
      if (!streamIsPlaying) return;
      streamIsPlaying = false;
      streamIsPaused = true;
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
    };

    streamAudio.onended = () => {
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
  }
}

// Append a raw PCM chunk (16-bit LE mono, array of bytes) to streamPcm.
function appendStreamingChunk(chunkArray) {
  const chunk = new Uint8Array(chunkArray);
  const newPcm = new Uint8Array(streamPcm.length + chunk.length);
  newPcm.set(streamPcm);
  newPcm.set(chunk, streamPcm.length);
  streamPcm = newPcm;
}

// Create a new WAV blob URL and swap it into the streaming audio element.
// Preserves playback position, rate, and play/pause state.
function swapStreamingBlob() {
  initStreamingAudio();

  const currentTime = streamAudio.currentTime;
  const wasPlaying = streamIsPlaying && !streamIsPaused && !streamAudio.paused;

  // Swap source
  streamBlobUrl = URL.createObjectURL(pcmToWavBlob(streamPcm));
  streamAudio.src = streamBlobUrl;
  streamAudio.currentTime = currentTime;
  streamAudio.playbackRate = streamPlaybackRate;

  if (wasPlaying) {
    streamSwappingSrc = true;
    streamAudio.play().catch(() => {});
    // Clear guard after a tick — events from the swap are synchronous
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
  streamPcm = null;
  streamPlaybackRate = 1;
}

// Reset streaming state before a new session.
function resetStreaming() {
  sendDiagnostic('Resetting streaming state');
  stopStreaming();
}

// ── Shared helpers ──

function getPlayerState() {
  if (streamIsPlaying || (streamPcm && streamAudio && streamAudio.src)) {
    return streamIsPaused ? 'paused' : (streamIsPlaying ? 'playing' : 'stopped');
  }
  if (!audioElement) return 'stopped';
  if (audioElement.paused) {
    return audioElement.currentTime > 0 && audioElement.currentTime < audioElement.duration ? 'paused' : 'stopped';
  }
  return 'playing';
}

function getTimeInfo() {
  if (streamPcm && streamAudio && streamAudio.src) {
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
  if (streamPcm && streamAudio && streamAudio.src) {
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
      if (!streamPcm) {
        initStreamingAudio();
        streamPcm = new Uint8Array(0);
        streamPlaybackRate = (message.rate && !isNaN(message.rate) && message.rate > 0) ? message.rate : 1;
        sendDiagnostic('Streaming initialized, playbackRate: ' + streamPlaybackRate);
      }
      appendStreamingChunk(message.chunk);
      sendDiagnostic('Buffer: bytes=' + streamPcm.length + ' duration=' + (streamPcm.length / 2 / SAMPLE_RATE).toFixed(2) + 's');
      swapStreamingBlob();
      // Auto-play on first chunk
      if (!streamIsPlaying && !streamIsPaused) {
        sendDiagnostic('Starting streaming playback');
        playStreaming();
      }
      break;

    case 'streamComplete':
      streamComplete = true;
      sendDiagnostic('Stream complete, total duration=' + (streamPcm ? (streamPcm.length / 2 / SAMPLE_RATE).toFixed(2) : 'N/A') + 's');
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
      if (streamPcm && streamAudio && streamAudio.src) {
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
