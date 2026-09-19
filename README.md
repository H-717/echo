# Echo

All 9,216 songs, 18 languages, 9 hymnals — offline,
with chords that stay attached to the right syllable at any window size.

## Running it

```bash
node scripts/build-data.mjs     # raw/ -> data/   (rerun when songs change)
node scripts/serve.mjs          # http://localhost:4173
```

No dependencies and no build tooling — plain ES modules and Node's standard
library. `data/` and `dist/` are generated, so they are not committed.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages automatically
(`.github/workflows/deploy.yml`). Enable it once under
**Settings -> Pages -> Source: GitHub Actions**.

To check a deploy locally first:

```bash
node scripts/build-site.mjs --base echo   # the repo name
node scripts/preview.mjs --base echo      # serves dist/ the way Pages does
```

The site works from a domain root or a project subpath: `--base` is stamped
into `<base href>` and everything is addressed relative to it. Deep links work
because `dist/404.html` is a copy of the app — GitHub Pages serves it for
unknown paths with the URL intact, which is the only routing hook Pages gives
you.

For a custom domain, build with `--base /` and add a `CNAME` file to `dist/`.

## How it is put together

```
raw/            the 18 language dumps pulled from the old API
data/           build output — static JSON, no server involved at runtime
web/            the app
scripts/        build, dev server, tests
```

Nothing is fetched from an application server. `data/` is plain files that sit
on a CDN, so hosting is static-file cost only.

| file | what it does |
| --- | --- |
| `web/chords.js` | chord theory: parsing, transposing, key detection |
| `web/render.js` | chord-chart layout — the important one, see below |
| `web/store.js` | song lookup, title search, per-device settings |
| `web/sync-worker.js` | downloads songs into IndexedDB; runs full-text search |
| `web/groove.js` | tempo, meter, strum pattern, metronome, tap tempo |
| `web/app.js` | routing, views, fit-to-screen layout |

## The three things that must not regress

**Chords stay on their syllable.** A line is never laid out as a row of chords
above a row of words — that breaks the moment the line wraps. Each *word*
becomes one unwrappable box carrying its own chords, so the browser wraps
between words and a chord can never drift off its syllable. `web/render.js`.

**Opening a song is instant.** Songs live in IndexedDB. Opening one is a local
read (~1.7ms) plus a render (~2ms); nothing waits on the network. The layout
pass is the only real cost, and its result is cached per song.

**The server does almost nothing.** One sync downloads every song, then the app
is offline-first. Personal settings never leave the device.

## Fit to screen

The default. It sizes the type and picks a column count so the whole song is on
one screen — nobody has to scroll while a room is singing. Songs genuinely
longer than the screen scroll normally instead of being shrunk past legibility.
Toggle it off in the dock for the plain reading layout.

## Rhythm

Per song, stored on the device: time signature, tempo (tap to set), feel, a
strum pattern (`D DU UDU`), and a free note. Tempo drives a metronome with a
one-bar count-in, which is what actually gets a group starting together.

Sharing these between people is Phase 2 and is the only part that needs a
server: suggestions ride down inside the existing sync, so reads stay free and
only submissions cost a request.

## Tests

```bash
node scripts/test-render.mjs      # chord layout edge cases
node scripts/audit-brackets.mjs   # how much of the corpus parses as chords
```

`build-data.mjs` fails the build if shard filenames collide or if the shards
stop covering all 9,216 songs.

## Where the songs come from

The corpus was imported from the public API of the original songbase.life. The
songs themselves are hymns and spiritual songs, mostly long out of copyright,
but the collection is not this project's own work — keep that in mind before
republishing it somewhere else.

## Data notes

- Song ids are globally unique and carried over from the old site, so existing
  links keep working.
- 99.8% of the 100,739 chord brackets parse as chords. Compound brackets
  (`[C-C/B-Am]`, `[G D]`, `[(A)]`) are kept and transposed. Anything that isn't
  chords is preserved as written rather than dropped.
- 86% of songs write the verse number on its own line; that number is used as
  the label rather than printed twice.
