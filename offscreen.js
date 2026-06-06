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


// Wrap raw PCM bytes (int16 little-endian) in a minimal WAV header
// so the browser <audio> element can decode and play it.
function pcmToWav(pcmBytes, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBytes.length;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + dataSize);
  const view = new DataView(wav.buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // 'RIFF'
  view.setUint32(4, headerSize + dataSize - 8, true);
  view.setUint32(8, 0x57415645, false); // 'WAVE'

  // fmt subchunk
  view.setUint32(12, 0x666d7420, false); // 'fmt '
  view.setUint32(16, 16, true);          // subchunk1 size (16 for PCM)
  view.setUint16(20, 1, true);           // audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  view.setUint32(36, 0x64617461, false); // 'data'
  view.setUint32(40, dataSize, true);

  // Copy PCM samples
  wav.set(pcmBytes, headerSize);
  return wav;
}
// Process audio data received from background script
function processAudioData(audioDataArray, mimeType) {
  try {
    initAudio();
    
    // Convert array back to Uint8Array
    const uint8Array = new Uint8Array(audioDataArray);
    
    let finalBytes = uint8Array;
    let finalMimeType = mimeType;
    
    // Wrap raw PCM in a WAV header so <audio> can play it
    if (mimeType && mimeType.includes('pcm')) {
      finalBytes = pcmToWav(uint8Array, 24000);
      finalMimeType = 'audio/wav';
    }
    
    // Create blob from the array
    const blob = new Blob([finalBytes], { type: finalMimeType });
    
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
    case 'audioChunk':
      // Store chunk at its index
      audioChunks[message.index] = message.chunk;
      if (message.isLast) {
        // Combine all chunks
        const combined = [].concat(...audioChunks);
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