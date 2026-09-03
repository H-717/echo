// Songbase — app shell, router and views.
//
// Reads are local: once the first sync lands, moving between songs never waits
// on the network. Everything a person changes here (key, capo, groove, chord
// tweaks) is stored per-device and costs nothing to keep.

import { Store, slug } from './store.js';
import { renderSong } from './render.js';
import { transposeKey } from './chords.js';
import * as G from './groove.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
  cols: '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>',
  scroll: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  fit: '<path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007.5 19a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H1a2 2 0 110-4h.1A1.6 1.6 0 002.6 7.5a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H7a1.6 1.6 0 001-1.5V1a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V7a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  tempo: '<path d="M9.5 3h5l3.5 18h-12z"/><path d="M12 21V9l4.5-3.5"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
};
const icon = (n, cls = 'ico') => `<span class="${cls}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg></span>`;

// Everything is addressed relative to where the app is deployed, so it works
// identically at a domain root and under a project subpath.
const BASE = new URL(document.baseURI).pathname.replace(/\/*$/, '/');
const path = (p) => BASE + String(p).replace(/^\/+/, '');

const app = $('#app');
const store = new Store(BASE);
const metro = new G.Metronome();
const tapper = new G.TapTempo();

let prefs = { size: 17, chords: true, cols: 'auto', fit: true, langs: null, theme: null };
let current = null;   // { meta, lyrics, local, steps, capo }
let autoscroll = null;

// ------------------------------------------------------------------ boot

(async function boot() {
  await store.init();
  prefs = { ...prefs, ...(await store.prefs()) };
  // Older builds could store several languages; keep only the first.
  if (prefs.langs && prefs.langs.length > 1) prefs = await store.setPrefs({ langs: prefs.langs.slice(0, 1) });
  applyTheme();

  store.on((ev) => { if (ev.type === 'sync') renderSyncStatus(ev.state); });

  window.addEventListener('popstate', route);
  document.addEventListener('click', onGlobalClick);
  route();

  // Cache-first is right in production and wrong in development, where it
  // would keep serving the last build.
  const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !isDev) {
    // A new worker installs in the background, so the refresh that fetches it
    // is still served the old build and only the one after that shows the new
    // one. That makes every update look like it did not take. Reload once, as
    // soon as the new worker actually takes control.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register(path('sw.js'), { scope: BASE }).catch(() => {});
  }
})();

function applyTheme() {
  const t = prefs.theme;
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');

  // Mirror it where the inline script in the document head can read it
  // synchronously on the next load, so the page never paints the wrong theme.
  try {
    if (t) localStorage.setItem('sb-theme', t);
    else localStorage.removeItem('sb-theme');
  } catch (e) { /* private mode: the flash comes back, nothing else breaks */ }

  // Keep the browser's own chrome in step with the choice.
  const dark = t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.setAttribute('content', dark ? '#0d0f13' : '#fcfcfd');
    m.removeAttribute('media');
  }
}

// ---------------------------------------------------------------- router

function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}

function route() {
  stopAutoscroll();
  metro.stop();
  window.removeEventListener('scroll', onListScroll);
  if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
  document.documentElement.classList.remove('locked');
  const rest = location.pathname.startsWith(BASE)
    ? location.pathname.slice(BASE.length)
    : location.pathname.replace(/^\/+/, '');
  const m = /^(\d+)/.exec(rest);
  if (m) renderSongView(Number(m[1]));
  else renderList();
}

function onGlobalClick(e) {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.metaKey && !e.ctrlKey && a.origin === location.origin) {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
}

// ------------------------------------------------------------ list view

// Rows are appended a page at a time as you reach the bottom, so all 9,216
// songs are reachable without building 9,216 DOM nodes up front.
const PAGE = 120;
let listState = { q: '', lyricHits: [], lyricPending: false, hits: [], total: 0, shown: 0 };
let moreObserver = null;

function renderList() {
  const params = new URLSearchParams(location.search);
  listState.q = params.get('q') || '';

  document.title = 'Songbase';
  app.innerHTML = `
    <header class="top">
      <span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS.music}</svg></span>
      <div class="name">Songbase<small>${store.index.ids.length.toLocaleString()} songs · ${store.index.langCodes.length} languages</small></div>
      <button class="ico" data-act="settings" aria-label="Settings"><svg viewBox="0 0 24 24">${ICONS.gear}</svg></button>
    </header>
    <div class="wrap">
      <div class="searchbar">
        <span class="mag"><svg viewBox="0 0 24 24">${ICONS.search}</svg></span>
        <input id="q" type="search" inputmode="search" autocomplete="off" spellcheck="false"
               placeholder="Search titles and lyrics" value="${esc(listState.q)}" aria-label="Search songs">
        <button class="clr" data-act="clear" aria-label="Clear search" ${listState.q ? '' : 'hidden'}>×</button>
      </div>
      <div class="filters" id="langs"></div>
      <div id="results"></div>
    </div>
    <div class="sync" hidden></div>`;

  renderLangFilters();
  const input = $('#q');
  input.addEventListener('input', onSearchInput);
  $('.clr').addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  renderResults();
  renderSyncStatus(store.syncState);
}

function activeLangs() {
  return prefs.langs && prefs.langs.length ? new Set(prefs.langs) : null;
}

function renderLangFilters() {
  const el = $('#langs');
  if (!el) return;
  const active = prefs.langs || [];
  const counts = {};
  const x = store.index;
  for (const li of x.langs) counts[x.langCodes[li]] = (counts[x.langCodes[li]] || 0) + 1;
  const langs = [...x.langCodes].sort((a, b) => counts[b] - counts[a]);

  el.innerHTML = `<button class="chipbtn" data-lang="" aria-pressed="${active.length === 0}">All</button>` +
    langs.map((l) => `<button class="chipbtn" data-lang="${esc(l)}" aria-pressed="${active.includes(l)}">${esc(l)} <span style="opacity:.6">${counts[l]}</span></button>`).join('');

  el.onclick = async (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    const l = b.dataset.lang;
    const cur = prefs.langs || [];
    // One language at a time: picking another replaces it, picking the
    // active one (or All) clears back to every language.
    const next = !l || cur.includes(l) ? [] : [l];
    prefs = await store.setPrefs({ langs: next });
    renderLangFilters();
    renderResults();
  };
}

let searchTimer = null;
function onSearchInput(e) {
  listState.q = e.target.value;
  $('.clr').hidden = !listState.q;
  const url = listState.q ? path(`?q=${encodeURIComponent(listState.q)}`) : BASE;
  history.replaceState({}, '', url);

  // Titles are matched instantly from memory on every keystroke; the full-text
  // pass is debounced and runs against IndexedDB, so typing never stalls.
  listState.lyricHits = [];
  renderResults();

  clearTimeout(searchTimer);
  if (listState.q.trim().length >= 3) {
    listState.lyricPending = true;
    searchTimer = setTimeout(runLyricSearch, 220);
  } else {
    listState.lyricPending = false;
  }
}

async function runLyricSearch() {
  const q = listState.q;
  const titleHits = store.searchTitles(q, { langs: activeLangs() });
  const exclude = new Set(titleHits.hits.map((i) => store.index.ids[i]));
  const hits = await store.searchLyrics(q, { exclude });
  if (q !== listState.q) return;    // a newer keystroke won
  listState.lyricHits = store.resolveHits(hits, activeLangs());
  listState.lyricPending = false;
  renderResults();
}

function rowHtml(s, extra = '') {
  const ref = s.refs.length ? `<span class="n">${esc(store.bookName(s.refs[0][0]))} ${esc(s.refs[0][1])}</span>` : '';
  return `<a class="row" data-nav href="${path(String(s.id))}">
    <span class="t">${esc(s.title)}${extra}</span>
    ${s.key ? `<span class="n">${esc(s.key)}</span>` : ''}
    ${ref}
  </a>`;
}

function renderResults() {
  const el = $('#results');
  if (!el) return;

  const { hits, total } = store.searchTitles(listState.q, { langs: activeLangs() });
  listState.hits = hits;
  listState.total = total;
  listState.shown = 0;

  if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
  window.removeEventListener('scroll', onListScroll);

  if (!total && !listState.lyricHits.length) {
    el.innerHTML = `<div class="empty">${listState.q ? `Nothing matches “${esc(listState.q)}”.` : 'No songs in the selected language.'}</div>`;
    return;
  }

  el.innerHTML =
    `<div class="count" id="count"></div>` +
    `<div class="rows" id="rows"></div>` +
    `<div id="more" style="height:1px"></div>` +
    lyricSectionHtml();

  appendRows();

  // Load the next page slightly before the sentinel is actually on screen.
  const sentinel = $('#more');
  if (sentinel) {
    moreObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) appendRows();
    }, { rootMargin: '600px 0px' });
    moreObserver.observe(sentinel);
  }
  // IntersectionObserver doesn't run in a hidden tab and can be missed during a
  // fast fling, so scrolling is also checked directly. Whichever fires first
  // wins; appendRows is idempotent once the list is exhausted.
  window.addEventListener('scroll', onListScroll, { passive: true });
}

let lastScrollCheck = 0;
function onListScroll() {
  // A timestamp throttle rather than requestAnimationFrame: rAF is throttled to
  // roughly once a second in a background tab, which would stall loading.
  const now = performance.now();
  if (now - lastScrollCheck < 60) return;
  lastScrollCheck = now;

  const sentinel = $('#more');
  if (!sentinel) { window.removeEventListener('scroll', onListScroll); return; }
  if (sentinel.getBoundingClientRect().top - window.innerHeight < 600) appendRows();
}

function appendRows() {
  const rowsEl = $('#rows');
  if (!rowsEl || listState.shown >= listState.hits.length) return;

  const next = listState.hits.slice(listState.shown, listState.shown + PAGE);
  rowsEl.insertAdjacentHTML('beforeend', next.map((i) => rowHtml(store.metaAt(i))).join(''));
  listState.shown += next.length;

  const c = $('#count');
  if (c) {
    const t = listState.total.toLocaleString();
    c.textContent = listState.shown < listState.total
      ? `${listState.shown.toLocaleString()} of ${t} ${listState.total === 1 ? 'title' : 'titles'}`
      : `${t} ${listState.total === 1 ? 'title' : 'titles'}`;
  }
  if (listState.shown >= listState.hits.length && moreObserver) {
    moreObserver.disconnect();
    moreObserver = null;
  }
}

function lyricSectionHtml() {
  if (listState.lyricHits.length) {
    return `<div class="groupname">Found in the words</div><div class="rows">` +
      listState.lyricHits.map((s) => rowHtml(s, `<span class="snip">${esc(s.snippet)}</span>`)).join('') +
      '</div>';
  }
  if (listState.lyricPending) return `<div class="groupname">Searching the words…</div>`;
  return '';
}

function renderSyncStatus(state) {
  const el = $('.sync');
  if (!el) return;
  if (!state || state.phase !== 'syncing') { el.hidden = true; return; }
  const pct = state.total ? Math.round(100 * state.done / state.total) : 0;
  el.hidden = false;
  el.innerHTML = `<span>Saving songs for offline</span><span class="bar"><i style="width:${pct}%"></i></span>`;
}

// ------------------------------------------------------------ song view

async function renderSongView(id) {
  const meta = store.meta(id);
  if (!meta) { go(BASE, true); return; }

  document.title = meta.title;
  // Keep the address bar at just the number. Someone reading from a laptop
  // changes song by editing "1482" to "1483"; a long slug makes that fiddly.
  // Older /<id>/<slug> links still resolve — the router reads the digits.
  if (location.pathname !== path(String(id))) {
    history.replaceState({}, '', path(String(id)));
  }

  // Paint the frame immediately from the in-memory index, then fill the body.
  app.innerHTML = `
    <header class="top">
      <a class="ico" data-nav href="${BASE}" aria-label="All songs"><svg viewBox="0 0 24 24">${ICONS.back}</svg></a>
      <div class="name">${esc(meta.title)}<small>${esc(meta.lang)}${meta.refs.length ? ' · ' + esc(store.bookName(meta.refs[0][0])) + ' ' + esc(meta.refs[0][1]) : ''}</small></div>
      <button class="ico" data-act="settings" aria-label="Settings"><svg viewBox="0 0 24 24">${ICONS.gear}</svg></button>
    </header>
    <div class="song" id="song"></div>
    <div class="dock" id="dock"></div>
    <div class="sheet" id="sheet" hidden></div>`;

  const [body, local] = await Promise.all([store.lyrics(id), store.getLocal(id)]);
  if (!body) { $('#song').innerHTML = `<div class="empty">This song hasn’t downloaded yet.</div>`; return; }

  current = {
    meta, local: local || {},
    lyrics: body.text, edited: body.edited,
    steps: (local && local.steps) || 0,
    capo: (local && local.capo) || 0,
  };
  paintSong();
}

/** Chords as written = original + transpose − capo. Sounding key = original + transpose. */
function shownSteps() { return current.steps - current.capo; }

function paintSong() {
  const { meta } = current;
  const groove = G.normalize(current.local.groove);
  const sounding = meta.key ? transposeKey(meta.key, current.steps, meta.flat ? 'flat' : 'sharp') : null;
  const played = meta.key ? transposeKey(meta.key, shownSteps(), meta.flat ? 'flat' : 'sharp') : null;

  const bits = [];
  if (meta.refs.length) bits.push(meta.refs.map((r) => `<b>${esc(store.bookName(r[0]))} ${esc(r[1])}</b>`).join(' · '));
  bits.push(esc(meta.lang));
  if (sounding) {
    bits.push(current.capo
      ? `Key <b>${esc(sounding)}</b> · capo ${current.capo} · play <b>${esc(played)}</b> shapes`
      : `Key <b>${esc(sounding)}</b>`);
  }
  if (current.edited) bits.push('<b>your edit</b>');

  $('#song').innerHTML = `
    <div class="songhead">
      <h1>${esc(meta.title)}</h1>
      <div class="meta">${bits.map((b) => `<span>${b}</span>`).join('')}</div>
    </div>
    ${grooveBarHtml(groove)}
    <div class="lyrics" id="lyrics"></div>`;

  paintDock();
  paintLyrics();
  wireGrooveBar();
  syncMetronome();
}

function paintLyrics() {
  const el = $('#lyrics');
  if (!el) return;
  const song = document.querySelector('.song');

  el.innerHTML = renderSong(current.lyrics, {
    steps: shownSteps(),
    flat: current.meta.flat,
    showChords: prefs.chords,
  });
  el.classList.toggle('nochords', !prefs.chords);

  if (prefs.fit) layoutFit(el, song);
  else layoutNormal(el, song);

  syncAutoscrollButton();
}

/** The reading layout: a comfortable measure, widened to columns when long. */
function layoutNormal(el, song) {
  document.documentElement.classList.remove('locked');
  song.classList.remove('fit');
  el.classList.remove('cols', 'ruled');
  el.style.setProperty('--lyric-size', prefs.size + 'px');
  song.style.setProperty('--measure', '720px');

  let cols = prefs.cols === 'on';
  if (prefs.cols === 'auto' && viewportW() >= 860) {
    const room = viewportH() - el.getBoundingClientRect().top - 84;
    cols = el.scrollHeight > room;
  }
  if (cols && viewportW() >= 860) {
    el.classList.add('cols');
    el.style.setProperty('--cols', '2');
    song.style.setProperty('--measure', '1160px');
  }
}

/**
 * Fit the whole song on one screen.
 *
 * Nobody should have to stand at a laptop scrolling while a room sings, so we
 * search for the layout that shows the entire song at the largest readable
 * type: try each sensible column count and binary-search the biggest font size
 * that still fits the available height. More columns are only worth taking if
 * they buy bigger text.
 */
// On phones the URL bar hides and shows, changing innerHeight mid-scroll.
// visualViewport is the honest number for "how much can the reader see".
const viewportH = () => Math.round(window.visualViewport?.height || window.innerHeight);
const viewportW = () => Math.round(window.visualViewport?.width || window.innerWidth);

let lastFitSize = 22;   // a warm starting guess makes the common case 2 probes

// Reading a laid-out height costs a synchronous reflow (~15ms), which is the
// entire cost of opening a song — the data read and render together are under
// 4ms. Remembering what fitted last time turns a revisit into a single probe.
const fitCache = new Map();
const fitKey = () => `${current.meta.id}:${viewportW()}x${viewportH()}` +
  `:${prefs.chords ? 1 : 0}:${shownSteps()}`;

/**
 * Width the lyrics should occupy for a given column count.
 *
 * Filling the whole screen is only right when there are columns to fill it
 * with. A single column stretched across a wide display leaves short lines
 * hugging the left edge with most of the screen empty, so the box is capped to
 * a sensible measure per column and centred.
 */
function setWidth(song, cols, chorded) {
  const per = chorded ? 660 : 560;
  const wanted = cols * per + (cols - 1) * 44;
  const avail = viewportW() - 32;
  song.style.setProperty('--measure', Math.min(wanted, avail) + 'px');
}

function layoutFit(el, song) {
  song.classList.add('fit');
  el.classList.add('cols');

  const MIN = 13, MAX = 46;

  // Measure from a fixed baseline. Fitting leaves the page scroll-locked and
  // padded; measuring the next fit in that state gives a slightly different
  // answer, so repeated relayouts ratcheted the type down a pixel at a time
  // and never recovered. Undo the previous outcome before measuring the next.
  document.documentElement.classList.remove('locked');
  song.style.paddingBottom = '0px';

  // Measure the dock rather than assuming its height, or the page ends up a
  // few pixels too tall and shows a scrollbar in a layout meant to fit exactly.
  window.scrollTo(0, 0);
  const dock = document.querySelector('.dock');
  const dockH = dock ? Math.ceil(dock.getBoundingClientRect().height) : 0;
  const avail = () => viewportH() - Math.ceil(el.getBoundingClientRect().top) - dockH - 10;

  // Chord lines are long, and a column too narrow to hold one wraps it — which
  // is the exact ugliness this layout exists to avoid. Give chorded songs a
  // much wider minimum column than plain lyrics.
  const chorded = !!el.querySelector('.ln.chorded');
  const minCol = chorded ? 430 : 300;
  const maxCols = Math.max(1, Math.min(3, Math.floor((viewportW() - 32) / minCol)));

  // Reading a laid-out height forces a synchronous reflow (~14ms on a full
  // song), so binary-searching every size would cost hundreds of milliseconds.
  // Height is close to linear in font size, so predict and correct instead.
  const clamp = (n) => Math.max(MIN, Math.min(MAX, Math.floor(n)));
  const apply = (cols, size) => {
    el.style.setProperty('--cols', String(cols));
    el.style.setProperty('--lyric-size', size + 'px');
  };

  // How far down the content actually reaches. A stanza that cannot be split
  // can hang below its column without scrollHeight ever reporting it.
  const contentHeight = () => {
    const top = el.getBoundingClientRect().top;
    let deepest = 0;
    for (const st of el.children) {
      const b = st.getBoundingClientRect().bottom - top;
      if (b > deepest) deepest = b;
    }
    return Math.max(el.scrollHeight, deepest);
  };

  // Content that will not fit also spills sideways into extra columns.
  const overflows = (room) => el.scrollWidth > el.clientWidth + 1 || contentHeight() > room + 1;

  const room = avail();
  const key = fitKey();
  const cached = fitCache.get(key);

  if (cached) {
    setWidth(song, cached.cols, chorded);
    apply(cached.cols, cached.size);
    if (!overflows(room)) {
      el.classList.toggle('ruled', cached.cols > 1);
      el.dataset.overflowing = String(cached.over);
      document.documentElement.classList.toggle('locked', !cached.over);
      song.style.paddingBottom = cached.over ? `${dockH + 28}px` : '0px';
      return;
    }
    fitCache.delete(key);
  }

  // Largest size that fits for a given column count. Height is close to linear
  // in font size, so predict and correct rather than stepping one pixel at a
  // time — stepping meant a song could never climb far from where the previous
  // one happened to land.
  const converge = (c) => {
    let sz = clamp(lastFitSize);
    apply(c, sz);
    for (let i = 0; i < 5; i++) {
      const h = contentHeight();
      if (h <= 0) break;
      const next = clamp(sz * room / h);
      if (next === sz) break;
      sz = next;
      apply(c, sz);
    }
    for (let i = 0; i < 8 && sz > MIN && overflows(room); i++) { sz -= 1; apply(c, sz); }
    for (let i = 0; i < 8 && sz < MAX; i++) {
      apply(c, sz + 1);
      if (overflows(room)) { apply(c, sz); break; }
      sz += 1;
    }
    return sz;
  };

  setWidth(song, maxCols, chorded);
  let cols = maxCols;
  let size = converge(cols);

  // Prefer the fewest columns that still holds this size — less eye travel.
  while (cols > 1) {
    setWidth(song, cols - 1, chorded);
    apply(cols - 1, size);
    if (overflows(room)) { setWidth(song, cols, chorded); apply(cols, size); break; }
    cols -= 1;
  }

  // Still too tall at a comfortable measure? Longer lines are a better trade
  // than making someone scroll mid-song, so spend the rest of the width.
  if (overflows(room) && maxCols * (chorded ? 660 : 560) < viewportW() - 32) {
    cols = maxCols;
    song.style.setProperty('--measure', (viewportW() - 32) + 'px');
    size = converge(cols);
  }

  lastFitSize = size;
  el.classList.toggle('ruled', cols > 1);

  // If even the smallest readable type won't fit, the song is genuinely longer
  // than this screen. Let it scroll rather than shrink past legibility — and
  // never lock scrolling in that case, which would simply cut the song off.
  const stillOver = overflows(avail());
  el.dataset.overflowing = String(stillOver);
  document.documentElement.classList.toggle('locked', !stillOver);

  // A song too long for the screen even at minimum size has to scroll. Without
  // room under it the last lines sit behind the fixed dock and the scrollbar
  // covers a useless 20-odd pixels; with it, the scroll actually reaches the
  // end of the song.
  song.style.paddingBottom = stillOver ? `${dockH + 28}px` : '0px';

  if (fitCache.size > 200) fitCache.clear();
  fitCache.set(key, { cols, size, over: stillOver });
}

// ------------------------------------------------------------- groove UI

function grooveBarHtml(g) {
  if (G.isEmpty(g)) {
    // While playing, an empty "No rhythm noted yet" bar is 54px of nothing.
    // The dock keeps the button, so the space goes to the song instead.
    if (prefs.fit) return '';
    return `<div class="groove"><span class="g" style="color:var(--ink-3)">No rhythm noted yet</span>
      <span class="spacer"></span>
      <button class="btn quiet" data-act="groove" style="flex:none;min-height:34px;padding:0 12px">Add one</button></div>`;
  }
  const strum = G.parseStrum(g.strum);
  const parts = [];
  if (g.meter) parts.push(`<span class="g"><b>${esc(g.meter)}</b></span>`);
  if (g.bpm) parts.push(`<span class="g"><b>${g.bpm}</b> bpm</span>`);
  if (g.feel) parts.push(`<span class="g">${esc(G.FEELS[g.feel])}</span>`);
  if (strum) {
    parts.push(`<span class="strum">${strum.map((t) =>
      t.gap ? '<span class="gap"></span>'
        : t.rest ? '<i class="rest">·</i>'
          : `<i class="${t.muted ? 'muted' : ''}">${t.dir === 'down' ? '↓' : '↑'}</i>`).join('')}</span>`);
  }
  if (g.note) parts.push(`<span class="g" style="color:var(--ink-3)">${esc(g.note)}</span>`);

  const beats = g.bpm ? `<span class="beats" id="beats">${Array.from({ length: G.beatsPerBar(g.meter) },
    () => '<span></span>').join('')}</span>` : '';

  return `<div class="groove">
    <span class="src mine">yours</span>
    ${parts.join('<span class="sep"></span>')}
    <span class="spacer"></span>
    ${beats}
    ${g.bpm ? `<button class="play" data-act="metro" aria-pressed="false"><svg viewBox="0 0 24 24">${ICONS.play}</svg> Count in</button>` : ''}
    <button class="ico" data-act="groove" aria-label="Edit rhythm"><svg viewBox="0 0 24 24">${ICONS.edit}</svg></button>
  </div>`;
}

function wireGrooveBar() {
  const bar = $('.groove');
  if (!bar) return;
  bar.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'groove') openGrooveSheet();
    if (btn.dataset.act === 'metro') toggleMetronome();
  };
}

/**
 * Point the running metronome at the elements currently on screen.
 *
 * Saving the rhythm repaints the whole song view, which replaced the beat dots
 * and the button while the click carried on playing — the control vanished
 * mid-count. The metronome now outlives the markup and is simply re-attached.
 */
function syncMetronome() {
  const btn = document.querySelector('[data-act="metro"]');
  const dots = [...document.querySelectorAll('#beats span')];

  if (!metro.running) {
    metro.onBeat = null;
    if (btn) {
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.play}</svg> Count in`;
    }
    return;
  }

  // The rhythm may have been edited down to nothing while it was playing.
  if (!btn) { metro.stop(); metro.onBeat = null; return; }

  metro.onBeat = ({ inBar, counting }) => {
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('on', i === inBar);
      dots[i].classList.toggle('counting', counting);
    }
  };
  btn.setAttribute('aria-pressed', 'true');
  btn.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.stop}</svg> Stop`;
}

function toggleMetronome() {
  if (metro.running) {
    metro.stop();
    document.querySelectorAll('#beats span').forEach((d) => d.classList.remove('on', 'counting'));
  } else {
    const g = G.normalize(current.local.groove);
    if (!g.bpm || !metro.start(g.bpm, g.meter)) return;
  }
  syncMetronome();
}

// ----------------------------------------------------------------- dock

function paintDock() {
  const d = $('#dock');
  if (!d) return;
  const { meta } = current;
  const key = meta.key ? transposeKey(meta.key, shownSteps(), meta.flat ? 'flat' : 'sharp') : null;

  // Transpose and capo only mean something when the song actually has chords.
  const tuning = meta.key ? `
    <div class="stepper">
      <button data-act="tr-" aria-label="Transpose down">−</button>
      <span class="val">${esc(key)}<small>${current.capo ? 'shapes' : 'key'}</small></span>
      <button data-act="tr+" aria-label="Transpose up">+</button>
    </div>
    <div class="stepper">
      <button data-act="capo-" aria-label="Capo down">−</button>
      <span class="val">${current.capo || '—'}<small>capo</small></span>
      <button data-act="capo+" aria-label="Capo up">+</button>
    </div>` : '';

  d.innerHTML = `<div class="dockrow">
    ${tuning}
    <span class="spacer"></span>
    ${meta.key ? `<button class="ico" data-act="chords" aria-pressed="${prefs.chords}" aria-label="Show chords"><svg viewBox="0 0 24 24">${ICONS.music}</svg></button>` : ''}
    <button class="ico" data-act="autoscroll" aria-pressed="${!!autoscroll}"
      ${canScroll() ? '' : 'disabled aria-disabled="true"'}
      aria-label="${canScroll() ? 'Auto-scroll' : 'Auto-scroll (the whole song is already on screen)'}"><svg viewBox="0 0 24 24">${ICONS.scroll}</svg></button>
    <span class="secondary">
      <button class="ico" data-act="tempo" aria-label="Rhythm"><svg viewBox="0 0 24 24">${ICONS.tempo}</svg></button>
      <button class="ico" data-act="fit" aria-pressed="${prefs.fit}" aria-label="Fit song to screen"><svg viewBox="0 0 24 24">${ICONS.fit}</svg></button>
      <button class="ico" data-act="size" aria-label="Text size"><svg viewBox="0 0 24 24">${ICONS.type}</svg></button>
      <button class="ico" data-act="editchords" aria-label="Adjust chords"><svg viewBox="0 0 24 24">${ICONS.edit}</svg></button>
    </span>
    <button class="ico more" data-act="more" aria-label="More"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none">${ICONS.more}</svg></button>
  </div>`;

  d.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b) handleDockAction(b.dataset.act);
  };
}

async function handleDockAction(act) {
  {
    if (act === 'tr+' || act === 'tr-') {
      current.steps = Math.max(-11, Math.min(11, current.steps + (act === 'tr+' ? 1 : -1)));
      await store.setLocal(current.meta.id, { steps: current.steps || null });
      paintSong();
    } else if (act === 'capo+' || act === 'capo-') {
      current.capo = Math.max(0, Math.min(11, current.capo + (act === 'capo+' ? 1 : -1)));
      await store.setLocal(current.meta.id, { capo: current.capo || null });
      paintSong();
    } else if (act === 'chords') {
      prefs = await store.setPrefs({ chords: !prefs.chords });
      paintDock(); paintLyrics();
    } else if (act === 'tempo') {
      openGrooveSheet();
    } else if (act === 'fit') {
      prefs = await store.setPrefs({ fit: !prefs.fit });
      // Repaint the whole view: whether the heading and an empty rhythm bar
      // are shown depends on the mode, and only paintSong rebuilds those.
      paintSong();
    } else if (act === 'size') {
      openSizeSheet();
    } else if (act === 'autoscroll') {
      if (!canScroll()) return;
      autoscroll ? stopAutoscroll() : startAutoscroll();
      paintDock();
    } else if (act === 'editchords') {
      openEditSheet();
    } else if (act === 'more') {
      openMoreSheet();
    }
  }
}

/** The controls folded away on a narrow screen, where the dock has no room. */
function openMoreSheet() {
  const items = [
    ['tempo', 'Rhythm', 'tempo'],
    ['fit', prefs.fit ? 'Fit to screen: on' : 'Fit to screen: off', 'fit'],
    ['size', 'Text size and scrolling', 'type'],
    ['editchords', 'Adjust the chords', 'edit'],
  ];
  openSheet(`
    <h2>Song options</h2>
    <div class="menu">
      ${items.map(([act, label, ic]) => `
        <button class="menuitem" data-act="${act}">
          <span class="ico"><svg viewBox="0 0 24 24">${ICONS[ic]}</svg></span>
          <span>${label}</span>
        </button>`).join('')}
    </div>
    <div class="actions"><button class="btn" data-act="close">Close</button></div>`,
    (s) => {
      s.onclick = (e) => {
        if (e.target === s) return closeSheet();
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeSheet();
        if (b.dataset.act !== 'close') handleDockAction(b.dataset.act);
      };
    });
}

/** Is there anything to scroll? Fit mode usually leaves nothing. */
function canScroll() {
  return document.documentElement.scrollHeight - document.documentElement.clientHeight > 4;
}

/**
 * The dock is built before the lyrics are laid out, so whether the song
 * scrolls is not known yet at that point. Settle the control afterwards.
 */
function syncAutoscrollButton() {
  const b = document.querySelector('[data-act="autoscroll"]');
  if (!b) return;
  const ok = canScroll();
  b.toggleAttribute('disabled', !ok);
  b.setAttribute('aria-disabled', String(!ok));
  b.setAttribute('aria-label', ok ? 'Auto-scroll' : 'Auto-scroll (the whole song is already on screen)');
  if (!ok && autoscroll) { stopAutoscroll(); b.setAttribute('aria-pressed', 'false'); }
}

// ----------------------------------------------------------- autoscroll

function startAutoscroll() {
  let last = performance.now(), acc = 0;
  const step = (now) => {
    if (!autoscroll) return;
    // Read the speed each frame so changing it applies without restarting.
    const speed = prefs.scroll || 22;   // pixels per second
    acc += (now - last) * speed / 1000;
    last = now;
    if (acc >= 1) { window.scrollBy(0, Math.floor(acc)); acc -= Math.floor(acc); }
    if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 2) return stopAutoscroll();
    autoscroll = requestAnimationFrame(step);
  };
  autoscroll = requestAnimationFrame(step);
}

function stopAutoscroll() {
  if (autoscroll) cancelAnimationFrame(autoscroll);
  autoscroll = null;
  const b = document.querySelector('[data-act="autoscroll"]');
  if (b) b.setAttribute('aria-pressed', 'false');
}

// --------------------------------------------------------------- sheets

function openSheet(html, wire) {
  const s = $('#sheet');
  s.innerHTML = `<div class="sheetbody"><div class="grabber"></div>${html}</div>`;
  s.hidden = false;
  s.onclick = (e) => { if (e.target === s) closeSheet(); };
  if (wire) wire(s);
}
function closeSheet() { const s = $('#sheet'); if (s) { s.hidden = true; s.innerHTML = ''; } }

/** Describe a scroll speed in something more useful than pixels per second. */
function speedLabel(px) {
  const lines = (px / 26).toFixed(1);   // ~26px per lyric line at default size
  return `${lines} lines/s`;
}

function openSizeSheet() {
  openSheet(`
    <h2>Text size</h2>
    <div class="opts">${[15, 17, 19, 22, 26, 30].map((n) =>
      `<button class="opt" data-size="${n}" aria-pressed="${prefs.size === n}" style="font-size:${Math.min(n, 22)}px">${n}</button>`).join('')}</div>
    <h3>Columns on wide screens</h3>
    <div class="opts">${[['auto', 'Automatic'], ['on', 'Always'], ['off', 'Never']].map(([v, l]) =>
      `<button class="opt" data-cols="${v}" aria-pressed="${prefs.cols === v}">${l}</button>`).join('')}</div>
    <h3>Auto-scroll speed</h3>
    <div class="speed">
      <input id="speed" type="range" min="4" max="90" step="1" value="${prefs.scroll || 22}"
             aria-label="Auto-scroll speed">
      <span class="val" id="speedval">${speedLabel(prefs.scroll || 22)}</span>
    </div>
    <div class="hint" style="font-size:12px;color:var(--ink-3);margin-top:6px">
      Adjusts while scrolling — no need to stop and restart.</div>
    <div class="actions"><button class="btn" data-act="close">Done</button></div>`,
    (s) => {
      const slider = $('#speed', s);
      slider.addEventListener('input', async () => {
        const v = Number(slider.value);
        $('#speedval', s).textContent = speedLabel(v);
        prefs = await store.setPrefs({ scroll: v });
      });
      s.onclick = async (e) => {
        if (e.target === s) return closeSheet();
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.act === 'close') return closeSheet();
        if (b.dataset.size) prefs = await store.setPrefs({ size: Number(b.dataset.size) });
        if (b.dataset.cols) prefs = await store.setPrefs({ cols: b.dataset.cols });
        openSizeSheet();
        paintLyrics();
      };
    });
}

function openGrooveSheet() {
  const g = G.normalize(current.local.groove);
  openSheet(`
    <h2>How it goes</h2>
    <p style="font-size:13.5px;color:var(--ink-3);margin:-6px 0 16px">Saved on this device only. Nothing is sent anywhere.</p>

    <div class="pair">
      <div>
        <h3>Time</h3>
        <div class="opts">${G.METERS.map((m) =>
          `<button class="opt" data-meter="${m}" aria-pressed="${g.meter === m}">${m}</button>`).join('')}</div>
      </div>
      <div>
        <h3>Feel</h3>
        <div class="opts">${Object.entries(G.FEELS).map(([v, l]) =>
          `<button class="opt" data-feel="${v}" aria-pressed="${g.feel === v}">${l}</button>`).join('')}</div>
      </div>
    </div>

    <div class="pair">
      <div class="field">
        <label for="bpm">Tempo</label>
        <div style="display:flex;gap:8px">
          <input id="bpm" type="number" min="30" max="260" inputmode="numeric" value="${g.bpm || ''}" placeholder="e.g. 92" style="flex:1 1 auto;min-width:0">
          <button class="btn" data-act="tap" style="flex:0 0 92px">Tap it</button>
        </div>
        <div class="hint" id="taphint">Tap along with the song.</div>
      </div>

      <div class="field">
        <label for="strum">Strum pattern</label>
        <input id="strum" type="text" value="${esc(g.strum || '')}" placeholder="D DU UDU" autocomplete="off" spellcheck="false">
        <div class="hint"><b>D</b> down · <b>U</b> up · <b>x</b> muted · <b>-</b> rest</div>
      </div>
    </div>

    <div class="field">
      <label for="note">Note for whoever plays this</label>
      <input id="note" type="text" value="${esc(g.note || '')}" placeholder="Starts quiet, builds on the last verse" maxlength="140">
    </div>

    <div class="actions">
      <button class="btn quiet" data-act="clear">Clear</button>
      <button class="btn primary" data-act="save">Save</button>
    </div>`,
    (s) => {
      let draft = { ...g };
      s.onclick = async (e) => {
        if (e.target === s) return closeSheet();
        const b = e.target.closest('button');
        if (!b) return;

        if (b.dataset.meter) { draft.meter = draft.meter === b.dataset.meter ? null : b.dataset.meter; refresh(); }
        else if (b.dataset.feel) { draft.feel = draft.feel === b.dataset.feel ? null : b.dataset.feel; refresh(); }
        else if (b.dataset.act === 'tap') {
          const bpm = tapper.tap();
          const hint = $('#taphint', s);
          if (bpm) { $('#bpm', s).value = bpm; hint.textContent = `${bpm} bpm — keep tapping to refine.`; }
          else hint.textContent = 'Keep tapping…';
        } else if (b.dataset.act === 'clear') {
          tapper.reset();
          await store.setLocal(current.meta.id, { groove: null });
          current.local = await store.getLocal(current.meta.id) || {};
          metro.stop();
          closeSheet(); paintSong();
        } else if (b.dataset.act === 'save') {
          const next = G.normalize({
            ...draft,
            bpm: $('#bpm', s).value,
            strum: $('#strum', s).value,
            note: $('#note', s).value,
          });
          tapper.reset();
          await store.setLocal(current.meta.id, { groove: G.isEmpty(next) ? null : next });
          current.local = await store.getLocal(current.meta.id) || {};
          if (metro.running) {
            if (next.bpm) metro.setTempo(next.bpm, next.meter || '4/4');
            else metro.stop();
          }
          closeSheet(); paintSong();
        }
      };
      function refresh() {
        s.querySelectorAll('[data-meter]').forEach((b) => b.setAttribute('aria-pressed', String(draft.meter === b.dataset.meter)));
        s.querySelectorAll('[data-feel]').forEach((b) => b.setAttribute('aria-pressed', String(draft.feel === b.dataset.feel)));
      }
    });
}

function openEditSheet() {
  openSheet(`
    <h2>Adjust the chords</h2>
    <p style="font-size:13.5px;color:var(--ink-3);margin:-6px 0 14px">
      Move a chord by moving its <code>[G]</code> next to the syllable it lands on.
      Your version stays on this device and replaces the original for you only.</p>
    <div class="field">
      <textarea id="src" spellcheck="false" autocomplete="off">${esc(current.lyrics)}</textarea>
    </div>
    <div class="actions">
      ${current.edited ? '<button class="btn quiet" data-act="revert">Revert to original</button>' : ''}
      <button class="btn primary" data-act="save">Save</button>
    </div>`,
    (s) => {
      s.onclick = async (e) => {
        if (e.target === s) return closeSheet();
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.act === 'revert') {
          await store.setLocal(current.meta.id, { lyrics: null });
          closeSheet();
          renderSongView(current.meta.id);
        } else if (b.dataset.act === 'save') {
          const text = $('#src', s).value;
          await store.setLocal(current.meta.id, { lyrics: text });
          closeSheet();
          renderSongView(current.meta.id);
        }
      };
    });
}

// --------------------------------------------------------------- settings

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="settings"]');
  if (b) openSettings();
});

function openSettings() {
  openSheetGlobal(`
    <h2>Settings</h2>
    <h3>Appearance</h3>
    <div class="opts">${[['', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
      `<button class="opt" data-theme="${v}" aria-pressed="${(prefs.theme || '') === v}">${l}</button>`).join('')}</div>
    <h3>Offline</h3>
    <p style="font-size:13.5px;color:var(--ink-2);margin:0">
      ${store.index.ids.length.toLocaleString()} songs in ${store.index.langCodes.length} languages are stored on this
      device, so the app works with no connection and never waits on a server to open a song.</p>
    <div class="credit">
      Built by <a href="https://github.com/H-717" target="_blank" rel="noopener">H-717</a>
    </div>
    <div class="actions"><button class="btn" data-act="close">Done</button></div>`,
    (s) => {
      s.onclick = async (e) => {
        if (e.target === s) return closeSheetGlobal();
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.act === 'close') return closeSheetGlobal();
        if (b.dataset.theme !== undefined) {
          prefs = await store.setPrefs({ theme: b.dataset.theme || null });
          applyTheme();
          openSettings();
        }
      };
    });
}

// The list view has no #sheet element, so settings gets its own host.
function openSheetGlobal(html, wire) {
  let s = $('#gsheet');
  if (!s) {
    s = document.createElement('div');
    s.id = 'gsheet';
    s.className = 'sheet';
    document.body.appendChild(s);
  }
  s.innerHTML = `<div class="sheetbody"><div class="grabber"></div>${html}</div>`;
  s.hidden = false;
  if (wire) wire(s);
}
function closeSheetGlobal() { const s = $('#gsheet'); if (s) { s.hidden = true; s.innerHTML = ''; } }

let relayoutTimer = null, lastVW = 0, lastVH = 0;

function scheduleRelayout() {
  lastVW = viewportW(); lastVH = viewportH();
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => { if (current && $('#lyrics')) paintLyrics(); }, 120);
}

// The mobile URL bar sliding away reports here as a height-only change. That
// is not a layout change worth re-fitting for; a real resize always is.
function onVisualViewportResize() {
  const w = viewportW(), h = viewportH();
  if (w === lastVW && Math.abs(h - lastVH) < 120) return;
  scheduleRelayout();
}

window.addEventListener('resize', scheduleRelayout);
window.addEventListener('orientationchange', scheduleRelayout);
window.visualViewport?.addEventListener('resize', onVisualViewportResize);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); closeSheetGlobal(); }
});
