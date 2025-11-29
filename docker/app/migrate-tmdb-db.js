#!/usr/bin/env node
/**
 * Migrate tmdb_movies_complete.json to new cinemaos-movies-db.json format
 * Deduplicates and normalizes all movies
 */

const fs = require('fs');
const path = require('path');

const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie',
  53: 'Thriller', 10752: 'War', 37: 'Western'
};

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const oldDbPath = path.join(dataDir, 'tmdb_movies_complete.json');
const newDbPath = path.join(dataDir, 'cinemaos-movies-db.json');

console.log('='.repeat(60));
console.log('Migrating TMDB database to new format');
console.log('='.repeat(60));

if (!fs.existsSync(oldDbPath)) {
  console.error(`Old database not found: ${oldDbPath}`);
  process.exit(1);
}

console.log(`Loading: ${oldDbPath}`);
const oldData = JSON.parse(fs.readFileSync(oldDbPath, 'utf8'));

const movies = new Map();
let totalRaw = 0;

for (const [category, categoryData] of Object.entries(oldData)) {
  if (!categoryData.movies) continue;

  console.log(`Processing ${category}: ${categoryData.movies.length} movies`);
  totalRaw += categoryData.movies.length;

  for (const movie of categoryData.movies) {
    const existing = movies.get(movie.id);

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
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    movies.set(movie.id, processed);
  }
}

console.log(`\nTotal raw entries: ${totalRaw}`);
console.log(`Unique movies after dedup: ${movies.size}`);
console.log(`Duplicates removed: ${totalRaw - movies.size}`);

const newData = {
  lastUpdate: new Date().toISOString(),
  totalMovies: movies.size,
  migratedFrom: 'tmdb_movies_complete.json',
  stats: {
    total: movies.size,
    categories: {}
  },
  movies: Array.from(movies.values())
};

// Count by category
for (const movie of movies.values()) {
  for (const cat of movie.categories) {
    newData.stats.categories[cat] = (newData.stats.categories[cat] || 0) + 1;
  }
}

console.log(`\nSaving to: ${newDbPath}`);
fs.writeFileSync(newDbPath, JSON.stringify(newData, null, 2));

const fileSize = fs.statSync(newDbPath).size;
console.log(`File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

console.log('\n' + '='.repeat(60));
console.log('Migration complete!');
console.log('='.repeat(60));
console.log(`\nCategory breakdown:`);
for (const [cat, count] of Object.entries(newData.stats.categories)) {
  console.log(`  ${cat}: ${count} movies`);
}
