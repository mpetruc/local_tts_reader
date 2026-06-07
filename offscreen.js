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
    
    // Convert array back to Uint8Array
    const uint8Array = new Uint8Array(audioDataArray);
    
    // Create blob from the array
    const blob = new Blob([uint8Array], { type: mimeType });
    
    // Create URL for the blob
    const audioUrl = URL.createObjectURL(blob);
    
    // Play the audio
    playAudioUrl(audioUrl);
    
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

// Handle messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received message:', message.type);
  
  switch (message.type) {
    case 'clearChunks':
      audioChunks = [];
      break;
    case 'audioChunk':
      // Store chunk at its index
      audioChunks[message.index] = message.chunk;
      if (message.isLast) {
        // Combine all chunks using batched concat
        const combined = concatAll(audioChunks);
        console.log('[OFFSCREEN] Combined array length:', combined.length);
        processAudioData(combined, message.mimeType);
        audioChunks = [];
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