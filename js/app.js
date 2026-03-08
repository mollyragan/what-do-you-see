// app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';


/* =========================================================
   SUPABASE
   ========================================================= */

const supabaseUrl = 'https://fyogbaeayboxjhleaqoj.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5b2diYWVheWJveGpobGVhcW9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczOTMxNDcsImV4cCI6MjA4Mjk2OTE0N30.JGa6qT6IkcNCJRxV5FYDFUiH1QWSKHABJ_Qu7BNV5m8';
const supabase = createClient(supabaseUrl, supabaseKey);


/* =========================================================
   STATE
   ========================================================= */

// Images + navigation
let images       = [];
let currentIndex = 0;
let preloadImg   = new Image();
let nextDeck     = [];
let historyStack = [];
let forwardStack = [];
let lastLoadToken = 0;

// Tag display
let tagOverlay    = null;
let tagElements   = [];
let showAllTags   = false;
let allTagsPinned = false;
let suppressAllTagRender  = false;
let holdSessionTagsVisible = false;

// Session tags: tags added during this browser session, keyed by imageId
// Stored as [{ tag, x, y }] where x/y are relative (0–1) to the image wrapper
let sessionTagsByImageId = new Map();

// Gallery
let selectedGalleryTags = new Set();
let galleryOrderIds     = null;
let pendingGalleryScrollTop = null;
let galleryScrollRAF        = 0;

// Interaction guards
let suppressNextTagOpen = false;
let lastPinchTime       = 0;

// Tag index: lightweight per-image tag sets (no positions), used for gallery
// filtering and counts. Populated by loadTagIndexAndCounts() on load.
const tagSetByImageId  = new Map(); // imageId -> Set<tag>
const globalTagCounts  = new Map(); // tag -> count of images containing it
const tagSetKnownLoaded = new Set(); // imageIds whose tag sets have been confirmed loaded

// Full tag cache: per-image arrays including x/y positions, fetched lazily
// when the user hovers or clicks the tag-toggle icon.
const fullTagsByImageId = new Map(); // imageId -> [{ id, tag, x, y, tagger_id }]

// Default to tagging view on first-ever load
if (!localStorage.getItem('activeView')) {
  localStorage.setItem('activeView', 'tagging');
}


/* =========================================================
   TAGGER ID
   Persistent anonymous ID stored in localStorage, used to
   attribute tags to a specific browser/device.
   ========================================================= */

const TAGGER_KEY = 'wdys:tagger_id';

function safeLSGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function safeLSSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

function makeClientId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();

  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  return `mbr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getTaggerId() {
  let id = safeLSGet(TAGGER_KEY);
  if (!id) {
    id = makeClientId();
    safeLSSet(TAGGER_KEY, id);
  }
  return id;
}


/* =========================================================
   DOM REFERENCES
   ========================================================= */

const mainImage = document.getElementById('main-image');
mainImage.decoding = 'async';
mainImage.loading  = 'eager';
mainImage.setAttribute('fetchpriority', 'high');

const taggingView  = document.getElementById('tagging-view');
const galleryView  = document.getElementById('gallery-view');
const imageWrapper = document.getElementById('image-wrapper');
const galleryGrid  = document.getElementById('gallery-grid');
const galleryTagList = document.getElementById('gallery-tag-list');
const tagToggleIcon  = document.getElementById('tag-toggle-icon');
const nextBtn        = document.getElementById('nextBtn');
const prevBtn        = document.getElementById('prevBtn');
const galleryBtn     = document.getElementById('galleryBtn');
const clearBtn       = document.getElementById('clearBtn');
const questionBtn    = document.getElementById('questionBtn');
const questionPopover = document.getElementById('question-popover');


/* =========================================================
   IMAGE URL HELPERS
   Supabase storage URLs are transformed via the render API
   to resize/compress images for faster loading.
   ========================================================= */

function supaThumb(url, w = 280, h = 373, q = 60) {
  return url
    .replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
    + `?width=${w}&height=${h}&quality=${q}&resize=cover`;
}

function supaFull(url, w = 900, q = 75) {
  return url
    .replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
    + `?width=${w}&quality=${q}`;
}

// Chooses width based on the actual wrapper size and device pixel ratio,
// capped at 2x DPR and 1400px to avoid unnecessarily large downloads.
function supaFullSmart(url, quality = 100) {
  const wrapW  = imageWrapper?.clientWidth || 520;
  const dpr    = Math.min(2, window.devicePixelRatio || 1);
  const w      = Math.max(600, Math.min(1400, Math.ceil(wrapW * dpr)));
  return supaFull(url, w, quality);
}


/* =========================================================
   LOCAL STORAGE — APP STATE
   Saves and restores the current view, image, filters, and
   gallery scroll position across page loads.
   ========================================================= */

const LS_STATE_KEY = 'wdys:lastState';

function saveLastStateToLocalStorage() {
  try { localStorage.setItem(LS_STATE_KEY, JSON.stringify(getAppStateSnapshot())); } catch {}
}

function loadLastStateFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}


/* =========================================================
   BROWSER HISTORY
   pushSnapshot / replaceSnapshot write the current app state
   into the browser history so back/forward navigation works.
   ========================================================= */

let suppressHistory = false;

function getAppStateSnapshot() {
  return {
    v:  galleryView.classList.contains('hidden') ? 'tagging' : 'gallery',
    i:  images[currentIndex]?.id ?? null,
    t:  [...selectedGalleryTags],
    c:  galleryZoom?.cols ?? null,
    go: getCurrentGalleryOrderIds(),
    gs: galleryGrid ? galleryGrid.scrollTop : 0,
  };
}

function applyAppStateSnapshot(st) {
  if (!st) return;

  selectedGalleryTags = new Set(Array.isArray(st.t) ? st.t : []);
  if (typeof st.c === 'number') setGalleryCols(st.c);
  galleryOrderIds = Array.isArray(st.go) ? st.go : null;

  if (st.v === 'gallery') {
    showGallery({ fromHistory: true, keepFilters: true, keepCols: true, restoreScrollTop: st.gs ?? 0 });
    saveLastStateToLocalStorage();
    return;
  }

  if (st.i != null && images.length) {
    const idx = images.findIndex(im => String(im.id) === String(st.i));
    if (idx !== -1) currentIndex = idx;
  }

  showTagging({ fromHistory: true });
  showImage();
  saveLastStateToLocalStorage();
}

function pushSnapshot() {
  if (suppressHistory) return;
  const st = getAppStateSnapshot();
  history.pushState(st, '', location.pathname + location.search);
  saveLastStateToLocalStorage();
}

function replaceSnapshot() {
  if (suppressHistory) return;
  const st = getAppStateSnapshot();
  history.replaceState(st, '', location.pathname + location.search);
  saveLastStateToLocalStorage();
}

window.addEventListener('popstate', (e) => {
  suppressHistory = true;
  applyAppStateSnapshot(e.state);
  suppressHistory = false;
});


/* =========================================================
   GALLERY ZOOM
   Pinch-to-zoom and ctrl+scroll change the number of columns.
   ========================================================= */

const galleryZoom = {
  cols: 3,
  minCols: 1,
  maxCols: 10,
  pointers: new Map(),
  startDist: 0,
  startCols: 3,
};

function isDesktop() { return window.innerWidth >= 900; }

function setGalleryCols(n) {
  galleryZoom.cols = Math.max(galleryZoom.minCols, Math.min(galleryZoom.maxCols, n));
  document.documentElement.style.setProperty('--gallery-cols', String(galleryZoom.cols));
}

function colsForFilteredCount(count) {
  const n = Math.max(0, count || 0);

  if (!isDesktop()) {
    if (n <= 1)  return 1;
    if (n <= 10) return 2;
    if (n <= 15) return 3;
    if (n <= 20) return 4;
    return 5;
  }

  if (n <= 1)  return 1;
  if (n <= 5)  return 2;
  if (n <= 10) return 3;
  if (n <= 15) return 4;
  if (n <= 40) return 5;
  if (n <= 70) return 6;
  return 10;
}

function setColsForImageCount(count) { setGalleryCols(colsForFilteredCount(count)); }

function initGalleryCols() {
  const w = window.innerWidth;
  if (w < 900) setGalleryCols(5);
  else         setGalleryCols(10);
}

initGalleryCols();

window.addEventListener('resize', () => {
  if (selectedGalleryTags.size > 0) setColsForImageCount(getFilteredImages().length);
  else initGalleryCols();
});

window.addEventListener('orientationchange', () => {
  if (selectedGalleryTags.size > 0) setColsForImageCount(getFilteredImages().length);
  else initGalleryCols();
});

// Ctrl+scroll to zoom
if (galleryGrid) {
  let wheelAccumulator = 0;
  const WHEEL_THRESHOLD = 10;

  galleryGrid.addEventListener('wheel', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    if (!e.ctrlKey) return;

    e.preventDefault();
    wheelAccumulator += e.deltaY;
    if (Math.abs(wheelAccumulator) < WHEEL_THRESHOLD) return;

    lastPinchTime = Date.now();
    setGalleryCols(galleryZoom.cols + (wheelAccumulator > 0 ? 1 : -1));
    replaceSnapshot();
    wheelAccumulator = 0;
  }, { passive: false });
}

// Pinch-to-zoom (pointer events)
if (galleryGrid) {
  galleryGrid.addEventListener('pointerdown', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    if (e.pointerType === 'touch') galleryGrid.setPointerCapture(e.pointerId);

    galleryZoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (galleryZoom.pointers.size === 2) {
      const pts = [...galleryZoom.pointers.values()];
      galleryZoom.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      galleryZoom.startCols = galleryZoom.cols;
    }
  });

  galleryGrid.addEventListener('pointermove', (e) => {
    if (!galleryZoom.pointers.has(e.pointerId)) return;
    if (galleryView.classList.contains('hidden')) return;

    galleryZoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (galleryZoom.pointers.size === 2) {
      e.preventDefault();
      const pts  = [...galleryZoom.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const target = Math.round(galleryZoom.startCols / (dist / (galleryZoom.startDist || dist)));
      setGalleryCols(target);
      replaceSnapshot();
      lastPinchTime = Date.now();
    }
  }, { passive: false });

  function endGalleryPointer(e) {
    galleryZoom.pointers.delete(e.pointerId);
    if (galleryZoom.pointers.size < 2) galleryZoom.startDist = 0;
  }
  galleryGrid.addEventListener('pointerup',     endGalleryPointer);
  galleryGrid.addEventListener('pointercancel', endGalleryPointer);

  // Safari gesture events (fallback)
  galleryGrid.addEventListener('gesturestart', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    e.preventDefault();
    galleryZoom._gestureStartCols = galleryZoom.cols;
  }, { passive: false });

  galleryGrid.addEventListener('gesturechange', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    e.preventDefault();
    setGalleryCols(Math.round((galleryZoom._gestureStartCols || galleryZoom.cols) / e.scale));
    replaceSnapshot();
  }, { passive: false });
}


/* =========================================================
   PAN + ZOOM (tagging view)
   Supports mouse wheel zoom, pinch-to-zoom, and drag-to-pan.
   ========================================================= */

let pz = {
  scale: 1, min: 1, max: 6,
  x: 0, y: 0,
  dragging: false, dragMoved: false,
  startX: 0, startY: 0,
  startPanX: 0, startPanY: 0,
  pointers: new Map(),
  startPinchDist: 0, startScale: 1, startMid: null,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function applyTransform() {
  mainImage.style.transform = `translate(${pz.x}px, ${pz.y}px) scale(${pz.scale})`;
}

function clampPan() {
  const wrap  = imageWrapper.getBoundingClientRect();
  const extraW = wrap.width  * (pz.scale - 1);
  const extraH = wrap.height * (pz.scale - 1);
  pz.x = clamp(pz.x, -extraW, 0);
  pz.y = clamp(pz.y, -extraH, 0);
}

function zoomAt(clientX, clientY, newScale) {
  const wrap = imageWrapper.getBoundingClientRect();
  const px = clientX - wrap.left;
  const py = clientY - wrap.top;
  const ix = (px - pz.x) / pz.scale;
  const iy = (py - pz.y) / pz.scale;

  pz.scale = clamp(newScale, pz.min, pz.max);
  pz.x = px - ix * pz.scale;
  pz.y = py - iy * pz.scale;

  clampPan();
  applyTransform();

  if (showAllTags && !suppressAllTagRender) {
    clearTagElements();
    displayAllPlusSessionTags();
  }
}

function wrapperPointToImageRel(clientX, clientY) {
  const wrap = imageWrapper.getBoundingClientRect();
  const px   = clientX - wrap.left;
  const py   = clientY - wrap.top;
  const ix   = (px - pz.x) / pz.scale;
  const iy   = (py - pz.y) / pz.scale;
  return {
    xRel: ix / wrap.width,
    yRel: iy / wrap.height,
    ix, iy, wrap,
  };
}

function resetPanZoom() {
  pz.scale = 1;
  pz.x = 0;
  pz.y = 0;
  applyTransform();
}

function isUIElement(target) {
  return (
    target === tagToggleIcon ||
    target.closest('#tag-toggle-icon') ||
    target.closest('.tag-label') ||
    target.closest('.tag-input')
  );
}

imageWrapper.style.touchAction = 'none';

imageWrapper.addEventListener('pointerdown', (e) => {
  if (tagOverlay && !tagOverlay.contains(e.target)) {
    suppressNextTagOpen = true;
    removeTagOverlay();
    return;
  }
  if (isUIElement(e.target)) return;

  imageWrapper.setPointerCapture(e.pointerId);
  pz.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  pz.dragging   = true;
  pz.dragMoved  = false;
  pz.startX     = e.clientX;
  pz.startY     = e.clientY;
  pz.startPanX  = pz.x;
  pz.startPanY  = pz.y;
  pz._swipeStartX = e.clientX;
  pz._swipeStartY = e.clientY;

  if (pz.pointers.size === 2) {
    const pts = [...pz.pointers.values()];
    pz.startPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pz.startScale = pz.scale;
    pz.startMid   = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
});

imageWrapper.addEventListener('pointermove', (e) => {
  if (!pz.dragging) return;
  if (pz.pointers.has(e.pointerId)) pz.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pz.pointers.size === 2) {
    const pts  = [...pz.pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mid  = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    zoomAt(mid.x, mid.y, pz.startScale * (dist / (pz.startPinchDist || dist)));
    pz.dragMoved = true;
    return;
  }

  const dx = e.clientX - pz.startX;
  const dy = e.clientY - pz.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) pz.dragMoved = true;

  pz.x = pz.startPanX + dx;
  pz.y = pz.startPanY + dy;
  clampPan();
  applyTransform();

  if (showAllTags && !suppressAllTagRender) {
    clearTagElements();
    displayAllPlusSessionTags();
  }
});

imageWrapper.addEventListener('pointerup', (e) => {
  pz.pointers.delete(e.pointerId);

  if (suppressNextTagOpen) {
    suppressNextTagOpen = false;
    pz.dragging  = false;
    pz.dragMoved = false;
    return;
  }

  if (isUIElement(e.target)) {
    if (pz.pointers.size < 2) { pz.startPinchDist = 0; pz.startMid = null; }
    if (pz.pointers.size === 0) pz.dragging = false;
    return;
  }

  // Swipe left/right to navigate images (only when not zoomed)
  if (pz.scale === 1 && pz.pointers.size === 0) {
    const dx = e.clientX - (pz._swipeStartX ?? e.clientX);
    const dy = e.clientY - (pz._swipeStartY ?? e.clientY);
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) goNextImage();
      else goPrevImage();
      pz.dragMoved = true;
    }
  }

  // Tap to open tag input
  if (!pz.dragMoved && pz.pointers.size === 0) {
    const { xRel, yRel, wrap } = wrapperPointToImageRel(e.clientX, e.clientY);
    if (xRel >= 0 && xRel <= 1 && yRel >= 0 && yRel <= 1) {
      createTagOverlay(xRel * wrap.width, yRel * wrap.height);
    }
  }

  if (pz.pointers.size < 2) { pz.startPinchDist = 0; pz.startMid = null; }
  if (pz.pointers.size === 0) pz.dragging = false;
});

imageWrapper.addEventListener('pointercancel', (e) => {
  pz.pointers.delete(e.pointerId);
  if (pz.pointers.size < 2) { pz.startPinchDist = 0; pz.startMid = null; }
  if (pz.pointers.size === 0) pz.dragging = false;
});

imageWrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomFactor = -e.deltaY > 0 ? 1.08 : 0.92;
  zoomAt(e.clientX, e.clientY, pz.scale * zoomFactor);
}, { passive: false });


/* =========================================================
   TAG INDEX
   Lightweight (image_id, tag) index used for gallery
   filtering and counts — no positions, loads on startup.
   ========================================================= */

async function loadTagIndexAndCounts() {
  const pageSize = 1000;
  const data = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data: page, error } = await supabase
      .from('image_tags')
      .select('image_id, tag')
      .range(from, to);

    if (error) { console.error(error); return; }
    if (!page || page.length === 0) break;

    data.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  tagSetKnownLoaded.clear();
  tagSetByImageId.clear();
  globalTagCounts.clear();

  const seenTagInImage = new Map();
  data.forEach(r => {
    const imageId = String(r.image_id);
    const tag     = String(r.tag || '').trim().toLowerCase();
    if (!imageId || !tag) return;

    let s = seenTagInImage.get(imageId);
    if (!s) { s = new Set(); seenTagInImage.set(imageId, s); }
    s.add(tag);
  });

  for (const [imageId, set] of seenTagInImage.entries()) {
    tagSetByImageId.set(imageId, set);
    for (const tag of set) {
      globalTagCounts.set(tag, (globalTagCounts.get(tag) || 0) + 1);
    }
  }

  await updateTagToggleIcon();
  updateGalleryTagList();
  if (!galleryView.classList.contains('hidden')) renderGallery();
}

// Fetches just the tag set for a single image (no positions),
// used when the index hasn't loaded yet for that image.
async function ensureTagSetForImage(imageId) {
  const key = String(imageId);
  if (tagSetKnownLoaded.has(key)) return tagSetByImageId.get(key) || new Set();

  const { data, error } = await supabase
    .from('image_tags')
    .select('tag')
    .eq('image_id', imageId);

  if (error) {
    console.error('ensureTagSetForImage error:', error);
    return tagSetByImageId.get(key) || new Set();
  }

  const set = new Set();
  (data || []).forEach(r => {
    const t = String(r.tag || '').trim().toLowerCase();
    if (t) set.add(t);
  });

  tagSetByImageId.set(key, set);
  tagSetKnownLoaded.add(key);
  return set;
}


/* =========================================================
   FULL TAG CACHE
   Fetches complete tag rows (including x/y positions) for a
   single image, lazily — only when the user wants to see tags.
   ========================================================= */

async function ensureFullTagsForImage(imageId) {
  if (!imageId) return [];
  const key = String(imageId);
  if (fullTagsByImageId.has(key)) return fullTagsByImageId.get(key);

  const { data, error } = await supabase
    .from('image_tags')
    .select('id, tag, x, y, tagger_id, image_id')
    .eq('image_id', imageId);

  if (error) {
    console.error(error);
    fullTagsByImageId.set(key, []);
    return [];
  }

  const tags = (data || []).map(t => ({ id: t.id, tag: t.tag, x: t.x, y: t.y, tagger_id: t.tagger_id }));
  fullTagsByImageId.set(key, tags);

  // Keep the lightweight index in sync
  const set = tagSetByImageId.get(key) || new Set();
  tags.forEach(t => {
    const norm = String(t.tag || '').trim().toLowerCase();
    if (norm) set.add(norm);
  });
  tagSetByImageId.set(key, set);

  return tags;
}


/* =========================================================
   TAG HELPERS
   ========================================================= */

function getTagSetForImageId(imageId) {
  return tagSetByImageId.get(String(imageId)) || new Set();
}

function imageHasTag(img, tag) {
  return getTagSetForImageId(img.id).has(String(tag || '').trim().toLowerCase());
}

function isUntagged(img) {
  return getTagSetForImageId(img.id).size === 0;
}

function getSessionTagsForCurrentImage() {
  const img = images[currentIndex];
  if (!img) return [];
  return sessionTagsByImageId.get(String(img.id)) || [];
}

function clearSessionTagsForCurrentImage() {
  const img = images[currentIndex];
  if (!img) return;
  sessionTagsByImageId.delete(String(img.id));
}


/* =========================================================
   TAG DISPLAY (tagging view)
   ========================================================= */

async function updateTagToggleIcon() {
  const img = images[currentIndex];
  if (!img) return;

  let set = tagSetByImageId.get(String(img.id));
  if (!set) set = await ensureTagSetForImage(img.id);

  tagToggleIcon.style.display = (set && set.size > 0) ? 'block' : 'none';
}

function displaySessionTags() {
  const rect = imageWrapper.getBoundingClientRect();
  getSessionTagsForCurrentImage().forEach(t => {
    createTagElement(t.tag, t.x * rect.width * pz.scale + pz.x, t.y * rect.height * pz.scale + pz.y);
  });
}

function displayAllPlusSessionTags() {
  const img = images[currentIndex];
  if (!img) return;

  const rect   = imageWrapper.getBoundingClientRect();
  const dbTags = (fullTagsByImageId.get(String(img.id)) || []).map(t => ({ tag: t.tag, x: t.x, y: t.y }));

  // Dedupe by tag text + approximate position
  const seen = new Set();
  const combined = [];
  for (const t of [...dbTags, ...getSessionTagsForCurrentImage()]) {
    const k = `${String(t.tag).toLowerCase()}@${Math.round(t.x * 1000)},${Math.round(t.y * 1000)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(t);
  }

  combined.forEach(t => {
    createTagElement(t.tag, t.x * rect.width * pz.scale + pz.x, t.y * rect.height * pz.scale + pz.y);
  });
}

function resetTagDisplayForCurrentImage({ showSession = false } = {}) {
  showAllTags        = false;
  allTagsPinned      = false;
  holdSessionTagsVisible = false;

  clearTagElements();
  removeTagOverlay();

  if (showSession && getSessionTagsForCurrentImage().length) displaySessionTags();
}

function createTagElement(tag, xPx, yPx) {
  const el = document.createElement('div');
  el.className  = 'tag-label';
  el.textContent = tag;
  imageWrapper.appendChild(el);

  const PADDING = 4;
  const wrap = imageWrapper.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  let left = xPx;
  let top  = yPx;

  if (left + w > wrap.width  - PADDING) left = xPx - w;
  if (top  + h > wrap.height - PADDING) top  = yPx - h;

  left = Math.max(PADDING, Math.min(left, wrap.width  - w - PADDING));
  top  = Math.max(PADDING, Math.min(top,  wrap.height - h - PADDING));

  el.style.left = `${left}px`;
  el.style.top  = `${top}px`;

  const best = findNonOverlappingPosition(el, left, top, wrap, tagElements.filter(e => e !== el), 8, 160);
  el.style.left = `${best.left}px`;
  el.style.top  = `${best.top}px`;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    goToGalleryFilteredByTag(tag);
  });

  tagElements.push(el);
}

function clearTagElements() {
  tagElements.forEach(el => el.remove());
  tagElements = [];
}

function rectsOverlap(a, b, pad = 2) {
  return !(
    a.right  < b.left  - pad ||
    a.left   > b.right + pad ||
    a.bottom < b.top   - pad ||
    a.top    > b.bottom + pad
  );
}

function findNonOverlappingPosition(el, startLeft, startTop, wrapRect, others, step = 8, maxRadius = 160) {
  const candidates = [[0, 0]];

  for (let r = step; r <= maxRadius; r += step) {
    candidates.push(
      [r, 0], [-r, 0], [0, r], [0, -r],
      [r, r], [r, -r], [-r, r], [-r, -r],
      [r/2, r], [-r/2, r], [r/2, -r], [-r/2, -r],
      [r, r/2], [r, -r/2], [-r, r/2], [-r, -r/2],
    );
  }

  const w = el.offsetWidth;
  const h = el.offsetHeight;

  for (const [dx, dy] of candidates) {
    const left = Math.max(2, Math.min(startLeft + dx, wrapRect.width  - w - 2));
    const top  = Math.max(2, Math.min(startTop  + dy, wrapRect.height - h - 2));
    const testRect = { left, top, right: left + w, bottom: top + h };

    const ok = others.every(o => !rectsOverlap(testRect, {
      left: o.offsetLeft, top: o.offsetTop,
      right: o.offsetLeft + o.offsetWidth, bottom: o.offsetTop + o.offsetHeight,
    }));

    if (ok) return { left, top };
  }

  return {
    left: Math.max(2, Math.min(startLeft, wrapRect.width  - w - 2)),
    top:  Math.max(2, Math.min(startTop,  wrapRect.height - h - 2)),
  };
}


/* =========================================================
   TAG INPUT OVERLAY
   Appears at the tap position and saves the tag on Enter.
   ========================================================= */

function createTagOverlay(xPx, yPx) {
  removeTagOverlay();

  const PADDING = 8;
  const OFFSET  = 10;

  tagOverlay = document.createElement('input');
  tagOverlay.type = 'text';
  tagOverlay.placeholder = 'Name what you notice + hit enter';
  tagOverlay.className = 'tag-input';
  imageWrapper.appendChild(tagOverlay);

  const wrap = imageWrapper.getBoundingClientRect();
  const ow = tagOverlay.offsetWidth;
  const oh = tagOverlay.offsetHeight;

  let left = xPx + OFFSET;
  let top  = yPx + OFFSET;

  if (wrap.width  - xPx < ow + OFFSET + PADDING && xPx >= ow + OFFSET + PADDING) left = xPx - ow - OFFSET;
  if (wrap.height - yPx < oh + OFFSET + PADDING && yPx >= oh + OFFSET + PADDING) top  = yPx - oh - OFFSET;

  left = Math.max(PADDING, Math.min(left, wrap.width  - ow - PADDING));
  top  = Math.max(PADDING, Math.min(top,  wrap.height - oh - PADDING));

  tagOverlay.style.left = `${left}px`;
  tagOverlay.style.top  = `${top}px`;
  tagOverlay.focus();

  let saved = false;

  async function saveIfNeeded() {
    if (saved) return;

    const tagText = (tagOverlay.value || '').trim().toLowerCase();
    if (!tagText) return;

    const img = images[currentIndex];
    if (getTagSetForImageId(img.id).has(tagText)) {
      showTagError('tag already exists', xPx, yPx);
      removeTagOverlay();
      return;
    }

    const ix   = (xPx - pz.x) / pz.scale;
    const iy   = (yPx - pz.y) / pz.scale;
    const xRel = ix / wrap.width;
    const yRel = iy / wrap.height;

    tagToggleIcon.style.display = 'block';
    suppressAllTagRender = true;

    await saveTag(tagText, xRel, yRel);
    saved = true;

    const imgId = String(images[currentIndex].id);
    const list  = sessionTagsByImageId.get(imgId) || [];
    list.push({ tag: tagText, x: xRel, y: yRel });
    sessionTagsByImageId.set(imgId, list);

    clearTagElements();

    if (allTagsPinned) {
      showAllTags = true;
      await ensureFullTagsForImage(images[currentIndex].id);
      displayAllPlusSessionTags();
      holdSessionTagsVisible = false;
    } else {
      showAllTags = false;
      holdSessionTagsVisible = true;
      displaySessionTags();
    }

    requestAnimationFrame(() => { suppressAllTagRender = false; });
  }

  tagOverlay.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'NumpadEnter') {
      e.preventDefault();
      await saveIfNeeded();
      removeTagOverlay();
    }
    if (e.key === 'Escape') removeTagOverlay();
  });

  tagOverlay.addEventListener('click', (e) => e.stopPropagation());
  tagOverlay.addEventListener('blur',  () => removeTagOverlay());
}

function removeTagOverlay() {
  if (tagOverlay) { tagOverlay.remove(); tagOverlay = null; }
}

function showTagError(message, xPx, yPx) {
  const el = document.createElement('div');
  el.className   = 'tag-error';
  el.textContent = message;
  imageWrapper.appendChild(el);
  el.style.left = `${xPx + 6}px`;
  el.style.top  = `${yPx + 6}px`;
  setTimeout(() => el.remove(), 1200);
}


/* =========================================================
   SAVE TAG TO SUPABASE
   ========================================================= */

async function saveTag(tag, x, y) {
  const img = images[currentIndex];

  const { data, error } = await supabase
    .from('image_tags')
    .insert([{ image_id: img.id, image_filename: img.filename, tag, x, y, tagger_id: getTaggerId() }])
    .select('id, tag, x, y, tagger_id')
    .single();

  if (error) {
    if (error.code === '23505') return; // duplicate — silently ignore
    console.error('saveTag error:', error);
    return;
  }
  if (!data) return;

  const imgId = String(img.id);
  const norm  = String(data.tag || '').trim().toLowerCase();

  // Update lightweight index
  let set = tagSetByImageId.get(imgId);
  if (!set) { set = new Set(); tagSetByImageId.set(imgId, set); }
  const wasNew = !set.has(norm);
  set.add(norm);

  if (wasNew) globalTagCounts.set(norm, (globalTagCounts.get(norm) || 0) + 1);

  // Update full tag cache if it's already been fetched for this image
  if (fullTagsByImageId.has(imgId)) {
    fullTagsByImageId.get(imgId).push(data);
  }

  tagToggleIcon.style.display = 'block';
  renderGallery();
  updateGalleryTagList();
}


/* =========================================================
   TAG TOGGLE ICON
   Click to pin all tags; click again to clear.
   Desktop: hover for a preview.
   ========================================================= */

tagToggleIcon.addEventListener('click', async (e) => {
  e.stopPropagation();

  if (allTagsPinned) {
    clearSessionTagsForCurrentImage();
    holdSessionTagsVisible = false;
    resetTagDisplayForCurrentImage({ showSession: false });
    return;
  }

  holdSessionTagsVisible = false;
  allTagsPinned = true;
  showAllTags   = true;

  await ensureFullTagsForImage(images[currentIndex]?.id);
  clearTagElements();
  displayAllPlusSessionTags();
});

if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  tagToggleIcon.addEventListener('mouseenter', async () => {
    if (allTagsPinned || suppressAllTagRender) return;
    showAllTags = true;
    await ensureFullTagsForImage(images[currentIndex]?.id);
    clearTagElements();
    displayAllPlusSessionTags();
  });

  tagToggleIcon.addEventListener('mouseleave', () => {
    if (allTagsPinned || suppressAllTagRender) return;
    showAllTags = false;
    clearTagElements();
  });
}


/* =========================================================
   IMAGE NAVIGATION
   ========================================================= */

// Builds a randomized play queue that favours untagged images
// (UNTAGGED_RATIO untagged images for every 1 tagged image).
const UNTAGGED_RATIO = 2;

function buildDeck(excludeIndex = null) {
  const untagged = [];
  const tagged   = [];

  for (let i = 0; i < images.length; i++) {
    if (i === excludeIndex) continue;
    (isUntagged(images[i]) ? untagged : tagged).push(i);
  }

  const U = shuffleArray(untagged);
  const T = shuffleArray(tagged);
  const deck = [];
  let u = 0, t = 0;

  while (u < U.length || t < T.length) {
    for (let k = 0; k < UNTAGGED_RATIO && u < U.length; k++) deck.push(U[u++]);
    if (t < T.length) deck.push(T[t++]);
    if (u >= U.length) while (t < T.length) deck.push(T[t++]);
    if (t >= T.length) while (u < U.length) deck.push(U[u++]);
  }

  return deck;
}

function getNextIndexFromDeck() {
  if (nextDeck.length === 0) nextDeck = buildDeck(currentIndex);
  return nextDeck.shift();
}

function preloadNext() {
  if (!images.length) return;

  const nextIdx = forwardStack.length > 0
    ? forwardStack[forwardStack.length - 1]
    : (nextDeck.length ? nextDeck[0] : null);

  if (nextIdx == null) return;
  preloadImg.decoding = 'async';
  preloadImg.src = supaFullSmart(images[nextIdx].url, 85);
}

function goNextImage() {
  if (!images.length) return;

  if (forwardStack.length > 0) {
    historyStack.push(currentIndex);
    currentIndex = forwardStack.pop();
  } else {
    historyStack.push(currentIndex);
    currentIndex = getNextIndexFromDeck();
  }

  showImage();
  pushSnapshot();
}

function goPrevImage() {
  if (!images.length || historyStack.length === 0) return;
  forwardStack.push(currentIndex);
  currentIndex = historyStack.pop();
  showImage();
  pushSnapshot();
}


/* =========================================================
   SHOW IMAGE
   ========================================================= */

function showImage() {
  if (!images.length) return;

  const img   = images[currentIndex];
  const token = ++lastLoadToken;

  mainImage.style.visibility = 'hidden';
  mainImage.removeAttribute('src');

  loadIntoMain(supaFullSmart(img.url, 85), token);
  preloadNext();
  resetPanZoom();
  resetTagDisplayForCurrentImage({ showSession: false });
  updateTagToggleIcon();
}

async function loadIntoMain(src, token) {
  const img = new Image();
  img.decoding      = 'async';
  img.fetchPriority = 'high';
  img.src = src;

  try {
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  } catch { return; }

  if (token !== lastLoadToken) return;

  mainImage.src = src;
  mainImage.style.visibility = 'visible';
}


/* =========================================================
   GALLERY — RENDER
   ========================================================= */

function renderGallery({ preserveCols = false } = {}) {
  const isFiltered = selectedGalleryTags.size > 0;
  const filtered   = isFiltered ? getFilteredImages() : images;

  if (isFiltered) setColsForImageCount(filtered.length);
  else if (!preserveCols) initGalleryCols();

  galleryGrid.classList.toggle('single-image', filtered.length === 1);

  let finalList = filtered;

  if (Array.isArray(galleryOrderIds) && galleryOrderIds.length) {
    const byId    = new Map(finalList.map(img => [String(img.id), img]));
    const ordered = [];
    galleryOrderIds.forEach(id => { const img = byId.get(String(id)); if (img) { ordered.push(img); byId.delete(String(id)); } });
    for (const img of byId.values()) ordered.push(img);
    finalList = ordered;
  } else {
    finalList = shuffleArray(finalList);
  }

  galleryGrid.innerHTML = '';

  const BATCH_SIZE = 60;
  let i = 0;

  function appendBatch() {
    const frag = document.createDocumentFragment();

    for (let k = 0; k < BATCH_SIZE && i < finalList.length; k++, i++) {
      const imgEl = document.createElement('img');
      imgEl.src      = finalList[i].url;
      imgEl.loading  = 'lazy';
      imgEl.decoding = 'async';
      imgEl.dataset.id = finalList[i].id;
      imgEl.draggable  = false;
      frag.appendChild(imgEl);
    }

    galleryGrid.appendChild(frag);

    if (pendingGalleryScrollTop != null) {
      galleryGrid.scrollTop = pendingGalleryScrollTop;
      if (galleryGrid.scrollHeight >= pendingGalleryScrollTop + galleryGrid.clientHeight) {
        pendingGalleryScrollTop = null;
      }
    }

    if (i < finalList.length) {
      if ('requestIdleCallback' in window) requestIdleCallback(appendBatch);
      else setTimeout(appendBatch, 16);
    }
  }

  appendBatch();
}


/* =========================================================
   GALLERY — TAG LIST
   ========================================================= */

function updateGalleryTagList() {
  galleryTagList.classList.toggle('has-selection', selectedGalleryTags.size > 0);

  // Sort tags by global count descending, then by first appearance in the image list
  const firstSeenAt = new Map();
  images.forEach((img, idx) => {
    for (const tag of getTagSetForImageId(img.id)) {
      if (!firstSeenAt.has(tag)) firstSeenAt.set(tag, idx);
    }
  });

  const allTagsSorted = [...globalTagCounts.entries()]
    .sort(([tagA, countA], [tagB, countB]) => {
      if (countB !== countA) return countB - countA;
      return (firstSeenAt.get(tagA) ?? 1e9) - (firstSeenAt.get(tagB) ?? 1e9);
    })
    .map(([tag]) => tag);

  // Count how many matching images each tag appears in, given the current selection
  const selected = [...selectedGalleryTags].map(t => String(t).trim().toLowerCase());
  const matchingImages = selected.length === 0
    ? images
    : images.filter(img => selected.every(tag => imageHasTag(img, tag)));

  const matchingCounts = new Map();
  matchingImages.forEach(img => {
    for (const tag of getTagSetForImageId(img.id)) {
      matchingCounts.set(tag, (matchingCounts.get(tag) || 0) + 1);
    }
  });

  const compatible = new Set(matchingCounts.keys());

  galleryTagList.innerHTML = allTagsSorted.map(tag => {
    const isSelected   = selectedGalleryTags.has(tag);
    const isCompatible = compatible.has(tag);
    const classes      = [isSelected ? 'selected' : '', !isCompatible ? 'incompatible' : ''].filter(Boolean).join(' ');
    const count        = matchingCounts.get(tag) || 0;

    return `<li class="${classes}" data-tag="${tag}">
      <span class="tag-name">${tag}</span>
      <span class="tag-count">(${count})</span>
    </li>`;
  }).join('');

  galleryTagList.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      const tag = li.dataset.tag;
      if (selectedGalleryTags.has(tag)) selectedGalleryTags.delete(tag);
      else selectedGalleryTags.add(tag);

      galleryOrderIds = null;
      updateGalleryTagList();
      renderGallery();
      resetGalleryViewport();
      pushSnapshot();
    });
  });
}

function scrollSelectedTagIntoView(desktopOffsetItems = 2) {
  if (!galleryTagList) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const selectedEl = galleryTagList.querySelector('li.selected');
      if (!selectedEl) return;

      const scroller   = galleryTagList;
      const canScrollX = scroller.scrollWidth  > scroller.clientWidth;
      const canScrollY = scroller.scrollHeight > scroller.clientHeight;

      if (canScrollX && !canScrollY) {
        scroller.scrollTo({ left: Math.max(0, selectedEl.offsetLeft), behavior: 'auto' });
        return;
      }

      const itemH = selectedEl.offsetHeight || 0;
      scroller.scrollTo({ top: Math.max(0, selectedEl.offsetTop - itemH * desktopOffsetItems), behavior: 'auto' });
    });
  });
}


/* =========================================================
   GALLERY — GRID INTERACTIONS
   ========================================================= */

const isTouchDevice = window.matchMedia('(hover: none)').matches;

// Preload full image on hover (desktop) and touchstart (mobile)
// so the tagging view loads instantly after a tap/click
if (galleryGrid) {
  galleryGrid.addEventListener('mouseover', (e) => {
    const imgEl = e.target.closest('#gallery-grid img');
    if (!imgEl) return;
    const img = images.find(im => String(im.id) === String(imgEl.dataset.id));
    if (img) preloadImg.src = supaFullSmart(img.url, 85);
  });

  galleryGrid.addEventListener('touchstart', (e) => {
    const imgEl = e.target.closest('#gallery-grid img');
    if (!imgEl) return;
    const img = images.find(im => String(im.id) === String(imgEl.dataset.id));
    if (img) preloadImg.src = supaFullSmart(img.url, 85);
  }, { passive: true });

  galleryGrid.addEventListener('click', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    if (Date.now() - lastPinchTime < (isTouchDevice ? 250 : 0)) return;

    const imgEl = e.target.closest('#gallery-grid img');
    if (!imgEl) return;

    const id = imgEl.dataset.id;
    currentIndex = images.findIndex(im => String(im.id) === String(id));
    if (currentIndex === -1) return;

    historyStack = [];
    forwardStack = [];
    nextDeck = buildDeck(currentIndex);
    preloadNext();

    showTagging();
    showImage();
  });

  galleryGrid.addEventListener('dragstart', (e) => {
    if (e.target.closest('#gallery-grid img')) e.preventDefault();
  });

  galleryGrid.addEventListener('scroll', () => {
    if (galleryView.classList.contains('hidden')) return;
    if (galleryScrollRAF) return;
    galleryScrollRAF = requestAnimationFrame(() => {
      galleryScrollRAF = 0;
      replaceSnapshot();
    });
  }, { passive: true });
}


/* =========================================================
   SHOW/HIDE VIEWS
   ========================================================= */

function setActiveView(view) {
  localStorage.setItem('activeView', view);
  document.documentElement.dataset.view = view;
}

function showGallery(opts = {}) {
  setActiveView('gallery');
  taggingView.classList.add('hidden');
  galleryView.classList.remove('hidden');

  if (!opts.keepFilters) { selectedGalleryTags.clear(); galleryOrderIds = null; }

  updateGalleryTagList();
  clearTagElements();
  removeTagOverlay();

  if (selectedGalleryTags.size === 0 && !opts.keepCols) initGalleryCols();

  galleryGrid.classList.remove('single-image');
  renderGallery({ preserveCols: !!opts.keepCols });

  if (typeof opts.restoreScrollTop === 'number') queueGalleryScrollRestore(opts.restoreScrollTop);

  if (!opts.fromHistory) pushSnapshot();
  else replaceSnapshot();
}

function showTagging(opts = {}) {
  setActiveView('tagging');
  galleryView.classList.add('hidden');
  taggingView.classList.remove('hidden');

  clearTagElements();
  removeTagOverlay();

  if (!opts.fromHistory) pushSnapshot();
  else replaceSnapshot();
}

function goToGalleryFilteredByTag(tag) {
  setActiveView('gallery');
  selectedGalleryTags.clear();
  selectedGalleryTags.add(String(tag || '').trim().toLowerCase());

  clearTagElements();
  removeTagOverlay();

  taggingView.classList.add('hidden');
  galleryView.classList.remove('hidden');

  updateGalleryTagList();
  renderGallery();
  scrollSelectedTagIntoView();
}


/* =========================================================
   GALLERY HELPERS
   ========================================================= */

function getFilteredImages() {
  if (selectedGalleryTags.size === 0) return images;
  const required = [...selectedGalleryTags].map(t => String(t).trim().toLowerCase());
  return images.filter(img => required.every(tag => imageHasTag(img, tag)));
}

function resetGalleryViewport() {
  if (galleryGrid) galleryGrid.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function queueGalleryScrollRestore(top) {
  pendingGalleryScrollTop = Math.max(0, top || 0);
}

function getCurrentGalleryOrderIds() {
  if (!galleryGrid) return null;
  const ids = [...galleryGrid.querySelectorAll('img[data-id]')].map(el => el.dataset.id);
  return ids.length ? ids : null;
}


/* =========================================================
   UI EVENT LISTENERS
   ========================================================= */

// Tagging view navigation
nextBtn.addEventListener('click', () => { if (images.length) goNextImage(); });
if (prevBtn) prevBtn.addEventListener('click', () => { if (images.length) goPrevImage(); });
galleryBtn.addEventListener('click', showGallery);

// Gallery filter clear
clearBtn.addEventListener('click', () => {
  galleryOrderIds = null;
  selectedGalleryTags.clear();
  updateGalleryTagList();
  renderGallery();
  resetGalleryViewport();
  pushSnapshot();
});

// Question popover (mobile: tap to toggle; desktop: CSS hover handles it)
if (questionBtn && questionPopover) {
  questionBtn.addEventListener('click', (e) => {
    if (window.matchMedia('(hover: none)').matches) {
      e.stopPropagation();
      const nowOpen = questionPopover.classList.toggle('open');
      questionBtn.classList.toggle('is-open', nowOpen);
    }
  });

  document.addEventListener('click', (e) => {
    if (
      window.matchMedia('(hover: none)').matches &&
      questionPopover.classList.contains('open') &&
      !questionPopover.contains(e.target) &&
      !questionBtn.contains(e.target)
    ) {
      questionPopover.classList.remove('open');
      questionBtn.classList.remove('is-open');
    }
  });
}

// Gallery help popovers (mobile: tap to toggle)
document.querySelectorAll('.help-anchor').forEach((anchor) => {
  const btn = anchor.querySelector('.js-help-btn');
  const pop = anchor.querySelector('.js-help-popover');
  if (!btn || !pop) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.js-help-popover').forEach(other => { if (other !== pop) other.classList.add('hidden'); });
    pop.classList.toggle('hidden');
  });
});

document.addEventListener('click', (e) => {
  document.querySelectorAll('.help-anchor').forEach((anchor) => {
    const btn = anchor.querySelector('.js-help-btn');
    const pop = anchor.querySelector('.js-help-popover');
    if (!btn || !pop) return;
    if (!pop.contains(e.target) && !btn.contains(e.target)) pop.classList.add('hidden');
  });
});


/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


/* =========================================================
   INIT — LOAD IMAGES
   ========================================================= */

async function loadImages() {
  const { data, error } = await supabase
    .from('images')
    .select('id, filename, url')
    .order('created_at', { ascending: true });

  if (error) { console.error(error); return; }

  images = (data || []).map(img => ({ ...img }));
  if (!images.length) return;

  historyStack = [];
  forwardStack = [];

  const persisted = loadLastStateFromLocalStorage();

  if (persisted) {
    selectedGalleryTags = new Set(Array.isArray(persisted.t) ? persisted.t : []);
    if (typeof persisted.c === 'number') setGalleryCols(persisted.c);
    galleryOrderIds = Array.isArray(persisted.go) ? persisted.go : null;

    if (persisted.i != null) {
      const idx = images.findIndex(im => String(im.id) === String(persisted.i));
      currentIndex = idx !== -1 ? idx : Math.floor(Math.random() * images.length);
    } else {
      currentIndex = Math.floor(Math.random() * images.length);
    }
  } else {
    currentIndex = Math.floor(Math.random() * images.length);
  }

  nextDeck = buildDeck(currentIndex);

  // Always open on tagging view regardless of last session
  showTagging({ fromHistory: true });
  showImage();
  replaceSnapshot();

  // Load the full tag index in the background, then refresh UI
  await loadTagIndexAndCounts();
  updateGalleryTagList();
  if (!galleryView.classList.contains('hidden')) renderGallery();
  updateTagToggleIcon();
}

loadImages();