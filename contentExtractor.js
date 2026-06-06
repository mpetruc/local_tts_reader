/**
 * Lightweight article content extractor for TTS.
 *
 * Priority cascade:
 *   1. Paragraph-density scoring (Readability-style heuristic)
 *   2. Semantic HTML5 containers (<article>, <main>, [role="main"])
 *   3. Fallback: document.body.innerText
 *
 * Injected into the active tab via chrome.scripting.executeScript.
 */

// Immediately-invoked so executeScript gets a return value.
(() => {
  'use strict';

  // ── Negative class/id patterns: content unlikely to live here ──
  const UNLIKELY = /nav|menu|footer|sidebar|header|banner|comment|widget|advert|promo|related|share|social|subscribe|newsletter|cookie|modal|popup|breadcrumb|pagination|metadata|byline|author|tag-list|signup/i;

  // ── Positive class/id patterns: content likely here ──
  const LIKELY = /article|post|entry|story|blog|content|body|prose|text|main|reading/i;

  /** Score a candidate container. Higher = more likely to be the article. */
  function score(el) {
    const cls = (el.className || '').toString();
    const id = el.id || '';
    const tag = el.tagName;

    // Hard skip: <nav>, <footer>, <header>, <aside>, hidden elements
    if (/^(NAV|FOOTER|HEADER|ASIDE)$/.test(tag)) return -1;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return -1;
    const style = el.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return -1;

    // Skip elements with unlikely class/id
    if (UNLIKELY.test(cls) || UNLIKELY.test(id)) return -1;

    // Count direct and near-direct paragraphs (depth ≤ 2)
    const paragraphs = el.querySelectorAll(':scope > p, :scope > div > p, :scope > section > p');
    let pTextLen = 0;
    let pCount = 0;
    for (const p of paragraphs) {
      const t = p.innerText.trim();
      if (t.length > 20) {  // Skip tiny "Read more" style paragraphs
        pTextLen += t.length;
        pCount++;
      }
    }

    if (pCount < 2) return -1;  // Need at least 2 real paragraphs

    let s = pTextLen;

    // Bonus for semantic tags
    if (tag === 'ARTICLE') s *= 1.5;
    if (tag === 'MAIN') s *= 1.3;
    if (el.getAttribute('role') === 'main') s *= 1.3;

    // Bonus for positive class/id
    if (LIKELY.test(cls) || LIKELY.test(id)) s *= 1.2;

    // Penalize containers that include nav/footer children
    if (el.querySelector('nav, footer, [role="navigation"]')) s *= 0.7;

    // Penalize very broad containers (body-level) — prefer tighter ones
    // Ratio of paragraph text to total text; higher ratio = more focused
    const totalLen = el.innerText.length;
    const ratio = totalLen > 0 ? pTextLen / totalLen : 0;
    s *= (0.5 + 0.5 * ratio);  // Blend: half score + half density-weighted

    return s;
  }

  /** Extract article title. */
  function extractTitle() {
    // Prefer: <h1> inside <article> or <main>
    for (const scope of ['article h1', 'main h1', '[role="main"] h1', 'h1']) {
      const el = document.querySelector(scope);
      if (el) {
        const text = el.innerText.trim();
        if (text.length > 5 && text.length < 300) return text;
      }
    }
    // Fallback to <title> tag, cleaned of site name
    const title = document.title || '';
    return title.replace(/\s*[|\\\-–—]\s*.+$/, '').trim();
  }

  /** Main extraction. Returns the article text with title prepended. */
  function extract() {
    const title = extractTitle();

    // Clean up any previous marking
    document.querySelectorAll('[data-tts-content]').forEach(el => el.removeAttribute('data-tts-content'));

    // Score all candidate containers
    const candidates = document.querySelectorAll('div, section, article, main, [role="main"]');
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      // Skip tiny elements
      if (el.innerText.length < 200) continue;
      const s = score(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }

    // If we found a good container, use it
    if (best && bestScore > 500) {
      best.setAttribute('data-tts-content', '1');
      let text = best.innerText.trim();
      if (title && !text.startsWith(title)) {
        text = title + '\n\n' + text;
        // Also mark the title element so the highlighter can find it
        const h1 = document.querySelector('article h1, main h1, [role="main"] h1, h1');
        if (h1) h1.setAttribute('data-tts-content', '1');
      }
      return text;
    }

    // Fallback: try semantic elements directly
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && el.innerText.length > 200) {
        el.setAttribute('data-tts-content', '1');
        let text = el.innerText.trim();
        if (title && !text.startsWith(title)) {
          text = title + '\n\n' + text;
          const h1 = document.querySelector('article h1, main h1, [role="main"] h1, h1');
          if (h1) h1.setAttribute('data-tts-content', '1');
        }
        return text;
      }
    }

    // Last resort: full page
    return document.body.innerText;
  }

  return extract();
})();
