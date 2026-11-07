# tasteEngine

Static movie taste tracker + recommender. No backend, no server, no API key in
the browser. GitHub Pages serves the files; GitHub Actions supplies the data.

## Architecture

```
GitHub Actions (nightly)          GitHub Pages (static)
  TMDB_API_KEY secret      ->  data/catalogue.json  ->  browser
  scripts/buildCatalogue.js      (committed to repo)      localStorage
```

The TMDB key lives only in repository secrets. The workflow queries TMDB, trims
each record to the handful of fields the client uses, and commits
`data/catalogue.json` back to the repo. The published page fetches that one
static file and makes zero API calls — nothing to extract from DevTools.

Posters load straight from `image.tmdb.org`, which needs no key at all.

## Setup

1. Get a free TMDB v3 key: themoviedb.org -> Settings -> API -> request key
2. Store it as a repository secret (never in the code):
   ```
   gh secret set TMDB_API_KEY
   ```
3. Generate the first catalogue:
   ```
   gh workflow run buildCatalogue
   ```
4. Enable Pages: Settings -> Pages -> Deploy from a branch -> `main` / `/ (root)`

After that the workflow refreshes the catalogue at 03:00 UTC daily.

## Tuning the catalogue

Workflow env vars in `.github/workflows/buildCatalogue.yml`:

- `PAGES_GLOBAL` (12) — pages of overall-popularity sweep
- `PAGES_PER_GENRE` (8) — pages fetched per genre
- `MIN_VOTES` (50) — discards obscure titles with too few votes

Defaults give roughly 2,500-3,500 films at a few hundred KB.

## How recommendations work

Per-genre averages are computed from your ratings, restricted to the chosen
genre scope and rating window (last 10 / last 50 / all-time). Every unrated
film in the catalogue gets a predicted score — the mean of your averages across
its overlapping genres — and the suggestion is drawn at random from the top 5
so asking twice doesn't return the same film. Confidence is a log curve over
sample size, capped at 95%.

## Data

Ratings stay in `localStorage` in one browser. Export/import JSON from Settings
to move them between devices.

## Not yet built

- Mood tag filter
- Explain-the-miss feedback loop
- Recency decay on older ratings
- Anti-repeat cooldown
- Cross-device sync via the GitHub Contents API
- In-browser LLM for natural-language blurbs
