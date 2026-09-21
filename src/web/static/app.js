/*
 * ccfind web UI.
 *
 * Every piece of transcript text reaches the DOM through `textContent`, and
 * highlights are built by slicing that text with the structured ranges the API
 * returns. There is no `innerHTML`, `insertAdjacentHTML`, `document.write` or
 * `eval` anywhere in this file, and the page runs under a CSP with no
 * unsafe-inline, so a transcript containing markup or a script tag is inert.
 */

import { parseMarkdown } from './markdown.js';

const el = (id) => document.getElementById(id);

const SEARCH_DEBOUNCE_MS = 140;
const STATUS_POLL_MS = 1000;
const PAGE_SIZE = 200;
const MAX_SEEK_PAGES = 50;
const COLLAPSE_HEIGHT_PX = 760;

/* ------------------------------------------------------------------ utils */

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { Accept: 'application/json' } }, options));
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return data;
}

function relativeAge(ts) {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  if (days < 365) return Math.round(days / 30) + 'mo ago';
  return Math.round(days / 365) + 'y ago';
}

function formatDate(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `/Users/me/x` -> `~/x`; the home prefix is noise on a card and in the bar. */
function shortPath(cwd) {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/.exec(cwd || '');
  return match ? '~' + cwd.slice(match[0].length) : cwd;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

/** Appends `text` to `parent`, wrapping the given `[start, end)` ranges in <mark>. */
function appendHighlighted(parent, text, ranges) {
  const list = Array.isArray(ranges) ? ranges : [];
  const safe = list
    .filter(
      (r) =>
        Array.isArray(r) &&
        Number.isInteger(r[0]) &&
        Number.isInteger(r[1]) &&
        r[0] >= 0 &&
        r[1] > r[0] &&
        r[1] <= text.length,
    )
    .sort((a, b) => a[0] - b[0]);

  let cursor = 0;
  for (const range of safe) {
    if (range[0] < cursor) continue;
    if (range[0] > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, range[0])));
    const mark = node('mark', 'hl', text.slice(range[0], range[1]));
    parent.appendChild(mark);
    cursor = range[1];
  }
  parent.appendChild(document.createTextNode(text.slice(cursor)));
}

/** The one true way to say `matchCount`: it counts mentions, not phrase matches. */
function matchCountLabel(count) {
  return count === 1 ? '1 message mentions this' : count + ' messages mention this';
}

/* --------------------------------------------------------- markdown reader */

/** Appends styled runs. Every string lands through textContent. */
function appendSpans(parent, spans) {
  for (const span of spans) {
    if (span.type === 'strong') {
      parent.appendChild(node('strong', null, span.text));
    } else if (span.type === 'em') {
      parent.appendChild(node('em', null, span.text));
    } else if (span.type === 'code') {
      parent.appendChild(node('code', 'md-code', span.text));
    } else if (span.type === 'link') {
      // Shown, not clickable: a transcript link is somebody else's idea.
      parent.appendChild(document.createTextNode(span.text + ' (' + span.href + ')'));
    } else {
      parent.appendChild(document.createTextNode(span.text));
    }
  }
}

/**
 * Renders one message body. Used only in the reader: result snippets keep raw
 * text, because their highlight ranges index into exactly that text.
 */
function renderMarkdown(parent, text) {
  const tokens = parseMarkdown(typeof text === 'string' ? text : '');
  if (tokens.length === 0) {
    parent.textContent = typeof text === 'string' ? text : '';
    return;
  }
  for (const token of tokens) {
    if (token.type === 'code') {
      const pre = node('pre', 'md-pre');
      pre.appendChild(node('code', null, token.text));
      parent.appendChild(pre);
      continue;
    }
    if (token.type === 'heading') {
      // Bold line, not big type: a transcript has one headline and it is the title.
      const heading = node('p', 'md-heading');
      appendSpans(heading, token.spans);
      parent.appendChild(heading);
      continue;
    }
    if (token.type === 'list') {
      const list = node(token.ordered ? 'ol' : 'ul', 'md-list');
      for (const item of token.items) {
        const li = node('li', null);
        appendSpans(li, item);
        list.appendChild(li);
      }
      parent.appendChild(list);
      continue;
    }
    if (token.type === 'paragraph') {
      const paragraph = node('p', 'md-p');
      appendSpans(paragraph, token.spans);
      parent.appendChild(paragraph);
      continue;
    }
    parent.appendChild(node('p', 'md-p', token.text));
  }
}

function flash(button, message) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = message;
  window.setTimeout(() => {
    button.textContent = button.dataset.label || original;
  }, 1800);
}

function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  element.focus();
}

/* ----------------------------------------------------------- search page */

function initSearch() {
  const view = el('view-search');
  view.hidden = false;

  const input = el('q');
  const results = el('results');
  const statusLine = el('search-status');
  const hint = el('search-hint');
  const setupLine = el('setup-line');
  const noticeLine = el('notice-line');
  const filters = el('filters');
  const filtersToggle = el('filters-toggle');
  const folderSelect = el('f-folder');
  const sinceInput = el('f-since');
  const untilInput = el('f-until');

  // No mode: searching is always `auto`, which uses meaning as soon as the
  // embeddings exist and plain keywords until then.
  const state = { q: '', sort: 'relevance', cwd: '', since: '', until: '' };
  let statusInfo = null;
  let requestToken = 0;
  let debounceTimer = 0;
  let activeIndex = -1;
  let foldersLoaded = false;
  let pollTimer = 0;
  let lastCount = -1;

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    state.q = params.get('q') || '';
    state.sort = params.get('sort') === 'recent' ? 'recent' : 'relevance';
    state.cwd = params.get('cwd') || '';
    state.since = params.get('since') || '';
    state.until = params.get('until') || '';
  }

  function toQueryString() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.sort !== 'relevance') params.set('sort', state.sort);
    if (state.cwd) params.set('cwd', state.cwd);
    if (state.since) params.set('since', state.since);
    if (state.until) params.set('until', state.until);
    const qs = params.toString();
    return qs ? '/?' + qs : '/';
  }

  /** Typing replaces the entry; deliberate changes (sort, filters) push one. */
  function writeUrl(push) {
    const url = toQueryString();
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }

  function syncControls() {
    if (input.value !== state.q) input.value = state.q;
    for (const button of document.querySelectorAll('.sort')) {
      button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort));
    }
    folderSelect.value = state.cwd;
    sinceInput.value = state.since;
    untilInput.value = state.until;
    const filtersActive = Boolean(state.cwd || state.since || state.until);
    filtersToggle.textContent = filtersActive ? 'Filters ·' : 'Filters';
    if (filtersActive) filters.hidden = false;
    filtersToggle.setAttribute('aria-expanded', String(!filters.hidden));
  }

  function setStatus(message) {
    statusLine.textContent = message || '';
    statusLine.hidden = !message;
  }

  function renderCard(result, index) {
    const card = node('a', 'card');
    card.href = '/s/' + encodeURIComponent(result.sessionId) + (result.snippet.messageId ? '?m=' + encodeURIComponent(result.snippet.messageId) : '');
    card.dataset.index = String(index);

    card.appendChild(node('h2', 'card-title', result.title || result.sessionId));

    const meta = node('p', 'card-meta');
    const folder = node('span', 'mono', shortPath(result.cwd));
    folder.title = result.cwd;
    meta.appendChild(folder);
    if (!result.cwdExists) meta.appendChild(node('span', 'badge', 'folder missing'));
    const bits = [];
    const age = relativeAge(result.lastTs);
    if (age) bits.push(age);
    if (result.gitBranch) bits.push(result.gitBranch);
    // No query means nothing was searched for, so there is nothing to count.
    if (state.q && result.matchCount > 0) bits.push(matchCountLabel(result.matchCount));
    if (bits.length > 0) meta.appendChild(document.createTextNode(' · ' + bits.join(' · ')));
    card.appendChild(meta);

    if (result.snippet && result.snippet.text) {
      const snippet = node('p', 'card-snippet');
      snippet.appendChild(node('span', 'msg-role', result.snippet.role === 'user' ? 'You: ' : 'Claude: '));
      appendHighlighted(snippet, result.snippet.text, result.snippet.highlights);
      card.appendChild(snippet);
    }
    return card;
  }

  function render(list) {
    results.replaceChildren();
    activeIndex = -1;
    list.forEach((result, index) => results.appendChild(renderCard(result, index)));
    document.body.classList.toggle('has-results', list.length > 0);
    hint.hidden = list.length === 0;
  }

  function setActive(index) {
    const cards = results.querySelectorAll('.card');
    if (cards.length === 0) return;
    const next = Math.max(0, Math.min(cards.length - 1, index));
    cards.forEach((card) => card.classList.remove('is-active'));
    const card = cards[next];
    card.classList.add('is-active');
    card.scrollIntoView({ block: 'nearest' });
    activeIndex = next;
  }

  /** Nothing to show has three different reasons; only one of them is a problem. */
  function emptyMessage() {
    if (statusInfo && statusInfo.projectsDirExists === false) {
      return statusInfo.projectsDirHint || 'No Claude Code transcripts found.';
    }
    if (state.q) return 'No matching sessions.';
    return 'No sessions yet';
  }

  async function runSearch() {
    requestToken += 1;
    const token = requestToken;
    const params = new URLSearchParams();
    params.set('q', state.q);
    params.set('sort', state.sort);
    params.set('limit', '25');
    if (state.cwd) params.set('cwd', state.cwd);
    if (state.since) params.set('since', state.since);
    if (state.until) params.set('until', state.until);

    try {
      const list = await api('/api/search?' + params.toString());
      if (token !== requestToken) return; // a newer keystroke already won
      lastCount = list.length;
      render(list);
      if (list.length === 0) setStatus(emptyMessage());
      else setStatus(state.q ? '' : 'Recent sessions');
    } catch (err) {
      if (token !== requestToken) return;
      render([]);
      setStatus(err.message);
    }
  }

  function schedule() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  }

  /* ---- smart search, setting itself up ---- */

  /**
   * One quiet line under the results while embeddings are being built, and
   * nothing at all otherwise. There is no button: smart search is on by
   * default, and an install without the optional library never hears about it.
   */
  function renderSetupLine() {
    const semantic = (statusInfo && statusInfo.semantic) || null;
    const job = (statusInfo && statusInfo.embedding) || {};
    if (!semantic || !semantic.runtimeInstalled) {
      setupLine.hidden = true;
      return false;
    }
    if (job.error) {
      setupLine.textContent = 'Smart search could not start: ' + job.error;
      setupLine.hidden = false;
      return false;
    }
    const building = Boolean(job.running || (semantic.enabled && semantic.pendingChunks > 0));
    if (!building || semantic.totalChunks === 0) {
      setupLine.hidden = true;
      return false;
    }
    const ready = semantic.totalChunks - semantic.pendingChunks;
    setupLine.textContent =
      'Setting up smart search… ' +
      ready +
      '/' +
      semantic.totalChunks +
      '. Results get better when this finishes.';
    setupLine.hidden = false;
    return true;
  }

  /**
   * The server's one advisory sentence, in the same quiet line style as the
   * smart-search setup line. Set once at startup and never changed, so it
   * survives every embed-job state the setup line goes through. Plain text
   * only: `textContent` never interprets markup.
   */
  function renderNoticeLine() {
    const text = statusInfo && typeof statusInfo.notice === 'string' ? statusInfo.notice : '';
    noticeLine.textContent = text;
    noticeLine.hidden = text === '';
  }

  async function loadStatus() {
    try {
      statusInfo = await api('/api/status');
      syncControls();
      renderNoticeLine();
      const building = renderSetupLine();
      // The setup sentence only arrives with the status; apply it to an
      // already-rendered empty list.
      if (lastCount === 0) setStatus(emptyMessage());
      if (building) poll();
    } catch {
      /* status is advisory; keyword search still works */
    }
  }

  function poll() {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(loadStatus, STATUS_POLL_MS);
  }

  async function loadFolders() {
    if (foldersLoaded) return;
    foldersLoaded = true;
    try {
      const folders = await api('/api/folders');
      for (const folder of folders) {
        const option = node('option', null, folder.cwd + '  (' + folder.sessionCount + ')');
        option.value = folder.cwd;
        folderSelect.appendChild(option);
      }
      folderSelect.value = state.cwd;
    } catch {
      foldersLoaded = false;
    }
  }

  /* ---- events ---- */

  input.addEventListener('input', () => {
    state.q = input.value;
    writeUrl(false);
    schedule();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      window.clearTimeout(debounceTimer);
      writeUrl(true);
      runSearch();
    }
  });

  for (const button of document.querySelectorAll('.sort')) {
    button.addEventListener('click', () => {
      if (state.sort === button.dataset.sort) return;
      state.sort = button.dataset.sort;
      syncControls();
      writeUrl(true);
      runSearch();
    });
  }

  filtersToggle.addEventListener('click', () => {
    filters.hidden = !filters.hidden;
    filtersToggle.setAttribute('aria-expanded', String(!filters.hidden));
    if (!filters.hidden) loadFolders();
  });

  function filterChanged() {
    state.cwd = folderSelect.value;
    state.since = sinceInput.value;
    state.until = untilInput.value;
    syncControls();
    writeUrl(true);
    runSearch();
  }

  folderSelect.addEventListener('change', filterChanged);
  sinceInput.addEventListener('change', filterChanged);
  untilInput.addEventListener('change', filterChanged);

  el('f-clear').addEventListener('click', () => {
    folderSelect.value = '';
    sinceInput.value = '';
    untilInput.value = '';
    filterChanged();
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const isSearchBox = target === input;
    const typing =
      isSearchBox ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement;

    if (event.key === '/' && !typing) {
      event.preventDefault();
      input.focus();
      input.select();
      return;
    }
    // Arrow keys belong to the folder dropdown and the date fields when they
    // have focus; only the search box shares them with the result list.
    if (typing && !isSearchBox) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(activeIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(activeIndex <= 0 ? 0 : activeIndex - 1);
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      const card = results.querySelectorAll('.card')[activeIndex];
      if (card) {
        event.preventDefault();
        window.location.assign(card.getAttribute('href'));
      }
    }
    if (event.key === 'Escape' && document.activeElement === input && input.value !== '') {
      input.value = '';
      state.q = '';
      writeUrl(false);
      runSearch();
    }
  });

  window.addEventListener('popstate', () => {
    readUrl();
    syncControls();
    runSearch();
  });

  readUrl();
  syncControls();
  if (state.cwd) loadFolders();
  input.focus();
  runSearch();
  loadStatus();
}

/* ------------------------------------------------------- transcript page */

function initTranscript(sessionId) {
  const view = el('view-transcript');
  view.hidden = false;

  const header = el('transcript-header');
  const statusLine = el('transcript-status');
  const container = el('messages');
  const loadMore = el('load-more');

  const params = new URLSearchParams(window.location.search);
  const targetId = Number.parseInt(params.get('m') || '', 10);
  const targetTs = params.get('ts') || '';

  let offset = 0;
  let total = 0;
  let loading = false;
  let seeking = Number.isInteger(targetId) || targetTs !== '';
  let pagesLoaded = 0;
  let targetFound = false;

  function setStatus(message) {
    statusLine.textContent = message || '';
    statusLine.hidden = !message;
  }

  function renderHeader(session) {
    const title = session.title || sessionId;
    document.title = title + ' — ccfind';
    el('t-title').textContent = title;
    el('t-cwd').textContent = session.cwd;

    // The bar is what stays on screen, so it carries the two things you need
    // to know you are in the right place.
    el('bar-title').textContent = title;
    const barCwd = el('bar-cwd');
    barCwd.textContent = shortPath(session.cwd);
    barCwd.title = session.cwd;

    const dates = [];
    if (session.firstTs) dates.push(formatDate(session.firstTs));
    if (session.lastTs && formatDate(session.lastTs) !== dates[0]) dates.push(formatDate(session.lastTs));
    const meta = [dates.join(' – ')];
    if (session.gitBranch) meta.push(session.gitBranch);
    meta.push(session.messageCount + (session.messageCount === 1 ? ' message' : ' messages'));
    el('t-meta').textContent = meta.filter(Boolean).join(' · ');

    const missing = el('t-missing');
    missing.textContent = session.cwdExists
      ? ''
      : 'This folder no longer exists: ' + session.cwd + '\nThe resume command will fail until the folder is back.';
    missing.hidden = session.cwdExists;

    const resume = el('t-resume');
    resume.textContent = session.resumeCommand;

    const copy = el('copy-resume');
    copy.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(session.resumeCommand);
        flash(copy, 'Copied');
      } catch {
        selectText(resume);
        flash(copy, 'Press ⌘C to copy');
      }
    });

    header.hidden = false;
  }

  function renderMessage(message) {
    const wrapper = node('article', 'msg ' + (message.role === 'user' ? 'msg-user' : 'msg-assistant'));
    wrapper.dataset.id = String(message.id);
    wrapper.dataset.ts = message.ts || '';

    const head = node('p', 'msg-head');
    head.appendChild(node('span', 'msg-role', message.role === 'user' ? 'You' : 'Claude'));
    const when = formatTime(message.ts);
    if (when) head.appendChild(document.createTextNode(' · ' + when));
    wrapper.appendChild(head);

    const body = node('div', 'msg-body md-body');
    renderMarkdown(body, message.text);
    wrapper.appendChild(body);
    container.appendChild(wrapper);

    if (body.scrollHeight > COLLAPSE_HEIGHT_PX) {
      body.classList.add('is-collapsed');
      const more = node('button', 'ghost msg-more', 'Show more');
      more.type = 'button';
      more.addEventListener('click', () => {
        const collapsed = body.classList.toggle('is-collapsed');
        more.textContent = collapsed ? 'Show more' : 'Show less';
      });
      wrapper.appendChild(more);
    }
    return wrapper;
  }

  function highlightTarget(wrapper) {
    targetFound = true;
    seeking = false;
    wrapper.classList.add('is-target');
    // `start` plus the CSS scroll-margin is what keeps the message clear of
    // the fixed bar; `center` hides the top of a long one behind it.
    window.requestAnimationFrame(() => wrapper.scrollIntoView({ block: 'start' }));
    window.setTimeout(() => wrapper.classList.add('is-fading'), 1600);
  }

  function isTarget(message) {
    if (Number.isInteger(targetId)) return message.id === targetId;
    return targetTs !== '' && message.ts === targetTs;
  }

  async function loadPage() {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    try {
      const page = await api(
        '/api/sessions/' + encodeURIComponent(sessionId) + '?offset=' + offset + '&limit=' + PAGE_SIZE,
      );
      if (offset === 0) renderHeader(page.session);
      total = page.total;
      pagesLoaded += 1;

      for (const message of page.messages) {
        const wrapper = renderMessage(message);
        if (!targetFound && isTarget(message)) highlightTarget(wrapper);
      }
      offset += page.messages.length;

      if (page.total === 0) setStatus('This session has no indexed messages.');
      else setStatus(offset < total ? 'Showing ' + offset + ' of ' + total + ' messages' : '');
      loadMore.hidden = offset >= total;
    } catch (err) {
      header.hidden = offset === 0 ? true : header.hidden;
      setStatus(
        err.status === 404
          ? 'Session not found. It may have been removed from the index — try searching again.'
          : err.message,
      );
      loadMore.hidden = true;
      seeking = false;
      return;
    } finally {
      loading = false;
      loadMore.disabled = false;
    }

    // Keep paging while the linked message is still ahead of us.
    if (seeking && !targetFound && offset < total && pagesLoaded < MAX_SEEK_PAGES) loadPage();
  }

  loadMore.addEventListener('click', loadPage);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !loadMore.hidden && !loading) loadPage();
      }
    });
    observer.observe(loadMore);
  }

  loadPage();
}

/* --------------------------------------------------------------- routing */

function start() {
  const path = window.location.pathname;
  if (path.indexOf('/s/') === 0) {
    const id = decodeURIComponent(path.slice(3));
    if (id) {
      initTranscript(id);
      return;
    }
  }
  initSearch();
}

start();
