// app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

/* ---------- SUPABASE ---------- */
const supabaseUrl = 'https://fyogbaeayboxjhleaqoj.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5b2diYWVheWJveGpobGVhcW9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczOTMxNDcsImV4cCI6MjA4Mjk2OTE0N30.JGa6qT6IkcNCJRxV5FYDFUiH1QWSKHABJ_Qu7BNV5m8';
const supabase = createClient(supabaseUrl, supabaseKey);

/* ---------- STATE ---------- */
let images = [];
let currentIndex = 0;

let tagOverlay = null;
let tagElements = [];
let showTags = false;

let selectedGalleryTags = new Set();

let nextDeck = [];
let historyStack = [];
let forwardStack = [];

let suppressNextTagOpen = false;
let lastPinchTime = 0;
let galleryOrderIds = null;

/* ✅ default view on first-ever load */
if (!localStorage.getItem('activeView')) {
  localStorage.setItem('activeView', 'tagging');
}

/* ---------- HELPERS ---------- */
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getCurrentGalleryOrderIds() {
  // only meaningful if gallery is visible and grid has items
  if (!galleryGrid) return null;

  const ids = [...galleryGrid.querySelectorAll('img[data-id]')].map(el => el.dataset.id);
  return ids.length ? ids : null;
}


/* ---------- DOM ---------- */
const mainImage = document.getElementById('main-image');
const nextBtn = document.getElementById('nextBtn');
const prevBtn = document.getElementById('prevBtn');
const galleryBtn = document.getElementById('galleryBtn');

const taggingView = document.getElementById('tagging-view');
const galleryView = document.getElementById('gallery-view');

const imageWrapper = document.getElementById('image-wrapper');
const galleryGrid = document.getElementById('gallery-grid');
const galleryTagList = document.getElementById('gallery-tag-list');

const tagToggleIcon = document.getElementById('tag-toggle-icon');

const galleryHelpBtn = document.getElementById('galleryHelpBtn');
const galleryHelpPopup = document.getElementById('gallery-help-popup');
const clearBtn = document.getElementById('clearBtn');

const questionBtn = document.getElementById('questionBtn');
const questionPopover = document.getElementById('question-popover');

const LS_STATE_KEY = 'wdys:lastState';

function saveLastStateToLocalStorage() {
  try {
    localStorage.setItem(LS_STATE_KEY, JSON.stringify(getAppStateSnapshot()));
  } catch {}
}

function loadLastStateFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/*************************************************
  BROWSER HISTORY (Back/Forward restores view/image/filter)
*************************************************/
let suppressHistory = false;

// Build a serializable snapshot of "what user is looking at"
function getAppStateSnapshot() {
  const view = galleryView.classList.contains('hidden') ? 'tagging' : 'gallery';

  return {
    v: view,
    i: images[currentIndex]?.id ?? null,
    t: [...selectedGalleryTags],
    c: galleryZoom?.cols ?? null,
    go: getCurrentGalleryOrderIds() // ✅ new
  };
}


function applyAppStateSnapshot(st) {
  if (!st) return;

  selectedGalleryTags = new Set(Array.isArray(st.t) ? st.t : []);
  if (typeof st.c === 'number') setGalleryCols(st.c);

  galleryOrderIds = Array.isArray(st.go) ? st.go : null;

  if (st.v === 'gallery') {
    showGallery({ fromHistory: true, keepFilters: true });
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
  history.pushState(st, "", location.pathname + location.search);
  saveLastStateToLocalStorage(); // ✅ durable
}

function replaceSnapshot() {
  if (suppressHistory) return;
  const st = getAppStateSnapshot();
  history.replaceState(st, "", location.pathname + location.search);
  saveLastStateToLocalStorage(); // ✅ durable
}

// Back/Forward handler
window.addEventListener('popstate', (e) => {
  suppressHistory = true;
  applyAppStateSnapshot(e.state);
  suppressHistory = false;
});


/*************************************************
  GALLERY GRID "PHOTOS-STYLE" ZOOM (GLOBAL)
*************************************************/
const galleryZoom = {
  cols: 3,
  minCols: 1,
  maxCols: 10,
  pointers: new Map(),
  startDist: 0,
  startCols: 3,
};

function setGalleryCols(n){
  galleryZoom.cols = Math.max(galleryZoom.minCols, Math.min(galleryZoom.maxCols, n));
  document.documentElement.style.setProperty('--gallery-cols', String(galleryZoom.cols));
}

function setColsForImageCount(count){
  const desired = Math.max(1, Math.min(3, count || 1));
  setGalleryCols(desired);
}

function initGalleryCols(){
  const w = window.innerWidth;
  if (w < 480) setGalleryCols(3);
  else if (w < 900) setGalleryCols(4);
  else setGalleryCols(5);
}

initGalleryCols();
window.addEventListener('resize', initGalleryCols);

if (galleryGrid) {
  /* Smooth desktop pinch zoom (trackpad) */
  let wheelAccumulator = 0;
  const WHEEL_THRESHOLD = 10;

  galleryGrid.addEventListener('wheel', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    if (!e.ctrlKey) return;

    e.preventDefault();
    wheelAccumulator += e.deltaY;

    if (Math.abs(wheelAccumulator) < WHEEL_THRESHOLD) return;

    lastPinchTime = Date.now();

    const dir = wheelAccumulator > 0 ? +1 : -1;
    setGalleryCols(galleryZoom.cols + dir);

    wheelAccumulator = 0;
  }, { passive: false });

  /* Pointer pinch zoom (mobile + desktop touch) */
  galleryGrid.addEventListener('pointerdown', (e) => {
    if (galleryView.classList.contains('hidden')) return;

    // capture only for touch pointers
    if (e.pointerType === 'touch') {
      galleryGrid.setPointerCapture(e.pointerId);
    }

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

      const pts = [...galleryZoom.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = dist / (galleryZoom.startDist || dist);

      const target = Math.round(galleryZoom.startCols / ratio);
      setGalleryCols(target);

      lastPinchTime = Date.now();
    }
  }, { passive: false });

  function endGalleryPointer(e){
    galleryZoom.pointers.delete(e.pointerId);
    if (galleryZoom.pointers.size < 2) galleryZoom.startDist = 0;
  }
  galleryGrid.addEventListener('pointerup', endGalleryPointer);
  galleryGrid.addEventListener('pointercancel', endGalleryPointer);

  /* iOS Safari fallback: gesture events */
  galleryGrid.addEventListener('gesturestart', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    e.preventDefault();
    galleryZoom._gestureStartCols = galleryZoom.cols;
  }, { passive: false });

  galleryGrid.addEventListener('gesturechange', (e) => {
    if (galleryView.classList.contains('hidden')) return;
    e.preventDefault();

    const target = Math.round((galleryZoom._gestureStartCols || galleryZoom.cols) / e.scale);
    setGalleryCols(target);
  }, { passive: false });
}

const isTouchDevice = window.matchMedia('(hover: none)').matches;

if (galleryGrid) {
  galleryGrid.addEventListener('click', (e) => {
    if (galleryView.classList.contains('hidden')) return;

    // desktop: do not block clicks
    const blockWindow = isTouchDevice ? 250 : 0;
    if (Date.now() - lastPinchTime < blockWindow) return;

    const imgEl = e.target.closest('#gallery-grid img');
    if (!imgEl) return;

    const id = imgEl.dataset.id;
    currentIndex = images.findIndex(im => String(im.id) === String(id));
    if (currentIndex === -1) return;

    historyStack = [];
    forwardStack = [];
    nextDeck = buildDeck(currentIndex);

    showTagging();
    showImage();
  });

  galleryGrid.addEventListener('dragstart', (e) => {
    if (e.target.closest('#gallery-grid img')) e.preventDefault();
  });
}

/* ---------- QUESTION POPOVER --------- */
if (questionBtn && questionPopover) {
  questionBtn.addEventListener('click', (e) => {
    if (window.matchMedia('(hover: none)').matches) {
      e.stopPropagation();
      questionPopover.classList.toggle('open');
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
    }
  });
}

/* ---------- CLEAR BUTTON --------- */
clearBtn.addEventListener('click', () => {
  galleryOrderIds = null; // ✅ reset order
  selectedGalleryTags.clear();
  updateGalleryTagList();
  renderGallery();
  pushSnapshot();
});

/* ---------- GALLERY HELP BUTTONS (multiple) --------- */
document.querySelectorAll('.help-anchor').forEach((anchor) => {
  const btn = anchor.querySelector('.js-help-btn');
  const pop = anchor.querySelector('.js-help-popover');
  if (!btn || !pop) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();

    // close all other open help popovers
    document.querySelectorAll('.js-help-popover').forEach((other) => {
      if (other !== pop) other.classList.add('hidden');
    });

    pop.classList.toggle('hidden');
  });
});

// click outside closes any open help popover
document.addEventListener('click', (e) => {
  document.querySelectorAll('.help-anchor').forEach((anchor) => {
    const btn = anchor.querySelector('.js-help-btn');
    const pop = anchor.querySelector('.js-help-popover');
    if (!btn || !pop) return;

    const clickedInside = pop.contains(e.target) || btn.contains(e.target);
    if (!clickedInside) pop.classList.add('hidden');
  });
});


/*************************************************
  PAN + ZOOM (tagging view)
*************************************************/
let pz = {
  scale: 1,
  min: 1,
  max: 6,
  x: 0,
  y: 0,
  dragging: false,
  dragMoved: false,
  startX: 0,
  startY: 0,
  startPanX: 0,
  startPanY: 0,
  pointers: new Map(),
  startPinchDist: 0,
  startScale: 1,
  startMid: null
};

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function applyTransform(){
  mainImage.style.transform = `translate(${pz.x}px, ${pz.y}px) scale(${pz.scale})`;
}

function clampPan(){
  const wrap = imageWrapper.getBoundingClientRect();
  const extraW = wrap.width  * (pz.scale - 1);
  const extraH = wrap.height * (pz.scale - 1);

  const minX = -extraW;
  const maxX = 0;
  const minY = -extraH;
  const maxY = 0;

  pz.x = clamp(pz.x, minX, maxX);
  pz.y = clamp(pz.y, minY, maxY);
}

function zoomAt(clientX, clientY, newScale){
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

  if (showTags) {
    clearTagElements();
    displayImageTags();
  }
}

function wrapperPointToImageRel(clientX, clientY){
  const wrap = imageWrapper.getBoundingClientRect();
  const px = clientX - wrap.left;
  const py = clientY - wrap.top;

  const ix = (px - pz.x) / pz.scale;
  const iy = (py - pz.y) / pz.scale;

  const xRel = ix / wrap.width;
  const yRel = iy / wrap.height;

  return { xRel, yRel, ix, iy, wrap };
}

function resetPanZoom(){
  pz.scale = 1;
  pz.x = 0;
  pz.y = 0;
  applyTransform();
}

function isUIElement(target){
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

  pz.dragging = true;
  pz.dragMoved = false;
  pz.startX = e.clientX;
  pz.startY = e.clientY;
  pz.startPanX = pz.x;
  pz.startPanY = pz.y;

  pz._swipeStartX = e.clientX;
  pz._swipeStartY = e.clientY;

  if (pz.pointers.size === 2) {
    const pts = [...pz.pointers.values()];
    pz.startPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pz.startScale = pz.scale;
    pz.startMid = {
      x: (pts[0].x + pts[1].x) / 2,
      y: (pts[0].y + pts[1].y) / 2
    };
  }
});

imageWrapper.addEventListener('pointermove', (e) => {
  if (!pz.dragging) return;

  if (pz.pointers.has(e.pointerId)) {
    pz.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  if (pz.pointers.size === 2) {
    const pts = [...pz.pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mid = {
      x: (pts[0].x + pts[1].x) / 2,
      y: (pts[0].y + pts[1].y) / 2
    };

    const ratio = dist / (pz.startPinchDist || dist);
    const targetScale = pz.startScale * ratio;

    zoomAt(mid.x, mid.y, targetScale);
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

  if (showTags) {
    clearTagElements();
    displayImageTags();
  }
});

imageWrapper.addEventListener('pointerup', (e) => {
  pz.pointers.delete(e.pointerId);

  if (suppressNextTagOpen) {
    suppressNextTagOpen = false;
    pz.dragging = false;
    pz.dragMoved = false;
    return;
  }

  if (isUIElement(e.target)) {
    if (pz.pointers.size < 2) {
      pz.startPinchDist = 0;
      pz.startMid = null;
    }
    if (pz.pointers.size === 0) pz.dragging = false;
    return;
  }

  // --- SWIPE NAV (tagging view) ---
  if (pz.scale === 1 && pz.pointers.size === 0) {
    const dx = e.clientX - (pz._swipeStartX ?? e.clientX);
    const dy = e.clientY - (pz._swipeStartY ?? e.clientY);

    const SWIPE_PX = 70;
    const H_DOMINANCE = 1.2;

    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * H_DOMINANCE) {
      if (dx < 0) goNextImage();
      else goPrevImage();
      pz.dragMoved = true;
    }
  }

  // tap-to-tag
  if (!pz.dragMoved && pz.pointers.size === 0) {
    const { xRel, yRel, wrap } = wrapperPointToImageRel(e.clientX, e.clientY);

    if (xRel >= 0 && xRel <= 1 && yRel >= 0 && yRel <= 1) {
      const xPx = xRel * wrap.width;
      const yPx = yRel * wrap.height;
      createTagOverlay(xPx, yPx);
    }
  }

  if (pz.pointers.size < 2) {
    pz.startPinchDist = 0;
    pz.startMid = null;
  }
  if (pz.pointers.size === 0) {
    pz.dragging = false;
  }
});

imageWrapper.addEventListener('pointercancel', (e) => {
  pz.pointers.delete(e.pointerId);
  if (pz.pointers.size < 2) {
    pz.startPinchDist = 0;
    pz.startMid = null;
  }
  if (pz.pointers.size === 0) pz.dragging = false;
});

imageWrapper.addEventListener('wheel', (e) => {
  e.preventDefault();

  const delta = -e.deltaY;
  const zoomFactor = delta > 0 ? 1.08 : 0.92;
  const target = pz.scale * zoomFactor;

  zoomAt(e.clientX, e.clientY, target);
}, { passive: false });

/* ---------- LOAD IMAGES ---------- */
async function loadImages() {
  const { data, error } = await supabase
    .from('images')
    .select(`
      id,
      filename,
      url,
      image_tags(id, tag, x, y)
    `)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  images = (data || []).map(img => ({
    ...img,
    tags: (img.image_tags || []).map(t => ({
      id: t.id,
      tag: t.tag,
      x: t.x,
      y: t.y
    }))
  }));

  if (!images.length) return;

 // Build default nav state
historyStack = [];
forwardStack = [];

// ✅ Try durable restore first
const persisted = loadLastStateFromLocalStorage();

if (persisted) {
  // restore selected tags
  selectedGalleryTags = new Set(Array.isArray(persisted.t) ? persisted.t : []);

  // restore cols if present
  if (typeof persisted.c === 'number') setGalleryCols(persisted.c);

  galleryOrderIds = Array.isArray(persisted.go) ? persisted.go : null;

  // restore current image if present (tagging)
  if (persisted.i != null) {
    const idx = images.findIndex(im => String(im.id) === String(persisted.i));
    if (idx !== -1) currentIndex = idx;
  } else {
    currentIndex = Math.floor(Math.random() * images.length);
  }

  nextDeck = buildDeck(currentIndex);

  // render once data exists
  showImage();
  renderGallery();
  updateGalleryTagList();

  if (persisted.v === 'gallery') showGallery({ fromHistory: true, keepFilters: true });
  else showTagging({ fromHistory: true });

  replaceSnapshot(); // writes history.state + localStorage
  return;
}

// ✅ Fallback: old behavior if no persisted state
currentIndex = Math.floor(Math.random() * images.length);
nextDeck = buildDeck(currentIndex);

showImage();
renderGallery();
updateGalleryTagList();

showTagging({ fromHistory: true });

replaceSnapshot();

}


/* ---------- SHOW IMAGE ---------- */
function showImage() {
  if (!images.length) return;
  const img = images[currentIndex];

  mainImage.src = img.url;

  resetPanZoom();

  clearTagElements();
  removeTagOverlay();
  showTags = false;
  tagToggleIcon.style.display = (img.tags && img.tags.length) ? 'block' : 'none';
}

/* ---------- DECK / NAV ---------- */
function buildDeck(excludeIndex = null) {
  const weighted = [];

  images.forEach((img, i) => {
    if (excludeIndex !== null && i === excludeIndex) return;

    const tagCount = (img.tags || []).length;

    if (tagCount === 0) {
      // untagged → weight 3
      weighted.push(i, i, i);
    } else {
      // tagged → weight 1
      weighted.push(i);
    }
  });

  return shuffleArray(weighted);
}


function getNextIndexFromDeck() {
  if (nextDeck.length === 0) {
    nextDeck = buildDeck(currentIndex);
  }
  return nextDeck.shift();
}

function goNextImage() {
  if (!images.length) return;

  // If the user previously went backward, "next" should replay forward history first
  if (forwardStack.length > 0) {
    historyStack.push(currentIndex);
    currentIndex = forwardStack.pop();
    showImage();
    pushSnapshot();
    return;
  }

  // Otherwise, continue random navigation
  historyStack.push(currentIndex);
  currentIndex = getNextIndexFromDeck();
  showImage();
  pushSnapshot();
}

function goPrevImage() {
  if (!images.length) return;
  if (historyStack.length === 0) return;

  forwardStack.push(currentIndex);
  currentIndex = historyStack.pop();
  showImage();
  pushSnapshot(); // ✅
}

/* ---------- TAG ELEMENTS ---------- */
function createTagElement(tag, xPx, yPx) {
  const el = document.createElement('div');
  el.className = 'tag-label';
  el.textContent = tag;

  imageWrapper.appendChild(el);

  const PADDING = 4;
  const wrap = imageWrapper.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  let left = xPx;
  let top  = yPx;

  if (left + w > wrap.width - PADDING) left = xPx - w;
  if (top + h > wrap.height - PADDING) top = yPx - h;

  left = Math.max(PADDING, Math.min(left, wrap.width - w - PADDING));
  top  = Math.max(PADDING, Math.min(top,  wrap.height - h - PADDING));

  el.style.left = `${left}px`;
  el.style.top  = `${top}px`;

  const others = tagElements.filter(tEl => tEl !== el);
  const best = findNonOverlappingPosition(el, left, top, wrap, others, 8, 160);
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

/* ---------- CREATE TAG INPUT OVERLAY ---------- */
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

  const spaceRight = wrap.width  - xPx;
  const spaceLeft  = xPx;
  const spaceDown  = wrap.height - yPx;
  const spaceUp    = yPx;

  let left = xPx + OFFSET;
  let top  = yPx + OFFSET;

  if (spaceRight < ow + OFFSET + PADDING && spaceLeft >= ow + OFFSET + PADDING) {
    left = xPx - ow - OFFSET;
  }

  if (spaceDown < oh + OFFSET + PADDING && spaceUp >= oh + OFFSET + PADDING) {
    top = yPx - oh - OFFSET;
  }

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
    const alreadyExists = (img.tags || []).some(
      t => String(t.tag || '').trim().toLowerCase() === tagText
    );

    if (alreadyExists) {
      showTagError('tag already exists', xPx, yPx);
      removeTagOverlay();
      return;
    }

    const ix = (xPx - pz.x) / pz.scale;
    const iy = (yPx - pz.y) / pz.scale;

    const xRel = ix / wrap.width;
    const yRel = iy / wrap.height;

    showTags = true;
    tagToggleIcon.style.display = 'block';

    await saveTag(tagText, xRel, yRel);
    saved = true;

    clearTagElements();
    displayImageTags();
  }

  tagOverlay.addEventListener('keydown', async (e) => {
    e.stopPropagation();

    if (e.key === 'Enter' || e.key === 'NumpadEnter') {
      e.preventDefault();
      await saveIfNeeded();
      removeTagOverlay();
    }

    if (e.key === 'Escape') {
      removeTagOverlay();
    }
  });

  tagOverlay.addEventListener('click', (e) => e.stopPropagation());

  tagOverlay.addEventListener('blur', () => {
    removeTagOverlay();
  });
}

function removeTagOverlay() {
  if (tagOverlay) {
    tagOverlay.remove();
    tagOverlay = null;
  }
}

function showTagError(message, xPx, yPx) {
  const el = document.createElement('div');
  el.className = 'tag-error';
  el.textContent = message;

  imageWrapper.appendChild(el);

  const OFFSET = 6;
  el.style.left = `${xPx + OFFSET}px`;
  el.style.top  = `${yPx + OFFSET}px`;

  setTimeout(() => el.remove(), 1200);
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
  const candidates = [];
  candidates.push([0, 0]);

  for (let r = step; r <= maxRadius; r += step) {
    candidates.push([ r, 0], [-r, 0], [0, r], [0, -r]);
    candidates.push([ r, r], [ r,-r], [-r, r], [-r,-r]);
    candidates.push([ r/2,  r], [-r/2,  r], [ r/2, -r], [-r/2, -r]);
    candidates.push([ r,  r/2], [ r, -r/2], [-r,  r/2], [-r, -r/2]);
  }

  const w = el.offsetWidth;
  const h = el.offsetHeight;

  for (const [dx, dy] of candidates) {
    let left = startLeft + dx;
    let top  = startTop  + dy;

    left = Math.max(2, Math.min(left, wrapRect.width  - w - 2));
    top  = Math.max(2, Math.min(top,  wrapRect.height - h - 2));

    const testRect = { left, top, right: left + w, bottom: top + h };

    let ok = true;
    for (const o of others) {
      const oRect = {
        left: o.offsetLeft,
        top: o.offsetTop,
        right: o.offsetLeft + o.offsetWidth,
        bottom: o.offsetTop + o.offsetHeight
      };
      if (rectsOverlap(testRect, oRect, 2)) { ok = false; break; }
    }

    if (ok) return { left, top };
  }

  return {
    left: Math.max(2, Math.min(startLeft, wrapRect.width  - w - 2)),
    top:  Math.max(2, Math.min(startTop,  wrapRect.height - h - 2))
  };
}

/* ---------- SAVE TAG TO SUPABASE ---------- */
async function saveTag(tag, x, y) {
  const img = images[currentIndex];

  const { data, error } = await supabase
    .from('image_tags')
    .insert([{ image_id: img.id, tag, x, y }])
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === '23505') return;
    console.error('saveTag error:', error);
    return;
  }

  if (!data) return;

  img.tags = img.tags || [];
  img.tags.push(data);

  tagToggleIcon.style.display = 'block';
  renderGallery();
  updateGalleryTagList();
}

/* ---------- DISPLAY EXISTING TAGS ---------- */
function displayImageTags() {
  const img = images[currentIndex];
  const rect = imageWrapper.getBoundingClientRect();

  (img.tags || []).forEach(t => {
    const baseX = t.x * rect.width;
    const baseY = t.y * rect.height;

    const xPx = baseX * pz.scale + pz.x;
    const yPx = baseY * pz.scale + pz.y;

    createTagElement(t.tag, xPx, yPx);
  });
}

/* ---------- TAG TOGGLE ICON ---------- */
tagToggleIcon.addEventListener('click', (e) => {
  e.stopPropagation();
  showTags = !showTags;
  clearTagElements();
  if (showTags) displayImageTags();
});

/* ---------- GALLERY ---------- */
function renderGallery() {
  let filtered = images;
  const isFiltered = selectedGalleryTags.size > 0;

  if (isFiltered) {
    filtered = images.filter(img =>
      [...selectedGalleryTags].every(tag =>
        (img.tags || []).some(t => t.tag === tag)
      )
    );

    setColsForImageCount(filtered.length);
  } else {
    initGalleryCols();
  }

  galleryGrid.classList.toggle('single-image', filtered.length === 1);

let finalList = filtered;

// ✅ If we have a saved order, reuse it (no reshuffle)
if (Array.isArray(galleryOrderIds) && galleryOrderIds.length) {
  const byId = new Map(finalList.map(img => [String(img.id), img]));
  const ordered = [];

  galleryOrderIds.forEach(id => {
    const img = byId.get(String(id));
    if (img) ordered.push(img);
    byId.delete(String(id));
  });

  for (const img of byId.values()) ordered.push(img);

  finalList = ordered;
} else {
  finalList = shuffleArray(finalList);
}

galleryGrid.innerHTML = finalList.map((img) => `
  <img src="${img.url}" loading="lazy" data-id="${img.id}" draggable="false" />
`).join('');

}

/* ---------- GALLERY TAG LIST ---------- */
function updateGalleryTagList() {
  // 1) GLOBAL counts + stable sort order
  const globalStats = new Map();

  images.forEach((img, imgIndex) => {
    (img.tags || []).forEach((t, tagIndex) => {
      const tag = String(t.tag || '').trim().toLowerCase();
      if (!tag) return;

      if (!globalStats.has(tag)) {
        globalStats.set(tag, { count: 0, firstSeenAt: imgIndex * 100000 + tagIndex });
      }
      globalStats.get(tag).count += 1;
    });
  });

  const allTagsSorted = [...globalStats.entries()]
    .sort((a, b) => {
      const A = a[1], B = b[1];
      if (B.count !== A.count) return B.count - A.count;
      return A.firstSeenAt - B.firstSeenAt;
    })
    .map(([tag]) => tag);

  // 2) Determine current "matching set" based on selected tags
  const selected = [...selectedGalleryTags];

  const matchingImages = selected.length === 0
    ? images
    : images.filter(img =>
        selected.every(tag => (img.tags || []).some(t => t.tag === tag))
      );

  // 3) For responsiveness: counts within matching set
  const matchingCounts = new Map(); // tag -> count within matchingImages
  matchingImages.forEach(img => {
    const seenInThisImage = new Set();
    (img.tags || []).forEach(t => {
      const tag = String(t.tag || '').trim().toLowerCase();
      if (!tag) return;
      // count per-image once (avoid double-count if duplicates ever exist)
      if (seenInThisImage.has(tag)) return;
      seenInThisImage.add(tag);

      matchingCounts.set(tag, (matchingCounts.get(tag) || 0) + 1);
    });
  });

  // 4) compatibility set (same as before)
  const compatible = new Set(matchingCounts.keys());

  // 5) render list with counts
  galleryTagList.innerHTML = allTagsSorted.map(tag => {
    const isSelected = selectedGalleryTags.has(tag);
    const isCompatible = compatible.has(tag);

    const classes = [
      isSelected ? 'selected' : '',
      (!isSelected && selected.length > 0 && !isCompatible) ? 'disabled' : ''
    ].filter(Boolean).join(' ');

    const globalCount = globalStats.get(tag)?.count || 0;

    // if there are active filters, show count within current matching set,
    // otherwise show global count
    const displayCount = (selected.length > 0)
      ? (matchingCounts.get(tag) || 0)
      : globalCount;

    return `<li class="${classes}" data-tag="${tag}">${tag} <span class="tag-count">(${displayCount})</span></li>`;
  }).join('');

  // 6) click handlers
  galleryTagList.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      if (li.classList.contains('disabled')) return;

      const tag = li.dataset.tag;
      if (selectedGalleryTags.has(tag)) selectedGalleryTags.delete(tag);
      else selectedGalleryTags.add(tag);

      galleryOrderIds = null; // reset order for new filter state
      updateGalleryTagList();
      renderGallery();
      pushSnapshot();
    });
  });
}

function scrollSelectedTagIntoView(offsetItems = 2) {
  if (!galleryTagList) return;

  requestAnimationFrame(() => {
    const selectedEl = galleryTagList.querySelector('li.selected');
    if (!selectedEl) return;

    const container = galleryTagList;
    const itemHeight = selectedEl.offsetHeight;
    const targetTop = selectedEl.offsetTop - itemHeight * offsetItems;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth'
    });
  });
}

/* ---------- SHOW/HIDE VIEWS ---------- */
function setActiveView(view) {
  localStorage.setItem('activeView', view);
  document.documentElement.dataset.view = view;
}

function showGallery(opts = {}) {
  setActiveView('gallery'); 
  taggingView.classList.add('hidden');
  galleryView.classList.remove('hidden');

  if (!opts.keepFilters) {
    selectedGalleryTags.clear();
    galleryOrderIds = null; // ✅ reset order
  }


  updateGalleryTagList();

  clearTagElements();
  removeTagOverlay();

  // ✅ if filters exist, keep whatever cols we already have;
  // otherwise initialize default cols
  if (selectedGalleryTags.size === 0) initGalleryCols();

  galleryGrid.classList.remove('single-image');
  renderGallery();

  // ✅ history
  if (!opts.fromHistory) pushSnapshot();
  else replaceSnapshot();
}

function showTagging(opts = {}) {
  setActiveView('tagging');    
  galleryView.classList.add('hidden');
  taggingView.classList.remove('hidden');

  clearTagElements();
  removeTagOverlay();

  // ✅ history
  if (!opts.fromHistory) pushSnapshot();
  else replaceSnapshot();
}

function goToGalleryFilteredByTag(tag) {
  setActiveView('gallery');

  selectedGalleryTags.clear();
  selectedGalleryTags.add(tag);

  showTags = false;
  clearTagElements();
  removeTagOverlay();

  taggingView.classList.add('hidden');
  galleryView.classList.remove('hidden');

  updateGalleryTagList();
  renderGallery();
  scrollSelectedTagIntoView();
}

/* ---------- EVENT LISTENERS ---------- */
nextBtn.addEventListener('click', () => {
  if (!images.length) return;
  goNextImage();
});

if (prevBtn) {
  prevBtn.addEventListener('click', () => {
    if (!images.length) return;
    goPrevImage();
  });
}

galleryBtn.addEventListener('click', showGallery);

/* ---------- INIT ---------- */
loadImages();


