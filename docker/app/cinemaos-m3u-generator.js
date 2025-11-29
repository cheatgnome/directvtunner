#!/usr/bin/env node
/**
 * CinemaOS M3U Playlist Generator
 * Generates an M3U playlist from the TMDB movie database
 * Streams are proxied through the tuner for proper header handling
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  // Path to your movie database
  movieDbPath: process.env.MOVIE_DB || '/app/data/tmdb_movies_complete.json',

  // Output M3U file
  outputPath: process.env.OUTPUT_M3U || '/app/data/cinemaos-movies.m3u',

  // Tuner host (for stream URLs)
  tunerHost: process.env.TUNER_HOST || 'localhost:7070',

  // Provider ID
  providerId: 'cinemaos',

  // Max movies to include (0 = all)
  maxMovies: parseInt(process.env.MAX_MOVIES || '0'),

  // Categories to include (empty = all)
  categories: (process.env.CATEGORIES || '').split(',').filter(c => c),

  // Minimum vote count for quality filtering
  minVotes: parseInt(process.env.MIN_VOTES || '0'),

  // Minimum rating
  minRating: parseFloat(process.env.MIN_RATING || '0')
};

// Genre ID to name mapping (TMDB)
const GENRE_MAP = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

function loadMovieDatabase() {
  console.log(`Loading movie database from ${CONFIG.movieDbPath}...`);

  if (!fs.existsSync(CONFIG.movieDbPath)) {
    throw new Error(`Movie database not found: ${CONFIG.movieDbPath}`);
  }

  const data = JSON.parse(fs.readFileSync(CONFIG.movieDbPath, 'utf8'));

  // Collect all movies from all categories
  const allMovies = new Map();

  for (const [category, categoryData] of Object.entries(data)) {
    if (!categoryData.movies) continue;

    // Skip if category filter is set and doesn't match
    if (CONFIG.categories.length > 0 && !CONFIG.categories.includes(category)) {
      continue;
    }

    for (const movie of categoryData.movies) {
      if (!allMovies.has(movie.id)) {
        movie._category = category;
        allMovies.set(movie.id, movie);
      }
    }
  }

  console.log(`Loaded ${allMovies.size} unique movies`);
  return Array.from(allMovies.values());
}

function filterMovies(movies) {
  let filtered = movies;

  // Filter by vote count
  if (CONFIG.minVotes > 0) {
    filtered = filtered.filter(m => (m.vote_count || 0) >= CONFIG.minVotes);
    console.log(`After vote filter (>=${CONFIG.minVotes}): ${filtered.length} movies`);
  }

  // Filter by rating
  if (CONFIG.minRating > 0) {
    filtered = filtered.filter(m => (m.vote_average || 0) >= CONFIG.minRating);
    console.log(`After rating filter (>=${CONFIG.minRating}): ${filtered.length} movies`);
  }

  // Limit count
  if (CONFIG.maxMovies > 0 && filtered.length > CONFIG.maxMovies) {
    filtered = filtered.slice(0, CONFIG.maxMovies);
    console.log(`Limited to ${CONFIG.maxMovies} movies`);
  }

  return filtered;
}

function getYear(movie) {
  if (movie.release_date) {
    return movie.release_date.split('-')[0];
  }
  return '';
}

function getGenres(movie) {
  if (!movie.genre_ids || movie.genre_ids.length === 0) {
    return 'Movies';
  }
  return movie.genre_ids
    .map(id => GENRE_MAP[id] || 'Other')
    .join(';');
}

function escapeM3UValue(str) {
  if (!str) return '';
  return str.replace(/"/g, "'").replace(/\n/g, ' ').trim();
}

function generateM3U(movies) {
  console.log(`Generating M3U playlist for ${movies.length} movies...`);

  const lines = [
    '#EXTM3U',
    `#PLAYLIST:CinemaOS Movies`,
    ''
  ];

  for (const movie of movies) {
    const tmdbId = movie.id;
    const title = escapeM3UValue(movie.title || movie.original_title);
    const year = getYear(movie);
    const rating = movie.vote_average ? movie.vote_average.toFixed(1) : '';
    const genres = getGenres(movie);
    const poster = movie.poster_path
      ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
      : '';
    const backdrop = movie.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`
      : '';
    const overview = escapeM3UValue(movie.overview || '');

    // Build stream URL with query params
    const streamUrl = `http://${CONFIG.tunerHost}/vod/${CONFIG.providerId}/${tmdbId}/stream` +
      `?title=${encodeURIComponent(title)}` +
      `&year=${year}`;

    // EXTINF with metadata
    const displayTitle = year ? `${title} (${year})` : title;

    lines.push(
      `#EXTINF:-1 tvg-id="cinemaos-${tmdbId}" ` +
      `tvg-name="${escapeM3UValue(displayTitle)}" ` +
      `tvg-logo="${poster}" ` +
      `group-title="${genres}" ` +
      `tvg-rating="${rating}",${displayTitle}`
    );

    // Add plot as comment (some players use this)
    if (overview) {
      lines.push(`#EXTGRP:${genres}`);
    }

    lines.push(streamUrl);
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  console.log('='.repeat(60));
  console.log('CinemaOS M3U Playlist Generator');
  console.log('='.repeat(60));
  console.log('');
  console.log('Configuration:');
  console.log(`  Movie DB: ${CONFIG.movieDbPath}`);
  console.log(`  Output: ${CONFIG.outputPath}`);
  console.log(`  Tuner Host: ${CONFIG.tunerHost}`);
  console.log(`  Max Movies: ${CONFIG.maxMovies || 'unlimited'}`);
  console.log(`  Min Votes: ${CONFIG.minVotes || 'none'}`);
  console.log(`  Min Rating: ${CONFIG.minRating || 'none'}`);
  console.log('');

  try {
    // Load movies
    let movies = loadMovieDatabase();

    // Filter
    movies = filterMovies(movies);

    // Sort by popularity (highest first)
    movies.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    // Generate M3U
    const m3u = generateM3U(movies);

    // Write output
    const outputDir = path.dirname(CONFIG.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(CONFIG.outputPath, m3u);
    console.log(`\nPlaylist saved to: ${CONFIG.outputPath}`);
    console.log(`Total movies: ${movies.length}`);
    console.log(`File size: ${(fs.statSync(CONFIG.outputPath).size / 1024).toFixed(1)} KB`);

    // Show sample
    console.log('\nSample entries:');
    movies.slice(0, 3).forEach(m => {
      console.log(`  - ${m.title} (${getYear(m)}) - Rating: ${m.vote_average || 'N/A'}`);
    });

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Export for use as module
module.exports = { generateM3U, loadMovieDatabase, filterMovies, CONFIG };

// Run if called directly
if (require.main === module) {
  main();
}
