const fs = require('fs');
const path = require('path');

// Use /data for persistent storage (Docker volume mount point)
const SETTINGS_PATH = process.env.DVR_DATA_DIR
  ? path.join(process.env.DVR_DATA_DIR, 'settings.json')
  : '/data/settings.json';

// Default settings - matches current config.js values
const DEFAULTS = {
  video: {
    resolution: { width: 1280, height: 720 },
    bitrate: '2500k'
  },
  audio: {
    bitrate: '128k'
  },
  hls: {
    segmentTime: 4,
    listSize: 5
  },
  epg: {
    refreshInterval: 4
  },
  tuners: {
    count: 1
  },
  encoding: {
    bufferSize: '8M',           // Encoder buffer size (e.g., '2M', '4M', '8M', '12M')
    threadQueueSize: 2048,      // FFmpeg thread queue size (1024, 2048, 4096)
    probeSize: '10M',           // Probe size for stream analysis
    drawMouse: false,           // Whether to capture mouse cursor
    vsync: 'cfr',               // Video sync mode: 'cfr' (constant), 'vfr' (variable), 'passthrough'
    gopSize: 60,                // GOP size (keyframe interval in frames)
    lowLatency: true            // Enable low-latency encoding options
  }
};

let cachedSettings = null;

/**
 * Load settings from settings.json, merging with defaults
 */
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const saved = JSON.parse(data);
      // Deep merge with defaults
      cachedSettings = deepMerge(DEFAULTS, saved);
    } else {
      cachedSettings = { ...DEFAULTS };
    }
  } catch (err) {
    console.warn('[settings] Failed to load settings.json, using defaults:', err.message);
    cachedSettings = { ...DEFAULTS };
  }
  return cachedSettings;
}

/**
 * Save settings to settings.json
 */
function saveSettings(newSettings) {
  // Validate and normalize
  const settings = {
    video: {
      resolution: {
        width: parseInt(newSettings.video?.resolution?.width) || DEFAULTS.video.resolution.width,
        height: parseInt(newSettings.video?.resolution?.height) || DEFAULTS.video.resolution.height
      },
      bitrate: String(newSettings.video?.bitrate || DEFAULTS.video.bitrate)
    },
    audio: {
      bitrate: String(newSettings.audio?.bitrate || DEFAULTS.audio.bitrate)
    },
    hls: {
      segmentTime: parseInt(newSettings.hls?.segmentTime) || DEFAULTS.hls.segmentTime,
      listSize: parseInt(newSettings.hls?.listSize) || DEFAULTS.hls.listSize
    },
    epg: {
      refreshInterval: parseInt(newSettings.epg?.refreshInterval) || DEFAULTS.epg.refreshInterval
    },
    tuners: {
      count: parseInt(newSettings.tuners?.count) || DEFAULTS.tuners.count
    },
    encoding: {
      bufferSize: String(newSettings.encoding?.bufferSize || DEFAULTS.encoding.bufferSize),
      threadQueueSize: parseInt(newSettings.encoding?.threadQueueSize) || DEFAULTS.encoding.threadQueueSize,
      probeSize: String(newSettings.encoding?.probeSize || DEFAULTS.encoding.probeSize),
      drawMouse: Boolean(newSettings.encoding?.drawMouse ?? DEFAULTS.encoding.drawMouse),
      vsync: ['cfr', 'vfr', 'passthrough'].includes(newSettings.encoding?.vsync)
        ? newSettings.encoding.vsync : DEFAULTS.encoding.vsync,
      gopSize: parseInt(newSettings.encoding?.gopSize) || DEFAULTS.encoding.gopSize,
      lowLatency: Boolean(newSettings.encoding?.lowLatency ?? DEFAULTS.encoding.lowLatency)
    }
  };

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  cachedSettings = settings;
  return settings;
}

/**
 * Get current settings (cached)
 */
function getSettings() {
  if (!cachedSettings) {
    loadSettings();
  }
  return cachedSettings;
}

/**
 * Get default settings
 */
function getDefaults() {
  return { ...DEFAULTS };
}

/**
 * Deep merge helper
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = {
  loadSettings,
  saveSettings,
  getSettings,
  getDefaults,
  DEFAULTS
};
