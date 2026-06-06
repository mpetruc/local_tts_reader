let audioPlayer = null;

function updateStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `visible ${isError ? 'error' : 'success'}`;
  setTimeout(() => status.className = '', 3000);
}

function updateControlButtons(state) {
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const seekBar = document.getElementById('seekBar');
  
  // Hide loading indicator by default
  loadingIndicator.style.display = 'none';
  
  // Stop button is always enabled (except during loading)
  stopBtn.disabled = state === 'loading';
  
  switch(state) {
    case 'loading':
      playBtn.disabled = true;
      pauseBtn.disabled = true;
      seekBar.disabled = true;
      loadingIndicator.style.display = 'flex';
      break;
    case 'ready':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      seekBar.disabled = false;
      break;
    case 'playing':
      playBtn.disabled = true;
      pauseBtn.disabled = false;
      seekBar.disabled = false;
      break;
    case 'paused':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      seekBar.disabled = false;
      break;
    case 'stopped':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      seekBar.disabled = true;
      // Reset seek bar to beginning
      seekBar.value = 0;
      document.getElementById('currentTime').textContent = '0:00';
      document.getElementById('duration').textContent = '0:00';
      break;
    default:
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      seekBar.disabled = true;
  }
}

function getSettings() {
  return {
    serverUrl: document.getElementById('serverUrl').value,
    voice: document.getElementById('voice').value,
    speed: document.getElementById('speed').value,
    recordAudio: document.getElementById('recordAudio').checked,
    preprocessText: document.getElementById('preprocessText').checked,
    highlightSentences: document.getElementById('highlightSentences').checked
  };
}

// Fetch available voices from the backend and populate the <select>
async function populateVoices() {
  const voiceSelect = document.getElementById('voice');
  const baseUrl = document.getElementById('serverUrl').value.trim();
  if (!baseUrl) return; // no base URL configured

  let base;
  try {
    base = new URL(baseUrl).origin;
  } catch {
    base = baseUrl;
  }

  // Try multiple endpoint patterns in priority order:
  // 1. /v1/audio/voices  — Kokoro, OpenAI-compatible backends
  // 2. /v1/voices         — Omnivoice
  const voiceEndpoints = [
    `${base}/v1/audio/voices`,
    `${base}/v1/voices`,
  ];

  for (const url of voiceEndpoints) {
    const voices = await fetchVoices(url);
    if (voices.length > 0) {
      _fillVoiceSelect(voiceSelect, voices);
      return;
    }
  }

  // All endpoints failed — keep existing options
  console.error('Failed to populate voices from any endpoint');
}

/**
 * Fetch voices from a single endpoint and normalise the response.
 * Returns an array of {id, label} objects, or [] on any failure.
 */
async function fetchVoices(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();

    // Normalize: backends return either string[] or {id, name, ...}[]
    const raw = Array.isArray(data.voices) ? data.voices
      : Array.isArray(data) ? data
      : [];
    if (raw.length === 0) return [];

    return raw.map(v => {
      if (typeof v === 'string') return { id: v, label: v.replace(/_/g, ' ') };
      const id = v.id || v.voice_id || v.name || '';
      const label = v.name || v.id || v.voice_id || '';
      return { id, label };
    }).filter(v => v.id);
  } catch {
    return [];
  }
}

/**
 * Populate the <select> element with a list of {id, label} voices,
 * preserving the current selection if possible.
 */
function _fillVoiceSelect(voiceSelect, voices) {
  const current = voiceSelect.value;
  voiceSelect.innerHTML = '';

  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    voiceSelect.appendChild(opt);
  }

  // Restore previous selection if still present
  if (Array.from(voiceSelect.options).some(o => o.value === current)) {
    voiceSelect.value = current;
  }
}

// Attach listener to fetch voices when the user interacts with the dropdown
document.getElementById('voice').addEventListener('focus', populateVoices);

async function saveSettings() {
  try {
    const settings = getSettings();
    await chrome.storage.local.set(settings);
    updateStatus('Settings saved!', false);
  } catch (e) {
    console.error('Error saving settings:', e);
    updateStatus('Failed to save settings', true);
  }
}

// Format time in seconds to MM:SS format
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Sync player state when popup opens
async function syncPlayerState() {
  if (audioPlayer) {
    const state = await audioPlayer.getState();
    updateControlButtons(state);
    
    // Also sync the seek bar
    const timeInfo = await audioPlayer.getTimeInfo();
    if (timeInfo) {
      const seekBar = document.getElementById('seekBar');
      seekBar.max = timeInfo.duration;
      seekBar.value = timeInfo.currentTime;
      document.getElementById('currentTime').textContent = formatTime(timeInfo.currentTime);
      document.getElementById('duration').textContent = formatTime(timeInfo.duration);
    }
  }
}

// Update seek bar periodically
function startSeekBarUpdates() {
  const updateInterval = setInterval(async () => {
    if (!audioPlayer) return;
    
    const state = await audioPlayer.getState();
    if (state !== 'playing' && state !== 'paused') {
      clearInterval(updateInterval);
      return;
    }
    
    const timeInfo = await audioPlayer.getTimeInfo();
    if (timeInfo) {
      const seekBar = document.getElementById('seekBar');
      // Only update if user is not currently dragging
      if (!seekBar.classList.contains('seeking')) {
        seekBar.max = timeInfo.duration;
        seekBar.value = timeInfo.currentTime;
        document.getElementById('currentTime').textContent = formatTime(timeInfo.currentTime);
        document.getElementById('duration').textContent = formatTime(timeInfo.duration);
      }
    }
  }, 1000);
  
  return updateInterval;
}

// Process text based on settings
function processText(text, settings) {
  if (settings.preprocessText) {
    return TextProcessor.process(text);
  }
  return text;
}
document.addEventListener('DOMContentLoaded', async function() {
  // Initialize audio player
  audioPlayer = new AudioPlayer();
  await audioPlayer.init();
  
  // Load saved settings (must complete before populating voices)
  const result = await chrome.storage.local.get({
    serverUrl: DEFAULT_SETTINGS.serverUrl,
    voice: DEFAULT_SETTINGS.voice,
    speed: DEFAULT_SETTINGS.speed,
    recordAudio: DEFAULT_SETTINGS.recordAudio,
    preprocessText: DEFAULT_SETTINGS.preprocessText,
    highlightSentences: DEFAULT_SETTINGS.highlightSentences
  });

  document.getElementById('serverUrl').value = result.serverUrl;
  document.getElementById('speed').value = result.speed;
  document.getElementById('recordAudio').checked = result.recordAudio;
  document.getElementById('preprocessText').checked = result.preprocessText;
  document.querySelector('.speed-value').textContent = `${result.speed}x`;
  document.getElementById('highlightSentences').checked = result.highlightSentences;

  // Populate voice list from server (needs serverUrl set first)
  await populateVoices();

  // Restore stored voice if present in the populated list
  const voiceSelect = document.getElementById('voice');
  if (Array.from(voiceSelect.options).some(o => o.value === result.voice)) {
    voiceSelect.value = result.voice;
  }
  // Sync player state
  syncPlayerState();
  
  // Start seek bar updates
  let updateInterval = startSeekBarUpdates();
  
  // Set up seek bar events
  const seekBar = document.getElementById('seekBar');
  
  // When user starts seeking
  seekBar.addEventListener('mousedown', function() {
    seekBar.classList.add('seeking');
  });
  
  // When user is seeking
  seekBar.addEventListener('input', function() {
    document.getElementById('currentTime').textContent = formatTime(seekBar.value);
  });
  
  // When user finishes seeking
  seekBar.addEventListener('change', async function() {
    const newTime = parseFloat(seekBar.value);
    await audioPlayer.seek(newTime);
    seekBar.classList.remove('seeking');
  });
  
  // Speed slider
  document.getElementById('speed').addEventListener('input', function(e) {
    // Update playback rate in the offscreen audio element
    const rate = parseFloat(e.target.value);
    if (!isNaN(rate)) {
      audioPlayer.setPlaybackRate(rate);
    }
    document.querySelector('.speed-value').textContent = `${e.target.value}x`;
  });
  
  // Play button
  document.getElementById('playBtn').addEventListener('click', async function() {
    try {
      const state = await audioPlayer.getState();
      
      if (state === 'paused' || state === 'ready') {
        audioPlayer.resume();
        updateControlButtons('playing');
        
        // Restart seek bar updates
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = startSeekBarUpdates();
      } else {
        const tabs = await chrome.tabs.query({active: true, currentWindow: true});
        const [tab] = tabs;

        // Try selection first (preserves newlines at block boundaries)
        const selResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const sel = window.getSelection();
            return sel ? sel.toString().trim() : '';
          }
        });
        let text = selResult[0]?.result || '';

        // No selection — extract article content via content extractor
        if (!text) {
          const extractResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['contentExtractor.js']
          });
          text = extractResult[0]?.result || '';
        }
        const settings = getSettings();

        // When highlighting is enabled, pass tab ID and original text so the
        // background highlighter can match against the DOM (not TTS-cleaned text)
        if (settings.highlightSentences) {
          settings.tabId = tab.id;
          settings.originalText = text;
        }

        // Process text if enabled
        text = processText(text, settings);

        await saveSettings();
        updateControlButtons('loading');
        await audioPlayer.play(text, settings);
        
        // Restart seek bar updates
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = startSeekBarUpdates();
      }
    } catch (error) {
      console.error('Error:', error);
      updateStatus(error.message, true);
      updateControlButtons('stopped');
    }
  });
  
  // Pause button
  document.getElementById('pauseBtn').addEventListener('click', function() {
    audioPlayer.pause();
    updateControlButtons('paused');
  });
  
  // Stop button
  document.getElementById('stopBtn').addEventListener('click', function() {
    audioPlayer.stop();
    updateControlButtons('stopped');
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });
  // Save settings
  ['serverUrl', 'voice', 'speed', 'recordAudio', 'preprocessText', 'highlightSentences'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
  
  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'playerStateUpdate':
        updateControlButtons(message.state);
        if (message.state === 'playing' && !updateInterval) {
          updateInterval = startSeekBarUpdates();
        }
        break;
      case 'streamError':
        updateStatus(message.error, true);
        updateControlButtons('stopped');
        break;
        
      case 'timeUpdate':
        if (message.timeInfo && !seekBar.classList.contains('seeking')) {
          seekBar.max = message.timeInfo.duration;
          seekBar.value = message.timeInfo.currentTime;
          document.getElementById('currentTime').textContent = formatTime(message.timeInfo.currentTime);
          document.getElementById('duration').textContent = formatTime(message.timeInfo.duration);
        }
        break;
    }
  });
});

// Export functions for unit tests (no effect in the extension runtime)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    populateVoices: populateVoices,
    populateVoiceSelect: populateVoices
  };
}