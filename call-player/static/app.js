// ── Config ────────────────────────────────────────────────────────────────────
const API = '';  // same origin — backend serves both frontend and API

const store = {
  appSecret: localStorage.getItem('appSecret') || '',
  sessionCookie: localStorage.getItem('sessionCookie') || '',
  calls: [],
  filteredCalls: [],
  nextCursor: null,
  currentCall: null,
  cues: [],
  activeCueIndex: -1,
  searchQuery: '',
  matchIndices: [],
  matchCursor: 0,
  speeds: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  speedIndex: 2,
  scrubbing: false,
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const setupScreen     = $('setup-screen');
const callsScreen     = $('calls-screen');
const playerScreen    = $('player-screen');
const settingsSheet   = $('settings-sheet');
const setupSubtitle   = $('setup-subtitle');
const secretForm      = $('secret-form');
const secretInput     = $('secret-input');
const secretSubmit    = $('secret-submit');
const setupError      = $('setup-error');
const setupErrorMsg   = $('setup-error-msg');
const setupSpinner    = $('setup-spinner');
const retryBtn        = $('retry-btn');
const callsList       = $('calls-list');
const callsLoading    = $('calls-loading');
const callsEmpty      = $('calls-empty');
const callsSearch     = $('calls-search');
const callsSearchClear = $('calls-search-clear');
const loadMoreWrap    = $('load-more-wrap');
const loadMoreBtn     = $('load-more-btn');
const settingsBtn     = $('settings-btn');
const sheetBackdrop   = $('sheet-backdrop');
const closeSettingsBtn = $('close-settings-btn');
const apiStatusDot    = $('api-status-dot');
const sessionCookieInput = $('session-cookie-input');
const saveSessionBtn  = $('save-session-btn');
const sessionStatus   = $('session-status');
const backBtn         = $('back-btn');
const callTitle       = $('call-title');
const callDate        = $('call-date');
const mediaArea       = $('media-area');
const video           = $('video');
const mediaLoading    = $('media-loading');
const noVideo         = $('no-video');
const openFathomLink  = $('open-fathom-link');
const videoOverlay    = $('video-overlay');
const overlayPlayBtn  = $('overlay-play-btn');
const controls        = $('controls');
const playPauseBtn    = $('play-pause');
const playIcon        = $('play-icon');
const pauseIcon       = $('pause-icon');
const skipBackBtn     = $('skip-back');
const skipFwdBtn      = $('skip-fwd');
const speedBtn        = $('speed-btn');
const progressWrap    = $('progress-bar-wrap');
const progressFill    = $('progress-fill');
const progressThumb   = $('progress-thumb');
const currentTimeEl   = $('current-time');
const totalTimeEl     = $('total-time');
const transcriptList  = $('transcript-list');
const transcriptLoading = $('transcript-loading');
const searchInput     = $('search-input');
const searchClear     = $('search-clear');
const searchNav       = $('search-nav');
const matchCount      = $('match-count');
const prevMatchBtn    = $('prev-match');
const nextMatchBtn    = $('next-match');

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (store.appSecret) headers['X-App-Secret'] = store.appSecret;
  if (store.sessionCookie) headers['X-Fathom-Session'] = store.sessionCookie;
  const resp = await fetch(API + path, { ...opts, headers });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw Object.assign(new Error(err.error || `HTTP ${resp.status}`), { status: resp.status });
  }
  return resp.json();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
showScreen(setupScreen);

async function boot() {
  setupSpinner.style.display = '';
  setupError.style.display = 'none';
  secretForm.style.display = 'none';

  try {
    const health = await apiFetch('/api/health');

    if (health.needs_secret && !health.authed) {
      setupSpinner.style.display = 'none';
      setupSubtitle.textContent = 'Enter your app password to continue.';
      secretForm.style.display = '';
      return;
    }

    if (!health.api_key_set) {
      showSetupError('FATHOM_API_KEY is not set on the server. See the setup guide.');
      return;
    }

    apiStatusDot.className = 'status-dot green';
    setupSpinner.style.display = 'none';
    await loadCalls(true);
    showScreen(callsScreen);
  } catch (e) {
    showSetupError(e.message || 'Could not connect to the server.');
  }
}

function showSetupError(msg) {
  setupSpinner.style.display = 'none';
  setupErrorMsg.textContent = msg;
  setupError.style.display = '';
}

secretSubmit.addEventListener('click', () => {
  store.appSecret = secretInput.value.trim();
  localStorage.setItem('appSecret', store.appSecret);
  boot();
});
secretInput.addEventListener('keydown', e => { if (e.key === 'Enter') secretSubmit.click(); });
retryBtn.addEventListener('click', boot);

boot();

// ── Screen management ─────────────────────────────────────────────────────────
function showScreen(screen) {
  [setupScreen, callsScreen, playerScreen].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ── Load calls ────────────────────────────────────────────────────────────────
async function loadCalls(reset = false) {
  if (reset) {
    store.calls = [];
    store.nextCursor = null;
    callsLoading.style.display = 'flex';
    callsEmpty.style.display = 'none';
    loadMoreWrap.style.display = 'none';
    renderCallCards([]);
  }

  try {
    const params = new URLSearchParams({ limit: 25 });
    if (store.nextCursor) params.set('cursor', store.nextCursor);
    const data = await apiFetch(`/api/calls?${params}`);

    store.calls = reset ? data.items : [...store.calls, ...data.items];
    store.nextCursor = data.next_cursor || null;

    callsLoading.style.display = 'none';
    filterAndRender();
    loadMoreWrap.style.display = store.nextCursor ? '' : 'none';
  } catch (e) {
    callsLoading.style.display = 'none';
    showSetupError(e.message);
    showScreen(setupScreen);
  }
}

loadMoreBtn.addEventListener('click', () => loadCalls(false));

// ── Filter + render calls ─────────────────────────────────────────────────────
callsSearch.addEventListener('input', () => {
  const q = callsSearch.value.trim();
  callsSearchClear.style.display = q ? '' : 'none';
  filterAndRender();
});
callsSearchClear.addEventListener('click', () => {
  callsSearch.value = '';
  callsSearchClear.style.display = 'none';
  filterAndRender();
});

function filterAndRender() {
  const q = callsSearch.value.trim().toLowerCase();
  store.filteredCalls = q
    ? store.calls.filter(c =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.calendar_invitees || []).some(p => (p.name || p.email || '').toLowerCase().includes(q))
      )
    : store.calls;

  callsEmpty.style.display = store.filteredCalls.length === 0 && !q ? 'flex' : 'none';
  if (store.filteredCalls.length === 0 && q) {
    callsEmpty.textContent = 'No calls match your search.';
    callsEmpty.style.display = 'flex';
  }
  renderCallCards(store.filteredCalls);
}

function renderCallCards(calls) {
  // Remove existing call cards (keep loading/empty divs)
  callsList.querySelectorAll('.date-group, .call-card').forEach(el => el.remove());

  if (!calls.length) return;

  // Group by date
  const groups = {};
  calls.forEach(call => {
    const d = new Date(call.scheduled_start_time || call.created_at);
    const label = dateGroupLabel(d);
    if (!groups[label]) groups[label] = [];
    groups[label].push(call);
  });

  const frag = document.createDocumentFragment();
  Object.entries(groups).forEach(([label, items]) => {
    const header = document.createElement('div');
    header.className = 'date-group';
    header.textContent = label;
    frag.appendChild(header);

    items.forEach(call => {
      const card = document.createElement('div');
      card.className = 'call-card';
      card.dataset.id = call.recording_id;

      const d = new Date(call.scheduled_start_time || call.created_at);
      const duration = callDuration(call);
      const participants = (call.calendar_invitees || [])
        .slice(0, 3)
        .map(p => p.name || p.email || '')
        .filter(Boolean);

      card.innerHTML = `
        <div class="card-main">
          <div class="card-title">${escapeHTML(call.title || 'Untitled Call')}</div>
          <div class="card-meta">
            <span>${formatCallTime(d)}</span>
            ${duration ? `<span class="meta-sep">·</span><span>${duration}</span>` : ''}
          </div>
          ${participants.length ? `<div class="card-participants">${participants.map(p => `<span class="participant-chip">${escapeHTML(p)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="card-chevron">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      `;

      card.addEventListener('click', () => openCall(call));
      frag.appendChild(card);
    });
  });

  callsList.appendChild(frag);
}

// ── Settings sheet ────────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', openSettings);
sheetBackdrop.addEventListener('click', closeSettings);
closeSettingsBtn.addEventListener('click', closeSettings);

function openSettings() {
  sessionCookieInput.value = store.sessionCookie;
  settingsSheet.style.display = '';
  requestAnimationFrame(() => settingsSheet.classList.add('open'));
}

function closeSettings() {
  settingsSheet.classList.remove('open');
  setTimeout(() => { settingsSheet.style.display = 'none'; }, 300);
}

saveSessionBtn.addEventListener('click', async () => {
  const val = sessionCookieInput.value.trim();
  store.sessionCookie = val;
  localStorage.setItem('sessionCookie', val);
  sessionStatus.textContent = val ? 'Saved. Video will use this session on next load.' : 'Cleared.';
  sessionStatus.className = 'session-status ok';
  setTimeout(() => { sessionStatus.textContent = ''; }, 3000);
});

// ── Open a call ───────────────────────────────────────────────────────────────
async function openCall(call) {
  store.currentCall = call;
  store.cues = [];
  store.activeCueIndex = -1;
  store.searchQuery = '';

  callTitle.textContent = call.title || 'Untitled Call';
  callDate.textContent = formatCallDateTime(new Date(call.scheduled_start_time || call.created_at));

  // Reset player UI
  video.src = '';
  video.style.display = 'none';
  mediaLoading.style.display = 'flex';
  noVideo.style.display = 'none';
  videoOverlay.classList.remove('show');
  controls.style.display = 'none';
  playIcon.style.display = '';
  pauseIcon.style.display = 'none';
  searchInput.value = '';
  searchClear.style.display = 'none';
  searchNav.style.display = 'none';

  transcriptList.innerHTML = '';
  transcriptList.appendChild(transcriptLoading);
  transcriptLoading.style.display = 'flex';

  showScreen(playerScreen);

  // Load transcript + video in parallel
  const [transcriptResult, videoResult] = await Promise.allSettled([
    apiFetch(`/api/calls/${call.recording_id}/transcript`),
    apiFetch(`/api/calls/${call.recording_id}/video`),
  ]);

  // Transcript
  if (transcriptResult.status === 'fulfilled') {
    store.cues = buildCues(transcriptResult.value.transcript || []);
    renderTranscript();
  } else {
    transcriptLoading.style.display = 'none';
    transcriptList.innerHTML = '<div class="no-transcript"><p>Transcript unavailable</p></div>';
  }

  // Video
  mediaLoading.style.display = 'none';
  if (videoResult.status === 'fulfilled') {
    const vd = videoResult.value;
    if (vd.url) {
      loadVideo(vd.url);
    } else if (vd.share_url) {
      // fallback: no native video, show link
      openFathomLink.href = vd.share_url;
      noVideo.style.display = 'flex';
    } else {
      noVideo.style.display = 'flex';
    }
  } else {
    noVideo.style.display = 'flex';
  }
}

function loadVideo(url) {
  video.src = url;
  video.style.display = 'block';
  controls.style.display = '';
  videoOverlay.classList.add('show');
  video.load();
}

backBtn.addEventListener('click', () => {
  video.pause();
  video.src = '';
  showScreen(callsScreen);
});

// ── Transcript builder ────────────────────────────────────────────────────────
function buildCues(items) {
  const cues = items.map((item, i) => {
    const start = tsToSeconds(item.timestamp || '0:00');
    return {
      start,
      end: 0, // filled below
      text: item.text || '',
      speaker: (item.speaker?.display_name || item.speaker || '').trim(),
    };
  }).filter(c => c.text);

  // End time = next cue's start (or start + 30 for last)
  cues.forEach((c, i) => {
    c.end = (i + 1 < cues.length) ? cues[i + 1].start - 0.1 : c.start + 30;
  });

  return cues;
}

function tsToSeconds(ts) {
  if (typeof ts === 'number') return ts;
  const parts = String(ts).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(ts) || 0;
}

// ── Render transcript ─────────────────────────────────────────────────────────
function renderTranscript() {
  transcriptList.innerHTML = '';

  if (!store.cues.length) {
    transcriptList.innerHTML = '<div class="no-transcript"><p>No transcript available</p></div>';
    return;
  }

  const frag = document.createDocumentFragment();
  store.cues.forEach((cue, i) => {
    const el = document.createElement('div');
    el.className = 'cue';
    el.dataset.index = i;

    const timeEl = document.createElement('div');
    timeEl.className = 'cue-time';
    timeEl.textContent = formatTime(cue.start);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'cue-text';
    if (cue.speaker) {
      const sp = document.createElement('span');
      sp.className = 'speaker';
      sp.textContent = cue.speaker;
      bodyEl.appendChild(sp);
    }
    const textSpan = document.createElement('span');
    textSpan.className = 'cue-body';
    textSpan.textContent = cue.text;
    bodyEl.appendChild(textSpan);

    el.appendChild(timeEl);
    el.appendChild(bodyEl);
    el.addEventListener('click', () => {
      video.currentTime = cue.start;
      if (video.paused && video.src) video.play();
    });

    frag.appendChild(el);
  });

  transcriptList.appendChild(frag);
}

// ── Video events ──────────────────────────────────────────────────────────────
video.addEventListener('loadedmetadata', () => {
  totalTimeEl.textContent = formatTime(video.duration);
  updateProgress();
});

video.addEventListener('timeupdate', () => {
  if (!store.scrubbing) updateProgress();
  syncActiveCue();
});

video.addEventListener('play', () => {
  playIcon.style.display = 'none';
  pauseIcon.style.display = '';
  videoOverlay.classList.remove('show');
  setMediaSession();
});

video.addEventListener('pause', () => {
  playIcon.style.display = '';
  pauseIcon.style.display = 'none';
  showOverlayBriefly();
});

video.addEventListener('ended', () => {
  playIcon.style.display = '';
  pauseIcon.style.display = 'none';
});

video.addEventListener('error', () => {
  video.style.display = 'none';
  controls.style.display = 'none';
  noVideo.style.display = 'flex';
  if (store.currentCall) {
    const call = store.currentCall;
    openFathomLink.href = call.share_url || call.url || '#';
  }
});

video.addEventListener('click', togglePlay);
overlayPlayBtn.addEventListener('click', e => { e.stopPropagation(); togglePlay(); });

let overlayTimer;
function showOverlayBriefly() {
  videoOverlay.classList.add('show');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => {
    if (!video.paused) videoOverlay.classList.remove('show');
  }, 2200);
}

function togglePlay() {
  if (!video.src) return;
  video.paused ? video.play() : video.pause();
}

// ── Player controls ───────────────────────────────────────────────────────────
playPauseBtn.addEventListener('click', togglePlay);
skipBackBtn.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
skipFwdBtn.addEventListener('click', () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); });

speedBtn.addEventListener('click', () => {
  store.speedIndex = (store.speedIndex + 1) % store.speeds.length;
  const s = store.speeds[store.speedIndex];
  video.playbackRate = s;
  speedBtn.textContent = s === 1 ? '1×' : `${s}×`;
});

function updateProgress() {
  if (!video.duration) return;
  const pct = (video.currentTime / video.duration) * 100;
  progressFill.style.width = pct + '%';
  progressThumb.style.left = pct + '%';
  currentTimeEl.textContent = formatTime(video.currentTime);
}

function scrubToEvent(e) {
  const rect = progressWrap.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  video.currentTime = pct * (video.duration || 0);
  updateProgress();
}

progressWrap.addEventListener('mousedown', e => { store.scrubbing = true; scrubToEvent(e); });
progressWrap.addEventListener('touchstart', e => { store.scrubbing = true; scrubToEvent(e); }, { passive: true });
document.addEventListener('mousemove', e => { if (store.scrubbing) scrubToEvent(e); });
document.addEventListener('touchmove', e => { if (store.scrubbing) scrubToEvent(e); }, { passive: true });
document.addEventListener('mouseup', () => { store.scrubbing = false; });
document.addEventListener('touchend', () => { store.scrubbing = false; });

// ── Transcript sync ───────────────────────────────────────────────────────────
function syncActiveCue() {
  if (!store.cues.length) return;
  const t = video.currentTime;

  if (store.activeCueIndex >= 0) {
    const cur = store.cues[store.activeCueIndex];
    if (t >= cur.start && t <= cur.end) return;
  }

  let found = -1;
  let lo = 0, hi = store.cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = store.cues[mid];
    if (t < c.start) hi = mid - 1;
    else if (t > c.end) lo = mid + 1;
    else { found = mid; break; }
  }
  if (found === -1) {
    for (let i = store.cues.length - 1; i >= 0; i--) {
      if (store.cues[i].start <= t) { found = i; break; }
    }
  }

  if (found !== store.activeCueIndex) setActiveCue(found);
}

function setActiveCue(index) {
  const prev = store.activeCueIndex;
  store.activeCueIndex = index;
  if (prev >= 0) transcriptList.querySelector(`[data-index="${prev}"]`)?.classList.remove('active');
  if (index >= 0) {
    const el = transcriptList.querySelector(`[data-index="${index}"]`);
    if (el) { el.classList.add('active'); scrollCueIntoView(el); }
  }
}

function scrollCueIntoView(el) {
  const margin = 80;
  const elTop = el.offsetTop;
  const elBottom = elTop + el.offsetHeight;
  const viewTop = transcriptList.scrollTop;
  const viewBottom = viewTop + transcriptList.clientHeight;
  if (elTop < viewTop + margin) transcriptList.scrollTo({ top: elTop - margin, behavior: 'smooth' });
  else if (elBottom > viewBottom - margin) transcriptList.scrollTo({ top: elBottom - transcriptList.clientHeight + margin, behavior: 'smooth' });
}

// ── Transcript search ─────────────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  store.searchQuery = searchInput.value.trim();
  searchClear.style.display = store.searchQuery ? '' : 'none';
  runSearch();
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  store.searchQuery = '';
  searchClear.style.display = 'none';
  runSearch();
  searchInput.focus();
});

prevMatchBtn.addEventListener('click', () => {
  if (!store.matchIndices.length) return;
  store.matchCursor = (store.matchCursor - 1 + store.matchIndices.length) % store.matchIndices.length;
  jumpToMatch();
});
nextMatchBtn.addEventListener('click', () => {
  if (!store.matchIndices.length) return;
  store.matchCursor = (store.matchCursor + 1) % store.matchIndices.length;
  jumpToMatch();
});

function runSearch() {
  const q = store.searchQuery.toLowerCase();
  store.matchIndices = [];

  transcriptList.querySelectorAll('.cue').forEach(el => {
    el.classList.remove('search-match');
    const i = +el.dataset.index;
    const body = el.querySelector('.cue-body');
    if (body && store.cues[i]) body.innerHTML = escapeHTML(store.cues[i].text);
  });

  if (!q) { searchNav.style.display = 'none'; return; }

  store.cues.forEach((cue, i) => {
    if (cue.text.toLowerCase().includes(q)) store.matchIndices.push(i);
  });

  store.matchIndices.forEach(i => {
    const el = transcriptList.querySelector(`[data-index="${i}"]`);
    if (!el) return;
    el.classList.add('search-match');
    const body = el.querySelector('.cue-body');
    if (body) body.innerHTML = highlightText(store.cues[i].text, q);
  });

  if (store.matchIndices.length) {
    store.matchCursor = 0;
    searchNav.style.display = 'flex';
    matchCount.textContent = `1/${store.matchIndices.length}`;
    jumpToMatch(false);
  } else {
    searchNav.style.display = 'none';
  }
}

function jumpToMatch(seekVideo = true) {
  if (!store.matchIndices.length) return;
  const idx = store.matchIndices[store.matchCursor];
  matchCount.textContent = `${store.matchCursor + 1}/${store.matchIndices.length}`;
  const el = transcriptList.querySelector(`[data-index="${idx}"]`);
  if (el) transcriptList.scrollTo({ top: el.offsetTop - 80, behavior: 'smooth' });
  if (seekVideo && video.src) {
    video.currentTime = store.cues[idx].start;
    if (video.paused) video.play();
  }
}

// ── Media Session API (background audio on iOS) ───────────────────────────────
function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const call = store.currentCall;
  if (!call) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: call.title || 'Call Recording',
    artist: 'Fathom',
    album: 'Sales Calls',
  });
  navigator.mediaSession.setActionHandler('play', () => video.play());
  navigator.mediaSession.setActionHandler('pause', () => video.pause());
  navigator.mediaSession.setActionHandler('seekbackward', () => { video.currentTime -= 10; });
  navigator.mediaSession.setActionHandler('seekforward', () => { video.currentTime += 10; });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(s) {
  if (isNaN(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function formatCallTime(d) {
  const now = new Date();
  const diff = now - d;
  const sod = new Date(now); sod.setHours(0,0,0,0);
  const yesterday = new Date(sod); yesterday.setDate(sod.getDate() - 1);
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d >= sod) return `Today ${timeStr}`;
  if (d >= yesterday) return `Yesterday ${timeStr}`;
  if (diff < 7 * 86400000) return d.toLocaleDateString([], { weekday: 'long' }) + ` ${timeStr}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${timeStr}`;
}

function formatCallDateTime(d) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) +
         ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dateGroupLabel(d) {
  const now = new Date();
  const sod = new Date(now); sod.setHours(0,0,0,0);
  const yesterday = new Date(sod); yesterday.setDate(sod.getDate() - 1);
  const weekAgo = new Date(sod); weekAgo.setDate(sod.getDate() - 6);
  if (d >= sod) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  if (d >= weekAgo) return 'This Week';
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function callDuration(call) {
  const start = call.recording_start_time;
  const end = call.recording_end_time;
  if (!start || !end) return '';
  const secs = Math.round((new Date(end) - new Date(start)) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function highlightText(text, query) {
  return escapeHTML(text).replace(
    new RegExp(`(${escapeRegex(query)})`, 'gi'),
    '<mark>$1</mark>'
  );
}

function escapeHTML(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
