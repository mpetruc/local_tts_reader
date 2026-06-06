// Content script injected into the active tab for TTS sentence highlighting.
// Uses the CSS Custom Highlight API (Chrome 105+) for non-destructive highlighting.
//
// Strategy: the background sends the full input text and sentence timing data.
// We locate the text region in the DOM first (one substring search), then map
// sentences and words within that bounded region. This avoids the fragility of
// searching for individual words across the entire page.

(function () {
  if (window.__ttsHighlighterInitialized) return;
  window.__ttsHighlighterInitialized = true;

  let sentenceRanges = [];
  let sentenceWordRanges = [];
  let currentSentenceIdx = -1;
  let currentWordIdx = -1;
  let styleEl = null;

  // ── Unicode normalization ──────────────────────────────────────────
  // TTS engines return ASCII punctuation; pages use typographic chars.
  // 1:1 mapping so character offsets stay valid for Range creation.
  const NORM = {
    '\u2018': "'", '\u2019': "'",
    '\u201C': '"', '\u201D': '"',
    '\u2014': '-', '\u2013': '-',
    '\u2026': '.',
    '\u00A0': ' ',
  };

  function normalize(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      out += NORM[text[i]] || text[i];
    }
    return out;
  }

  // ── Text-node walker ───────────────────────────────────────────────
  function buildTextMap() {
    // Scope to content-extractor-marked elements when available,
    // otherwise fall back to document.body.
    const roots = [...document.querySelectorAll('[data-tts-content]')];
    if (roots.length === 0) roots.push(document.body);

    const filter = {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.textContent.length === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    };

    const entries = [];
    let offset = 0;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, filter);
      let node;
      while ((node = walker.nextNode())) {
        const len = node.textContent.length;
        entries.push({ node, offset, length: len });
        offset += len;
      }
    }

    const fullText = entries.map(e => e.node.textContent).join('');
    const searchText = normalize(fullText);
    return { entries, searchText };
  }

  // ── Range creation from character offsets ───────────────────────────
  function createRange(entries, startPos, endPos) {
    let startNode = null, startOffset = 0;
    let endNode = null, endOffset = 0;

    for (const e of entries) {
      const eEnd = e.offset + e.length;
      if (!startNode && startPos >= e.offset && startPos < eEnd) {
        startNode = e.node;
        startOffset = startPos - e.offset;
      }
      if (endPos > e.offset && endPos <= eEnd) {
        endNode = e.node;
        endOffset = endPos - e.offset;
        break;
      }
    }

    if (!startNode || !endNode) return null;
    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch {
      return null;
    }
  }

  // ── Whitespace-collapsed substring search ──────────────────────────
  // Finds `needle` in `haystack` starting from `from`, treating any run
  // of whitespace as equivalent to any other. Returns {start, end} in
  // haystack coordinates, or null.
  function findCollapsed(needle, haystack, from) {
    const normNeedle = needle.replace(/\s+/g, ' ').trim();
    if (normNeedle.length === 0) return null;

    let hi = from;
    const hLen = haystack.length;
    const nLen = normNeedle.length;

    while (hi < hLen) {
      // Try matching normNeedle against haystack starting at hi
      let ni = 0;
      let matchStart = -1;
      let hj = hi;

      while (hj < hLen && ni < nLen) {
        const hc = haystack[hj];
        const nc = normNeedle[ni];

        if (/\s/.test(hc) && /\s/.test(nc)) {
          // Both whitespace: skip runs in both
          while (hj < hLen && /\s/.test(haystack[hj])) hj++;
          ni++;
          while (ni < nLen && /\s/.test(normNeedle[ni])) ni++;
          continue;
        }

        if (/\s/.test(hc)) {
          // Only haystack whitespace: skip it
          hj++;
          continue;
        }

        if (/\s/.test(nc)) {
          // Only needle whitespace (paragraph boundary in selection text
          // that doesn't exist in DOM concatenation): skip it
          ni++;
          while (ni < nLen && /\s/.test(normNeedle[ni])) ni++;
          continue;
        }

        if (hc === nc) {
          if (matchStart === -1) matchStart = hj;
          hj++;
          ni++;
        } else {
          break;
        }
      }

      if (ni >= nLen && matchStart !== -1) {
        return { start: matchStart, end: hj };
      }

      hi++;
    }

    return null;
  }

  // ── Find a word within a bounded region ────────────────────────────
  const PUNCTUATION = new Set(['.', '!', '?', ',', ';', ':', "'", '"', ')', ']', '}', '-', '\u2014', '\u2013', '\u2026']);

  function findWordInRegion(word, searchText, from, regionEnd) {
    const len = Math.min(searchText.length, regionEnd);
    let i = from;

    // Skip whitespace
    if (!PUNCTUATION.has(word)) {
      while (i < len && /\s/.test(searchText[i])) i++;
    }

    // Exact match at position
    if (i + word.length <= len && searchText.startsWith(word, i)) {
      return { start: i, end: i + word.length };
    }

    // Scan forward within region
    const idx = searchText.indexOf(word, from);
    if (idx !== -1 && idx + word.length <= regionEnd) {
      return { start: idx, end: idx + word.length };
    }

    return null;
  }

  // ── CSS ────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.textContent = `
      ::highlight(tts-current-sentence) {
        background-color: rgba(255, 214, 0, 0.35);
      }
      ::highlight(tts-current-word) {
        background-color: rgba(255, 214, 0, 0.65);
        text-decoration: underline;
        text-decoration-thickness: 3px;
        text-decoration-color: rgba(220, 170, 0, 0.8);
        text-underline-offset: 2px;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // ── Core: initHighlight ────────────────────────────────────────────
  // text:      the exact string sent to TTS
  // sentences: [{text, words}, ...] from groupTimestampsIntoSentences
  function initHighlight(text, sentences) {
    const { entries, searchText } = buildTextMap();
    sentenceRanges = [];
    sentenceWordRanges = [];

    // Step 1: Locate the full text region in the DOM.
    // Normalize the input text the same way we normalize the DOM.
    const normInput = normalize(text);
    const region = findCollapsed(normInput, searchText, 0);
    if (!region) return 0;

    // Step 2: For each sentence, find its text within the region,
    // then find individual words within the sentence span.
    let sentenceFrom = region.start;

    for (const s of sentences) {
      const normSentence = normalize(s.text);
      let sPos = findCollapsed(normSentence, searchText, sentenceFrom);

      // If no match, retry with trailing punctuation stripped.
      // TextProcessor may append '.' to headings for TTS sentence splitting,
      // but the DOM won't have that punctuation.
      if (!sPos || sPos.end > region.end + 50) {
        const stripped = normSentence.replace(/[.!?]+$/, '');
        if (stripped.length > 0 && stripped.length !== normSentence.length) {
          sPos = findCollapsed(stripped, searchText, sentenceFrom);
        }
      }

      if (sPos && sPos.end <= region.end + 50) {
        // Exact sentence text found in DOM
        sentenceRanges.push(createRange(entries, sPos.start, sPos.end));

        // Build word ranges within the sentence span
        const wordRanges = [];
        let wordFrom = sPos.start;
        for (const word of s.words) {
          if (!word || word.trim().length === 0) { wordRanges.push(null); continue; }
          const wPos = findWordInRegion(word, searchText, wordFrom, sPos.end + 10);
          if (wPos) { wordRanges.push(createRange(entries, wPos.start, wPos.end)); wordFrom = wPos.end; }
          else { wordRanges.push(null); }
        }
        sentenceWordRanges.push(wordRanges);
        sentenceFrom = sPos.end;
      } else {
        // Sentence text diverged from DOM (e.g. TTS expanded "100" -> "one hundred").
        // Fallback: find individual words within the remaining region.
        const regionBound = region.end + 50;
        let firstPos = null, lastPos = null;
        const wordRanges = [];
        let wordFrom = sentenceFrom;

        for (const word of s.words) {
          if (!word || word.trim().length === 0) { wordRanges.push(null); continue; }
          // Bound each word search to 200 chars from last match to prevent
          // jumping to a different sentence within the region.
          const wordBound = Math.min(wordFrom + 200, regionBound);
          const wPos = findWordInRegion(word, searchText, wordFrom, wordBound);
          if (wPos) {
            if (!firstPos) firstPos = wPos;
            lastPos = wPos;
            wordRanges.push(createRange(entries, wPos.start, wPos.end));
            wordFrom = wPos.end;
          } else {
            // TTS-only word (e.g. "four" for "4"): skip it
            wordRanges.push(null);
          }
        }

        if (firstPos && lastPos) {
          sentenceRanges.push(createRange(entries, firstPos.start, lastPos.end));
          sentenceWordRanges.push(wordRanges);
          sentenceFrom = lastPos.end;
        } else {
          sentenceRanges.push(null);
          sentenceWordRanges.push([]);
        }
      }
    }

    ensureStyle();
    return sentenceRanges.filter(Boolean).length;
  }

  // ── Highlight controls ─────────────────────────────────────────────
  function highlightSentence(index) {
    if (index === currentSentenceIdx) return;
    currentSentenceIdx = index;
    currentWordIdx = -1;

    const range = sentenceRanges[index];
    if (!range) return;

    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.set('tts-current-sentence', new Highlight(range));
      CSS.highlights.delete('tts-current-word');
    }

    const rect = range.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      const el = range.startContainer.parentElement;
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function highlightWord(sentenceIndex, wordIndex) {
    if (sentenceIndex === currentSentenceIdx && wordIndex === currentWordIdx) return;
    currentWordIdx = wordIndex;

    const wordRanges = sentenceWordRanges[sentenceIndex];
    if (!wordRanges || !wordRanges[wordIndex]) return;

    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.set('tts-current-word', new Highlight(wordRanges[wordIndex]));
    }
  }

  function clearHighlight() {
    currentSentenceIdx = -1;
    currentWordIdx = -1;
    sentenceRanges = [];
    sentenceWordRanges = [];
    // Remove content-extractor scoping markers
    document.querySelectorAll('[data-tts-content]').forEach(el => el.removeAttribute('data-tts-content'));
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('tts-current-sentence');
      CSS.highlights.delete('tts-current-word');
    }
    if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  }

  // ── Message listener ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'initHighlight': {
        const matched = initHighlight(message.text, message.sentences);
        sendResponse({ success: true, matched });
        return true;
      }
      case 'highlightSentence':
        highlightSentence(message.index);
        break;
      case 'highlightWord':
        highlightWord(message.sentenceIndex, message.wordIndex);
        break;
      case 'clearHighlight':
        clearHighlight();
        break;
    }
  });
})();
