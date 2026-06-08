let offscreenDocument = null;
let isRecording = false;
let currentPlayerState = 'stopped';
let currentSentences = null;
let currentHighlightTabId = null;
let currentSentenceIndex = -1;
let currentWordIndex = -1;
let abortController = null; // AbortController for cancelling streaming TTS requests
// Create or get the offscreen document
// Helper: try to ping offscreen to verify it is alive
async function pingOffscreen() {
  try {
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ping' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 2000))
    ]);
    return resp && resp.ok === true;
  } catch {
    return false;
  }
}

// Create or get the offscreen document
async function setupOffscreenDocument() {
  // Check if we already have an offscreen document
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    // Verify it is actually alive (getContexts can return stale contexts)
    const alive = await pingOffscreen();
    if (alive) {
      offscreenDocument = existingContexts[0];
      console.log('[BG] Reusing existing offscreen document');
      return;
    }
    console.log('[BG] Existing offscreen is dead — recreating');
  }

  // Create an offscreen document
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Playing TTS audio in the background'
  });

  // Wait until the new document registers its message listener
  for (let i = 0; i < 30; i++) {
    if (await pingOffscreen()) {
      console.log('[BG] Offscreen document created and ready');
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.warn('[BG] Offscreen document created but did not respond to ping');
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
      // Audio is ready but not yet playing
      if (currentPlayerState === 'loading') {
        currentPlayerState = 'ready';
        chrome.runtime.sendMessage({ 
          type: 'playerStateUpdate', 
          state: 'ready' 
        });
      }
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
      
    case 'stop':
      // Abort any in-flight streaming TTS request
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      currentPlayerState = 'stopped';
      chrome.runtime.sendMessage({ type: 'playerStateUpdate', state: 'stopped' });
      // Forward stop to offscreen to halt playback
      chrome.runtime.sendMessage({ type: 'stop' });
      // Clear highlights when stopped
      if (currentHighlightTabId) {
        chrome.tabs.sendMessage(currentHighlightTabId, { type: 'clearHighlight' }).catch(() => {});
        currentSentences = null;
        currentHighlightTabId = null;
        currentSentenceIndex = -1;
        currentWordIndex = -1;
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
async function sendAudioChunks(audioBytes, mimeType, rate = 1) {
  const CHUNK_SIZE = 256 * 1024; // 256 KB
  const totalChunks = Math.ceil(audioBytes.length / CHUNK_SIZE);
  console.log('[BG] Sending', totalChunks, 'audio chunks (', audioBytes.length, 'bytes total)');

  // Verify offscreen is alive; it may have been killed during a long fetch
  let alive = await pingOffscreen();
  if (!alive) {
    console.log('[BG] Offscreen gone — recreating before send');
    await setupOffscreenDocument();
    alive = true; // setupOffscreenDocument waits for ping to succeed
  }
  console.log('[BG] Offscreen is ready');

  // Tell offscreen to clear any previous state
  chrome.runtime.sendMessage({ type: 'clearChunks' });

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, audioBytes.length);
    const chunkArray = Array.from(audioBytes.slice(start, end));
    try {
      await chrome.runtime.sendMessage({
        type: 'audioChunk',
        chunk: chunkArray,
        index: i,
        isLast: i === totalChunks - 1,
        mimeType: mimeType,
        rate: i === totalChunks - 1 ? rate : undefined,
        isRecording: isRecording
      });
      console.log('[BG] Chunk', i, '/', totalChunks - 1, 'sent (', chunkArray.length, 'elements)');
    } catch (err) {
      console.error('[BG] Failed to send chunk', i, ':', err);
      throw err;
    }
  }
  console.log('[BG] All', totalChunks, 'chunks sent successfully');
}

// Split text into sentence-bounded chunks for streaming synthesis.
// Each chunk is at most `maxChars` characters (default 400), split at
// sentence boundaries (., !, ?) to preserve speech coherence.
function splitTextIntoChunks(text, maxChars) {
  maxChars = maxChars || 400; // default: 400 chars per chunk
  // Extract sentences (text ending with sentence punctuation)
  const sentences = text.match(/[^.!?]*[.!?]["')\\]*\\s*/g);
  if (!sentences) {
    // No sentence-ending punctuation — treat the whole text as one chunk
    return text.trim() ? [text.trim()] : [];
  }
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if ((buf + ' ' + trimmed).trim().length > maxChars && buf) {
      chunks.push(buf.trim());
      buf = trimmed;
    } else {
      buf = buf ? buf + ' ' + trimmed : trimmed;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// Stream audio from the TTS server in real-time.
// Splits text into chunks, sends each to the TTS API with stream:true,
// and forwards PCM audio to the offscreen document as it arrives.
async function startStreamingAudioStream(text, settings) {
  const chunks = splitTextIntoChunks(text, settings.streamChunkMaxChars);
  console.log('[BG] Streaming: split text into', chunks.length, 'chunks');
  if (chunks.length === 0) {
    console.log('[BG] Streaming: no chunks, stopping');
    chrome.runtime.sendMessage({ type: 'playerStateUpdate', state: 'stopped' });
    return;
  }

  const baseUrl = settings.serverUrl.replace(/\/v1\/audio\/speech\/?$/, '').replace(/\/*$/, '');
  const speechUrl = `${baseUrl}/v1/audio/speech`;
  const rate = parseFloat(settings.speed) || 1;
  console.log('[BG] Streaming to:', speechUrl, 'rate:', rate);
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (abortController && abortController.signal.aborted) break;
      console.log('[BG] Streaming chunk', i + 1, '/', chunks.length, '(', chunks[i].length, 'chars)');

      const response = await fetch(speechUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'tts-1',
          voice: settings.voice,
          input: chunks[i],
          stream: true,
          response_format: 'pcm'
        }),
        signal: abortController ? abortController.signal : undefined
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      console.log('[BG] Fetch OK (status', response.status + ')');
      // Read the PCM stream and forward to offscreen in chunks
      const reader = response.body.getReader();
      let streamOffset = 0;
      const MSG_CHUNK = 256 * 1024; // 256 KB per message

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Send in sub-chunks to stay under sendMessage payload limits
        for (let pos = 0; pos < value.length; pos += MSG_CHUNK) {
          const end = Math.min(pos + MSG_CHUNK, value.length);
          const subChunk = Array.from(value.slice(pos, end));
          await chrome.runtime.sendMessage({
            type: 'streamingChunk',
            chunk: subChunk,
            sequence: i,
            offset: streamOffset,
            isLast: i === chunks.length - 1 && end >= value.length,
            rate: i === 0 ? rate : undefined
          });
          console.log('[BG] Sent streamingChunk', streamOffset, 'bytes');
          streamOffset += end - pos;
        }
      }
      console.log('[BG] Chunk', i, 'complete,', streamOffset, 'bytes total');
    }

    // Signal completion — if no chunks were sent, ensure state is set
    if (currentPlayerState === 'loading') {
      currentPlayerState = 'stopped';
      chrome.runtime.sendMessage({ type: 'playerStateUpdate', state: 'stopped' });
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('[BG] Streaming aborted');
      return;
    }
    throw error;
  }
}
// Start streaming audio from the TTS server
async function startStreamingAudio(text, settings) {
  try {
    await setupOffscreenDocument();
    chrome.runtime.sendMessage({ type: 'offscreenReady' });

    // Validate voice selection before proceeding
    if (!settings.voice || typeof settings.voice !== 'string' || settings.voice.trim() === '') {
      throw new Error('Voice selection is empty or invalid');
    }

    // ── Branch: streaming (real-time) vs non-streaming (save/highlight) ──
    // Streaming starts playback as soon as the first audio chunk arrives.
    // Non-streaming waits for the full response — required when saving audio
    // or when sentence highlighting needs word-level timestamps.
    const useStreaming = !isRecording && !(settings.highlightSentences && settings.tabId);
    console.log('[BG] useStreaming:', useStreaming, 'isRecording:', isRecording, 'highlight:', settings.highlightSentences);

    if (useStreaming) {
      // ── Real-time streaming mode ──
      console.log('[BG] Starting real-time streaming');
      abortController = new AbortController();
      try {
        await startStreamingAudioStream(text, settings);
      } finally {
        abortController = null;
      }
      return;
    }

    // ── Non-streaming mode (save audio / highlight sentences) ──
    const baseUrl = settings.serverUrl.replace(/\/v1\/audio\/speech\/?$/, '').replace(/\/*$/, '');

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
          response_format: settings.outputFormat || 'mp3',
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
          input: text,
          response_format: settings.outputFormat || 'mp3'
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const audioBlob = await response.blob();
      // Use server-provided type, fallback to format-based mapping
      const FORMAT_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm' };
      mimeType = audioBlob.type || FORMAT_MIME[settings.outputFormat] || 'audio/mpeg';
      audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
    }

    // Wrap raw PCM in WAV container so browsers can play it
    if ((settings.outputFormat || 'mp3') === 'pcm') {
      audioBytes = pcmToWav(audioBytes);
      mimeType = 'audio/wav';
    }

    // Send audio to offscreen document and set playback rate
    await sendAudioChunks(audioBytes, mimeType, parseFloat(settings.speed));

    // Auto-download audio file if "Save audio" is enabled.
    // MV3 service workers lack URL.createObjectURL, so we use a data URL.
    if (isRecording) {
      const base64 = uint8ArrayToBase64(audioBytes);
      const FORMAT_EXT = { mp3: 'mp3', wav: 'wav', pcm: 'pcm' };
      const ext = FORMAT_EXT[settings.outputFormat] || 'mp3';
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

// Wrap raw PCM bytes (24kHz, 16-bit, mono) in a WAV container so browsers can play it
function pcmToWav(pcmBytes) {
  const dataLen = pcmBytes.length;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // 'RIFF'
  view.setUint32(4, 36 + dataLen, true);
  view.setUint32(8, 0x57415645, false); // 'WAVE'

  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // 'fmt '
  view.setUint32(16, 16, true);           // chunk size
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, 24000, true);        // sample rate
  view.setUint32(28, 48000, true);        // byte rate (24000 * 2 * 1)
  view.setUint16(32, 2, true);            // block align (2 * 1)
  view.setUint16(34, 16, true);           // bits per sample

  // data chunk
  view.setUint32(36, 0x64617461, false); // 'data'
  view.setUint32(40, dataLen, true);

  const wav = new Uint8Array(buf);
  wav.set(pcmBytes, 44);
  return wav;
}

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

if (typeof module !== 'undefined') {
  module.exports = { startStreamingAudio, startStreamingAudioStream, splitTextIntoChunks, groupTimestampsIntoSentences };
}