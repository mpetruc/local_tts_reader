const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:8000',
    voice: 'af_bella',
    speed: 1.0,
    recordAudio: false,
    preprocessText: true,
    highlightSentences: false
  };
  
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_SETTINGS };
  } else {
    self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  }