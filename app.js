// tasteEngine, static, client-only movie taste tracker + recommender.
// No backend, no API key in the browser. Film data comes from
// data/catalogue.json, rebuilt nightly by a GitHub Actions workflow that
// holds the TMDB key as a repository secret. Ratings live in localStorage.

const lsKeyRatings = "tasteEngine.ratings";
const lsKeyRateGenres = "tasteEngine.rateGenres";
const lsKeyRecGenres = "tasteEngine.recGenres";
const lsKeyBatchSize = "tasteEngine.batchSize";
const overviewsPath = "data/overviews.json";
const posterBase = "https://image.tmdb.org/t/p/w342"; // public CDN, needs no key
const cataloguePath = "data/catalogue.json";

let genreMap = {};
let catalogue = [];
let catalogueMeta = { generated: null, count: 0 };
// Plot summaries live in their own file, fetched in the background so they
// never delay the first render or the scoring, neither of which needs them.
let overviews = {};
let ratings = loadRatings();
let ratedIds = new Set(Object.keys(ratings).map(Number));
let rateQueue = [];

// Empty set means "all genres" everywhere it is used.
let rateGenres = loadGenreSet(lsKeyRateGenres);
let recGenres = loadGenreSet(lsKeyRecGenres);

// ---------- storage ----------

function loadRatings(){
  try{ return JSON.parse(localStorage.getItem(lsKeyRatings)) || {}; }
  catch(e){ return {}; }
}

function saveRatings(){
  try{ localStorage.setItem(lsKeyRatings, JSON.stringify(ratings)); }
  catch(e){ console.warn("could not save ratings", e); }
}

function loadGenreSet(key){
  try{
    const raw = JSON.parse(localStorage.getItem(key));
    return new Set(Array.isArray(raw) ? raw.map(Number) : []);
  }catch(e){ return new Set(); }
}

function saveGenreSet(key, set){
  try{ localStorage.setItem(key, JSON.stringify(Array.from(set))); }
  catch(e){ /* non-fatal */ }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}

// ---------- catalogue ----------

async function loadCatalogue(){
  const res = await fetch(cataloguePath, { cache: "no-cache" });
  if(!res.ok) throw new Error("catalogue not found (" + res.status + ")");
  const data = await res.json();
  genreMap = data.genres || {};
  catalogue = data.movies || [];
  catalogueMeta = { generated: data.generated || null, count: catalogue.length };
  if(catalogue.length === 0) throw new Error("catalogue is empty");
  renderGenreChips();
}

async function loadOverviews(){
  try{
    const res = await fetch(overviewsPath, { cache: "no-cache" });
    if(!res.ok) return;
    overviews = await res.json() || {};
    // A card may already be on screen when this lands; fill it in.
    hydrateVisibleOverview();
  }catch(e){
    console.warn("overviews unavailable", e);
  }
}

function overviewHtml(movie){
  const text = overviews[movie.i];
  if(!text) return `<p class="overview empty" data-for="${movie.i}"></p>`;
  return `<p class="overview" data-for="${movie.i}">${escapeHtml(text)}</p>`;
}

function hydrateVisibleOverview(){
  document.querySelectorAll(".overview.empty").forEach(el => {
    const text = overviews[el.dataset.for];
    if(text){
      el.textContent = text;
      el.classList.remove("empty");
    }
  });
}

// ---------- genre chips ----------

function renderGenreChips(){
  buildChipRow("rateGenres", rateGenres, lsKeyRateGenres);
  buildChipRow("recGenres", recGenres, lsKeyRecGenres);
}

function buildChipRow(containerId, selected, storageKey){
  const row = document.getElementById(containerId);
  if(!row) return;

  const entries = Object.entries(genreMap).sort((a, b) => a[1].localeCompare(b[1]));
  const allOn = selected.size === 0;

  row.innerHTML =
    `<button class="chip${allOn ? " on" : ""}" data-all="1">All</button>` +
    entries.map(([id, name]) =>
      `<button class="chip${selected.has(Number(id)) ? " on" : ""}" data-genre="${id}">${escapeHtml(name)}</button>`
    ).join("");

  // Toggle classes in place rather than re-rendering the row, so chips keep
  // their identity and focus across clicks.
  const syncChipClasses = () => {
    row.querySelectorAll(".chip").forEach(c => {
      const on = c.dataset.all
        ? selected.size === 0
        : selected.has(Number(c.dataset.genre));
      c.classList.toggle("on", on);
    });
  };

  row.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      if(chip.dataset.all){
        selected.clear();
      }else{
        const id = Number(chip.dataset.genre);
        if(selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
      saveGenreSet(storageKey, selected);
      syncChipClasses();
    });
  });
}

function matchesGenres(movie, selected){
  if(selected.size === 0) return true;
  return (movie.g || []).some(g => selected.has(g));
}

function unrated(selected){
  return catalogue.filter(m => !ratedIds.has(m.i) && matchesGenres(m, selected));
}

// Films occasionally have no poster. Render a short labelled placeholder
// instead of an empty 2:3 slab.
function posterHtml(movie){
  if(movie.p){
    return `<div class="poster" style="background-image:url('${posterBase}${movie.p}')"></div>`;
  }
  return `<div class="poster noPoster">No poster</div>`;
}

function genreNamesFor(movie){
  return (movie.g || []).map(id => genreMap[id]).filter(Boolean).join(" · ");
}

// ---------- tabs ----------

document.querySelectorAll(".tabBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tabPanel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if(btn.dataset.tab === "dashboard") renderDashboard();
    if(btn.dataset.tab === "settings") renderSettings();
  });
});

// ---------- RATE TAB ----------

document.getElementById("loadBatchBtn").addEventListener("click", () => {
  const stage = document.getElementById("rateStage");
  if(catalogue.length === 0){
    stage.innerHTML = `<p class="emptyState">Catalogue hasn't loaded.</p>`;
    return;
  }

  const pool = unrated(rateGenres);
  if(pool.length === 0){
    stage.innerHTML = `<p class="emptyState">You've rated everything matching this selection. Pick different genres, or wait for tonight's catalogue refresh.</p>`;
    return;
  }

  const batchSize = Number(document.getElementById("batchSize").value) || 10;

  // Draw from a popularity-weighted slice, shuffled, so repeated batches
  // aren't always the same handful of blockbusters in the same order.
  // The slice scales with batch size so a 50-film batch still has variety.
  const sliceSize = Math.min(pool.length, Math.max(60, batchSize * 6));
  rateQueue = shuffle(pool.slice(0, sliceSize)).slice(0, batchSize);
  renderRateCard();
});

document.getElementById("batchSize").addEventListener("change", (e) => {
  try{ localStorage.setItem(lsKeyBatchSize, e.target.value); }catch(err){ /* non-fatal */ }
});

function shuffle(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderRateCard(){
  const stage = document.getElementById("rateStage");
  const progress = document.getElementById("rateProgress");
  const movie = rateQueue[0];

  if(!movie){
    stage.innerHTML = `<p class="emptyState">Batch done. Load another.</p>`;
    progress.textContent = "";
    return;
  }

  progress.textContent = `${rateQueue.length} left in batch`;
  const ratingButtons = Array.from({length: 10}, (_, i) => i + 1)
    .map(n => `<button data-score="${n}">${n}</button>`).join("");

  stage.innerHTML = `
    <div class="card">
      ${posterHtml(movie)}
      <div class="cardBody">
        <div class="tag">${escapeHtml(genreNamesFor(movie) || "Unknown")}</div>
        <div class="title">${escapeHtml(movie.t)}</div>
        <div class="year">${movie.y || "n/a"}${movie.v ? " · TMDB " + movie.v : ""}</div>
        ${overviewHtml(movie)}
        <div class="rateGrid">${ratingButtons}</div>
        <div class="belowRow">
          <button id="watchlistBtn">Watchlist</button>
          <button id="skipBtn">Haven't seen it</button>
        </div>
      </div>
    </div>
  `;

  stage.querySelectorAll(".rateGrid button").forEach(btn => {
    btn.addEventListener("click", () => submitRating(movie, Number(btn.dataset.score)));
  });
  document.getElementById("watchlistBtn").addEventListener("click", () => submitRating(movie, "watchlist"));
  document.getElementById("skipBtn").addEventListener("click", () => submitRating(movie, "skip"));
}

function submitRating(movie, value){
  ratings[movie.i] = {
    title: movie.t,
    year: movie.y || null,
    genreIds: movie.g || [],
    poster: movie.p || null,
    rating: value,
    ts: Date.now()
  };
  ratedIds.add(movie.i);
  saveRatings();
  if(rateQueue[0] && rateQueue[0].i === movie.i) rateQueue.shift();
  renderRateCard();
}

// ---------- scoring ----------

function scoredRatings(windowSize){
  const entries = Object.entries(ratings)
    .filter(([, r]) => typeof r.rating === "number")
    .sort((a, b) => b[1].ts - a[1].ts); // newest first
  if(windowSize === "all") return entries;
  return entries.slice(0, Number(windowSize));
}

// How strongly a thinly-rated genre is pulled toward your overall mean.
// Equivalent to seeding every genre with this many average-scored ratings,
// so one 9/10 in a genre you've barely touched can't outrank a genre you've
// rated twenty times at 8.2.
const shrinkWeight = 5;

function genreStats(windowSize){
  const entries = scoredRatings(windowSize || "all");

  let total = 0;
  entries.forEach(([, r]) => { total += r.rating; });
  const globalMean = entries.length ? total / entries.length : 0;

  const acc = {};
  entries.forEach(([, r]) => {
    (r.genreIds || []).forEach(g => {
      if(!acc[g]) acc[g] = { sum: 0, count: 0 };
      acc[g].sum += r.rating;
      acc[g].count += 1;
    });
  });

  const out = {};
  Object.entries(acc).forEach(([g, s]) => {
    const raw = s.sum / s.count;
    const shrunk = (s.sum + globalMean * shrinkWeight) / (s.count + shrinkWeight);
    // avg drives ranking; rawAvg is what the dashboard and explanations show.
    out[g] = { avg: shrunk, rawAvg: raw, count: s.count };
  });
  return out;
}

// ---------- RECOMMEND TAB ----------

document.getElementById("recommendBtn").addEventListener("click", () => {
  const stage = document.getElementById("recStage");
  if(catalogue.length === 0){
    stage.innerHTML = `<p class="emptyState">Catalogue hasn't loaded.</p>`;
    return;
  }

  const windowSize = document.getElementById("recWindow").value;
  const stats = genreStats(windowSize);
  const trainedOn = scoredRatings(windowSize).length;

  if(trainedOn === 0){
    stage.innerHTML = `<p class="emptyState">No ratings in this window yet. Rate some titles first.</p>`;
    return;
  }

  const pool = unrated(recGenres);
  const scored = [];

  for(const m of pool){
    const overlap = (m.g || []).filter(g => stats[g]);
    if(overlap.length === 0) continue;
    const predicted = overlap.reduce((sum, g) => sum + stats[g].avg, 0) / overlap.length;
    const sampleCount = overlap.reduce((sum, g) => sum + stats[g].count, 0);
    scored.push({ movie: m, predicted, overlap, sampleCount });
  }

  if(scored.length === 0){
    stage.innerHTML = `<p class="emptyState">Nothing in this scope overlaps the genres you've rated. Widen the genre selection, or rate a few titles in these genres first.</p>`;
    return;
  }

  // Pick from the top few rather than always the single highest, so asking
  // twice in a row doesn't hand back the same film.
  scored.sort((a, b) => b.predicted - a.predicted);
  const topSlice = scored.slice(0, Math.min(5, scored.length));
  const pick = topSlice[Math.floor(Math.random() * topSlice.length)];

  const { movie, predicted, overlap, sampleCount } = pick;
  const confidence = Math.min(95, Math.round((Math.log2(sampleCount + 1) / Math.log2(30)) * 100));
  const matchNames = overlap
    .map(g => `${genreMap[g]} (${stats[g].rawAvg.toFixed(1)} avg over ${stats[g].count})`)
    .join(", ");

  stage.innerHTML = `
    <div class="card recCard">
      ${posterHtml(movie)}
      <div class="cardBody">
        <div class="tag">Predicted ${predicted.toFixed(1)}/10</div>
        <div class="title">${escapeHtml(movie.t)}</div>
        <div class="year">${movie.y || "n/a"}${movie.v ? " · TMDB " + movie.v : ""}</div>
        ${overviewHtml(movie)}
        <div class="why">Matches your taste in ${escapeHtml(matchNames)}.</div>
        <div class="confidence">${confidence}% confidence, from ${sampleCount} rated title${sampleCount === 1 ? "" : "s"} in these genres, trained on ${trainedOn} rating${trainedOn === 1 ? "" : "s"}</div>
        <div class="belowRow">
          <button id="recWatchlist">Watchlist this</button>
          <button id="recSkip">Not interested</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("recWatchlist").addEventListener("click", () => {
    submitRating(movie, "watchlist");
    document.getElementById("recommendBtn").click();
  });
  document.getElementById("recSkip").addEventListener("click", () => {
    submitRating(movie, "skip");
    document.getElementById("recommendBtn").click();
  });
});

// ---------- DASHBOARD ----------

function renderDashboard(){
  const el = document.getElementById("dashboardStage");
  const stats = genreStats("all");
  const rows = Object.entries(stats)
    .sort((a, b) => b[1].avg - a[1].avg)
    .map(([g, s]) => `
      <div class="genreRow${s.count < 3 ? " lowSample" : ""}">
        <span class="name">${escapeHtml(genreMap[g] || ("Genre " + g))}</span>
        <span class="bar"><span style="width:${(s.rawAvg / 10 * 100).toFixed(1)}%"></span></span>
        <span class="val"><b>${s.rawAvg.toFixed(1)}</b> (${s.count})</span>
      </div>
    `).join("");

  const vals = Object.values(ratings);
  const totalRated = vals.filter(r => typeof r.rating === "number").length;
  const totalSkip = vals.filter(r => r.rating === "skip").length;
  const totalWatchlist = vals.filter(r => r.rating === "watchlist").length;

  el.innerHTML = `
    <p class="hint">${totalRated} rated · ${totalSkip} unseen · ${totalWatchlist} on watchlist</p>
    ${rows || '<p class="emptyState">Nothing rated yet.</p>'}
  `;
}

// ---------- SETTINGS ----------

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(ratings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tasteEngine-ratings.json";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const incoming = JSON.parse(reader.result);
      ratings = { ...ratings, ...incoming };
      ratedIds = new Set(Object.keys(ratings).map(Number));
      saveRatings();
      renderSettings();
      alert("Imported " + Object.keys(incoming).length + " ratings.");
    }catch(err){
      alert("Invalid file: " + err.message);
    }
  };
  reader.readAsText(file);
});

document.getElementById("wipeBtn").addEventListener("click", () => {
  if(!confirm("Delete all ratings? This cannot be undone.")) return;
  ratings = {};
  ratedIds = new Set();
  saveRatings();
  renderSettings();
  renderDashboard();
});

function renderSettings(){
  document.getElementById("statsLine").textContent =
    `${Object.keys(ratings).length} titles tracked.`;
  const src = document.getElementById("sourceLine");
  if(catalogueMeta.count === 0){
    src.textContent = "Catalogue not loaded.";
    return;
  }
  const when = catalogueMeta.generated
    ? new Date(catalogueMeta.generated).toLocaleString()
    : "unknown date";
  src.textContent = `${catalogueMeta.count} films · last refreshed ${when}`;
}

// ---------- init ----------

(async function init(){
  const stage = document.getElementById("rateStage");

  try{
    const savedBatch = localStorage.getItem(lsKeyBatchSize);
    if(savedBatch) document.getElementById("batchSize").value = savedBatch;
  }catch(e){ /* non-fatal */ }

  loadOverviews(); // background, deliberately not awaited

  try{
    await loadCatalogue();
    stage.innerHTML = `<p class="emptyState">Pick your genres, then "Load batch".</p>`;
  }catch(e){
    stage.innerHTML = `<p class="emptyState">Couldn't load the film catalogue (${escapeHtml(e.message)}).<br>Run the <strong>buildCatalogue</strong> workflow in the repo's Actions tab to generate it.</p>`;
  }
  renderSettings();
})();
