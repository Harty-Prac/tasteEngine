# tasteEngine

Static, zero-backend movie taste tracker + recommender. No server, no database,
no hidden API keys. Everything runs in your browser; GitHub Pages just serves the files.

## How it works

- Rate tab pulls popular titles per genre from TMDB, you rate 1-10 / watchlist / haven't seen
- Ratings live in `localStorage` only — never leave your browser except to export
- Recommend tab scores unrated TMDB titles by your per-genre averages, filtered by genre scope and rating-window (last N vs all-time), shows a confidence % based on sample size
- Dashboard shows per-genre average + count
- Settings: paste your own free TMDB API key (client-side keys are fine for TMDB — unlike Groq/OpenAI, their free key is meant to be used this way), export/import ratings as JSON, wipe data

## Deploy

1. Create a public GitHub repo, push these three files (`index.html`, `style.css`, `app.js`) plus this README
2. Repo Settings → Pages → Deploy from branch → `main` / root
3. Done — your URL is `https://<username>.github.io/<repo>/`

## Get a TMDB key

themoviedb.org → create free account → Settings → API → request a key (select "Developer", any use case works) → paste the v3 `api_key` into the app's Settings tab.

## Not yet built (see feature backlog)

- Mood tag filter
- Explain-the-miss feedback loop
- Recency decay
- Anti-repeat cooldown
- GitHub-repo-as-sync (currently single-browser via localStorage only)
- In-browser LLM blurb generation
