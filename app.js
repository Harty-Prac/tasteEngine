// tasteEngine, static client-only movie taste tracker and recommender.
//
// No backend and no API key in the browser. All film data is pre-baked into
// static JSON by GitHub Actions, which holds the TMDB and OMDb keys as
// repository secrets. Ratings live in localStorage.
//
// Scoring works on four feature types rather than genre alone:
//   genre (18 of them), keyword (thousands), director, cast.
// Each feature gets an affinity score from your ratings, shrunk toward your
// overall mean so thin evidence cannot dominate, and a candidate film scores
// as the evidence-weighted mean of its features.

const lsKeyRatings = "tasteEngine.ratings";
const lsKeyRateGenres = "tasteEngine.rateGenres";
const lsKeyRecGenres = "tasteEngine.recGenres";
const lsKeyBatchSize = "tasteEngine.batchSize";

const posterBase = "https://image.tmdb.org/t/p/w342"; // public CDN, needs no key
const cataloguePath = "data/catalogue.json";
const overviewsPath = "data/overviews.json";
const enrichedPath = "data/enriched.json";
const omdbPath = "data/omdb.json";

// How hard each feature type is pulled toward your global mean. Lower means
// the feature is trusted sooner. Genre needs the most evidence because every
// film has two or three and they say the least.
const shrinkByType = { g: 5, k: 2, d: 2, c: 3 };

// How much a confident feature of each type counts toward the final score.
// A director you have rated three times says far more than a shared genre.
const weightByType = { g: 1.0, k: 2.0, d: 3.0, c: 1.5 };

let genreMap = {};
let catalogue = [];
let catalogueMeta = { generated: null, count: 0 };
let overviews = {};
let enriched = { names: { k: {}, p: {} }, films: {} };
let omdbScores = {};
let enrichedReady = false;

let ratings = loadRatings();
let ratedIds = new Set(Object.keys(ratings).map(Number));
let rateQueue = [];

// Empty set means all genres.
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

// ---------- data loading ----------

async function loadJson(url){
  const res = await fetch(url, { cache: "no-cache" });
  if(!res.ok) throw new Error(url + " returned " + res.status);
  return res.json();
}

async function loadCatalogue(){
  const data = await loadJson(cataloguePath);
  genreMap = data.genres || {};
  catalogue = data.movies || [];
  catalogueMeta = { generated: data.generated || null, count: catalogue.length };
  if(catalogue.length === 0) throw new Error("catalogue is empty");
  renderGenreChips();
}

// Summaries and rich features are not needed for first paint, so they load
// in the background. Scoring waits on them only if you ask for a suggestion
// before they land.
let enrichedPromise = null;

function loadExtras(){
  enrichedPromise = (async () => {
    const [ov, en, om] = await Promise.allSettled([
      loadJson(overviewsPath),
      loadJson(enrichedPath),
      loadJson(omdbPath)
    ]);
    if(ov.status === "fulfilled") overviews = ov.value || {};
    if(en.status === "fulfilled" && en.value && en.value.films){
      enriched = en.value;
      enriched.names = enriched.names || { k: {}, p: {} };
      enriched.names.k = enriched.names.k || {};
      enriched.names.p = enriched.names.p || {};
      enrichedReady = true;
    }
    if(om.status === "fulfilled") omdbScores = om.value || {};
    hydrateVisibleCards();
    renderSettings();
  })();
  return enrichedPromise;
}

// ---------- feature extraction ----------

// Every film reduces to a list of typed feature keys such as "k:1234".
function featuresOf(movie){
  const out = (movie.g || []).map(g => "g:" + g);
  const extra = enriched.films[movie.i];
  if(extra && !extra.dead){
    (extra.k || []).forEach(k => out.push("k:" + k));
    (extra.d || []).forEach(d => out.push("d:" + d));
    (extra.c || []).forEach(c => out.push("c:" + c));
  }
  return out;
}

// Rated films store their own feature list at rating time, so a rating still
// counts even if that film later drops out of the catalogue.
function featuresOfRating(entry, id){
  if(Array.isArray(entry.features) && entry.features.length) return entry.features;
  const out = (entry.genreIds || []).map(g => "g:" + g);
  const extra = enriched.films[id];
  if(extra && !extra.dead){
    (extra.k || []).forEach(k => out.push("k:" + k));
    (extra.d || []).forEach(d => out.push("d:" + d));
    (extra.c || []).forEach(c => out.push("c:" + c));
  }
  return out;
}

function featureLabel(key){
  const [type, id] = key.split(":");
  if(type === "g") return genreMap[id] || ("Genre " + id);
  if(type === "k") return enriched.names.k[id] || ("keyword " + id);
  return enriched.names.p[id] || ("person " + id);
}

function featureKind(key){
  return { g: "genre", k: "theme", d: "director", c: "actor" }[key.split(":")[0]];
}

// ---------- taste profile ----------

function scoredRatings(windowSize){
  const entries = Object.entries(ratings)
    .filter(([, r]) => typeof r.rating === "number")
    .sort((a, b) => b[1].ts - a[1].ts); // newest first
  if(windowSize === "all") return entries;
  return entries.slice(0, Number(windowSize));
}

function buildProfile(windowSize){
  const entries = scoredRatings(windowSize || "all");

  let total = 0;
  entries.forEach(([, r]) => { total += r.rating; });
  const globalMean = entries.length ? total / entries.length : 0;

  const acc = {};
  entries.forEach(([id, r]) => {
    featuresOfRating(r, id).forEach(f => {
      if(!acc[f]) acc[f] = { sum: 0, count: 0 };
      acc[f].sum += r.rating;
      acc[f].count += 1;
    });
  });

  const features = {};
  Object.entries(acc).forEach(([key, s]) => {
    const type = key.split(":")[0];
    const w = shrinkByType[type] || 3;
    features[key] = {
      affinity: (s.sum + globalMean * w) / (s.count + w),
      rawAvg: s.sum / s.count,
      count: s.count
    };
  });

  return { features, globalMean, sampleSize: entries.length };
}

// Score a candidate as the evidence-weighted mean of its known features.
// Weight rises with the log of how many times you have rated that feature,
// so a director seen four times outweighs one seen once.
function scoreFilm(movie, profile){
  const matched = [];
  let weightedSum = 0;
  let weightTotal = 0;
  let evidence = 0;

  featuresOf(movie).forEach(key => {
    const f = profile.features[key];
    if(!f) return;
    const type = key.split(":")[0];
    const weight = (weightByType[type] || 1) * Math.log2(f.count + 1);
    if(weight <= 0) return;
    weightedSum += f.affinity * weight;
    weightTotal += weight;
    evidence += f.count;
    matched.push({ key, weight, affinity: f.affinity, rawAvg: f.rawAvg, count: f.count });
  });

  if(weightTotal === 0) return null;

  // Rank contributors by how far they pull the score away from your mean.
  matched.sort((a, b) =>
    Math.abs(b.affinity - profile.globalMean) * b.weight -
    Math.abs(a.affinity - profile.globalMean) * a.weight
  );

  return {
    movie,
    predicted: weightedSum / weightTotal,
    evidence,
    matched
  };
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

  row.innerHTML =
    `<button class="chip${selected.size === 0 ? " on" : ""}" data-all="1">All</button>` +
    entries.map(([id, name]) =>
      `<button class="chip${selected.has(Number(id)) ? " on" : ""}" data-genre="${id}">${escapeHtml(name)}</button>`
    ).join("");

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

// ---------- card rendering ----------

function posterHtml(movie){
  if(movie.p){
    return `<div class="poster" style="background-image:url('${posterBase}${movie.p}')"></div>`;
  }
  return `<div class="poster noPoster">No poster</div>`;
}

function overviewHtml(movie){
  const text = overviews[movie.i];
  if(!text) return `<p class="overview empty" data-for="${movie.i}"></p>`;
  return `<p class="overview" data-for="${movie.i}">${escapeHtml(text)}</p>`;
}

// Scores line: IMDb and Rotten Tomatoes when OMDb has reached this film,
// TMDB's own score always.
function scoresHtml(movie){
  const bits = [];
  const o = omdbScores[movie.i];
  if(o && !o.miss){
    if(o.imdb) bits.push(`<span class="score"><b>IMDb</b> ${o.imdb}</span>`);
    if(o.rt) bits.push(`<span class="score"><b>RT</b> ${o.rt}%</span>`);
    if(o.mc) bits.push(`<span class="score"><b>MC</b> ${o.mc}</span>`);
  }
  if(movie.v) bits.push(`<span class="score"><b>TMDB</b> ${movie.v}</span>`);
  const extra = enriched.films[movie.i];
  if(extra && extra.rt) bits.push(`<span class="score">${extra.rt} min</span>`);
  if(o && o.rated) bits.push(`<span class="score">${escapeHtml(o.rated)}</span>`);
  return `<div class="scoreRow" data-for="${movie.i}">${bits.join("")}</div>`;
}

function metaLine(movie){
  const extra = enriched.films[movie.i];
  if(!extra || extra.dead) return "";
  const dir = (extra.d || []).map(id => enriched.names.p[id]).filter(Boolean);
  if(dir.length === 0) return "";
  return `<div class="credits" data-for="${movie.i}">Directed by ${escapeHtml(dir.join(", "))}</div>`;
}

// Fill in anything that was still loading when a card was drawn.
function hydrateVisibleCards(){
  document.querySelectorAll(".overview.empty").forEach(el => {
    const text = overviews[el.dataset.for];
    if(text){
      el.textContent = text;
      el.classList.remove("empty");
    }
  });
  document.querySelectorAll(".scoreRow").forEach(el => {
    const movie = catalogue.find(m => String(m.i) === el.dataset.for);
    if(movie) el.outerHTML = scoresHtml(movie);
  });
}

// ---------- RATE TAB ----------

document.getElementById("loadBatchBtn").addEventListener("click", () => {
  const stage = document.getElementById("rateStage");
  if(catalogue.length === 0){
    stage.innerHTML = `<p class="emptyState">Catalogue has not loaded.</p>`;
    return;
  }

  const pool = unrated(rateGenres);
  if(pool.length === 0){
    stage.innerHTML = `<p class="emptyState">You have rated everything matching this selection. Pick different genres, or wait for tonight's catalogue refresh.</p>`;
    return;
  }

  const batchSize = Number(document.getElementById("batchSize").value) || 10;
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

  const genreNames = (movie.g || []).map(id => genreMap[id]).filter(Boolean).join(" · ");

  stage.innerHTML = `
    <div class="card">
      ${posterHtml(movie)}
      <div class="cardBody">
        <div class="tag">${escapeHtml(genreNames || "Unknown")}</div>
        <div class="title">${escapeHtml(movie.t)}</div>
        <div class="year">${movie.y || "n/a"}</div>
        ${scoresHtml(movie)}
        ${metaLine(movie)}
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
    // Snapshot the feature list so the rating keeps its meaning even if the
    // film later leaves the catalogue.
    features: featuresOf(movie),
    poster: movie.p || null,
    rating: value,
    ts: Date.now()
  };
  ratedIds.add(movie.i);
  saveRatings();
  if(rateQueue[0] && rateQueue[0].i === movie.i) rateQueue.shift();
  renderRateCard();
}

// ---------- RECOMMEND TAB ----------

document.getElementById("recommendBtn").addEventListener("click", async () => {
  const stage = document.getElementById("recStage");
  if(catalogue.length === 0){
    stage.innerHTML = `<p class="emptyState">Catalogue has not loaded.</p>`;
    return;
  }

  stage.innerHTML = `<p class="emptyState">Scoring…</p>`;
  if(enrichedPromise) await enrichedPromise;

  const windowSize = document.getElementById("recWindow").value;
  const profile = buildProfile(windowSize);

  if(profile.sampleSize === 0){
    stage.innerHTML = `<p class="emptyState">No ratings in this window yet. Rate some titles first.</p>`;
    return;
  }

  const scored = [];
  for(const m of unrated(recGenres)){
    const s = scoreFilm(m, profile);
    if(s) scored.push(s);
  }

  if(scored.length === 0){
    stage.innerHTML = `<p class="emptyState">Nothing in this scope overlaps what you have rated. Widen the genre selection, or rate a few more titles.</p>`;
    return;
  }

  scored.sort((a, b) => b.predicted - a.predicted);
  const topSlice = scored.slice(0, Math.min(5, scored.length));
  const pick = topSlice[Math.floor(Math.random() * topSlice.length)];
  renderRecommendation(pick, profile);
});

function renderRecommendation(pick, profile){
  const stage = document.getElementById("recStage");
  const { movie, predicted, evidence, matched } = pick;

  const confidence = Math.min(95, Math.round((Math.log2(evidence + 1) / Math.log2(60)) * 100));

  const reasons = matched.slice(0, 4).map(m => {
    const dir = m.affinity >= profile.globalMean ? "up" : "down";
    return `<li class="${dir}">
      <span class="rKind">${featureKind(m.key)}</span>
      <span class="rName">${escapeHtml(featureLabel(m.key))}</span>
      <span class="rNum">${m.rawAvg.toFixed(1)} over ${m.count}</span>
    </li>`;
  }).join("");

  const basis = enrichedReady
    ? ""
    : `<div class="warn">Rich features are still loading or unavailable, so this used genres only.</div>`;

  stage.innerHTML = `
    <div class="card recCard">
      ${posterHtml(movie)}
      <div class="cardBody">
        <div class="tag">Predicted ${predicted.toFixed(1)}/10</div>
        <div class="title">${escapeHtml(movie.t)}</div>
        <div class="year">${movie.y || "n/a"}</div>
        ${scoresHtml(movie)}
        ${metaLine(movie)}
        ${overviewHtml(movie)}
        ${basis}
        <div class="whyBlock">
          <div class="whyHead">Why this one</div>
          <ul class="reasons">${reasons}</ul>
        </div>
        <div class="confidence">${confidence}% confidence, from ${evidence} matching data points across ${profile.sampleSize} ratings</div>
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

// ---------- DASHBOARD ----------

function topFeatures(profile, type, limit, minCount){
  return Object.entries(profile.features)
    .filter(([key, f]) => key.startsWith(type + ":") && f.count >= minCount)
    .sort((a, b) => b[1].affinity - a[1].affinity)
    .slice(0, limit)
    .map(([key, f]) => ({ key, ...f }));
}

function featureListHtml(items){
  if(items.length === 0) return `<p class="emptyState small">Not enough ratings yet.</p>`;
  return items.map(i => `
    <div class="genreRow${i.count < 3 ? " lowSample" : ""}">
      <span class="name">${escapeHtml(featureLabel(i.key))}</span>
      <span class="bar"><span style="width:${(i.rawAvg / 10 * 100).toFixed(1)}%"></span></span>
      <span class="val"><b>${i.rawAvg.toFixed(1)}</b> (${i.count})</span>
    </div>
  `).join("");
}

function renderDashboard(){
  const el = document.getElementById("dashboardStage");
  const profile = buildProfile("all");

  const vals = Object.values(ratings);
  const totalRated = vals.filter(r => typeof r.rating === "number").length;
  const totalSkip = vals.filter(r => r.rating === "skip").length;
  const totalWatchlist = vals.filter(r => r.rating === "watchlist").length;

  if(totalRated === 0){
    el.innerHTML = `<p class="emptyState">Nothing rated yet.</p>`;
    return;
  }

  el.innerHTML = `
    <p class="hint">${totalRated} rated · ${totalSkip} unseen · ${totalWatchlist} on watchlist · average ${profile.globalMean.toFixed(1)}</p>

    <h2 class="dashHead">Genres</h2>
    ${featureListHtml(topFeatures(profile, "g", 20, 1))}

    <h2 class="dashHead">Themes you rate highest</h2>
    ${featureListHtml(topFeatures(profile, "k", 12, 2))}

    <h2 class="dashHead">Directors</h2>
    ${featureListHtml(topFeatures(profile, "d", 8, 2))}

    <h2 class="dashHead">Actors</h2>
    ${featureListHtml(topFeatures(profile, "c", 8, 2))}
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
  if(!src) return;
  if(catalogueMeta.count === 0){
    src.textContent = "Catalogue not loaded.";
    return;
  }
  const when = catalogueMeta.generated
    ? new Date(catalogueMeta.generated).toLocaleString()
    : "unknown date";
  const enrichedCount = Object.keys(enriched.films || {}).length;
  const ratedCount = Object.values(omdbScores).filter(v => v && !v.miss).length;
  src.innerHTML =
    `${catalogueMeta.count} films, last refreshed ${when}.<br>` +
    `${enrichedCount} enriched with keywords and credits, ${ratedCount} with IMDb scores.`;
}

// ---------- init ----------

(async function init(){
  const stage = document.getElementById("rateStage");

  try{
    const savedBatch = localStorage.getItem(lsKeyBatchSize);
    if(savedBatch) document.getElementById("batchSize").value = savedBatch;
  }catch(e){ /* non-fatal */ }

  loadExtras(); // background, deliberately not awaited

  try{
    await loadCatalogue();
    stage.innerHTML = `<p class="emptyState">Pick your genres, then "Load batch".</p>`;
  }catch(e){
    stage.innerHTML = `<p class="emptyState">Could not load the film catalogue (${escapeHtml(e.message)}).<br>Run the <strong>buildCatalogue</strong> workflow in the repo's Actions tab to generate it.</p>`;
  }
  renderSettings();
})();
