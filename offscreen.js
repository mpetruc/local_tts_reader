// Batched concat to avoid V8's ~655K argument limit
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

// ── Streaming state ──
let audioCtx = null;
let audioBuffer = null;        // AudioBuffer that grows as chunks arrive
let bufferLength = 0;          // number of frames written into audioBuffer
let bufferCapacity = 0;        // total capacity of audioBuffer
let sourceNode = null;         // current AudioBufferSourceNode
let audioStartTime = 0;        // audioCtx.currentTime when playback started
let audioOffset = 0;           // playback offset (frames) within audioBuffer
let isStreamingPlaying = false;
let isStreamingPaused = false;
let streamDuration = 0;        // total duration of streamed audio so far
let streamPlaybackRate = 1;    // playback rate for streaming mode
let timeUpdateInterval = null;
const SAMPLE_RATE = 24000;     // TTS server sample rate


// Send diagnostic info to background console (offscreen logs are in separate DevTools)
function sendDiagnostic(msg) {
  console.log('[OFFSCREEN]', msg);
  chrome.runtime.sendMessage({ type: 'streamingDiagnostic', msg });
}
// ── Non-streaming helpers ──

// Ensure the audio element exists
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

// Process audio data received from background script
function processAudioData(audioDataArray, mimeType, rate) {
  try {
    initAudio();

    // Convert array back to Uint8Array
    const uint8Array = new Uint8Array(audioDataArray);

    // Create blob from the array
    const blob = new Blob([uint8Array], { type: mimeType });

    // Create URL for the blob
    const audioUrl = URL.createObjectURL(blob);

    // Play the audio
    playAudioUrl(audioUrl, rate);

    // Notify that audio is ready to play
    chrome.runtime.sendMessage({ type: 'audioReady' });
  } catch (error) {
    console.error('Error processing audio data:', error);
    chrome.runtime.sendMessage({
      type: 'streamError',
      error: error.message
    });
  }
}

// Play audio from URL
function playAudioUrl(audioUrl, rate) {
  try {
    console.log('[OFFSCREEN] Playing audio URL:', audioUrl);

    // Set up audio element
    audioElement.src = audioUrl;

    // Apply playback rate AFTER src is set (setting src can reset playbackRate)
    if (rate && !isNaN(rate) && rate > 0) {
      audioElement.playbackRate = rate;
      console.log('[OFFSCREEN] Playback rate set to:', rate);
    }

    // Set up event listeners
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

    // Add timeupdate event for seeking
    audioElement.ontimeupdate = () => {
      chrome.runtime.sendMessage({
        type: 'timeUpdate',
        timeInfo: {
          currentTime: audioElement.currentTime,
          duration: audioElement.duration
        }
      });
    };

    // Start playing
    audioElement.play().catch(err => {
      console.error('Play error:', err);
      chrome.runtime.sendMessage({
        type: 'streamError',
        error: err.message
      });
    });
  } catch (error) {
    console.error('Error playing audio:', error);
    chrome.runtime.sendMessage({
      type: 'streamError',
      error: error.message
    });
  }
}

// ── Streaming helpers ──

// Initialise (or reset) the streaming AudioContext and buffer.
// Returns the playback rate applied.
function initStreamingAudio(rate) {
  // Close any previous context
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  streamPlaybackRate = rate && !isNaN(rate) && rate > 0 ? rate : 1;
  audioBuffer = null;
  bufferLength = 0;
  bufferCapacity = 0;
  sourceNode = null;
  audioStartTime = 0;
  audioOffset = 0;
  isStreamingPlaying = false;
  isStreamingPaused = false;
  streamDuration = 0;
}

// Append a raw PCM chunk (16-bit, little-endian, mono) to the streaming buffer.
// The buffer is grown as needed.
function appendStreamingChunk(chunkArray) {
  let pcmBytes = new Uint8Array(chunkArray);
  // Handle odd-length chunks: stream reader may split mid-sample.
  // Buffer the stray byte and prepend it to the next chunk.
  if (typeof appendStreamingChunk._leftover !== 'undefined') {
    const combined = new Uint8Array(pcmBytes.length + 1);
    combined[0] = appendStreamingChunk._leftover;
    combined.set(pcmBytes, 1);
    pcmBytes = combined;
    appendStreamingChunk._leftover = undefined;
  }
  const newFrames = Math.floor(pcmBytes.length / 2); // 2 bytes per sample (16-bit)
  if (pcmBytes.length % 2 === 1) {
    appendStreamingChunk._leftover = pcmBytes[pcmBytes.length - 1];
  }

  // Grow buffer if needed (double capacity each time)
  if (!audioBuffer || bufferLength + newFrames > bufferCapacity) {
    const newCapacity = Math.max(
      bufferCapacity * 2 || newFrames * 4, // start with 4x headroom
      bufferLength + newFrames
    );
    const oldBuffer = audioBuffer;
    audioBuffer = audioCtx.createBuffer(1, newCapacity, SAMPLE_RATE);
    if (oldBuffer) {
      audioBuffer.getChannelData(0).set(oldBuffer.getChannelData(0).slice(0, bufferLength));
    }
    bufferCapacity = newCapacity;
  }

  const channelData = audioBuffer.getChannelData(0);
  // Decode 16-bit little-endian PCM byte-by-byte (avoids Int16Array alignment issues)
  for (let i = 0; i < newFrames; i++) {
    const lo = pcmBytes[i * 2];
    const hi = pcmBytes[i * 2 + 1];
    let sample = lo | (hi << 8); // little-endian
    if (sample >= 32768) sample -= 65536; // sign-extend
    channelData[bufferLength + i] = sample / 32768;
  }
  bufferLength += newFrames;
  streamDuration = bufferLength / SAMPLE_RATE;
}

// Start (or resume) streaming playback from the current offset.
async function playStreaming() {
  if (!audioBuffer || bufferLength === 0) return;

  // If we already have a source playing, don't create a new one
  if (sourceNode && isStreamingPlaying && !isStreamingPaused) return;

  const remainingFrames = bufferLength - audioOffset;
  if (remainingFrames <= 0) return;

  // Create a new source for the remaining audio
  sourceNode = audioCtx.createBufferSource();
  // Use the full buffer but start at the offset
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioCtx.destination);
  sourceNode.playbackRate.value = streamPlaybackRate;
  console.log('[OFFSCREEN] playStreaming: offset=', audioOffset, 'bufferLen=', bufferLength, 'rate=', streamPlaybackRate);
  sourceNode.onended = () => {
    // Only transition to stopped if we've played all buffered audio
    // and no new chunks are expected (source ended naturally)
    sendDiagnostic('sourceNode.onended fired, offset=' + audioOffset + ' bufferLen=' + bufferLength);
    if (audioOffset >= bufferLength) {
      isStreamingPlaying = false;
      isStreamingPaused = false;
      sourceNode = null;
      if (timeUpdateInterval) {
        clearInterval(timeUpdateInterval);
        timeUpdateInterval = null;
      }
      sendDiagnostic('Playback stopped (all audio consumed)');
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
    } else {
      // Buffer grew while playing — more chunks will trigger restart
      sendDiagnostic('source ended but buffer still growing, will restart');
      sourceNode = null; // allow new source to be created
    }
    // If buffer grew (more chunks arrived), the message handler will restart playback
  };

  const offsetSeconds = audioOffset / SAMPLE_RATE;
  sendDiagnostic('playStreaming: ctx state before resume: ' + audioCtx.state);
  // Resume AudioContext (may be suspended in offscreen documents)
  await audioCtx.resume();
  sendDiagnostic('playStreaming: ctx state after resume: ' + audioCtx.state);
  sourceNode.start(0, offsetSeconds);
  sendDiagnostic('sourceNode.start() called at offset ' + offsetSeconds + 's, bufferLen=' + bufferLength);
  audioStartTime = audioCtx.currentTime - offsetSeconds;
  isStreamingPlaying = true;
  isStreamingPaused = false;

  chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing' });

  // Start time update interval
  if (timeUpdateInterval) clearInterval(timeUpdateInterval);
  timeUpdateInterval = setInterval(() => {
    if (!isStreamingPlaying || isStreamingPaused) return;
    const elapsed = (audioCtx.currentTime - audioStartTime) * SAMPLE_RATE;
    const currentFrame = Math.min(audioOffset + elapsed, bufferLength);
    const currentTime = currentFrame / SAMPLE_RATE;
    chrome.runtime.sendMessage({
      type: 'timeUpdate',
      timeInfo: {
        currentTime: currentTime,
        duration: 0 // unknown until stream completes
      }
    });
  }, 250);
}

// Pause streaming playback.
function pauseStreaming() {
  if (!isStreamingPlaying || isStreamingPaused) return;

  // Save current playback position
  const elapsed = (audioCtx.currentTime - audioStartTime) * SAMPLE_RATE;
  audioOffset = Math.min(audioOffset + elapsed, bufferLength);

  // Stop the current source
  if (sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode.disconnect();
    sourceNode = null;
  }

  isStreamingPaused = true;
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }
  chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
}

// Stop streaming playback completely.
function stopStreaming() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  audioBuffer = null;
  bufferLength = 0;
  bufferCapacity = 0;
  audioOffset = 0;
  audioStartTime = 0;
  isStreamingPlaying = false;
  isStreamingPaused = false;
  streamDuration = 0;
}

// ── Shared helpers ──

// Get current player state
function getPlayerState() {
  if (isStreamingPlaying) {
    return isStreamingPaused ? 'paused' : 'playing';
  }
  if (!audioElement) return 'stopped';
  if (audioElement.paused) {
    return audioElement.currentTime > 0 && audioElement.currentTime < audioElement.duration ? 'paused' : 'stopped';
  }
  return 'playing';
}

// Get current time and duration
function getTimeInfo() {
  if (isStreamingPlaying || (audioCtx && bufferLength > 0)) {
    let currentFrame = audioOffset;
    if (isStreamingPlaying && !isStreamingPaused && audioCtx) {
      const elapsed = (audioCtx.currentTime - audioStartTime) * SAMPLE_RATE;
      currentFrame = Math.min(audioOffset + elapsed, bufferLength);
    }
    return {
      currentTime: currentFrame / SAMPLE_RATE,
      duration: streamDuration || 0
    };
  }
  if (!audioElement) return null;
  return {
    currentTime: audioElement.currentTime,
    duration: audioElement.duration
  };
}

// Seek to a specific time
function seekTo(time) {
  if (isStreamingPlaying) {
    // Seek within buffered streaming audio
    const targetFrame = Math.max(0, Math.min(time * SAMPLE_RATE, bufferLength));
    audioOffset = targetFrame;
    if (sourceNode) {
      try { sourceNode.stop(); } catch {}
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (isStreamingPlaying && !isStreamingPaused) {
      playStreaming();
    }
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

// Handle messages from the background script
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
      // Store chunk at its index (non-streaming mode)
      audioChunks[message.index] = message.chunk;
      if (message.isLast) {
        // Combine all chunks using batched concat
        const combined = concatAll(audioChunks);
        console.log('[OFFSCREEN] Combined array length:', combined.length);
        processAudioData(combined, message.mimeType, message.rate);
        audioChunks = [];
      }
      break;

    case 'streamingChunk':
      // Real-time streaming PCM chunk — append and play immediately
      sendDiagnostic('streamingChunk received, size: ' + message.chunk.length + ' rate: ' + message.rate);
      if (!audioCtx) {
        initStreamingAudio(message.rate);
        sendDiagnostic('AudioContext created, playbackRate: ' + streamPlaybackRate);
      }
      appendStreamingChunk(message.chunk);
      sendDiagnostic('Buffer: frames=' + bufferLength + ' duration=' + (bufferLength / SAMPLE_RATE).toFixed(2) + 's');

      // Start playing on first chunk if not already playing
      if (!isStreamingPlaying && !isStreamingPaused) {
        sendDiagnostic('Starting streaming playback');
        playStreaming().catch(console.error);
      } else if (isStreamingPaused) {
        // If paused, don't auto-resume — wait for explicit play command
      } else if (isStreamingPlaying && !sourceNode) {
        // Source ended but more chunks arrived — restart playback from offset
        sendDiagnostic('Restarting playback after source end');
        playStreaming().catch(console.error);
      }
      break;

    case 'processAudioData':
      if (message.audioData) {
        processAudioData(message.audioData, message.mimeType);
      }
      break;

    case 'offscreenReady':
      // Respond to readiness check from background
      sendResponse({ ready: true });
      return true;

    case 'play':
      if (isStreamingPlaying || (audioCtx && bufferLength > 0)) {
        if (isStreamingPaused) {
          playStreaming().catch(console.error); // resumes from saved offset
        } else if (!isStreamingPlaying) {
          playStreaming().catch(console.error); // start from beginning or saved offset
        }
      } else if (audioElement) {
        audioElement.play();
      }
      break;

    case 'pause':
      if (isStreamingPlaying && !isStreamingPaused) {
        pauseStreaming();
      } else if (audioElement) {
        audioElement.pause();
      }
      break;

    case 'stop':
      // Stop both streaming and legacy audio
      stopStreaming();
      if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
        audioElement.src = '';
      }
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
      break;

    case 'seek':
      const success = seekTo(message.time);
      sendResponse({ success });
      return true;

    case 'setRate':
      {
        const rate = parseFloat(message.rate);
        if (!isNaN(rate) && rate > 0) {
          if (audioCtx) {
            streamPlaybackRate = rate;
            if (sourceNode) sourceNode.playbackRate.value = rate;
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
