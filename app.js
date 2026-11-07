// tasteEngine — static, client-only movie taste tracker + recommender.
// No backend. All state in localStorage. TMDB called directly from the browser.

const LS_KEY_API = "tasteEngine.tmdbKey";
const LS_KEY_RATINGS = "tasteEngine.ratings";
const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w342";

let genreMap = {};        // id -> name
let ratings = loadRatings();
let rateQueue = [];       // movies pending rating in current batch
let rateSeenIds = new Set(Object.keys(ratings).map(Number));

// ---------- storage ----------

function loadRatings(){
  try{ return JSON.parse(localStorage.getItem(LS_KEY_RATINGS)) || {}; }
  catch(e){ return {}; }
}
function saveRatings(){
  localStorage.setItem(LS_KEY_RATINGS, JSON.stringify(ratings));
}
function getApiKey(){
  return localStorage.getItem(LS_KEY_API) || "";
}

// ---------- tabs ----------

document.querySelectorAll(".tabBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tabPanel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if(btn.dataset.tab === "dashboard") renderDashboard();
    if(btn.dataset.tab === "settings") renderStats();
  });
});

// ---------- TMDB calls ----------

async function tmdbFetch(path, params){
  const key = getApiKey();
  if(!key){ throw new Error("no TMDB key set"); }
  const usp = new URLSearchParams({ api_key: key, ...params });
  const res = await fetch(`${TMDB_BASE}${path}?${usp.toString()}`);
  if(!res.ok) throw new Error("TMDB error " + res.status);
  return res.json();
}

async function loadGenres(){
  if(!getApiKey()) return;
  try{
    const data = await tmdbFetch("/genre/movie/list", {});
    genreMap = {};
    data.genres.forEach(g => genreMap[g.id] = g.name);
    populateGenreSelects();
  }catch(e){
    console.warn("genre load failed", e);
  }
}

function populateGenreSelects(){
  const rateSel = document.getElementById("rateGenre");
  const recSel = document.getElementById("recGenreScope");
  rateSel.innerHTML = "";
  recSel.innerHTML = `<option value="all">All genres</option>`;
  Object.entries(genreMap)
    .sort((a,b) => a[1].localeCompare(b[1]))
    .forEach(([id, name]) => {
      rateSel.insertAdjacentHTML("beforeend", `<option value="${id}">${name}</option>`);
      recSel.insertAdjacentHTML("beforeend", `<option value="${id}">${name}</option>`);
    });
}

async function fetchCandidates(genreId, page){
  const params = { sort_by: "popularity.desc", page: page || 1, "vote_count.gte": 50 };
  if(genreId && genreId !== "all") params.with_genres = genreId;
  const data = await tmdbFetch("/discover/movie", params);
  return data.results || [];
}

// ---------- RATE TAB ----------

document.getElementById("loadBatchBtn").addEventListener("click", async () => {
  const stage = document.getElementById("rateStage");
  if(!getApiKey()){
    stage.innerHTML = `<p class="emptyState">Set your TMDB key in Settings first.</p>`;
    return;
  }
  const genreId = document.getElementById("rateGenre").value;
  stage.innerHTML = `<p class="emptyState">Loading…</p>`;
  try{
    let page = 1, pool = [];
    // pull a couple pages so we have enough unseen titles
    while(pool.length < 10 && page <= 5){
      const results = await fetchCandidates(genreId, page);
      if(results.length === 0) break;
      pool = pool.concat(results.filter(m => !rateSeenIds.has(m.id)));
      page++;
    }
    rateQueue = pool.slice(0, 10);
    if(rateQueue.length === 0){
      stage.innerHTML = `<p class="emptyState">No new unrated titles found in this genre right now.</p>`;
      return;
    }
    renderRateCard();
  }catch(e){
    stage.innerHTML = `<p class="emptyState">Error: ${e.message}</p>`;
  }
});

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
  const year = (movie.release_date || "").slice(0,4) || "—";
  const poster = movie.poster_path ? `${POSTER_BASE}${movie.poster_path}` : "";
  const genreNames = (movie.genre_ids||[]).map(id => genreMap[id]).filter(Boolean).join(" · ");

  const ratingButtons = Array.from({length:10}, (_,i)=>i+1)
    .map(n => `<button data-score="${n}">${n}</button>`).join("");

  stage.innerHTML = `
    <div class="card">
      <div class="poster" style="${poster ? `background-image:url('${poster}')` : ""}"></div>
      <div class="cardBody">
        <div class="tag">${genreNames || "Unknown"}</div>
        <div class="title">${escapeHtml(movie.title)}</div>
        <div class="year">${year}</div>
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
  ratings[movie.id] = {
    title: movie.title,
    year: (movie.release_date||"").slice(0,4) || null,
    genreIds: movie.genre_ids || [],
    poster: movie.poster_path || null,
    rating: value,
    ts: Date.now()
  };
  rateSeenIds.add(movie.id);
  saveRatings();
  rateQueue.shift();
  renderRateCard();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ---------- scoring ----------

function filteredRatings(windowSize){
  const entries = Object.entries(ratings)
    .filter(([id, r]) => typeof r.rating === "number")
    .sort((a,b) => b[1].ts - a[1].ts); // newest first
  if(windowSize === "all") return entries;
  return entries.slice(0, Number(windowSize));
}

function genreStats(windowSize){
  const entries = filteredRatings(windowSize || "all");
  const stats = {}; // id -> {sum, count}
  entries.forEach(([id, r]) => {
    (r.genreIds||[]).forEach(g => {
      if(!stats[g]) stats[g] = {sum:0, count:0};
      stats[g].sum += r.rating;
      stats[g].count += 1;
    });
  });
  const avg = {};
  Object.entries(stats).forEach(([g, s]) => avg[g] = {avg: s.sum/s.count, count: s.count});
  return avg;
}

// ---------- RECOMMEND TAB ----------

document.getElementById("recommendBtn").addEventListener("click", async () => {
  const stage = document.getElementById("recStage");
  if(!getApiKey()){
    stage.innerHTML = `<p class="emptyState">Set your TMDB key in Settings first.</p>`;
    return;
  }
  const scope = document.getElementById("recGenreScope").value;
  const windowSize = document.getElementById("recWindow").value;
  const stats = genreStats(windowSize);
  const totalRated = filteredRatings(windowSize).length;

  if(totalRated === 0){
    stage.innerHTML = `<p class="emptyState">No ratings in this window yet. Rate some movies first.</p>`;
    return;
  }

  stage.innerHTML = `<p class="emptyState">Thinking…</p>`;
  try{
    let pool = [];
    let pages = [1,2,3];
    for(const page of pages){
      const results = await fetchCandidates(scope, page);
      pool = pool.concat(results);
    }
    pool = pool.filter(m => !rateSeenIds.has(m.id));

    let best = null, bestScore = -1, bestMatches = [];
    for(const m of pool){
      const overlapping = (m.genre_ids||[]).filter(g => stats[g]);
      if(overlapping.length === 0) continue;
      const score = overlapping.reduce((sum,g) => sum + stats[g].avg, 0) / overlapping.length;
      if(score > bestScore){
        bestScore = score; best = m; bestMatches = overlapping;
      }
    }

    if(!best){
      stage.innerHTML = `<p class="emptyState">Couldn't find a match in this scope. Try "All genres" or rate more titles.</p>`;
      return;
    }

    const sampleCount = bestMatches.reduce((s,g) => s + stats[g].count, 0);
    const confidence = Math.min(95, Math.round((Math.log2(sampleCount+1) / Math.log2(30)) * 100));
    const matchNames = bestMatches.map(g => `${genreMap[g]} (${stats[g].avg.toFixed(1)} avg)`).join(", ");
    const year = (best.release_date||"").slice(0,4) || "—";
    const poster = best.poster_path ? `${POSTER_BASE}${best.poster_path}` : "";

    stage.innerHTML = `
      <div class="card recCard">
        <div class="poster" style="${poster ? `background-image:url('${poster}')` : ""}"></div>
        <div class="cardBody">
          <div class="tag">Predicted score ${bestScore.toFixed(1)}/10</div>
          <div class="title">${escapeHtml(best.title)}</div>
          <div class="year">${year}</div>
          <div class="why">Matches your taste in ${matchNames}.</div>
          <div class="confidence">${confidence}% confidence — based on ${sampleCount} rated title${sampleCount===1?"":"s"} in these genres</div>
          <div class="belowRow">
            <button id="recWatchlist">Watchlist this</button>
            <button id="recSkip">Not interested</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("recWatchlist").addEventListener("click", () => {
      submitRating(best, "watchlist");
      document.getElementById("recommendBtn").click();
    });
    document.getElementById("recSkip").addEventListener("click", () => {
      submitRating(best, "skip");
      document.getElementById("recommendBtn").click();
    });
  }catch(e){
    stage.innerHTML = `<p class="emptyState">Error: ${e.message}</p>`;
  }
});

// ---------- DASHBOARD ----------

function renderDashboard(){
  const el = document.getElementById("dashboardStage");
  const stats = genreStats("all");
  const rows = Object.entries(stats)
    .sort((a,b) => b[1].avg - a[1].avg)
    .map(([g, s]) => `
      <div class="genreRow">
        <span>${genreMap[g] || ("Genre " + g)}</span>
        <span class="bar"><span style="width:${(s.avg/10*100)}%"></span></span>
        <span>${s.avg.toFixed(1)} (${s.count})</span>
      </div>
    `).join("");
  const totalRated = Object.values(ratings).filter(r => typeof r.rating === "number").length;
  const totalSkip = Object.values(ratings).filter(r => r.rating === "skip").length;
  const totalWatchlist = Object.values(ratings).filter(r => r.rating === "watchlist").length;

  el.innerHTML = `
    <p class="hint">${totalRated} rated · ${totalSkip} unseen · ${totalWatchlist} on watchlist</p>
    ${rows || '<p class="emptyState">Nothing rated yet.</p>'}
  `;
}

// ---------- SETTINGS ----------

document.getElementById("saveKeyBtn").addEventListener("click", async () => {
  const val = document.getElementById("tmdbKeyInput").value.trim();
  if(!val) return;
  localStorage.setItem(LS_KEY_API, val);
  document.getElementById("keyStatus").textContent = "saved";
  await loadGenres();
});

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(ratings, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "tasteEngine-ratings.json";
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
      ratings = {...ratings, ...incoming};
      rateSeenIds = new Set(Object.keys(ratings).map(Number));
      saveRatings();
      renderStats();
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
  rateSeenIds = new Set();
  saveRatings();
  renderStats();
  renderDashboard();
});

function renderStats(){
  const total = Object.keys(ratings).length;
  document.getElementById("statsLine").textContent = `${total} titles tracked total.`;
  const key = getApiKey();
  if(key){
    document.getElementById("tmdbKeyInput").value = key;
    document.getElementById("keyStatus").textContent = "saved";
  }
}

// ---------- init ----------

(async function init(){
  renderStats();
  await loadGenres();
})();
