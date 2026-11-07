// enrich.js, runs in GitHub Actions only.
// Pulls keywords, director, top cast and the imdb_id for every film in the
// catalogue, one TMDB call each via append_to_response. Results are cached in
// data/enriched.json and only missing films are fetched, so repeat runs are
// cheap and a failed run never loses prior work.

const fs = require("fs");
const path = require("path");

const apiKey = process.env.TMDB_API_KEY;
const tmdbBase = "https://api.themoviedb.org/3";
const budget = Number(process.env.ENRICH_BUDGET || 4000);
const castDepth = Number(process.env.CAST_DEPTH || 5);

const dataDir = path.join(__dirname, "..", "data");
const cataloguePath = path.join(dataDir, "catalogue.json");
const enrichedPath = path.join(dataDir, "enriched.json");

if(!apiKey){
  console.error("TMDB_API_KEY is not set.");
  process.exit(1);
}
if(!fs.existsSync(cataloguePath)){
  console.error("data/catalogue.json missing. Run buildCatalogue.js first.");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdbGet(endpoint, params){
  const usp = new URLSearchParams({ api_key: apiKey, ...params });
  const url = `${tmdbBase}${endpoint}?${usp.toString()}`;
  for(let attempt = 1; attempt <= 4; attempt++){
    let res;
    try{
      res = await fetch(url);
    }catch(err){
      await sleep(600 * attempt);
      continue;
    }
    if(res.ok) return res.json();
    if(res.status === 404) return null;      // film pulled from TMDB
    if(res.status === 429){
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(`TMDB ${res.status} on ${endpoint}`);
  }
  return null;
}

function loadCache(){
  if(!fs.existsSync(enrichedPath)){
    return { generated: null, names: { k: {}, p: {} }, films: {} };
  }
  try{
    const c = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
    c.names = c.names || { k: {}, p: {} };
    c.names.k = c.names.k || {};
    c.names.p = c.names.p || {};
    c.films = c.films || {};
    return c;
  }catch(e){
    console.warn("cache unreadable, starting fresh:", e.message);
    return { generated: null, names: { k: {}, p: {} }, films: {} };
  }
}

async function main(){
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));
  const cache = loadCache();

  const pending = catalogue.movies
    .map(m => m.i)
    .filter(id => !cache.films[id]);

  console.log(`${catalogue.movies.length} films in catalogue, ${pending.length} not yet enriched`);

  const todo = pending.slice(0, budget);
  let done = 0, failed = 0;

  for(const id of todo){
    const data = await tmdbGet(`/movie/${id}`, { append_to_response: "keywords,credits" });
    if(!data){
      // Record the miss so a dead id is not retried every single night.
      cache.films[id] = { k: [], d: [], c: [], imdb: null, rt: null, dead: true };
      failed++;
      await sleep(45);
      continue;
    }

    const keywords = ((data.keywords && data.keywords.keywords) || []).slice(0, 14);
    keywords.forEach(k => { cache.names.k[k.id] = k.name; });

    const crew = (data.credits && data.credits.crew) || [];
    const directors = crew.filter(c => c.job === "Director").slice(0, 2);
    directors.forEach(d => { cache.names.p[d.id] = d.name; });

    const cast = ((data.credits && data.credits.cast) || [])
      .slice(0, castDepth);
    cast.forEach(c => { cache.names.p[c.id] = c.name; });

    cache.films[id] = {
      imdb: data.imdb_id || null,
      rt: data.runtime || null,
      k: keywords.map(k => k.id),
      d: directors.map(d => d.id),
      c: cast.map(c => c.id)
    };

    done++;
    if(done % 250 === 0) console.log(`  enriched ${done}/${todo.length}`);
    await sleep(45);
  }

  cache.generated = new Date().toISOString();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(enrichedPath, JSON.stringify(cache));

  const kb = Math.round(fs.statSync(enrichedPath).size / 1024);
  const remaining = pending.length - todo.length;
  console.log(`enriched ${done} films (${failed} unavailable), ${remaining} still queued`);
  console.log(`data/enriched.json is ${kb} KB, ${Object.keys(cache.films).length} films cached`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
