# cutlist

A fully client-side cut list optimiser for sheet goods. Enter your panels and
stock sheets, set the kerf and per-panel alignment (any / parallel /
perpendicular to the sheet length), hit **Calculate**, and get a visual
layout for every sheet.

The layout algorithm matches a **small-workshop tracksaw workflow**:

- **Rips first, and never again.** First-stage cuts always run the full
  length of the sheet (dashed red lines), made with a long track. Every
  later cut is a cross cut — no layout is ever produced that would need a
  rip after cross cutting.
- **Cross-cut capacity** (option, default 700mm) models a hinged-rail
  cross-cut station: a strip that needs separating cuts can't be taller
  than the capacity, and a panel sitting below its strip height is trimmed
  by rotating the piece and cross cutting along it — only legal if the
  piece's width fits the capacity.

Each calculation runs a **time-budgeted search** in a Web Worker, so the UI
never blocks: all 96 combinations of the packer's heuristic knobs (placement
orders, strip-fit rules, orientation preferences, stock policies, like-panel
affinities) always run — and render an interim result immediately — then
seeded random restarts keep coming for up to ~10 seconds, stopping early once
hundreds of candidates in a row fail to improve. Each candidate is refined
by a local-improvement pass that
relocates and swaps panels between strips (letting strips shrink when a tall
straggler finds a better home). The best result wins by: fewest unplaced
panels, then least stock consumed, then **fewest rips**, then **fewest cross
cuts**, then fewest mixed-panel strips, preferring smaller sheets when
material ties, then least strip area committed (biggest reusable offcut).

Projects are saved automatically to your browser's local storage — name them
in the top bar and switch between them with the dropdown. No server, no
account, no data leaves the browser.

## Run locally

```sh
npm install
npm run dev
```

Then open the printed URL (default <http://localhost:5173>).

## Build

```sh
npm run build    # type-checks and outputs a static site to dist/
npm run preview  # serve the built site locally
```

The build is entirely static (relative asset paths), so `dist/` can be hosted
anywhere — GitHub Pages, Netlify, an S3 bucket, or a plain file server.

## Deploy to GitHub Pages

A workflow is included at `.github/workflows/deploy.yml`. Push the repo to
GitHub, then under **Settings → Pages** set the source to **GitHub Actions**.
Every push to `main` builds and deploys the site.
