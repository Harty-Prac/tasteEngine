// tasteEngine — static, client-only movie taste tracker + recommender.
// No backend, no API key in the browser. Film data comes from
// data/catalogue.json, rebuilt nightly by a GitHub Actions workflow that
// holds the TMDB key as a repository secret. Ratings live in localStorage.

const lsKeyRatings = "tasteEngine.ratings";
const posterBase = "https://image.tmdb.org/t/p/w342"; // public CDN, needs no key
const cataloguePath = "data/catalogue.json";

let genreMap = {};
let catalogue = [];
let catalogueMeta = { generated: null, count: 0 };
let ratings = loadRatings();
let ratedIds = new Set(Object.keys(ratings).map(Number));
let rateQueue = [];

// ---------- storage ----------

function loadRatings(){
  try{ return JSON.parse(localStorage.getItem(lsKeyRatings)) || {}; }
  catch(e){ return {}; }
}

function saveRatings(){
  try{ localStorage.setItem(lsKeyRatings, JSON.stringify(ratings)); }
  catch(e){ console.warn("could not save ratings", e); }
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
  populateGenreSelects();
}

function populateGenreSelects(){
  const rateSel = document.getElementById("rateGenre");
  const recSel = document.getElementById("recGenreScope");
  rateSel.innerHTML = `<option value="all">All genres</option>`;
  recSel.innerHTML = `<option value="all">All genres</option>`;
  Object.entries(genreMap)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([id, name]) => {
      const opt = `<option value="${id}">${escapeHtml(name)}</option>`;
      rateSel.insertAdjacentHTML("beforeend", opt);
      recSel.insertAdjacentHTML("beforeend", opt);
    });
}

function inGenre(movie, genreId){
  if(genreId === "all") return true;
  return (movie.g || []).includes(Number(genreId));
}

function unrated(genreId){
  return catalogue.filter(m => !ratedIds.has(m.i) && inGenre(m, genreId));
}

function posterStyle(posterPath){
  return posterPath ? `background-image:url('${posterBase}${posterPath}')` : "";
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
  const genreId = document.getElementById("rateGenre").value;
  const pool = unrated(genreId);
  if(pool.length === 0){
    stage.innerHTML = `<p class="emptyState">You've rated everything in this genre. Pick another, or wait for tonight's catalogue refresh.</p>`;
    return;
  }
  // Draw from the top slice by popularity, shuffled, so repeated batches
  // aren't always the same handful of blockbusters in the same order.
  const slice = pool.slice(0, Math.min(60, pool.length));
  rateQueue = shuffle(slice).slice(0, 10);
  renderRateCard();
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
      <div class="poster" style="${posterStyle(movie.p)}"></div>
      <div class="cardBody">
        <div class="tag">${escapeHtml(genreNamesFor(movie) || "Unknown")}</div>
        <div class="title">${escapeHtml(movie.t)}</div>
        <div class="year">${movie.y || "—"}${movie.v ? " · TMDB " + movie.v : ""}</div>
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

function genreStats(windowSize){
  const entries = scoredRatings(windowSize || "all");
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
    out[g] = { avg: s.sum / s.count, count: s.count };
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

  const scope = document.getElementById("recGenreScope").value;
  const windowSize = document.getElementById("recWindow").value;
  const stats = genreStats(windowSize);
  const trainedOn = scoredRatings(windowSize).length;

  if(trainedOn === 0){
    stage.innerHTML = `<p class="emptyState">No ratings in this window yet. Rate some titles first.</p>`;
    return;
  }

  const pool = unrated(scope);
  const scored = [];

  for(const m of pool){
    const overlap = (m.g || []).filter(g => stats[g]);
    if(overlap.length === 0) continue;
    const predicted = overlap.reduce((sum, g) => sum + stats[g].avg, 0) / overlap.length;
    const sampleCount = overlap.reduce((sum, g) => sum + stats[g].count, 0);
    scored.push({ movie: m, predicted, overlap, sampleCount });
  }

  if(scored.length === 0){
    stage.innerHTML = `<p class="emptyState">Nothing in this scope overlaps the genres you've rated. Try "All genres", or rate a few titles in this genre first.</p>`;
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
    .map(g => `${genreMap[g]} (${stats[g].avg.toFixed(1)} avg)`)
    .join(", ");

  stage.innerHTML = `
    <div class="card recCard">
      <div class="poster" style="${posterStyle(movie.p)}"></div>
      <div class="cardBody">
        <div class="tag">Predicted ${predicted.toFixed(1)}/10</div>
        <div class="title">${escapeHtml(movie.t)}</div>
        <div class="year">${movie.y || "—"}${movie.v ? " · TMDB " + movie.v : ""}</div>
        <div class="why">Matches your taste in ${escapeHtml(matchNames)}.</div>
        <div class="confidence">${confidence}% confidence — ${sampleCount} rated title${sampleCount === 1 ? "" : "s"} in these genres, trained on ${trainedOn} rating${trainedOn === 1 ? "" : "s"}</div>
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
      <div class="genreRow">
        <span>${escapeHtml(genreMap[g] || ("Genre " + g))}</span>
        <span class="bar"><span style="width:${(s.avg / 10 * 100)}%"></span></span>
        <span>${s.avg.toFixed(1)} (${s.count})</span>
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
    await loadCatalogue();
    stage.innerHTML = `<p class="emptyState">Pick a genre, then "Load batch".</p>`;
  }catch(e){
    stage.innerHTML = `<p class="emptyState">Couldn't load the film catalogue (${escapeHtml(e.message)}).<br>Run the <strong>buildCatalogue</strong> workflow in the repo's Actions tab to generate it.</p>`;
  }
  renderSettings();
})();
