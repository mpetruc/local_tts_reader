const VERSION = 'edee4ba';
let audioElement = null;
let isPlaying = false;
let audioChunks = [];

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
function processAudioData(audioDataArray, mimeType) {
  try {
    initAudio();
    console.log(`[OFFSCREEN]${VERSION} processAudioData: input array length`, audioDataArray.length, 'mimeType:', mimeType);

    // Convert array back to Uint8Array
    const uint8Array = new Uint8Array(audioDataArray);
    console.log(`[OFFSCREEN]${VERSION} Uint8Array created, length:`, uint8Array.length);

    // Create blob from the array
    const blob = new Blob([uint8Array], { type: mimeType });
    console.log(`[OFFSCREEN]${VERSION} Blob created, size:`, blob.size, 'type:', blob.type);

    // Create URL for the blob
    const audioUrl = URL.createObjectURL(blob);
    console.log(`[OFFSCREEN]${VERSION} Object URL created`);

    // Play the audio
    playAudioUrl(audioUrl);

    // Notify that audio is ready to play
    chrome.runtime.sendMessage({ type: 'audioReady' });
  } catch (error) {
    console.error(`[OFFSCREEN]${VERSION} Error processing audio data:`, error);
    chrome.runtime.sendMessage({
      type: 'streamError',
      error: error.message
    });
  }
}

// Play audio from URL
function playAudioUrl(audioUrl) {
  try {
    console.log('Playing audio URL:', audioUrl);

    // Set up audio element
    audioElement.src = audioUrl;

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
    console.error('Error playing audio URL:', error);
    chrome.runtime.sendMessage({
      type: 'streamError',
      error: error.message
    });
  }
}

// Get current player state
function getPlayerState() {
  if (!audioElement) return 'stopped';
  if (audioElement.paused) {
    return audioElement.currentTime > 0 && audioElement.currentTime < audioElement.duration ? 'paused' : 'stopped';
  }
  return 'playing';
}

// Get current time and duration
function getTimeInfo() {
  if (!audioElement) return null;
  return {
    currentTime: audioElement.currentTime,
    duration: audioElement.duration
  };
}

// Seek to a specific time
function seekTo(time) {
  if (!audioElement) return false;
  try {
    audioElement.currentTime = time;
    return true;
  } catch (error) {
    console.error('Error seeking:', error);
    return false;
  }
}

// Helper: concat arrays without hitting V8's spread-argument limit
function concatAll(arrays) {
  const result = [];
  for (const arr of arrays) {
    const BATCH = 65536;
    for (let i = 0; i < arr.length; i += BATCH) {
      result.push(...arr.slice(i, i + BATCH));
    }
  }
  return result;
}

// Handle messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received message:', message.type);
  
  switch (message.type) {
    case 'ping':
      sendResponse({ ok: true });
      return true;
    case 'clearChunks':
      audioChunks = [];
      console.log(`[OFFSCREEN]${VERSION} Chunks cleared`);
      break;
    case 'audioChunk': {
      // Store chunk at its index
      const chunk = message.chunk;
      console.log(`[OFFSCREEN]${VERSION} Chunk`, message.index, 'received, length:', chunk ? chunk.length : 'null', 'isLast:', message.isLast);
      audioChunks[message.index] = chunk;
      if (message.isLast) {
        const expected = audioChunks.length;
        const holes = audioChunks.filter(c => c === undefined).length;
        console.log(`[OFFSCREEN]${VERSION} Last chunk. Total slots:`, expected, 'Holes:', holes);
        try {
          const combined = concatAll(audioChunks);
          console.log(`[OFFSCREEN]${VERSION} Combined array length:`, combined.length);
          processAudioData(combined, message.mimeType);
          // Confirm to background so it's visible in BG console too
          chrome.runtime.sendMessage({ type: 'chunksProcessed', length: combined.length });
        } catch (err) {
          console.error(`[OFFSCREEN]${VERSION} Failed to combine chunks:`, err);
          chrome.runtime.sendMessage({ type: 'streamError', error: err.message });
        }
        audioChunks = [];
      }
      break;
    }
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
      if (audioElement) {
        audioElement.play();
      }
      break;
      
    case 'pause':
      if (audioElement) {
        audioElement.pause();
      }
      break;
      
case 'stop':
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
    audioElement.src = '';
    chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
  }
  break;
      
    case 'seek':
      const success = seekTo(message.time);
      sendResponse({ success });
      return true;
      
    case 'setRate':
      if (audioElement) {
        const rate = parseFloat(message.rate);
        if (!isNaN(rate) && rate > 0) {
          audioElement.playbackRate = rate;
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