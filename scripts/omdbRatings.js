// omdbRatings.js, runs in GitHub Actions only.
// OMDb's free tier allows 1000 calls a day, so this works through the
// catalogue incrementally: each run fetches up to OMDB_BUDGET films that have
// no cached entry, then stops. Full coverage of a ~3000 film catalogue takes
// a few nights, after which only newly added films cost anything.

const fs = require("fs");
const path = require("path");

const apiKey = process.env.OMDB_API_KEY;
const budget = Number(process.env.OMDB_BUDGET || 900);

const dataDir = path.join(__dirname, "..", "data");
const enrichedPath = path.join(dataDir, "enriched.json");
const omdbPath = path.join(dataDir, "omdb.json");

if(!apiKey){
  console.error("OMDB_API_KEY is not set. Add it as a repository secret.");
  process.exit(1);
}
if(!fs.existsSync(enrichedPath)){
  console.error("data/enriched.json missing. Run enrich.js first.");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "85%" -> 85, "67/100" -> 67, "7.6/10" -> 7.6, "N/A" -> null
function parseScore(value){
  if(!value || value === "N/A") return null;
  const m = String(value).match(/^([\d.]+)/);
  if(!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function pickRating(ratings, source){
  const hit = (ratings || []).find(r => r.Source === source);
  return hit ? parseScore(hit.Value) : null;
}

async function omdbGet(imdbId){
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`;
  for(let attempt = 1; attempt <= 3; attempt++){
    let res;
    try{
      res = await fetch(url);
    }catch(err){
      await sleep(500 * attempt);
      continue;
    }
    if(!res.ok){
      if(res.status === 429 || res.status >= 500){
        await sleep(800 * attempt);
        continue;
      }
      return { error: `http ${res.status}` };
    }
    const data = await res.json();
    if(data.Response === "False") return { error: data.Error || "not found" };
    return { data };
  }
  return { error: "retries exhausted" };
}

function loadCache(){
  if(!fs.existsSync(omdbPath)) return {};
  try{ return JSON.parse(fs.readFileSync(omdbPath, "utf8")) || {}; }
  catch(e){ return {}; }
}

async function main(){
  const enriched = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
  const cache = loadCache();

  const pending = Object.entries(enriched.films || {})
    .filter(([tmdbId, f]) => f.imdb && !cache[tmdbId])
    .map(([tmdbId, f]) => [tmdbId, f.imdb]);

  console.log(`${pending.length} films without OMDb data, budget ${budget} this run`);

  const todo = pending.slice(0, budget);
  let ok = 0, missing = 0;
  let quotaHit = false;

  for(const [tmdbId, imdbId] of todo){
    const { data, error } = await omdbGet(imdbId);

    if(error){
      // The daily cap returns an error string rather than a status code.
      if(/limit|quota/i.test(error)){
        console.warn(`daily quota reached after ${ok + missing} calls, stopping early`);
        quotaHit = true;
        break;
      }
      // Cache the miss so a title OMDb simply does not have is not retried nightly.
      cache[tmdbId] = { miss: true };
      missing++;
      await sleep(110);
      continue;
    }

    const entry = {
      imdb: parseScore(data.imdbRating),
      votes: data.imdbVotes && data.imdbVotes !== "N/A"
        ? Number(String(data.imdbVotes).replace(/,/g, "")) || null
        : null,
      rt: pickRating(data.Ratings, "Rotten Tomatoes"),
      mc: pickRating(data.Ratings, "Metacritic"),
      rated: data.Rated && data.Rated !== "N/A" ? data.Rated : null
    };

    // Drop empty entries rather than storing four nulls per film.
    const hasAny = entry.imdb || entry.rt || entry.mc || entry.rated;
    cache[tmdbId] = hasAny ? entry : { miss: true };
    if(hasAny) ok++; else missing++;

    if((ok + missing) % 200 === 0) console.log(`  ${ok + missing}/${todo.length} fetched`);
    await sleep(110);
  }

  fs.writeFileSync(omdbPath, JSON.stringify(cache));

  const kb = Math.round(fs.statSync(omdbPath).size / 1024);
  const covered = Object.values(cache).filter(v => !v.miss).length;
  const remaining = pending.length - (ok + missing);
  console.log(`added ${ok} ratings (${missing} unavailable)${quotaHit ? ", stopped on quota" : ""}`);
  console.log(`data/omdb.json is ${kb} KB, ${covered} films rated, ${remaining} still queued`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
