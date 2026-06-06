# Changelog

All notable changes to the Local TTS Reader extension.

## [Unreleased] - 2026-02-26

### Fixed

- **Voice selection not persisting** (`popup.js`): Changed to promise-based `chrome.storage.local.get` with `await` to eliminate race condition with `populateVoices()`.
- **Silent replay on subsequent plays** (`offscreen.js`): Removed AudioContext (single-call `createMediaElementSource` limitation). Now uses plain `<audio>` element.
- **Citation regex too broad** (`textProcessor.js`): `(\b\w+)(\d+)\b` was mangling numbers (`100` → `10`, `2020` → `202`). Fixed to `([a-zA-Z]{2,})(\d{1,2})\b`.
- **Version regex incrementing** (`textProcessor.js`): `GPT-4` → `GPT 5` was wrong. Fixed to just remove dash.
- **Save audio completely refactored** (`background.js`, `popup.js`, `popup.html`, `offscreen.js`, `manifest.json`): The download button was fundamentally broken (popup is ephemeral; blob URLs are context-scoped). Complete refactor: (1) added `downloads` permission; (2) background service worker auto-triggers `chrome.downloads.download()` with `saveAs: true` and a data URL immediately when TTS audio is ready and "Save audio" is checked; (3) removed download button from popup; (4) renamed checkbox to "Save audio"; (5) works from both popup and context menu, even when popup is closed; (6) default filename `tts_YYYYMMDD_HHmmss.mp3`; (7) cleaned all dead recording code from offscreen.js.

### Added

- **Sentence highlighting** (`highlighter.js`, `background.js`, `popup.js`): CSS Custom Highlight API (`::highlight()`) for non-destructive sentence highlighting during TTS playback. Background sends word timestamps from Kokoro `/dev/captioned_speech` endpoint. Content script builds DOM ranges.
- **Word-level highlighting**: Darker yellow background + 3px underline for current word within highlighted sentence. `::highlight(tts-current-word)` layer on top of sentence layer.
- **Text-region-first DOM matching architecture** (`highlighter.js`): Complete rewrite. Finds full input text in DOM first (unique substring match), then maps sentences/words within bounded region. Eliminates previous heuristic fragility.
- **Unicode normalization** (`highlighter.js`): 1:1 character mapping (curly quotes → straight, em/en dash → hyphen, ellipsis → period, NBSP → space) preserving character offsets for Range creation.
- **Paragraph boundary handling** (`highlighter.js`): `findCollapsed` now skips needle-only whitespace, handling cases where `innerText` inserts newlines at `</p><p>` boundaries but DOM text node concatenation has no separator.
- **Bounded word search** (`highlighter.js`): Word-anchor fallback limits each word search to 200 chars from last match, preventing TTS-expanded words (e.g., `'one'` from `'4.1'`) from jumping to wrong sentence.
- **Heading termination** (`textProcessor.js`): Lines ≤150 chars without terminal punctuation get `.` appended before whitespace collapse, forcing TTS to treat headings as separate sentences with natural pauses.
- **Selection text via getSelection()** (`background.js`): Replaced `info.selectionText` (collapses whitespace) with `window.getSelection().toString()` (preserves newlines at block boundaries) for context menu path.
- **Article content extraction** (`contentExtractor.js`): Readability-style paragraph-density scoring extracts article content for full-page TTS. Excludes nav, footer, sidebar, related content. Marks content elements with `data-tts-content` for scoped highlighting.
- **Scoped text-node walking** (`highlighter.js`): `buildTextMap()` scopes to `[data-tts-content]` elements when set by content extractor. Falls back to `document.body` for selection path.
- **Original text preservation** (`background.js`, `popup.js`): Original (unprocessed) text is sent to highlighter for DOM matching, while processed text goes to TTS. Prevents mismatches from heading periods, symbol expansion, etc.

### Technical

- **groupTimestampsIntoSentences** (`background.js`): Groups word-level TTS timestamps into sentences by sentence-ending punctuation. Each sentence carries `text`, `words`, `wordTimestamps`, `startTime`, and `endTime`.

## Regression Test Map

| # | Feature / Fix | Test File | Describe Block |
|---|---|---|---|
| 1 | Voice selection not persisting | `__tests__/popup.test.js` | `populateVoiceSelect` |
| 2 | Silent replay on subsequent plays | `__tests__/background.test.js` | `startStreamingAudio` |
| 3 | Citation regex too broad | `__tests__/textProcessor.test.js` | `Citation removal` |
| 4 | Version regex incrementing | `__tests__/textProcessor.test.js` | `Version number normalization` |
| 5 | Sentence highlighting | `__tests__/highlighter.test.js` | `findCollapsed`, `findWordInRegion` |
| 6 | Word-level highlighting | `__tests__/highlighter.test.js` | `findWordInRegion` |
| 7 | Text-region-first DOM matching | `__tests__/highlighter.test.js` | `findCollapsed` (region-finding tests) |
| 8 | Unicode normalization | `__tests__/highlighter.test.js` | `normalize` |
| 9 | Paragraph boundary handling | `__tests__/highlighter.test.js` | `findCollapsed` > `needle-only whitespace (paragraph boundary)` |
| 10 | Bounded word search | `__tests__/highlighter.test.js` | `findWordInRegion` (bounded search tests) |
| 11 | Heading termination | `__tests__/textProcessor.test.js` | `Heading termination` |
| 12 | Selection text via getSelection() | Manual testing | Chrome API dependent |
| 13 | Article content extraction | `__tests__/contentExtractor.test.js` | All groups |
| 14 | Scoped text-node walking | `__tests__/contentExtractor.test.js` | `data-tts-content marking` |
| 15 | Original text preservation | Manual testing | Chrome messaging dependent |
| 16 | groupTimestampsIntoSentences | `__tests__/groupTimestamps.test.js` | All groups |
| 17 | Save audio (auto-download) | Manual testing | Check "Save audio", trigger TTS from context menu or popup; OS Save As dialog should appear with `tts_YYYYMMDD_HHmmss.mp3` filename |
