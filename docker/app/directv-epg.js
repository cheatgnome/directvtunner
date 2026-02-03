// DirecTV EPG Service
// Fetches guide data from DirecTV API and generates XMLTV format

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_CACHE = path.join(DATA_DIR, 'directv_channels.json');
const EPG_CACHE = path.join(DATA_DIR, 'directv_epg.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'channel-overrides.json');

// DirecTV API base
const API_BASE = 'https://api.cld.dtvce.com';

// Default client context (New York DMA 501)
const DEFAULT_CLIENT_CONTEXT = 'dmaID:501_0,billingDmaID:501,regionID:OV MSG SPOT_RegC New York NY_OTT MSG Plus 08152022 SPOT_OV New York NY 501_BTN4OF_BG10O2H_BTN3OF_BTN2OF_SNF SportsNet NY SPOT_YESHDNY_YES2HD_BGTN4HD_OV2 RegC New York NY_BGTN3HD_BIG10HD_MSG OTT SPOT_YES Network Spot SPOT_OV MSG PLUS SPOT_MSG OV 02052021 SPOT_YES OOM B/O_OV MeTV Allowed SPOT_OV New York NY DMA 501,zipCode:11369,countyCode:081,stateNumber:36,stateAbbr:NY,usrLocAndBillLocAreSame:true,bRegionID:OV MSG SPOT_RegC New York NY_OTT MSG Plus 08152022 SPOT_OV New York NY 501_BTN4OF_BG10O2H_BTN3OF_BTN2OF_SNF SportsNet NY SPOT_YESHDNY_YES2HD_BGTN4HD_OV2 RegC New York NY_BGTN3HD_BIG10HD_MSG OTT SPOT_YES Network Spot SPOT_OV MSG PLUS SPOT_MSG OV 02052021 SPOT_YES OOM B/O_OV MeTV Allowed SPOT_OV New York NY DMA 501,isFFP:false,deviceProximity:OOH';

// Auto-refresh interval (4 hours)
const settingsManager = require('./settings-manager');

// Get refresh interval from settings (in hours), default 4
function getRefreshInterval() {
  const settings = settingsManager.getSettings();
  const hours = settings.epg?.refreshInterval || 4;
  return hours * 60 * 60 * 1000;
}

class DirectvEpg {
  constructor() {
    this.channels = [];           // Merged channel list (deduplicated)
    this.tunerChannels = {};      // Per-tuner channels: { tunerId: [...channels] }
    this.tunerMapping = {};       // Channel to tuner: { channelNumber: tunerId }
    this.schedules = {};
    this.lastFetch = null;
    this.refreshTimer = null;
    this.isRefreshing = false;
    this.overrides = {};          // Channel overrides: { channelId: { hidden, customName, customGroup } }
    this.loadCache();
    this.loadOverrides();
  }

  // Start auto-refresh timer
  startAutoRefresh() {
    if (this.refreshTimer) return;

    console.log(`[epg] Auto-refresh enabled (every ${getRefreshInterval() / 1000 / 60 / 60} hours)`);

    // Check if we need an immediate refresh (cache older than interval)
    const cacheAge = this.lastFetch ? Date.now() - this.lastFetch : Infinity;
    if (cacheAge > getRefreshInterval()) {
      console.log('[epg] Cache is stale, scheduling immediate refresh...');
      setTimeout(() => this.autoRefresh(), 10000); // Wait 10s for server to be ready
    }

    // Set up recurring refresh
    this.refreshTimer = setInterval(() => this.autoRefresh(), getRefreshInterval());
  }

  // Stop auto-refresh
  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      console.log('[epg] Auto-refresh disabled');
    }
  }

  // Auto-refresh handler
  async autoRefresh() {
    if (this.isRefreshing) {
      console.log('[epg] Refresh already in progress, skipping');
      return;
    }

    console.log('[epg] Starting auto-refresh...');
    try {
      await this.fetchFromBrowser();
      console.log('[epg] Auto-refresh completed successfully');
    } catch (err) {
      console.error('[epg] Auto-refresh failed:', err.message);
    }
  }

  loadCache() {
    try {
      if (fs.existsSync(CHANNELS_CACHE)) {
        const data = JSON.parse(fs.readFileSync(CHANNELS_CACHE, 'utf8'));
        this.channels = data.channels || [];
        this.tunerChannels = data.tunerChannels || {};
        this.tunerMapping = data.tunerMapping || {};
        console.log(`[epg] Loaded ${this.channels.length} channels from cache (${Object.keys(this.tunerChannels).length} tuners)`);
      }
      if (fs.existsSync(EPG_CACHE)) {
        const data = JSON.parse(fs.readFileSync(EPG_CACHE, 'utf8'));
        this.schedules = data.schedules || {};
        this.lastFetch = data.lastFetch;
        console.log(`[epg] Loaded EPG cache from ${new Date(this.lastFetch).toISOString()}`);
      }
    } catch (err) {
      console.error('[epg] Error loading cache:', err.message);
    }
  }

  saveCache() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(CHANNELS_CACHE, JSON.stringify({
        channels: this.channels,
        tunerChannels: this.tunerChannels,
        tunerMapping: this.tunerMapping
      }, null, 2));
      fs.writeFileSync(EPG_CACHE, JSON.stringify({ schedules: this.schedules, lastFetch: this.lastFetch }, null, 2));
      console.log('[epg] Cache saved');
    } catch (err) {
      console.error('[epg] Error saving cache:', err.message);
    }
  }

  // Load channel overrides from file
  loadOverrides() {
    try {
      if (fs.existsSync(OVERRIDES_FILE)) {
        this.overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
        console.log(`[epg] Loaded ${Object.keys(this.overrides).length} channel overrides`);
      }
    } catch (err) {
      console.error('[epg] Error loading overrides:', err.message);
      this.overrides = {};
    }
  }

  // Save channel overrides to file
  saveOverrides() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(this.overrides, null, 2));
      console.log('[epg] Overrides saved');
    } catch (err) {
      console.error('[epg] Error saving overrides:', err.message);
    }
  }

  // Set override for a channel
  setOverride(channelId, override) {
    this.overrides[channelId] = { ...this.overrides[channelId], ...override };
    this.saveOverrides();
    return this.overrides[channelId];
  }

  // Remove override for a channel
  removeOverride(channelId) {
    delete this.overrides[channelId];
    this.saveOverrides();
  }

  // Get all overrides
  getOverrides() {
    return this.overrides;
  }

  // Get channel with overrides applied
  getChannelWithOverrides(channel) {
    const override = this.overrides[channel.id] || {};
    return {
      ...channel,
      name: override.customName || channel.name,
      group: override.customGroup || this.getChannelGroup(channel),
      hidden: override.hidden || false,
      hasOverride: !!this.overrides[channel.id]
    };
  }

  // Fetch channels and EPG via browser CDP (uses authenticated session)
  // Scans ALL tuners to support multi-account setups
  async fetchFromBrowser() {
    if (this.isRefreshing) {
      console.log('[epg] Refresh already in progress, skipping');
      return { channels: this.channels.length, schedules: Object.keys(this.schedules).length };
    }

    this.isRefreshing = true;
    const numTuners = parseInt(process.env.DVR_NUM_TUNERS) || 1;
    console.log(`[epg] Fetching EPG data from ${numTuners} tuner(s)...`);

    // Reset per-tuner data
    this.tunerChannels = {};
    this.tunerMapping = {};
    const allChannelsById = new Map(); // Deduplicate by ID (not number - some channels share numbers)

    try {
      // Scan each tuner
      for (let tunerId = 0; tunerId < numTuners; tunerId++) {
        const debugPort = 9222 + tunerId;
        console.log(`[epg] Scanning tuner ${tunerId} (port ${debugPort})...`);

        try {
          const tunerChannels = await this.fetchFromTuner(tunerId, debugPort);

          if (tunerChannels.length > 0) {
            this.tunerChannels[tunerId] = tunerChannels;
            console.log(`[epg] Tuner ${tunerId}: Found ${tunerChannels.length} channels`);

            // Build tuner mapping (first tuner with channel wins)
            // Use compound key (number:name) to handle channels that share the same number
            for (const channel of tunerChannels) {
              const channelKey = `${channel.number}:${channel.name}`;
              if (!this.tunerMapping[channelKey]) {
                this.tunerMapping[channelKey] = tunerId;
              }
              // Also add to merged channel list (deduplicated by ID)
              if (!allChannelsById.has(channel.id)) {
                allChannelsById.set(channel.id, channel);
              }
            }
          } else {
            console.log(`[epg] Tuner ${tunerId}: No channels found (not logged in?)`);
          }
        } catch (err) {
          console.log(`[epg] Tuner ${tunerId}: Failed to scan - ${err.message}`);
        }
      }

      // Build merged channel list sorted by channel number, then by name
      this.channels = Array.from(allChannelsById.values())
        .sort((a, b) => {
          const numDiff = parseInt(a.number) - parseInt(b.number);
          if (numDiff !== 0) return numDiff;
          return (a.name || '').localeCompare(b.name || '');
        });

      console.log(`[epg] Total: ${this.channels.length} unique channels from ${Object.keys(this.tunerChannels).length} tuner(s)`);

      // Log tuner mapping summary
      const tunerCounts = {};
      for (const tunerId of Object.values(this.tunerMapping)) {
        tunerCounts[tunerId] = (tunerCounts[tunerId] || 0) + 1;
      }
      console.log('[epg] Tuner mapping:', tunerCounts);

      this.lastFetch = Date.now();
      this.saveCache();

      this.isRefreshing = false;
      return {
        channels: this.channels.length,
        schedules: Object.keys(this.schedules).length,
        tunerChannels: Object.fromEntries(
          Object.entries(this.tunerChannels).map(([k, v]) => [k, v.length])
        )
      };

    } catch (err) {
      this.isRefreshing = false;
      throw err;
    }
  }

  // Fetch channels from a single tuner
  async fetchFromTuner(tunerId, debugPort) {
    let browser = null;
    let page = null;

    try {
      browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
      const contexts = browser.contexts();

      if (contexts.length === 0) {
        console.log(`[epg] Tuner ${tunerId}: No browser context found`);
        return [];
      }

      const context = contexts[0];
      page = await context.newPage();

      // Capture API responses
      const apiResponses = {};

      context.on('response', async (response) => {
        const url = response.url();
        if (url.includes('api.cld.dtvce.com')) {
          try {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('application/json')) {
              const body = await response.json();

              // Capture channels
              if (url.includes('/allchannels')) {
                apiResponses.channels = body;
              }

              // Capture schedule  
              if (url.includes('/schedule') && body.schedules) {
                if (!apiResponses.schedules) apiResponses.schedules = [];
                apiResponses.schedules.push(...body.schedules);
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      });

      // Navigate to guide page to trigger API calls
      await page.goto('https://stream.directv.com/guide', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Wait for data to load
      await page.waitForTimeout(8000);

      // Close the page
      await page.close();
      page = null;

      // Process captured data
      const channels = [];
      if (apiResponses.channels?.channelInfoList) {
        const allChannels = apiResponses.channels.channelInfoList;
        const streamableChannels = allChannels.filter(ch => ch.augmentation?.constraints?.isLiveStreamEnabled === true);

        for (const ch of streamableChannels) {
          channels.push({
            id: ch.resourceId,
            name: ch.channelName,
            number: ch.channelNumber,
            callSign: ch.callSign,
            ccid: ch.ccid,
            logo: ch.imageList?.find(i => i.imageType === 'chlogo-clb-guide')?.imageUrl || null,
            format: ch.format
          });
        }
      }

      // Process schedules (merge into main schedules)
      if (apiResponses.schedules) {
        for (const schedule of apiResponses.schedules) {
          const channelId = schedule.channelId;
          if (!this.schedules[channelId]) {
            this.schedules[channelId] = [];
          }

          for (const content of schedule.contents || []) {
            const consumable = content.consumables?.[0];
            if (consumable) {
              // Check if this schedule entry already exists
              const exists = this.schedules[channelId].some(s =>
                s.startTime === consumable.startTime && s.title === (content.title || content.displayTitle)
              );
              if (!exists) {
                this.schedules[channelId].push({
                  title: content.title || content.displayTitle,
                  subtitle: content.episodeTitle || null,
                  description: content.description || '',
                  startTime: consumable.startTime,
                  endTime: consumable.endTime,
                  duration: consumable.duration,
                  categories: content.categories || [],
                  genres: content.genres || [],
                  rating: consumable.parentalRating || content.parentalRating,
                  seasonNumber: content.seasonNumber,
                  episodeNumber: content.episodeNumber,
                  originalAirDate: content.originalAirDate,
                  year: content.releaseYear
                });
              }
            }
          }
        }
      }

      return channels;

    } catch (err) {
      throw err;
    } finally {
      // Cleanup
      if (page && !page.isClosed()) {
        try { await page.close(); } catch (e) { }
      }

      // Close lingering guide pages
      try {
        const http = require('http');
        const req = http.get(`http://localhost:${debugPort}/json`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const pages = JSON.parse(data);
              for (const p of pages) {
                if (p.type === 'page' && p.url && p.url.includes('/guide')) {
                  http.get(`http://localhost:${debugPort}/json/close/${p.id}`);
                }
              }
            } catch (e) { }
          });
        });
        req.on('error', () => { });
      } catch (e) { }
    }
  }

  // Generate XMLTV format EPG
  generateXMLTV(hoursAhead = 24) {
    const now = new Date();
    const endTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
    xml += '<tv generator-info-name="directv-epg" generator-info-url="http://localhost:3000">\n';

    // Add channels
    for (const channel of this.channels) {
      // Use channel ID for tvg-id (matches M3U, handles same-number channels)
      const tvgId = `dtv-${channel.id}`;
      xml += `  <channel id="${tvgId}">\n`;
      xml += `    <display-name>${this.escapeXml(channel.name)}</display-name>\n`;
      xml += `    <display-name>${channel.number}</display-name>\n`;
      if (channel.callSign) {
        xml += `    <display-name>${this.escapeXml(channel.callSign)}</display-name>\n`;
      }
      if (channel.logo) {
        xml += `    <icon src="${this.escapeXml(channel.logo)}" />\n`;
      }
      xml += `  </channel>\n`;
    }

    // Add programs
    for (const channel of this.channels) {
      const programs = this.schedules[channel.id] || [];
      const tvgId = `dtv-${channel.id}`;

      for (const program of programs) {
        const start = new Date(program.startTime);
        const end = new Date(program.endTime);

        // Skip programs outside our time window
        if (end < now || start > endTime) continue;

        xml += `  <programme start="${this.formatXMLTVDate(start)}" stop="${this.formatXMLTVDate(end)}" channel="${tvgId}">\n`;
        xml += `    <title lang="en">${this.escapeXml(program.title)}</title>\n`;

        if (program.subtitle) {
          xml += `    <sub-title lang="en">${this.escapeXml(program.subtitle)}</sub-title>\n`;
        }

        if (program.description) {
          xml += `    <desc lang="en">${this.escapeXml(program.description)}</desc>\n`;
        }

        if (program.categories?.length > 0) {
          for (const cat of program.categories) {
            xml += `    <category lang="en">${this.escapeXml(cat)}</category>\n`;
          }
        }

        if (program.genres?.length > 0) {
          for (const genre of program.genres) {
            xml += `    <category lang="en">${this.escapeXml(genre)}</category>\n`;
          }
        }

        if (program.seasonNumber && program.episodeNumber) {
          // XMLTV episode format: season-1.episode-1.0
          const s = program.seasonNumber - 1;
          const e = program.episodeNumber - 1;
          xml += `    <episode-num system="xmltv_ns">${s}.${e}.0</episode-num>\n`;
        }

        if (program.originalAirDate) {
          xml += `    <date>${program.originalAirDate.replace(/-/g, '')}</date>\n`;
        }

        if (program.rating) {
          xml += `    <rating system="VCHIP">\n`;
          xml += `      <value>${this.escapeXml(program.rating)}</value>\n`;
          xml += `    </rating>\n`;
        }

        xml += `  </programme>\n`;
      }
    }

    xml += '</tv>\n';
    return xml;
  }

  // Generate M3U playlist with tvg-id matching EPG
  // Uses channel ID in URLs to handle channels with same number (e.g., NESN/NESN+)
  // Applies channel overrides (custom names, groups, hidden)
  generateM3U(host) {
    let m3u = '#EXTM3U url-tvg="http://' + host + '/tve/directv/epg.xml"\n\n';

    for (const channel of this.channels) {
      // Apply overrides
      const override = this.overrides[channel.id] || {};

      // Skip hidden channels
      if (override.hidden) continue;

      // Use custom name/group if set
      const displayName = override.customName || channel.name;
      const groupTitle = override.customGroup || this.getChannelGroup(channel);

      // Use channel ID for unique tvg-id (handles same-number channels)
      const tvgId = `dtv-${channel.id}`;

      m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${displayName}" tvg-logo="${channel.logo || ''}" tvg-chno="${channel.number}" group-title="${groupTitle}",${displayName}\n`;
      // Use channel ID in URL to uniquely identify the channel
      m3u += `http://${host}/stream/${encodeURIComponent(channel.id)}\n\n`;
    }

    return m3u;
  }

  // Get channel group/category
  getChannelGroup(channel) {
    const name = (channel.name || '').toLowerCase();
    const callSign = (channel.callSign || '').toLowerCase();

    if (/espn|fox sports|nfl|mlb|nba|nhl|golf|sports/i.test(name + callSign)) return 'Sports';
    if (/news|cnn|msnbc|fox news|cnbc/i.test(name + callSign)) return 'News';
    if (/hbo|max|showtime|starz|cinemax|movie/i.test(name + callSign)) return 'Movies';
    if (/disney|nick|cartoon|kids/i.test(name + callSign)) return 'Kids';
    if (/discovery|history|natgeo|animal|tlc|hgtv|food/i.test(name + callSign)) return 'Documentary';
    return 'Entertainment';
  }

  // Format date for XMLTV (YYYYMMDDHHmmss +0000)
  formatXMLTVDate(date) {
    const d = new Date(date);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
  }

  // Escape XML special characters
  escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Get channel by number (first match if multiple share same number)
  getChannelByNumber(number) {
    return this.channels.find(ch => ch.number === number || String(ch.number) === String(number));
  }

  // Get channel by ID (resourceId - unique identifier)
  getChannelById(id) {
    return this.channels.find(ch => ch.id === id);
  }

  // Get channel by ID or number (tries ID first, then number)
  getChannel(idOrNumber) {
    // Try ID first
    let channel = this.channels.find(ch => ch.id === idOrNumber);
    if (channel) return channel;

    // Try number
    return this.channels.find(ch =>
      ch.number === idOrNumber || String(ch.number) === String(idOrNumber)
    );
  }

  // Get all channels
  getChannels() {
    return this.channels;
  }

  // Get which tuner can access a given channel
  // Accepts channelKey (number:name format) or just a channel number
  // Returns tunerId or null if channel not found
  getTunerForChannel(channelKey) {
    // Direct lookup with exact key
    if (this.tunerMapping[channelKey] !== undefined) {
      return this.tunerMapping[channelKey];
    }

    // Fallback: if given just a number, find first matching key
    for (const [key, tunerId] of Object.entries(this.tunerMapping)) {
      if (key.startsWith(`${channelKey}:`)) {
        return tunerId;
      }
    }
    return null;
  }

  // Get all tuners that have access to a channel
  // Accepts channelKey (number:name format) or just a channel number
  getTunersForChannel(channelKey) {
    const tuners = [];

    // Check if it's an exact key or just a number
    const isExactKey = String(channelKey).includes(':');

    for (const [tunerId, channels] of Object.entries(this.tunerChannels)) {
      const hasAccess = channels.some(ch => {
        if (isExactKey) {
          return `${ch.number}:${ch.name}` === channelKey;
        }
        return ch.number === channelKey || String(ch.number) === String(channelKey);
      });
      if (hasAccess) {
        tuners.push(parseInt(tunerId));
      }
    }
    return tuners;
  }

  // Get channel key for a channel (number:name format)
  getChannelKey(channel) {
    return `${channel.number}:${channel.name}`;
  }

  // Get EPG status
  getStatus() {
    return {
      channelCount: this.channels.length,
      scheduledChannels: Object.keys(this.schedules).length,
      lastFetch: this.lastFetch,
      cacheAge: this.lastFetch ? Math.round((Date.now() - this.lastFetch) / 1000) : null,
      tunerChannelCounts: Object.fromEntries(
        Object.entries(this.tunerChannels).map(([k, v]) => [k, v.length])
      )
    };
  }
}

module.exports = new DirectvEpg();
