// buildCatalogue.js, runs in GitHub Actions only, never in the browser.
// Reads TMDB_API_KEY from the environment (Actions Secret) and writes
// data/catalogue.json. The key never reaches the published site.

const fs = require("fs");
const path = require("path");

const apiKey = process.env.TMDB_API_KEY;
const tmdbBase = "https://api.themoviedb.org/3";
const pagesPerGenre = Number(process.env.PAGES_PER_GENRE || 8);
const pagesGlobal = Number(process.env.PAGES_GLOBAL || 12);
const minVotes = Number(process.env.MIN_VOTES || 50);
const outPath = path.join(__dirname, "..", "data", "catalogue.json");
// Plot summaries are bulky and are not used for scoring, so they ship in a
// separate file the client fetches in the background.
const overviewPath = path.join(__dirname, "..", "data", "overviews.json");

if(!apiKey){
  console.error("TMDB_API_KEY is not set. Add it as a repository secret.");
  process.exit(1);
}

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

async function tmdbGet(endpoint, params){
  const usp = new URLSearchParams({ api_key: apiKey, ...params });
  const url = `${tmdbBase}${endpoint}?${usp.toString()}`;
  for(let attempt = 1; attempt <= 4; attempt++){
    const res = await fetch(url);
    if(res.ok) return res.json();
    if(res.status === 429){
      const wait = 1000 * attempt;
      console.warn(`rate limited, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`TMDB ${res.status} on ${endpoint}`);
  }
  throw new Error(`TMDB kept rate limiting on ${endpoint}`);
}

// Trim each TMDB record down to only what the client actually uses.
// Short keys because this file ships to every visitor.
function trim(movie){
  return {
    i: movie.id,
    t: movie.title,
    y: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null,
    g: movie.genre_ids || [],
    v: typeof movie.vote_average === "number" ? Number(movie.vote_average.toFixed(1)) : null,
    c: movie.vote_count || 0,
    o: typeof movie.popularity === "number" ? Number(movie.popularity.toFixed(1)) : 0,
    p: movie.poster_path || null
  };
}

async function discover(genreId, page){
  const params = {
    sort_by: "popularity.desc",
    page,
    include_adult: "false",
    "vote_count.gte": minVotes
  };
  if(genreId) params.with_genres = genreId;
  const data = await tmdbGet("/discover/movie", params);
  return data.results || [];
}

async function main(){
  console.log("fetching genre list");
  const genreData = await tmdbGet("/genre/movie/list", {});
  const genres = {};
  genreData.genres.forEach(g => { genres[g.id] = g.name; });

  const byId = new Map();
  const overviewById = new Map();
  let requests = 0;

  const absorb = (results) => {
    results.forEach(m => {
      byId.set(m.id, trim(m));
      if(m.overview) overviewById.set(m.id, m.overview);
    });
  };

  // Global popularity sweep first, catches big cross-genre titles.
  for(let page = 1; page <= pagesGlobal; page++){
    const results = await discover(null, page);
    requests++;
    absorb(results);
    await sleep(60);
    if(results.length === 0) break;
  }
  console.log(`global sweep done, ${byId.size} titles`);

  // Then per-genre, so niche genres aren't drowned out by blockbusters.
  for(const genreId of Object.keys(genres)){
    for(let page = 1; page <= pagesPerGenre; page++){
      const results = await discover(genreId, page);
      requests++;
      absorb(results);
      await sleep(60);
      if(results.length === 0) break;
    }
    console.log(`${genres[genreId]} done, running total ${byId.size}`);
  }

  const movies = Array.from(byId.values()).sort((a, b) => b.o - a.o);

  const payload = {
    generated: new Date().toISOString(),
    genres,
    count: movies.length,
    movies
  };

  const overviews = {};
  movies.forEach(m => {
    const text = overviewById.get(m.i);
    if(text) overviews[m.i] = text;
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload));
  fs.writeFileSync(overviewPath, JSON.stringify(overviews));

  const kb = Math.round(fs.statSync(outPath).size / 1024);
  const okb = Math.round(fs.statSync(overviewPath).size / 1024);
  console.log(`wrote ${movies.length} titles to data/catalogue.json (${kb} KB, ${requests} API calls)`);
  console.log(`wrote ${Object.keys(overviews).length} summaries to data/overviews.json (${okb} KB)`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
