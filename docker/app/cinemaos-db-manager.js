#!/usr/bin/env node
/**
 * CinemaOS Movie Database Manager
 * - Fetches movies from CinemaOS API
 * - Deduplicates across categories
 * - Supports incremental updates (only new movies)
 * - Generates M3U playlist
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  apiBase: 'https://cinemaos.live/api/tmdb',
  categories: ['popularMovie', 'latestMovie', 'topRatedMovie', 'upcomingMovie'],
  language: 'en-US',

  // Paths
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  dbFile: 'cinemaos-movies-db.json',
  m3uFile: 'cinemaos-movies.m3u',

  // Fetch settings
  maxConcurrent: 5,
  delayBetweenRequests: 200, // ms
  maxPagesPerCategory: 500,  // Safety limit

  // Tuner host for M3U URLs
  tunerHost: process.env.TUNER_HOST || 'localhost:7070'
};

// Genre mapping
const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie',
  53: 'Thriller', 10752: 'War', 37: 'Western'
};

class CinemaOSDbManager {
  constructor() {
    this.movies = new Map();  // id -> movie
    this.lastUpdate = null;
    this.stats = {
      total: 0,
      new: 0,
      updated: 0,
      categories: {}
    };
  }

  // Load existing database
  loadDatabase() {
    const dbPath = path.join(CONFIG.dataDir, CONFIG.dbFile);

    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        this.lastUpdate = data.lastUpdate;

        for (const movie of data.movies || []) {
          this.movies.set(movie.id, movie);
        }

        console.log(`[db] Loaded ${this.movies.size} movies from database`);
        console.log(`[db] Last update: ${this.lastUpdate || 'never'}`);
        return true;
      } catch (err) {
        console.error('[db] Error loading database:', err.message);
      }
    }

    console.log('[db] No existing database found, starting fresh');
    return false;
  }

  // Save database
  saveDatabase() {
    if (!fs.existsSync(CONFIG.dataDir)) {
      fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    }

    const dbPath = path.join(CONFIG.dataDir, CONFIG.dbFile);
    const data = {
      lastUpdate: new Date().toISOString(),
      totalMovies: this.movies.size,
      stats: this.stats,
      movies: Array.from(this.movies.values())
    };

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    console.log(`[db] Saved ${this.movies.size} movies to database`);
  }

  // Fetch a single page from API
  async fetchPage(category, page) {
    return new Promise((resolve, reject) => {
      const url = `${CONFIG.apiBase}?requestID=${category}&language=${CONFIG.language}&page=${page}`;

      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'application/json'
        },
        rejectUnauthorized: false
      };

      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      }).on('error', reject);
    });
  }

  // Process and deduplicate a movie
  processMovie(movie, category) {
    const existing = this.movies.get(movie.id);

    const processed = {
      id: movie.id,
      title: movie.title || movie.original_title,
      originalTitle: movie.original_title,
      year: movie.release_date ? movie.release_date.split('-')[0] : null,
      releaseDate: movie.release_date,
      overview: movie.overview,
      poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
      backdrop: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
      rating: movie.vote_average,
      voteCount: movie.vote_count,
      popularity: movie.popularity,
      genres: (movie.genre_ids || []).map(id => GENRES[id]).filter(g => g),
      adult: movie.adult,
      language: movie.original_language,
      categories: existing ? [...new Set([...existing.categories, category])] : [category],
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existing) {
      // Update existing - merge categories, keep addedAt
      this.stats.updated++;
    } else {
      // New movie
      this.stats.new++;
    }

    this.movies.set(movie.id, processed);
  }

  // Fetch all movies from a category
  async fetchCategory(category, incrementalMode = false) {
    console.log(`\n[fetch] Category: ${category}`);

    let page = 1;
    let totalPages = 1;
    let newInCategory = 0;
    let consecutiveExisting = 0;
    const maxConsecutiveExisting = 3; // Stop if 3 pages have no new movies

    while (page <= totalPages && page <= CONFIG.maxPagesPerCategory) {
      try {
        const data = await this.fetchPage(category, page);

        if (page === 1) {
          totalPages = Math.min(data.total_pages || 1, CONFIG.maxPagesPerCategory);
          console.log(`[fetch] Total pages: ${totalPages}`);
        }

        const results = data.results || [];
        let newOnPage = 0;

        for (const movie of results) {
          const wasNew = !this.movies.has(movie.id);
          this.processMovie(movie, category);
          if (wasNew) {
            newOnPage++;
            newInCategory++;
          }
        }

        // Progress
        if (page % 10 === 0 || page === totalPages) {
          console.log(`[fetch] ${category}: page ${page}/${totalPages} - ${newOnPage} new this page, ${newInCategory} new total`);
        }

        // Incremental mode: stop early if no new movies
        if (incrementalMode) {
          if (newOnPage === 0) {
            consecutiveExisting++;
            if (consecutiveExisting >= maxConsecutiveExisting) {
              console.log(`[fetch] ${category}: stopping early - ${maxConsecutiveExisting} pages with no new movies`);
              break;
            }
          } else {
            consecutiveExisting = 0;
          }
        }

        page++;

        // Rate limiting
        await this.sleep(CONFIG.delayBetweenRequests);

      } catch (err) {
        console.error(`[fetch] Error on page ${page}:`, err.message);
        page++;
      }
    }

    this.stats.categories[category] = {
      pagesScanned: page - 1,
      newMovies: newInCategory
    };

    console.log(`[fetch] ${category}: completed - ${newInCategory} new movies from ${page - 1} pages`);
    return newInCategory;
  }

  // Full fetch of all categories
  async fullFetch() {
    console.log('\n' + '='.repeat(60));
    console.log('FULL DATABASE FETCH');
    console.log('='.repeat(60));

    this.stats = { total: 0, new: 0, updated: 0, categories: {} };
    const startCount = this.movies.size;

    for (const category of CONFIG.categories) {
      await this.fetchCategory(category, false);
    }

    this.stats.total = this.movies.size;
    this.stats.new = this.movies.size - startCount;

    console.log('\n' + '='.repeat(60));
    console.log(`COMPLETE: ${this.movies.size} total movies (${this.stats.new} new)`);
    console.log('='.repeat(60));

    this.saveDatabase();
    return this.stats;
  }

  // Incremental update - only look for new movies
  async incrementalUpdate() {
    console.log('\n' + '='.repeat(60));
    console.log('INCREMENTAL UPDATE');
    console.log('='.repeat(60));

    this.loadDatabase();

    this.stats = { total: this.movies.size, new: 0, updated: 0, categories: {} };
    const startCount = this.movies.size;

    for (const category of CONFIG.categories) {
      await this.fetchCategory(category, true);
    }

    this.stats.total = this.movies.size;
    this.stats.new = this.movies.size - startCount;

    console.log('\n' + '='.repeat(60));
    console.log(`COMPLETE: ${this.movies.size} total movies (${this.stats.new} new added)`);
    console.log('='.repeat(60));

    if (this.stats.new > 0) {
      this.saveDatabase();
    } else {
      console.log('[db] No new movies, skipping save');
    }

    return this.stats;
  }

  // Generate M3U playlist
  generateM3U(options = {}) {
    const {
      maxMovies = 0,
      minRating = 0,
      minVotes = 0,
      genres = [],
      sortBy = 'popularity'
    } = options;

    let movies = Array.from(this.movies.values());

    // Filter
    if (minRating > 0) {
      movies = movies.filter(m => (m.rating || 0) >= minRating);
    }
    if (minVotes > 0) {
      movies = movies.filter(m => (m.voteCount || 0) >= minVotes);
    }
    if (genres.length > 0) {
      movies = movies.filter(m => m.genres.some(g => genres.includes(g)));
    }

    // Sort
    if (sortBy === 'popularity') {
      movies.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    } else if (sortBy === 'rating') {
      movies.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sortBy === 'year') {
      movies.sort((a, b) => (b.year || '0').localeCompare(a.year || '0'));
    } else if (sortBy === 'title') {
      movies.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }

    // Limit
    if (maxMovies > 0) {
      movies = movies.slice(0, maxMovies);
    }

    // Generate M3U
    const lines = ['#EXTM3U', `#PLAYLIST:CinemaOS Movies (${movies.length})`, ''];

    for (const movie of movies) {
      const displayTitle = movie.year ? `${movie.title} (${movie.year})` : movie.title;
      const groupTitle = movie.genres.join(';') || 'Movies';

      lines.push(
        `#EXTINF:-1 tvg-id="cinemaos-${movie.id}" ` +
        `tvg-name="${this.escapeM3U(displayTitle)}" ` +
        `tvg-logo="${movie.poster || ''}" ` +
        `group-title="${groupTitle}" ` +
        `tvg-rating="${movie.rating || ''}",${displayTitle}`
      );

      // Read TUNER_HOST at runtime, not from static CONFIG
      const tunerHost = process.env.TUNER_HOST || CONFIG.tunerHost;
      const streamUrl = `http://${tunerHost}/vod/cinemaos/${movie.id}/stream` +
        `?title=${encodeURIComponent(movie.title || '')}` +
        `&year=${movie.year || ''}`;

      lines.push(streamUrl);
      lines.push('');
    }

    const m3u = lines.join('\n');
    const m3uPath = path.join(CONFIG.dataDir, CONFIG.m3uFile);
    fs.writeFileSync(m3uPath, m3u);

    console.log(`[m3u] Generated playlist with ${movies.length} movies`);
    console.log(`[m3u] Saved to ${m3uPath}`);

    return {
      totalMovies: movies.length,
      filePath: m3uPath,
      fileSize: fs.statSync(m3uPath).size
    };
  }

  escapeM3U(str) {
    if (!str) return '';
    return str.replace(/"/g, "'").replace(/\n/g, ' ').trim();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get database stats
  getStats() {
    const movies = Array.from(this.movies.values());

    const genreCounts = {};
    const yearCounts = {};

    for (const movie of movies) {
      for (const genre of movie.genres || []) {
        genreCounts[genre] = (genreCounts[genre] || 0) + 1;
      }
      if (movie.year) {
        yearCounts[movie.year] = (yearCounts[movie.year] || 0) + 1;
      }
    }

    return {
      totalMovies: this.movies.size,
      lastUpdate: this.lastUpdate,
      nextAutoUpdate: this.nextAutoUpdate || null,
      autoRefreshEnabled: this.autoRefreshEnabled || false,
      genres: genreCounts,
      years: yearCounts,
      avgRating: movies.length > 0
        ? (movies.reduce((sum, m) => sum + (m.rating || 0), 0) / movies.length).toFixed(2)
        : 0
    };
  }

  // ========== Auto-Refresh Methods ==========

  /**
   * Start automatic incremental updates
   * @param {number} intervalHours - Hours between updates (default: 6)
   */
  startAutoRefresh(intervalHours = 6) {
    if (this.autoRefreshTimer) {
      console.log('[cinemaos] Auto-refresh already running');
      return;
    }

    const intervalMs = intervalHours * 60 * 60 * 1000;
    this.autoRefreshEnabled = true;
    this.autoRefreshInterval = intervalHours;

    console.log(`[cinemaos] Starting auto-refresh (every ${intervalHours} hours)`);

    // Run first update after a short delay (let server start up first)
    setTimeout(() => {
      this.runAutoUpdate();
    }, 30000); // 30 seconds after startup

    // Then run at regular intervals
    this.autoRefreshTimer = setInterval(() => {
      this.runAutoUpdate();
    }, intervalMs);

    this.updateNextAutoUpdateTime(intervalMs);
  }

  /**
   * Stop automatic updates
   */
  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
      this.autoRefreshEnabled = false;
      this.nextAutoUpdate = null;
      console.log('[cinemaos] Auto-refresh stopped');
    }
  }

  /**
   * Run an automatic incremental update
   */
  async runAutoUpdate() {
    console.log('[cinemaos] Auto-refresh: starting incremental update...');

    try {
      const stats = await this.incrementalUpdate();

      if (stats.new > 0) {
        this.generateM3U();
        console.log(`[cinemaos] Auto-refresh complete: ${stats.new} new movies added, playlist regenerated`);
      } else {
        console.log('[cinemaos] Auto-refresh complete: no new movies found');
      }

      // Update next run time
      if (this.autoRefreshInterval) {
        this.updateNextAutoUpdateTime(this.autoRefreshInterval * 60 * 60 * 1000);
      }

      return stats;
    } catch (error) {
      console.error('[cinemaos] Auto-refresh error:', error.message);
      throw error;
    }
  }

  /**
   * Update the next auto-update timestamp
   */
  updateNextAutoUpdateTime(intervalMs) {
    this.nextAutoUpdate = new Date(Date.now() + intervalMs).toISOString();
  }

  /**
   * Get auto-refresh status
   */
  getAutoRefreshStatus() {
    return {
      enabled: this.autoRefreshEnabled || false,
      intervalHours: this.autoRefreshInterval || null,
      nextUpdate: this.nextAutoUpdate || null,
      lastUpdate: this.lastUpdate || null
    };
  }
}

// Export for use as module
module.exports = CinemaOSDbManager;

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  const manager = new CinemaOSDbManager();

  async function run() {
    switch (command) {
      case 'full':
        await manager.fullFetch();
        manager.generateM3U();
        break;

      case 'update':
        await manager.incrementalUpdate();
        manager.generateM3U();
        break;

      case 'generate':
        manager.loadDatabase();
        manager.generateM3U({
          maxMovies: parseInt(args[1]) || 0,
          minRating: parseFloat(args[2]) || 0
        });
        break;

      case 'stats':
        manager.loadDatabase();
        console.log(JSON.stringify(manager.getStats(), null, 2));
        break;

      case 'help':
      default:
        console.log(`
CinemaOS Database Manager

Commands:
  full      - Full fetch of all movies (takes 30-60 minutes)
  update    - Incremental update (only new movies, faster)
  generate  - Generate M3U from existing database
  stats     - Show database statistics

Examples:
  node cinemaos-db-manager.js full
  node cinemaos-db-manager.js update
  node cinemaos-db-manager.js generate 1000 7.0
  node cinemaos-db-manager.js stats
        `);
    }
  }

  run().catch(console.error);
}
