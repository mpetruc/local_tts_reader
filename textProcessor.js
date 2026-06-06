/**
 * Text processor for TTS
 * - Removes markdown formatting
 * - Cleans up URLs
 * - Removes special characters that don't read well
 */
class TextProcessor {
  /**
   * Process text for TTS
   * @param {string} text - The text to process
   * @returns {string} - The processed text
   */
  static process(text) {
    if (!text) return '';
    
    let processedText = text;
    
    // Remove markdown headers
    processedText = processedText.replace(/^#{1,6}\s+(.+)$/gm, '$1');
    
    // Remove markdown bold/italic
    processedText = processedText.replace(/(\*\*|__)(.*?)\1/g, '$2');
    processedText = processedText.replace(/(\*|_)(.*?)\1/g, '$2');
    
    // Remove markdown code blocks
    processedText = processedText.replace(/```[\s\S]*?```/g, 'code block omitted');
    processedText = processedText.replace(/`([^`]+)`/g, '$1');
    
    // Remove markdown links but keep the text
    processedText = processedText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    
    // Process URLs
    processedText = this.processUrls(processedText);
    
    // Remove special characters that don't read well
    processedText = processedText.replace(/[|*~`]/g, ' ');
    
    // Terminate heading/title lines so TTS treats them as separate sentences.
    // innerText separates block elements (h1-h6, p, div) with \n. A heading
    // is a short line (≤150 chars) that doesn't end with sentence punctuation.
    // We append a period so TTS pauses between heading and body text.
    const lines = processedText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.length === 0 || trimmed.length > 150) continue;
      const lastChar = trimmed[trimmed.length - 1];
      if (/[.!?:;)\]]/.test(lastChar)) continue; // already terminated
      lines[i] = trimmed + '.';
    }
    processedText = lines.join('\n');
    
    // Remove excessive whitespace
    processedText = processedText.replace(/\s+/g, ' ').trim();
    
    // Remove markdown list markers
    processedText = processedText.replace(/^[\s-]*[-*+]\s+/gm, '');
    processedText = processedText.replace(/^\s*\d+\.\s+/gm, '');
    
    // Remove HTML tags
    processedText = processedText.replace(/<[^>]*>/g, '');
    
    // Replace common symbols with words
    processedText = processedText.replace(/&/g, ' and ');
    processedText = processedText.replace(/\$/g, ' dollars ');
    processedText = processedText.replace(/%/g, ' percent ');
    processedText = processedText.replace(/\^/g, ' ');
    
    // Replace multiple dots with a single period
    processedText = processedText.replace(/\.{2,}/g, '.');
    
    // Remove footnote-style citation marks: a word (letters only) followed
    // by 1-2 trailing digits, e.g., 'results1' → 'results', 'data12' → 'data'.
    // Does NOT match standalone numbers like '100' or '2020'.
    processedText = processedText.replace(/([a-zA-Z]{2,})(\d{1,2})\b/g, '$1');
    
    // Normalise dash-separated version numbers for TTS readability:
    // e.g., 'GPT-4' → 'GPT 4', 'Claude-3.5' → 'Claude 3.5'
    processedText = processedText.replace(/(\b[a-zA-Z]+)-(\d+(?:\.\d+)?)\b/g, '$1 $2');
    return processedText;
  }
  
  /**
   * Process URLs in text
   * @param {string} text - The text containing URLs
   * @returns {string} - Text with processed URLs
   */
  static processUrls(text) {
    // Regular expression for URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    
    return text.replace(urlRegex, (url) => {
      try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;
        
        // Extract the domain name without subdomains
        let domainName = domain.split('.');
        if (domainName.length > 2) {
          // Handle cases like www.example.com
          if (domainName[0] === 'www') {
            domainName = domainName.slice(1);
          }
          // Get the main domain part
          domainName = domainName.slice(-2, -1)[0];
        } else {
          // Handle cases like example.com
          domainName = domainName[0];
        }
        
        // Capitalize first letter
        domainName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
        
        return `[${domainName} dot ${domain.split('.').pop()} link]`;
      } catch (e) {
        // If URL parsing fails, return a generic placeholder
        return '[web link]';
      }
    });
  }
}

// Make available globally
if (!window.TextProcessor) {
	window.TextProcessor = TextProcessor;
}

if (typeof module !== 'undefined') {
  module.exports = { TextProcessor };
}