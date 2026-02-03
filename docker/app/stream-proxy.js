const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const tunerManager = require('./tuner-manager');
const { generateM3U, getAllChannels, getChannel } = require('./channels');

// DirecTV EPG Service
const directvEpg = require('./directv-epg');

// Settings GUI
const settingsManager = require('./settings-manager');
const { getPresets, getPreset } = require('./presets');

const app = express();

// Auto-sync tracking
let profileSyncedAfterLogin = false;
let lastLoginCheckTime = 0;
const LOGIN_CHECK_INTERVAL = 5000; // Check every 5 seconds

// JSON body parsing for settings API
app.use(express.json());

// Serve static files (settings GUI)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for logging
app.use((req, res, next) => {
  if (!req.url.startsWith('/api/logs')) console.log(`[server] ${req.method} ${req.url}`);
  next();
});

// CORS for IPTV clients
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', tuners: tunerManager.getStatus() });
});

// ============================================
// Version API
// ============================================
app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  const os = require('os');

  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return days + 'd ' + hours + 'h ' + mins + 'm';
    if (hours > 0) return hours + 'h ' + mins + 'm';
    return mins + 'm';
  }

  res.json({
    version: pkg.version || '1.0.0',
    name: pkg.name || 'directv-tuner',
    image: process.env.DVR_IMAGE || process.env.DOCKER_IMAGE || 'sunnyside1/directvtuner:latest',
    buildDate: process.env.BUILD_DATE || null,
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: formatUptime(process.uptime())
  });
});


// ============================================
// System Status API
// ============================================

app.get("/api/status", async (req, res) => {
  try {
    // Check login status by examining the browser page
    let loginStatus = {
      isLoggedIn: false,
      currentUrl: "",
      needsLogin: false,
      message: ""
    };

    // Try to get browser page info
    try {
      const tuner = tunerManager.getTuner(0);
      if (tuner && tuner.page) {
        const url = tuner.page.url();
        loginStatus.currentUrl = url;
        loginStatus.isLoggedIn = url.includes("stream.directv.com") && !url.includes("login") && !url.includes("signin") && !url.includes("auth");
        loginStatus.needsLogin = url.includes("login") || url.includes("signin") || url.includes("auth");
        if (loginStatus.needsLogin) {
          loginStatus.message = "Please log in via noVNC";
        } else if (loginStatus.isLoggedIn) {
          loginStatus.message = "Logged in to DirecTV";
        } else {
          loginStatus.message = "Checking login status...";
        }
      } else {
        loginStatus.message = "Browser not ready";
      }
    } catch (e) {
      loginStatus.error = e.message;
      loginStatus.message = "Error checking login";
    }

    // EPG Status
    const epgStatus = directvEpg.getStatus();
    epgStatus.autoRefreshEnabled = directvEpg.refreshTimer !== null;

    // Get tuner status with channel names
    const tunerStatus = tunerManager.getStatus();

    // Load channels to get names
    let channelMap = {};
    try {
      const fs = require("fs");
      const channelsPath = "/app/data/directv_channels.json";
      if (fs.existsSync(channelsPath)) {
        const data = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
        (data.channels || []).forEach(ch => {
          channelMap[ch.number] = { name: ch.callSign || ch.name, fullName: ch.name };
        });
      }
    } catch (e) { }

    // Enhance tuner info with channel names and per-tuner login status
    tunerStatus.tuners = await Promise.all(tunerStatus.tuners.map(async (t) => {
      // Check login status for this specific tuner
      let tunerLoginStatus = {
        isLoggedIn: false,
        needsLogin: false
      };
      try {
        const tuner = tunerManager.getTuner(t.id);
        if (tuner && tuner.page) {
          const url = tuner.page.url();
          tunerLoginStatus.isLoggedIn = url.includes("stream.directv.com") && !url.includes("login") && !url.includes("signin") && !url.includes("auth");
          tunerLoginStatus.needsLogin = url.includes("login") || url.includes("signin") || url.includes("auth");
        }
      } catch (e) { }

      return {
        ...t,
        channelName: channelMap[t.channel] ? channelMap[t.channel].name : "",
        channelFullName: channelMap[t.channel] ? channelMap[t.channel].fullName : "",
        login: tunerLoginStatus
      };
    }));

    // System ready status
    const channelsLoaded = directvEpg.getChannels().length > 0;
    const browserReady = loginStatus.currentUrl !== "";
    const systemReady = channelsLoaded && browserReady && loginStatus.isLoggedIn;

    let systemMessage = "Ready";
    if (!browserReady) {
      systemMessage = "Browser starting...";
    } else if (!loginStatus.isLoggedIn) {
      systemMessage = "Please log in via noVNC";
    } else if (!channelsLoaded) {
      systemMessage = "Loading channels...";
    }

    res.json({
      system: {
        ready: systemReady,
        message: systemMessage,
        browserReady: browserReady,
        channelsLoaded: channelsLoaded,
        uptime: Math.floor(process.uptime())
      },
      login: loginStatus,
      epg: epgStatus,
      tuners: tunerStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ============================================
// Settings API
// ============================================

// Get current settings
app.get('/api/settings', (req, res) => {
  res.json(settingsManager.getSettings());
});

// Save settings
app.post('/api/settings', (req, res) => {
  try {
    const saved = settingsManager.saveSettings(req.body);
    res.json({ success: true, settings: saved, restartRequired: false });
  } catch (err) {
    console.error('[server] Failed to save settings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reset to defaults
app.post('/api/settings/reset', (req, res) => {
  try {
    const defaults = settingsManager.getDefaults();
    const saved = settingsManager.saveSettings(defaults);
    res.json({ success: true, settings: saved });
  } catch (err) {
    console.error('[server] Failed to reset settings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get available presets
app.get('/api/presets', (req, res) => {
  res.json(getPresets());
});

// Apply a preset
app.post('/api/presets/:presetId', (req, res) => {
  const { presetId } = req.params;
  const preset = getPreset(presetId);

  if (!preset) {
    return res.status(404).json({ error: `Preset "${presetId}" not found` });
  }

  try {
    const currentSettings = settingsManager.getSettings();
    const newSettings = {
      ...currentSettings,
      ...preset.settings,
      // tuners preserved from currentSettings above
    };

    // Save the preset settings
    settingsManager.saveSettings(newSettings);
    res.json({ success: true, name: preset.name, settings: newSettings });
  } catch (err) {
    console.error('[server] Failed to apply preset:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ============================================
// Logs API
// ============================================

// Get server logs
app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  const logFile = '/var/log/supervisor/dvr.log';
  const errFile = '/var/log/supervisor/dvr_err.log';

  const logs = [];

  // Helper to parse log lines
  const parseLogLine = (line, isError = false) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    let level = 'info';
    let message = line.trim();

    if (!message) return null;

    // Detect level from content
    if (isError || message.includes('Error:') || message.includes('[error]') || message.includes('ERROR') || message.includes('failed')) {
      level = 'error';
    } else if (message.includes('[debug]') || message.includes('DEBUG')) {
      level = 'debug';
    } else if (message.includes('[warn]') || message.includes('WARN')) {
      level = 'warn';
    }

    // Extract timestamp if present in log
    const tsMatch = message.match(/^\[?(\d{2}:\d{2}:\d{2})\]?\s*/);
    const time = tsMatch ? tsMatch[1] : timestamp;

    return { time, level, message };
  };

  try {
    // Read main log
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      const logLines = content.split('\n').slice(-lines);
      logLines.forEach(line => {
        const parsed = parseLogLine(line);
        if (parsed) logs.push(parsed);
      });
    }

    // Read error log
    if (fs.existsSync(errFile)) {
      const content = fs.readFileSync(errFile, 'utf8');
      const errLines = content.split('\n').slice(-Math.floor(lines / 2));
      errLines.forEach(line => {
        const parsed = parseLogLine(line, true);
        if (parsed) logs.push(parsed);
      });
    }

    // Sort by time (most recent last)
    logs.sort((a, b) => a.time.localeCompare(b.time));

    res.json({ logs: logs.slice(-lines) });
  } catch (err) {
    res.status(500).json({ error: err.message, logs: [] });
  }
});


// ============================================
// System Info API
// ============================================

app.get('/api/system-info', (req, res) => {
  try {
    const os = require('os');
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const memUsage = process.memoryUsage();
    const memoryStr = `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`;

    // Get container ID
    let containerId = '-';
    try {
      containerId = fs.readFileSync('/etc/hostname', 'utf8').trim().substring(0, 12);
    } catch (e) { }

    // Get image info from environment or file
    const imageInfo = process.env.DVR_IMAGE || 'sunnyside1/directvtuner:latest';
    const version = process.env.DVR_VERSION || '1.0';

    res.json({
      version: version,
      image: imageInfo,
      uptime: uptimeStr,
      memory: memoryStr,
      nodeVersion: process.version,
      containerId: containerId
    });
  } catch (err) {
    console.error('[server] Failed to get system info:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ============================================
// Diagnostics Export API
// ============================================

app.get('/api/diagnostics', async (req, res) => {
  try {
    const os = require('os');
    const { execSync } = require('child_process');
    const archiver = require('archiver');

    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="dvr-diagnostics-${timestamp}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // System info
    const systemInfo = {
      timestamp: new Date().toISOString(),
      version: process.env.DVR_VERSION || '1.0',
      image: process.env.DVR_IMAGE || 'sunnyside1/directvtuner:latest',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      env: {
        DVR_NUM_TUNERS: process.env.DVR_NUM_TUNERS,
        EXTERNAL: process.env.EXTERNAL,
        DISPLAY: process.env.DISPLAY
      }
    };
    archive.append(JSON.stringify(systemInfo, null, 2), { name: 'system-info.json' });

    // Tuner status
    try {
      const tunerStatus = tunerManager.getStatus();
      archive.append(JSON.stringify(tunerStatus, null, 2), { name: 'tuner-status.json' });
    } catch (e) {
      archive.append(`Error getting tuner status: ${e.message}`, { name: 'tuner-status-error.txt' });
    }

    // Current settings
    try {
      const settings = settingsManager.getSettings();
      archive.append(JSON.stringify(settings, null, 2), { name: 'settings.json' });
    } catch (e) {
      archive.append(`Error getting settings: ${e.message}`, { name: 'settings-error.txt' });
    }

    // Log files
    const logFiles = [
      '/var/log/supervisor/dvr.log',
      '/var/log/supervisor/dvr_err.log',
      '/var/log/supervisor/chrome_err.log',
      '/var/log/supervisor/supervisord.log'
    ];

    for (const logFile of logFiles) {
      try {
        if (fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf8');
          // Only include last 10000 lines to keep file size reasonable
          const lines = content.split('\n').slice(-10000).join('\n');
          const filename = path.basename(logFile);
          archive.append(lines, { name: `logs/${filename}` });
        }
      } catch (e) {
        archive.append(`Error reading ${logFile}: ${e.message}`, { name: `logs/${path.basename(logFile)}-error.txt` });
      }
    }

    // Process list
    try {
      const ps = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
      archive.append(ps, { name: 'processes.txt' });
    } catch (e) {
      archive.append(`Error getting process list: ${e.message}`, { name: 'processes-error.txt' });
    }

    // Network info
    try {
      const netInterfaces = os.networkInterfaces();
      archive.append(JSON.stringify(netInterfaces, null, 2), { name: 'network-interfaces.json' });
    } catch (e) {
      archive.append(`Error getting network info: ${e.message}`, { name: 'network-error.txt' });
    }

    // Disk usage
    try {
      const df = execSync('df -h', { encoding: 'utf8', timeout: 5000 });
      archive.append(df, { name: 'disk-usage.txt' });
    } catch (e) {
      archive.append(`Error getting disk usage: ${e.message}`, { name: 'disk-error.txt' });
    }

    await archive.finalize();

  } catch (err) {
    console.error('[server] Failed to generate diagnostics:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});


// M3U Playlist endpoint
app.get('/playlist.m3u', (req, res) => {
  const host = req.headers.host || `${config.host}:${config.port}`;
  const m3u = generateM3U(host);

  res.setHeader('Content-Type', 'application/x-mpegurl');
  res.setHeader('Content-Disposition', 'attachment; filename="directv.m3u"');
  res.send(m3u);
});

// Channel list as JSON
app.get('/channels', (req, res) => {
  res.json(getAllChannels());
});

// Tuner status
app.get('/tuners', (req, res) => {
  res.json(tunerManager.getStatus());
});

// Stream health statistics
app.get('/stats', (req, res) => {
  const status = tunerManager.getStatus();
  const stats = {
    server: {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: Date.now()
    },
    tuners: status.tuners.map(t => ({
      id: t.id,
      state: t.state,
      channel: t.channel,
      clients: t.clients,
      stream: t.stream
    }))
  };
  res.json(stats);
});

// Main stream endpoint - serves HLS playlist or MPEG-TS depending on mode
app.get('/stream/:channelId', async (req, res) => {
  const { channelId } = req.params;
  const startTime = Date.now();
  const log = (msg) => console.log(`[server] [${Date.now() - startTime}ms] ${msg}`);

  log(`Stream request for ${channelId}`);

  // Try to find channel - first check static channels.js, then try EPG (supports both ID and number)
  let channel = getChannel(channelId);
  if (!channel) {
    // Try EPG data - getChannel handles both ID and number lookup
    channel = directvEpg.getChannel(channelId);
  }
  if (!channel) {
    return res.status(404).json({ error: `Unknown channel: ${channelId}` });
  }

  try {
    // Use channel key for tuner allocation (EPG routes by number:name key)
    const channelKey = channel.name ? `${channel.number}:${channel.name}` : channelId;

    // Allocate a tuner for this channel
    log('Allocating tuner...');
    const tuner = await tunerManager.allocateTuner(channelKey);
    log(`Tuner allocated: ${tuner ? tuner.id : 'none'} (state: ${tuner?.state})`);

    if (!tuner) {
      return res.status(503).json({
        error: 'All tuners busy',
        message: 'No tuners available. Try again later or release a tuner.',
      });
    }

    log(`Serving ${channelId} from tuner ${tuner.id} (state: ${tuner.state})`);

    // Wait for tuner to be in streaming state (not tuning)
    let stateWait = 0;
    const maxStateWait = 30000;  // 30 seconds for channel switch
    while (tuner.state === 'tuning' && stateWait < maxStateWait) {
      await new Promise(r => setTimeout(r, 500));
      stateWait += 500;
      log(`Waiting for tuner state... (${stateWait}ms, state: ${tuner.state})`);
    }
    log(`Tuner ready (state: ${tuner.state})`);

    // Verify tuner is on the correct channel
    if (tuner.currentChannel !== channelKey) {
      console.log(`[server] Tuner switched away from ${channelKey}, was expecting ${channelKey} got ${tuner.currentChannel}`);
      return res.status(503).json({ error: 'Channel switched, please retry' });
    }

    // Update activity
    tuner.lastActivity = Date.now();

    // Check if using HLS mode (better for multiple clients)
    if (tuner.ffmpeg && tuner.ffmpeg.isHlsMode()) {
      log('Using HLS mode - waiting for playlist...');

      // Wait for HLS playlist to be ready (first segments generated)
      // HLS needs ~4-6 seconds to generate first segment
      let hlsWait = 0;
      const maxHlsWait = 20000; // 20 seconds for first segments
      while (!tuner.ffmpeg.isHlsReady() && hlsWait < maxHlsWait) {
        await new Promise(r => setTimeout(r, 500));
        hlsWait += 500;
        if (hlsWait % 5000 === 0) {
          log(`Still waiting for HLS playlist... (${hlsWait / 1000}s)`);
        }
      }

      if (!tuner.ffmpeg.isHlsReady()) {
        log('HLS playlist not ready after 20s, returning error');
        return res.status(503).json({
          error: 'Stream not ready',
          message: 'HLS segments still generating, please retry in a few seconds'
        });
      }

      // Redirect to HLS playlist
      const host = req.headers.host || `${config.host}:${config.port}`;
      const hlsUrl = `http://${host}/tuner/${tuner.id}/stream.m3u8`;
      log(`Redirecting to HLS: ${hlsUrl}`);
      return res.redirect(302, hlsUrl);
    }

    // MPEG-TS pipe mode (only when HLS is disabled)
    // Set MPEG-TS headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');

    log('Starting MPEG-TS stream');

    // Pipe the MPEG-TS stream directly to the client
    // This will restart FFmpeg if it was stopped due to idle timeout
    await tuner.pipeToClient(res);

    // The connection will stay open until the client disconnects
    // or the tuner is released

  } catch (err) {
    // Handle no upcoming airings with a generated error video
    if (err.message === "NO_UPCOMING_AIRINGS") {
      // Reset the tuner so it can be used again
      tunerManager.releaseTuner(0);
      console.log(`[server] Channel ${channelId} has no upcoming airings, sending error video`);
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "no-cache");

      // Generate a simple error video with FFmpeg
      const { spawn } = require("child_process");
      const ffmpeg = spawn("ffmpeg", [
        "-f", "lavfi",
        "-i", `color=c=black:s=1280x720:d=10`,
        "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=stereo",
        "-vf", `drawtext=text='No Upcoming Airings\nPlease Change Channel':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-t", "10",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-c:a", "aac",
        "-f", "mpegts",
        "-"
      ]);

      ffmpeg.stdout.pipe(res);
      ffmpeg.stderr.on("data", () => { });
      ffmpeg.on("close", () => res.end());
      return;
    }

    console.error(`[server] Error allocating tuner for ${channelId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve HLS playlist for a tuner
app.get('/tuner/:tunerId/stream.m3u8', async (req, res) => {
  const { tunerId } = req.params;
  const tuner = tunerManager.getTuner(tunerId);

  if (!tuner) {
    return res.status(404).json({ error: `Tuner ${tunerId} not found` });
  }

  const playlistPath = tuner.getPlaylistPath();
  if (!playlistPath || !fs.existsSync(playlistPath)) {
    return res.status(404).json({ error: 'Stream not ready' });
  }

  // Update activity
  tuner.lastActivity = Date.now();

  // Read and modify playlist to use absolute URLs
  let playlist = fs.readFileSync(playlistPath, 'utf8');

  // Replace segment filenames with full URLs (both regular HLS and LL-HLS)
  const host = req.headers.host || `${config.host}:${config.port}`;
  playlist = playlist.replace(/^(segment\d+\.ts)$/gm, `http://${host}/tuner/${tunerId}/$1`);
  playlist = playlist.replace(/^(segment\d+\.m4s)$/gm, `http://${host}/tuner/${tunerId}/$1`);
  // Handle init.mp4 in EXT-X-MAP tag: #EXT-X-MAP:URI="init.mp4"
  playlist = playlist.replace(/URI="(init\.mp4)"/g, `URI="http://${host}/tuner/${tunerId}/$1"`);

  // Add EXT-X-START to force players to start near live edge (reduces stuttering on resume)
  // TIME-OFFSET=-3 means start 3 seconds before live edge
  if (!playlist.includes('#EXT-X-START')) {
    playlist = playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=-3,PRECISE=YES');
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(playlist);
});

// Serve HLS segments for a tuner (supports both regular HLS and LL-HLS)
app.get('/tuner/:tunerId/:segment', (req, res) => {
  const { tunerId, segment } = req.params;
  const tuner = tunerManager.getTuner(tunerId);

  if (!tuner) {
    return res.status(404).json({ error: `Tuner ${tunerId} not found` });
  }

  // Security: only serve valid HLS segment files
  // Regular HLS: .ts files
  // LL-HLS: .m4s segments and init.mp4
  const isValidSegment = segment.endsWith('.ts') ||
    segment.endsWith('.m4s') ||
    segment === 'init.mp4';

  if (!isValidSegment) {
    return res.status(400).json({ error: 'Invalid segment' });
  }

  const segmentPath = tuner.getSegmentPath(segment);
  if (!segmentPath || !fs.existsSync(segmentPath)) {
    return res.status(404).json({ error: 'Segment not found' });
  }

  // Update activity
  tuner.lastActivity = Date.now();

  // Set correct MIME type based on segment type
  let contentType = 'video/mp2t'; // Default for .ts
  if (segment.endsWith('.m4s') || segment === 'init.mp4') {
    contentType = 'video/mp4';
  }

  res.setHeader('Content-Type', contentType);
  // Short cache for LL-HLS segments, longer for init
  res.setHeader('Cache-Control', segment === 'init.mp4' ? 'max-age=3600' : 'no-cache');
  fs.createReadStream(segmentPath).pipe(res);
});

// Release a client from tuner (called when client stops watching)
app.post('/tuner/:tunerId/release', (req, res) => {
  const { tunerId } = req.params;
  tunerManager.releaseClient(tunerId);
  res.json({ success: true });
});

// Force release tuner (admin endpoint)
app.post('/tuner/:tunerId/force-release', async (req, res) => {
  const { tunerId } = req.params;
  await tunerManager.releaseTuner(tunerId);
  res.json({ success: true });
});

// Reset a single tuner (kill its FFmpeg and reset state)
app.post('/api/tuner/:tunerId/reset', async (req, res) => {
  const tunerId = parseInt(req.params.tunerId);
  try {
    const tuner = tunerManager.getTuner(tunerId);
    if (!tuner) {
      return res.status(404).json({ error: `Tuner ${tunerId} not found` });
    }

    // Stop the FFmpeg capture for this tuner
    if (tuner.ffmpegCapture) {
      tuner.ffmpegCapture.stop();
    }

    // Release the tuner
    await tunerManager.releaseTuner(tunerId);

    console.log(`[server] Tuner ${tunerId} reset via API`);
    res.json({ success: true, message: `Tuner ${tunerId} reset successfully` });
  } catch (err) {
    console.error(`[server] Failed to reset tuner ${tunerId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear Chrome cache for a tuner AND restart Chrome (fixes DirecTV "streaming limit" errors)
app.post('/api/tuner/:tunerId/clear-cache', async (req, res) => {
  const tunerId = parseInt(req.params.tunerId);
  const numTuners = parseInt(process.env.DVR_NUM_TUNERS) || 1;

  if (tunerId < 0 || tunerId >= numTuners) {
    return res.status(400).json({ error: `Invalid tuner ID: ${tunerId}` });
  }

  try {
    const { execSync, spawn } = require('child_process');
    const profileDir = `/data/chrome-profile-${tunerId}`;
    const debugPort = 9222 + tunerId;
    const displayNum = tunerId + 1;

    // 1. Kill Chrome for this specific tuner
    try {
      execSync(`pkill -9 -f "chrome-profile-${tunerId}"`, { timeout: 5000 });
      console.log(`[server] Killed Chrome for tuner ${tunerId}`);
    } catch (e) {
      // Chrome might not be running for this tuner
    }

    // Wait for Chrome to fully terminate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Clear cache directories
    const cacheDirs = [
      `${profileDir}/Default/Cache`,
      `${profileDir}/Default/Code Cache`,
      `${profileDir}/Default/GPUCache`,
      `${profileDir}/Default/Service Worker`,
    ];

    for (const dir of cacheDirs) {
      try {
        execSync(`rm -rf "${dir}"`, { timeout: 5000 });
      } catch (e) {
        // Directory might not exist, that's fine
      }
    }
    console.log(`[server] Cleared Chrome cache for tuner ${tunerId}`);

    // 3. Restart Chrome for this tuner
    const chromeArgs = [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=0.0.0.0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--window-position=0,0',
      '--kiosk',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--alsa-output-device=pulse',
      'https://stream.directv.com'
    ];

    const chrome = spawn('/usr/bin/google-chrome-stable', chromeArgs, {
      env: { ...process.env, DISPLAY: `:${displayNum}` },
      detached: true,
      stdio: 'ignore'
    });
    chrome.unref();

    console.log(`[server] Restarted Chrome for tuner ${tunerId} on display :${displayNum}, debug port ${debugPort}`);

    res.json({
      success: true,
      message: `Cache cleared and Chrome restarted for tuner ${tunerId}. You may need to log in again.`
    });
  } catch (err) {
    console.error(`[server] Failed to clear cache for tuner ${tunerId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to sync Chrome profiles (used by API and auto-sync)
async function syncChromeProfiles() {
  const numTuners = parseInt(process.env.DVR_NUM_TUNERS) || 1;

  if (numTuners <= 1) {
    return { success: true, message: 'Only 1 tuner configured, nothing to sync' };
  }

  const { execSync, spawn } = require('child_process');
  const sourceProfile = '/data/chrome-profile-0';

  // Check if source profile exists
  if (!fs.existsSync(sourceProfile)) {
    return { success: false, error: 'Source profile not found' };
  }

  // Check if cookies exist (login data)
  if (!fs.existsSync(`${sourceProfile}/Default/Cookies`)) {
    return { success: false, error: 'No login data found in tuner 0' };
  }

  console.log(`[server] Syncing Chrome profile from tuner 0 to tuners 1-${numTuners - 1}...`);

  // Stop Chrome for tuners 1+ before copying
  for (let i = 1; i < numTuners; i++) {
    try {
      execSync(`pkill -9 -f "chrome-profile-${i}"`, { timeout: 5000 });
    } catch (e) {
      // Chrome might not be running
    }
  }

  // Wait for Chrome to stop
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Copy ONLY auth-related files (not the whole profile) to each tuner
  const authFiles = [
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Login Data',
    'Default/Login Data-journal',
    'Default/Web Data',
    'Default/Web Data-journal'
  ];
  const authDirs = [
    'Default/Local Storage',
    'Default/Session Storage',
    'Default/IndexedDB'
  ];

  for (let i = 1; i < numTuners; i++) {
    const targetProfile = `/data/chrome-profile-${i}`;

    // Create target profile and Default directory if they don't exist
    if (!fs.existsSync(targetProfile)) {
      fs.mkdirSync(targetProfile, { recursive: true });
    }
    if (!fs.existsSync(`${targetProfile}/Default`)) {
      fs.mkdirSync(`${targetProfile}/Default`, { recursive: true });
    }

    // Copy auth files
    for (const file of authFiles) {
      const src = `${sourceProfile}/${file}`;
      const dst = `${targetProfile}/${file}`;
      if (fs.existsSync(src)) {
        try {
          execSync(`cp "${src}" "${dst}"`, { timeout: 5000 });
        } catch (e) {
          console.log(`[server] Warning: Could not copy ${file}`);
        }
      }
    }

    // Copy auth directories
    for (const dir of authDirs) {
      const src = `${sourceProfile}/${dir}`;
      const dst = `${targetProfile}/${dir}`;
      if (fs.existsSync(src)) {
        try {
          execSync(`rm -rf "${dst}" && cp -r "${src}" "${dst}"`, { timeout: 10000 });
        } catch (e) {
          console.log(`[server] Warning: Could not copy ${dir}`);
        }
      }
    }

    // Remove lock files
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const lock of lockFiles) {
      try {
        fs.unlinkSync(`${targetProfile}/${lock}`);
      } catch (e) { }
    }

    console.log(`[server] Copied auth files to tuner ${i}`);
  }

  // Restart Chrome for tuners 1+
  for (let i = 1; i < numTuners; i++) {
    const debugPort = 9222 + i;
    const displayNum = i + 1;
    const profileDir = `/data/chrome-profile-${i}`;

    const chromeArgs = [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=0.0.0.0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--window-position=0,0',
      '--kiosk',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--alsa-output-device=pulse',
      'https://stream.directv.com'
    ];

    const chrome = spawn('/usr/bin/google-chrome-stable', chromeArgs, {
      env: {
        ...process.env,
        DISPLAY: `:${displayNum}`,
        PULSE_SERVER: 'unix:/run/pulse/native',
        PULSE_SINK: `virtual_speaker_${i}`
      },
      detached: true,
      stdio: 'ignore'
    });
    chrome.unref();

    console.log(`[server] Restarted Chrome for tuner ${i} on display :${displayNum}`);
  }

  return { success: true, message: `Profile synced to ${numTuners - 1} tuner(s). All tuners should now be logged in!` };
}

// Auto-sync login when tuner 0 logs in
async function checkAndAutoSyncLogin() {
  const numTuners = parseInt(process.env.DVR_NUM_TUNERS) || 1;
  if (numTuners <= 1 || profileSyncedAfterLogin) return;

  // Allow disabling auto-sync for multi-account setups
  if (process.env.DVR_PROFILE_SYNC_DISABLED === 'true') return;

  const now = Date.now();
  if (now - lastLoginCheckTime < LOGIN_CHECK_INTERVAL) return;
  lastLoginCheckTime = now;

  try {
    const tuner = tunerManager.getTuner(0);
    if (!tuner || !tuner.page) return;

    const url = tuner.page.url();
    const isLoggedIn = url.includes("stream.directv.com") && !url.includes("login") && !url.includes("signin") && !url.includes("auth");

    if (isLoggedIn) {
      // Check if cookies exist
      const sourceProfile = '/data/chrome-profile-0';
      if (fs.existsSync(`${sourceProfile}/Default/Cookies`)) {
        console.log('[server] Login detected on tuner 0, auto-syncing profiles to other tuners...');
        const result = await syncChromeProfiles();
        if (result.success) {
          profileSyncedAfterLogin = true;
          console.log('[server] Auto-sync complete:', result.message);
        }
      }
    }
  } catch (e) {
    // Ignore errors during auto-check
  }
}

// Start auto-sync checker
setInterval(checkAndAutoSyncLogin, LOGIN_CHECK_INTERVAL);

// Sync Chrome profile from tuner 0 to all other tuners (share login session)
app.post('/api/sync-profiles', async (req, res) => {
  try {
    const result = await syncChromeProfiles();
    if (result.success) {
      profileSyncedAfterLogin = true;
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    console.error('[server] Profile sync failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Kill all FFmpeg processes (emergency reset)
app.post("/api/ffmpeg/kill", async (req, res) => {
  try {
    const { execSync } = require("child_process");
    // Kill any running ffmpeg processes
    try {
      execSync("pkill -9 ffmpeg", { timeout: 5000 });
      console.log("[server] FFmpeg processes killed via API");
    } catch (e) {
      // pkill returns error if no processes found, which is fine
    }
    // Reset tuner states
    const status = tunerManager.getStatus();
    for (const tuner of status.tuners) {
      if (tuner.state === 'streaming' || tuner.state === 'tuning') {
        await tunerManager.releaseTuner(tuner.id);
      }
    }
    res.json({ success: true, message: "FFmpeg processes killed and tuners reset" });
  } catch (err) {
    console.error("[server] Failed to kill FFmpeg:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reset Chrome (clean lock files and restart)
app.post("/api/chrome/reset", async (req, res) => {
  try {
    const { execSync } = require("child_process");
    const fs = require("fs");
    const path = require("path");

    const chromeProfile = "/data/chrome-profile";
    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

    // Kill Chrome first
    try {
      execSync("pkill -9 chrome", { timeout: 5000 });
      console.log("[server] Chrome processes killed");
    } catch (e) {
      // Chrome might not be running
    }

    // Clean up lock files
    let cleaned = [];
    for (const lockFile of lockFiles) {
      const filePath = path.join(chromeProfile, lockFile);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleaned.push(lockFile);
      }
    }

    console.log("[server] Chrome lock files cleaned:", cleaned.length > 0 ? cleaned.join(", ") : "none found");

    // Restart Chrome via supervisorctl
    try {
      execSync("supervisorctl restart chrome", { timeout: 10000 });
      console.log("[server] Chrome restarted via supervisorctl");
    } catch (e) {
      console.log("[server] supervisorctl not available, Chrome will restart automatically");
    }

    res.json({
      success: true,
      message: "Chrome reset successfully",
      cleanedFiles: cleaned
    });
  } catch (err) {
    console.error("[server] Failed to reset Chrome:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GPU Monitoring API
// ============================================
const gpuMonitor = require('./gpu-monitor');

// Get GPU status
app.get('/api/gpu/status', (req, res) => {
  try {
    const status = gpuMonitor.getStatus();
    res.json(status);
  } catch (err) {
    console.error('[server] Failed to get GPU status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test NVENC encoding
app.post('/api/gpu/test-nvenc', async (req, res) => {
  try {
    const result = await gpuMonitor.testNvenc();
    res.json(result);
  } catch (err) {
    console.error('[server] Failed to test NVENC:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get NVENC session limits
app.get('/api/gpu/sessions', (req, res) => {
  try {
    const limits = gpuMonitor.getSessionLimits();
    res.json(limits || { error: 'No NVIDIA GPU available' });
  } catch (err) {
    console.error('[server] Failed to get session limits:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================== DIRECTV EPG ENDPOINTS ==================

// XMLTV EPG for TvMate/IPTV apps
app.get('/tve/directv/epg.xml', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  console.log(`[epg] Generating XMLTV EPG (${hours} hours)`);

  const xml = directvEpg.generateXMLTV(hours);

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', 'attachment; filename="directv-epg.xml"');
  res.send(xml);
});

// M3U playlist with EPG tvg-id matching
app.get('/tve/directv/playlist.m3u', (req, res) => {
  const host = req.headers.host || `${config.host}:${config.port}`;
  console.log('[epg] Generating DirecTV M3U playlist with EPG IDs');

  const m3u = directvEpg.generateM3U(host);

  res.setHeader('Content-Type', 'application/x-mpegurl');
  res.setHeader('Content-Disposition', 'attachment; filename="directv.m3u"');
  res.send(m3u);
});

// DirecTV channel list from EPG
app.get('/tve/directv/channels', (req, res) => {
  res.json({
    success: true,
    count: directvEpg.getChannels().length,
    channels: directvEpg.getChannels()
  });
});

// EPG status
app.get('/tve/directv/epg/status', (req, res) => {
  res.json(directvEpg.getStatus());
});

// Refresh EPG data from DirecTV (requires authenticated browser session)
app.post('/tve/directv/epg/refresh', async (req, res) => {
  try {
    console.log('[epg] Manual EPG refresh requested');
    const result = await directvEpg.fetchFromBrowser();
    res.json({
      success: true,
      message: 'EPG refreshed',
      ...result
    });
  } catch (error) {
    console.error('[epg] Refresh error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stream a DirecTV channel by number (placeholder - needs tuner integration)
app.get('/tve/directv/stream/:channelNumber', async (req, res) => {
  const { channelNumber } = req.params;

  // Find channel by number
  const channel = directvEpg.getChannelByNumber(channelNumber);
  if (!channel) {
    return res.status(404).json({ error: `Channel ${channelNumber} not found` });
  }

  // For now, redirect to the stream.directv.com URL
  // This would need browser automation to actually play
  res.redirect(`https://stream.directv.com/watch/live?channel=${channel.ccid}`);
});

// ================== END DIRECTV EPG ENDPOINTS ==================

// Startup
// Login watcher - monitors for login and triggers EPG refresh when logged in
let loginWatcherActive = false;
let loginDetected = false;

async function startLoginWatcher() {
  if (loginWatcherActive) return;
  loginWatcherActive = true;
  loginDetected = false;

  console.log("[login-watcher] Starting login monitor...");

  const checkInterval = 10000; // Check every 10 seconds
  const maxWait = 600000; // Max 10 minutes
  let waited = 0;

  const check = async () => {
    try {
      const tuner = tunerManager.getTuner(0);
      if (tuner && tuner.page) {
        const url = tuner.page.url();
        const isLoggedIn = url.includes("stream.directv.com") &&
          !url.includes("login") &&
          !url.includes("signin") &&
          !url.includes("auth");

        if (isLoggedIn && !loginDetected) {
          loginDetected = true;
          console.log("[login-watcher] Login detected! Triggering EPG refresh...");

          // Check if EPG is empty or stale
          const epgStatus = directvEpg.getStatus();
          if (epgStatus.channelCount === 0 || epgStatus.cacheAge > 14400) {
            try {
              await directvEpg.fetchFromBrowser();
              console.log("[login-watcher] EPG refresh completed");
            } catch (e) {
              console.error("[login-watcher] EPG refresh failed:", e.message);
            }
          } else {
            console.log("[login-watcher] EPG already has " + epgStatus.channelCount + " channels");
          }
          loginWatcherActive = false;
          return;
        } else if (!isLoggedIn) {
          console.log("[login-watcher] Waiting for login... (URL: " + url.substring(0, 50) + "...)");
        }
      }
    } catch (e) {
      console.log("[login-watcher] Check error:", e.message);
    }

    waited += checkInterval;
    if (waited < maxWait) {
      setTimeout(check, checkInterval);
    } else {
      console.log("[login-watcher] Timeout waiting for login");
      loginWatcherActive = false;
    }
  };

  // Start checking after 15 seconds (give browser time to load)
  setTimeout(check, 15000);
}


async function start() {
  console.log('='.repeat(60));
  console.log('DirecTV IPTV Proxy Server');
  console.log('='.repeat(60));

  // Initialize tuner manager
  console.log('[server] Initializing tuners...');
  await tunerManager.initialize();

  // Initialize GPU monitor
  console.log('[server] Initializing GPU monitor...');
  await gpuMonitor.initialize();

  // Start HTTP server
  app.listen(config.port, config.host, () => {
    console.log(`[server] Server running on http://${config.host}:${config.port}`);
    console.log('');
    console.log('DirecTV Endpoints:');
    console.log(`  M3U Playlist:     http://<host>:${config.port}/playlist.m3u`);
    console.log(`  Channels:         http://<host>:${config.port}/channels`);
    console.log(`  Tuner Status:     http://<host>:${config.port}/tuners`);
    console.log(`  Stream Health:    http://<host>:${config.port}/stats`);
    console.log(`  Stream:           http://<host>:${config.port}/stream/<channelId>`);
    console.log('');
    console.log('Add the M3U URL to TvMate or VLC to start watching!');
    console.log('='.repeat(60));

    // Start login watcher - checks for login and triggers EPG refresh
    startLoginWatcher();

    // Start EPG auto-refresh (every 4 hours)
    directvEpg.startAutoRefresh();
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[server] Shutting down...');
  await tunerManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[server] Shutting down...');
  await tunerManager.shutdown();
  process.exit(0);
});

// Start the server
start().catch(err => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
