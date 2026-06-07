const VERSION = '6f51f69';
let offscreenTabId = null;
let offscreenResolve = null; // resolved when offscreen tab is created

// Listen for offscreen tab creation
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url && tab.url.includes(chrome.runtime.id)) {
    console.log(`[BG]${VERSION} Offscreen tab created: ${tab.id}`);
    if (offscreenResolve) {
      offscreenResolve(tab.id);
      offscreenResolve = null;
    }
  }
});

// Create or get the offscreen document.
// Reuse existing if available. Create new only if none exists.
async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    offscreenDocument = existingContexts[0];
    offscreenTabId = existingContexts[0].tab.id;
    console.log(`[BG]${VERSION} Reusing existing offscreen tab ${offscreenTabId}`);
    return;
  }

  // Create new offscreen and wait for tabs.onCreated to fire
  const tabIdPromise = new Promise((resolve) => {
    offscreenResolve = resolve;
  });

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Playing TTS audio in the background'
  });
  console.log(`[BG]${VERSION} Offscreen document created`);

  // Wait for the tab ID (with timeout)
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Offscreen tab timeout')), 5000)
  );

  try {
    offscreenTabId = await Promise.race([tabIdPromise, timeout]);
    offscreenDocument = null; // will be set from getContexts if needed
    console.log(`[BG]${VERSION} Offscreen tab ID: ${offscreenTabId}`);
  } catch (err) {
    console.warn(`[BG]${VERSION} Offscreen tab not found:`, err.message);
  }
}
// Set up context menu items
function setupContextMenu() {
  chrome.contextMenus.create({
    id: "readAloud",
    title: "Read Aloud",
    contexts: ["selection", "page"]
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "readAloud") {
    // Extract text: prefer DOM getSelection (preserves newlines at block
    // boundaries) over info.selectionText (collapses whitespace).
    const [selResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        if (sel && sel.toString().trim()) return sel.toString();
        return null;
      }
    });
    const selectedText = selResult?.result || '';

    if (selectedText) {
      processAndReadText(selectedText, tab.id);
    } else {
      // No selection — extract article content (not the whole page)
      const [pageResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['contentExtractor.js']
      });
      if (pageResult?.result) {
        processAndReadText(pageResult.result, tab.id);
      }
    }
  }
});

// Process and read text with default settings
async function processAndReadText(text, tabId) {
  try {
    // Get default settings
    const settings = await chrome.storage.local.get({
      serverUrl: 'http://localhost:8000/v1/audio/speech',
      voice: 'af_bella',
      speed: 1.0,
      recordAudio: false,
      preprocessText: true,
      highlightSentences: false
    });
    
    // Save original text for highlighting (must match DOM text closely)
    const originalText = text;

    // Process text if enabled
    if (settings.preprocessText && tabId) {
      try {
        // Inject the text processor script if needed
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['textProcessor.js']
        });
        
        // Process the text
        const result = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (textToProcess) => {
            return window.TextProcessor.process(textToProcess);
          },
          args: [text]
        });
        
        if (result && result[0] && result[0].result) {
          text = result[0].result;
        }
      } catch (error) {
        console.error('Error processing text:', error);
        // Fall back to using the original text
      }
    }
    
    // Set state to loading
    currentPlayerState = 'loading';
    chrome.runtime.sendMessage({ 
      type: 'playerStateUpdate', 
      state: 'loading' 
    });
    
    // When highlighting is enabled, pass the tab ID and original text so
    // startStreamingAudio can send the unprocessed text to the highlighter
    // (it needs to match the DOM, not the TTS-cleaned version).
    if (settings.highlightSentences && tabId) {
      settings.tabId = tabId;
      settings.originalText = originalText;
    }
    // Enable recording if the user toggled it in settings
    isRecording = settings.recordAudio || false;

    // Start streaming audio
    startStreamingAudio(text, settings);
  } catch (error) {
    console.error('Error in processAndReadText:', error);
    chrome.runtime.sendMessage({ 
      type: 'streamError', 
      error: error.message 
    });
  }
}

// Handle messages from popup or offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'setupOffscreen':
      setupOffscreenDocument().then(() => sendResponse({ success: true }));
      return true;
      
case 'startStreaming':
  isRecording = message.record;
  // Set state to loading before starting the audio stream
  currentPlayerState = 'loading';
  chrome.runtime.sendMessage({
    type: 'playerStateUpdate',
    state: 'loading'
  });
  // Ensure offscreen ready and start streaming asynchronously
  (async () => {
    await startStreamingAudio(message.text, message.settings);
    sendResponse({ success: true });
  })();
  return true;
      
    case 'controlAudio':
// Ensure offscreen document exists before forwarding control messages
(async () => {
  if (!offscreenDocument) {
    await setupOffscreenDocument();
  }
  chrome.runtime.sendMessage({
    type: message.action,
    data: message.data
  });
})();
      return true;
      
    case 'stateUpdate':
      currentPlayerState = message.state;
      chrome.runtime.sendMessage({
        type: 'playerStateUpdate',
        state: message.state
      });
      // Clear highlights when playback stops
      if (message.state === 'stopped' && currentHighlightTabId) {
        chrome.tabs.sendMessage(currentHighlightTabId, { type: 'clearHighlight' }).catch(() => {});
        currentSentences = null;
        currentHighlightTabId = null;
        currentSentenceIndex = -1;
        currentWordIndex = -1;
      }
      return true;
      
    case 'audioReady':
      console.log('[BG] Offscreen: audio is ready');
      // Audio is ready but not yet playing
      if (currentPlayerState === 'loading') {
        currentPlayerState = 'ready';
        chrome.runtime.sendMessage({
          type: 'playerStateUpdate',
          state: 'ready'
        });
      }
      return true;

    case 'chunksProcessed':
      console.log('[BG] Offscreen: chunks combined, total length:', message.length);
      return true;

    case 'streamError':
      console.error('[BG] Offscreen error:', message.error);
      chrome.runtime.sendMessage({
        type: 'streamError',
        error: message.error
      });
      return true;
      
    case 'getPlayerState':
      sendResponse({ state: currentPlayerState });
      return true;
      
    case 'seek':
      chrome.runtime.sendMessage({ 
        type: 'seek', 
        time: message.time 
      }, (response) => {
        sendResponse(response);
      });
      return true;
      
    case 'getTimeInfo':
      chrome.runtime.sendMessage({ 
        type: 'getTimeInfo' 
      }, (response) => {
        sendResponse(response);
      });
      return true;
      
    case 'timeUpdate':
      // Forward time updates to the popup
      chrome.runtime.sendMessage(message);
      // Advance sentence and word highlights based on current playback time.
      if (currentSentences && currentHighlightTabId && message.timeInfo) {
        const time = message.timeInfo.currentTime;

        // Find current sentence (last one whose startTime we've passed)
        let newSentence = -1;
        for (let i = currentSentences.length - 1; i >= 0; i--) {
          if (time >= currentSentences[i].startTime) {
            newSentence = i;
            break;
          }
        }

        if (newSentence !== -1 && newSentence !== currentSentenceIndex) {
          currentSentenceIndex = newSentence;
          currentWordIndex = -1;  // reset word tracking for new sentence
          chrome.tabs.sendMessage(currentHighlightTabId, {
            type: 'highlightSentence',
            index: newSentence
          }).catch(() => {});
        }

        // Find current word within the active sentence
        if (newSentence !== -1) {
          const wts = currentSentences[newSentence].wordTimestamps;
          let newWord = -1;
          for (let i = wts.length - 1; i >= 0; i--) {
            if (time >= wts[i].startTime) {
              newWord = i;
              break;
            }
          }
          if (newWord !== -1 && newWord !== currentWordIndex) {
            currentWordIndex = newWord;
            chrome.tabs.sendMessage(currentHighlightTabId, {
              type: 'highlightWord',
              sentenceIndex: newSentence,
              wordIndex: newWord
            }).catch(() => {});
          }
        }
      }
      return true;
  }
});

// Group word-level timestamps into sentence-level timing
function groupTimestampsIntoSentences(timestamps) {
  const sentenceEnd = new Set(['.', '!', '?']);
  const puncNoSpace = new Set(['.', '!', '?', ',', ';', ':', "'", '"']);
  const sentences = [];
  let words = [];

  for (const ts of timestamps) {
    words.push(ts);
    if (sentenceEnd.has(ts.word)) {
      let text = '';
      for (const w of words) {
        if (text && !puncNoSpace.has(w.word)) text += ' ';
        text += w.word;
      }
      sentences.push({
        text,
        words: words.map(w => w.word),
        wordTimestamps: words.map(w => ({ word: w.word, startTime: w.start_time, endTime: w.end_time })),
        startTime: words[0].start_time,
        endTime: ts.end_time
      });
      words = [];
    }
  }

  // Leftover words without sentence-ending punctuation
  if (words.length > 0) {
    let text = '';
    for (const w of words) {
      if (text && !puncNoSpace.has(w.word)) text += ' ';
      text += w.word;
    }
    sentences.push({
      text,
      words: words.map(w => w.word),
      wordTimestamps: words.map(w => ({ word: w.word, startTime: w.start_time, endTime: w.end_time })),
      startTime: words[0].start_time,
      endTime: words[words.length - 1].end_time
    });
  }

  return sentences;
}


// Convert Uint8Array to base64 string (service workers lack URL.createObjectURL)
function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Send audio bytes to offscreen document in chunks
// Chunk size kept small (256KB) to stay under Chrome's internal
// sendMessage payload limit (structured-clone of a plain Array of
// numbers is ~7x the raw byte size).
async function sendAudioChunks(audioBytes, mimeType) {
  const CHUNK_SIZE = 256 * 1024; // 256 KB
  const totalChunks = Math.ceil(audioBytes.length / CHUNK_SIZE);
  console.log(`[BG]${VERSION} Sending`, totalChunks, 'audio chunks (', audioBytes.length, 'bytes total)');

  if (!offscreenTabId) {
    throw new Error('No offscreen tab available');
  }

  // Tell offscreen to clear any previous state
  await new Promise(resolve => {
    chrome.tabs.sendMessage(offscreenTabId, { type: 'clearChunks' }, resolve);
  });

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, audioBytes.length);
    const chunkArray = Array.from(audioBytes.slice(start, end));
    try {
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(offscreenTabId, {
          type: 'audioChunk',
          chunk: chunkArray,
          index: i,
          isLast: i === totalChunks - 1,
          mimeType: mimeType,
          isRecording: isRecording
        }, resp => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      });
      console.log(`[BG]${VERSION} Chunk`, i, '/', totalChunks - 1, 'sent (', chunkArray.length, 'elements)');
    } catch (err) {
      console.error(`[BG]${VERSION} Failed to send chunk`, i, ':', err);
      throw err;
    }
  }
  console.log(`[BG]${VERSION} All`, totalChunks, 'chunks sent successfully');
}
  if (!offscreenTabId) {
    throw new Error('No offscreen tab available');
  }

  // Tell offscreen to clear any previous state
  await new Promise(resolve => {
    chrome.tabs.sendMessage(offscreenTabId, { type: 'clearChunks' }, resolve);
  });

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, audioBytes.length);
    const chunkArray = Array.from(audioBytes.slice(start, end));
    try {
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(offscreenTabId, {
          type: 'audioChunk',
          chunk: chunkArray,
          index: i,
          isLast: i === totalChunks - 1,
          mimeType: mimeType,
          isRecording: isRecording
        }, resp => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      });
      console.log('[BG] Chunk', i, '/', totalChunks - 1, 'sent (', chunkArray.length, 'elements)');
    } catch (err) {
      console.error('[BG] Failed to send chunk', i, ':', err);
      throw err;
    }
  }
  console.log('[BG] All', totalChunks, 'chunks sent successfully');
}

// Start streaming audio from the TTS server
async function startStreamingAudio(text, settings) {
  try {
    await setupOffscreenDocument();

    // Validate voice selection before proceeding
    if (!settings.voice || typeof settings.voice !== 'string' || settings.voice.trim() === '') {
      throw new Error('Voice selection is empty or invalid');
    }

    // Ensure the URL is a base URL (remove any trailing '/v1/audio/speech' path)
    const baseUrl = settings.serverUrl.replace(/\/v1\/audio\/speech\/?$/,'').replace(/\/*$/,'');

    let audioBytes;
    let mimeType;

    if (settings.highlightSentences && settings.tabId) {
      // ── Captioned speech: get word-level timestamps for highlighting ──
      const captionedUrl = `${baseUrl}/dev/captioned_speech`;
      const response = await fetch(captionedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-raw-response': 'true'
        },
        body: JSON.stringify({
          model: 'kokoro',
          voice: settings.voice,
          input: text,
          speed: parseFloat(settings.speed) || 1,
          return_timestamps: true,
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      mimeType = data.audio_format || 'audio/mpeg';

      // Decode base64 audio
      const binaryStr = atob(data.audio);
      audioBytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        audioBytes[i] = binaryStr.charCodeAt(i);
      }

      // Group word timestamps into sentences
      const sentenceTiming = groupTimestampsIntoSentences(data.timestamps || []);

      // Inject highlighter content script and initialise sentence ranges
      await chrome.scripting.executeScript({
        target: { tabId: settings.tabId },
        files: ['highlighter.js']
      });

      // Send original (unprocessed) text + sentence timing for DOM matching.
      // The highlighter needs text that closely matches the DOM, not the
      // TTS-cleaned version (which has heading periods, expanded symbols, etc.).
      await chrome.tabs.sendMessage(settings.tabId, {
        type: 'initHighlight',
        text: settings.originalText || text,
        sentences: sentenceTiming.map(s => ({
          text: s.text,
          words: s.words
        }))
      });

      // Store for timeUpdate tracking
      currentSentences = sentenceTiming;
      currentHighlightTabId = settings.tabId;
      currentSentenceIndex = -1;
      currentWordIndex = -1;
    } else {
      // ── Standard speech endpoint ──
      const speechUrl = `${baseUrl}/v1/audio/speech`;
      const response = await fetch(speechUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg, audio/wav, audio/*'
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice: settings.voice,
          input: text
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const audioBlob = await response.blob();
      mimeType = audioBlob.type || 'audio/mpeg';
      audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
    }

    // Send audio to offscreen document and set playback rate
    await sendAudioChunks(audioBytes, mimeType);
    chrome.runtime.sendMessage({
      type: 'setRate',
      rate: parseFloat(settings.speed)
    });

    // Auto-download audio file if "Save audio" is enabled.
    // MV3 service workers lack URL.createObjectURL, so we use a data URL.
    if (isRecording) {
      const base64 = uint8ArrayToBase64(audioBytes);
      const ext = mimeType.includes('wav') ? 'wav' : 'mp3';
      const now = new Date();
      const ts = now.getFullYear()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + '_'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
      chrome.downloads.download({
        url: `data:${mimeType};base64,${base64}`,
        filename: `tts_${ts}.${ext}`,
        saveAs: true
      });
    }
  } catch (error) {
    console.error('Error streaming audio:', error);
    chrome.runtime.sendMessage({
      type: 'streamError',
      error: error.message
    });

    // Update state to stopped on error
    currentPlayerState = 'stopped';
    chrome.runtime.sendMessage({
      type: 'playerStateUpdate',
      state: 'stopped'
    });
  }
}

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

if (typeof module !== 'undefined') {
  module.exports = { startStreamingAudio, groupTimestampsIntoSentences };
}