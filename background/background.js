/*
 * PageRadar service worker.
 *
 * Single writer for subscriptions. Content scripts only send intent
 * messages; every mutation lands here so scheduling and badges stay in sync.
 */
importScripts('../shared/text.js');

var T = self.__PRT;
var ALARM = 'pr:tick';
var CONCURRENCY = 3;
var FETCH_TIMEOUT = 25000;
var TAB_TIMEOUT = 30000;
var MIN_ALARM_DELAY = 30000;

var DEFAULT_SETTINGS = {
  intervalHours: 12,
  startupCheck: true,
  notify: true,
  onlyChanged: true,
  panelEnabled: true,
  panelSide: 'right',
  panelOpacity: 0.92,
  panelHiddenHosts: [],
  maxItems: 40,
  carryCategory: false,
  categories: []
};

// ---------------------------------------------------------------- utilities

function uid() {
  try { return crypto.randomUUID(); } catch (e) { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

function pageKey(u) {
  try {
    var x = new URL(u);
    return x.origin + x.pathname.replace(/\/+$/, '');
  } catch (e) {
    return String(u || '');
  }
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || ''); }
}

function localDay(d) {
  var x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------- categories

var CATEGORY_COLORS = ['#5ee0ff', '#6f8dff', '#3ddc97', '#f2994a', '#f05f8a', '#b98cff', '#f2c94c', '#56ccf2'];

function sanitizeCategories(list) {
  if (!Array.isArray(list)) return null;
  var out = [];
  var seen = {};
  for (var i = 0; i < list.length && out.length < 20; i++) {
    var c = list[i];
    if (!c || typeof c.name !== 'string') continue;
    var name = c.name.trim().slice(0, 20);
    if (!name) continue;
    var id = String(c.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || uid();
    if (seen[id]) continue;
    seen[id] = true;
    var color = /^#[0-9a-fA-F]{6}$/.test(String(c.color || ''))
      ? String(c.color).toLowerCase()
      : CATEGORY_COLORS[out.length % CATEGORY_COLORS.length];
    out.push({ id: id, name: name, color: color });
  }
  return out;
}

function validCategoryId(settings, id) {
  var cats = (settings && settings.categories) || [];
  for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return id;
  return '';
}

/** 只接受已知字段的设置补丁，导入备份时用，避免把脏数据写进设置。 */
function sanitizeImportedSettings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  var out = {};
  if (raw.intervalHours != null) {
    out.intervalHours = clamp(Math.round(Number(raw.intervalHours) || DEFAULT_SETTINGS.intervalHours), 1, 168);
  }
  ['startupCheck', 'notify', 'onlyChanged', 'panelEnabled', 'carryCategory'].forEach(function (k) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  });
  if (raw.panelSide === 'left' || raw.panelSide === 'right') out.panelSide = raw.panelSide;
  if (raw.panelOpacity != null) {
    out.panelOpacity = clamp(Number(raw.panelOpacity) || DEFAULT_SETTINGS.panelOpacity, 0.3, 1);
  }
  if (Array.isArray(raw.panelHiddenHosts)) {
    out.panelHiddenHosts = raw.panelHiddenHosts.filter(function (h) {
      return typeof h === 'string' && /^[a-z0-9.-]{1,120}$/i.test(h);
    }).slice(0, 200);
  }
  if (raw.maxItems != null) {
    out.maxItems = clamp(Math.round(Number(raw.maxItems) || DEFAULT_SETTINGS.maxItems), 10, 200);
  }
  if (Array.isArray(raw.categories)) {
    var cats = sanitizeCategories(raw.categories);
    if (cats) out.categories = cats;
  }
  return out;
}

/** Compact, storable slice of a snapshot, used by the preview surfaces. */
function previewOf(snap, limit) {
  var items = (snap.items || []).slice(0, limit || 12).map(function (i) {
    return { title: String(i.title || '').slice(0, 140), url: i.url || '' };
  });
  var text = String(snap.text || '');
  return {
    items: items,
    total: (snap.items || []).length,
    excerpt: text.length > 900 ? text.slice(0, 900) + '…' : text,
    textLen: snap.textLen || text.length,
    at: snap.at || 0,
    via: snap.via || ''
  };
}

/** Normalized keyword list for one subscription (max 12, each <= 24 chars). */
function sanitizeKeywords(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < 12; i++) {
    var s = String(list[i] == null ? '' : list[i]).replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!s) continue;
    var dup = false;
    for (var j = 0; j < out.length; j++) {
      if (out[j].toLowerCase() === s.toLowerCase()) { dup = true; break; }
    }
    if (!dup) out.push(s);
  }
  return out;
}

function keywordHit(text, k) {
  if (!text || !k) return false;
  return String(text).toLowerCase().indexOf(String(k).toLowerCase()) !== -1;
}

function sanitizeKeywordMode(v) {
  return v === 'all' ? 'all' : 'any';
}

function matchKeywords(kw, text, items, mode) {
  if (!kw.length) return [];
  var hits = [];
  kw.forEach(function (k) {
    if (keywordHit(text, k)) { hits.push(k); return; }
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      if (keywordHit(it.title, k) || keywordHit(it.url, k)) { hits.push(k); break; }
    }
  });
  // 「包含全部关键词」：缺一个就不算命中。
  if (sanitizeKeywordMode(mode) === 'all' && hits.length < kw.length) return [];
  return hits;
}

function intervalMs(sub, settings) {
  var h = Number(sub && sub.intervalHours) || Number(settings && settings.intervalHours) || 12;
  h = clamp(h, 1, 168);
  return h * 3600000;}

// 订阅上的「是否启用」开关：默认开启，只有显式 false 才算暂停。
function isOn(sub) {
  return !!sub && sub.enabled !== false;
}

function trimSub(sub) {
  return {
    id: sub.id, url: sub.url, name: sub.name, selector: sub.selector,
    candidates: sub.candidates, anchorText: sub.anchorText, tag: sub.tag
  };
}

// All read-modify-write cycles on {subs, snaps} go through this chain.
var chain = Promise.resolve();
function withLock(fn) {
  var p = chain.then(fn, fn);
  chain = p.then(function () {}, function () {});
  return p;
}

async function getSettings() {
  var all = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, all.settings || {});
}

async function getData() {
  var all = await chrome.storage.local.get(['subs', 'snaps', 'meta']);
  return {
    subs: Array.isArray(all.subs) ? all.subs : [],
    snaps: all.snaps && typeof all.snaps === 'object' ? all.snaps : {},
    meta: all.meta && typeof all.meta === 'object' ? all.meta : {}
  };
}

async function setMeta(patch) {
  return withLock(async function () {
    var data = await getData();
    var meta = Object.assign({}, data.meta, patch);
    await chrome.storage.local.set({ meta: meta });
    return meta;
  });
}

// ---------------------------------------------------------------- offscreen

var offscreenPromise = null;

function ensureOffscreen() {
  if (!offscreenPromise) {
    offscreenPromise = (async function () {
      try {
        if (chrome.offscreen.hasDocument) {
          var has = await chrome.offscreen.hasDocument();
          if (has) return true;
        }
        await chrome.offscreen.createDocument({
          url: 'offscreen/offscreen.html',
          reasons: ['DOM_PARSER'],
          justification: '解析抓取到的网页 HTML，定位订阅板块并比较更新'
        });
        return true;
      } catch (e) {
        offscreenPromise = null;
        throw e;
      }
    })();
  }
  return offscreenPromise;
}

async function parseHtml(html, opts) {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, reason: 'offscreen-unavailable', error: String(e && e.message || e) };
  }
  try {
    var res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse', html: html, opts: opts });
    return res || { ok: false, reason: 'offscreen-empty' };
  } catch (e) {
    offscreenPromise = null;
    return { ok: false, reason: 'offscreen-error', error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------- fetching

async function fetchHtml(url) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
  try {
    var resp = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'include',
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
      }
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    var ct = resp.headers.get('content-type') || '';
    if (ct && !/html|xml|text\/plain/i.test(ct)) return { ok: false, error: '不是网页内容（' + ct.split(';')[0] + '）' };
    var html = await resp.text();
    return { ok: true, html: html, finalUrl: resp.url };
  } catch (e) {
    var msg = e && e.name === 'AbortError' ? '请求超时' : String(e && e.message || e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function waitTabComplete(tabId, timeout) {
  return new Promise(function (resolve) {
    var start = Date.now();
    (function check() {
      chrome.tabs.get(tabId).then(function (tab) {
        if (tab && tab.status === 'complete') return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, 400);
      }).catch(function () { resolve(false); });
    })();
  });
}

async function parseViaTab(url, opts) {
  var tab = null;
  try {
    tab = await chrome.tabs.create({ url: url, active: false });
    var done = await waitTabComplete(tab.id, TAB_TIMEOUT);
    if (!done) return { ok: false, reason: 'tab-timeout' };
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['shared/text.js', 'content/extract.js']
    });
    // Poll for the section: client-rendered pages (and throttled background
    // tabs) may need longer than a fixed settle delay.
    var results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function (o) {
        var X = window.__PRX;
        if (!X) return { ok: false, reason: 'no-extractor' };
        var t0 = Date.now();
        var last = null;
        while (Date.now() - t0 < 6000) {
          last = X.extractFromDocument(document, o);
          if (last && last.ok && last.text && last.textLen >= 30) return last;
          await new Promise(function (r) { setTimeout(r, 300); });
        }
        return last || { ok: false, reason: 'empty' };
      },
      args: [opts]
    });
    var out = results && results[0] && results[0].result;
    return out || { ok: false, reason: 'no-result' };
  } catch (e) {
    return { ok: false, reason: 'tab-error', error: String(e && e.message || e) };
  } finally {
    if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* already gone */ } }
  }
}

function sectionOpts(sub) {
  return {
    selector: sub.selector,
    candidates: sub.candidates || [],
    anchor: sub.anchorText || '',
    tag: sub.tag || '',
    baseUrl: sub.url
  };
}

async function fetchSection(sub) {
  var opts = sectionOpts(sub);
  var fetched = await fetchHtml(sub.url);
  var parsed = null;
  if (fetched.ok) {
    parsed = await parseHtml(fetched.html, opts);
    if (parsed && parsed.ok && parsed.text && parsed.textLen >= 30) {
      return { ok: true, snapshot: parsed, via: 'fetch' };
    }
  }
  // Static HTML did not contain the section: render it in a real tab.
  var viaTab = await parseViaTab(sub.url, opts);
  if (viaTab && viaTab.ok && viaTab.text) {
    return { ok: true, snapshot: viaTab, via: 'tab' };
  }
  if (!fetched.ok) return { ok: false, error: fetched.error || '抓取失败', stage: 'fetch' };
  var reason = (parsed && (parsed.reason || parsed.error)) || '未找到板块';
  if (viaTab) {
    var tabWhy = viaTab.reason || viaTab.error;
    if (tabWhy) reason += '（后台渲染：' + tabWhy + '）';
  }
  return { ok: false, error: reason, stage: 'parse' };
}

// ---------------------------------------------------------------- diff

function computeDiff(prev, next, settings) {
  if (!prev) return { changed: false, first: true, added: 0, removed: 0, addedItems: [] };
  if (prev.hash === next.hash) return { changed: false, added: 0, removed: 0, addedItems: [] };
  var nhash = T.hashText(T.noiseKey(next.text));
  if (settings.onlyChanged && prev.nhash && prev.nhash === nhash) {
    return { changed: false, noise: true, added: 0, removed: 0, addedItems: [] };
  }
  var nextItems = next.items || [];
  var prevKeys = new Set(prev.itemKeys || []);
  var nextKeys = new Set();
  var addedItems = [];
  for (var i = 0; i < nextItems.length; i++) {
    nextKeys.add(nextItems[i].key);
    if (!prevKeys.has(nextItems[i].key)) addedItems.push(nextItems[i]);
  }
  var removed = 0;
  (prev.itemKeys || []).forEach(function (k) { if (!nextKeys.has(k)) removed++; });
  return { changed: true, added: addedItems.length, removed: removed, addedItems: addedItems, nhash: nhash };
}

// ---------------------------------------------------------------- checks

async function runCheck(sub, opts) {
  opts = opts || {};
  var settings = await getSettings();
  var res = await fetchSection(sub);
  var now = Date.now();

  if (!res.ok) {
    var backoff = Math.min(3600000, Math.max(600000, Math.floor(intervalMs(sub, settings) / 2)));
    var failed = await applyPatch(sub.id, {
      sub: { err: res.error, lastError: res.error, checkedAt: now, nextCheckAt: now + backoff }
    });
    return { ok: false, sub: failed || sub, error: res.error };
  }

  var snap = res.snapshot;
  var data = await getData();
  var prev = data.snaps[sub.id];
  var diff = computeDiff(prev, snap, settings);
  var firstValidation = !sub.validated;
  var changed = !!diff.changed && !firstValidation;
  var interval = intervalMs(sub, settings);

  // 关键词提醒：一旦设置，这个板块只在「关键词新命中」时提醒，普通更新不再提醒。
  var kw = sanitizeKeywords(sub.keywords);
  var kwMode = sanitizeKeywordMode(sub.keywordMode);
  var prevHits = Array.isArray(sub.hits) ? sub.hits : [];
  var hits = matchKeywords(kw, snap.text, snap.items, kwMode);
  var newHits = hits.filter(function (k) { return prevHits.indexOf(k) === -1; });
  var keywordMode = kw.length > 0;
  var hitNow = keywordMode && !firstValidation &&
    (kwMode === 'all' ? hits.length === kw.length && prevHits.length < kw.length : newHits.length > 0);
  var keepHit = keywordMode && !!sub.hasNew && hits.length > 0;
  var notify = keywordMode ? hitNow : changed;

  function sampleOf(list) {
    return (list || []).slice(0, 5).map(function (i) {
      return { title: String(i.title || '').slice(0, 140), url: i.url || '' };
    });
  }
  var sample = [];
  if (keywordMode) {
    sample = sampleOf((snap.items || []).filter(function (i) {
      return hits.some(function (k) { return keywordHit(i.title, k) || keywordHit(i.url, k); });
    }));
  } else {
    sample = sampleOf(diff.addedItems);
  }

  var preview = previewOf(snap);
  var nextSnap = {
    hash: snap.hash,
    nhash: T.hashText(T.noiseKey(snap.text)),
    itemKeys: (snap.items || []).map(function (i) { return i.key; }),
    items: preview.items,
    total: preview.total,
    excerpt: preview.excerpt,
    textLen: snap.textLen,
    at: now,
    via: res.via
  };

  var patch = {
    sub: {
      checkedAt: now,
      err: null,
      lastError: '',
      validated: true,
      nextCheckAt: now + interval,
      keywords: kw,
      keywordMode: kwMode,
      hits: hits,
      hitAt: newHits.length ? now : (sub.hitAt || 0),
      hasNew: keywordMode ? (hitNow || keepHit) : (changed ? true : !!sub.hasNew),
      addedCount: keywordMode
        ? (hitNow ? newHits.length : (keepHit ? (sub.addedCount || 0) : 0))
        : (changed ? (sub.addedCount || 0) + diff.added : (sub.addedCount || 0)),
      lastChangeAt: (changed || hitNow) ? now : (sub.lastChangeAt || 0),
      lastDiff: (changed || hitNow) ? {
        added: keywordMode ? newHits.length : diff.added,
        removed: keywordMode ? 0 : diff.removed,
        at: now,
        via: res.via,
        kind: keywordMode ? 'keyword' : 'change',
        matchMode: keywordMode ? kwMode : 'any',
        hits: hits,
        newHits: newHits,
        sample: sample
      } : (sub.lastDiff || null)
    }
  };

  var updated = await applyPatch(sub.id, patch, nextSnap);
  return {
    ok: true,
    sub: updated || sub,
    changed: changed,
    notify: notify,
    keywordMode: keywordMode,
    matchMode: kwMode,
    hits: hits,
    newHits: newHits,
    diff: diff,
    firstValidation: firstValidation,
    via: res.via
  };
}

async function applyPatch(subId, patch, snap) {
  return withLock(async function () {
    var data = await getData();
    var idx = -1;
    for (var i = 0; i < data.subs.length; i++) if (data.subs[i].id === subId) { idx = i; break; }
    if (idx === -1) return null;
    Object.assign(data.subs[idx], patch.sub || {});
    if (snap !== undefined) {
      if (snap) data.snaps[subId] = snap;
      else delete data.snaps[subId];
    }
    await chrome.storage.local.set({ subs: data.subs, snaps: data.snaps });
    return data.subs[idx];
  });
}

async function pool(items, limit, worker) {
  var results = new Array(items.length);
  var cursor = 0;
  async function drain() {
    while (cursor < items.length) {
      var idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  var lanes = [];
  for (var i = 0; i < Math.min(limit, items.length); i++) lanes.push(drain());
  await Promise.all(lanes);
  return results;
}

async function runChecks(subs, opts) {
  opts = opts || {};
  subs = (subs || []).filter(isOn);
  if (!subs.length) return [];
  var results = await pool(subs, CONCURRENCY, function (sub) {
    return runCheck(sub, opts).catch(function (e) {
      return { ok: false, sub: sub, error: String(e && e.message || e) };
    });
  });
  var settings = await getSettings();
  var changed = results.filter(function (r) { return r.ok && r.notify; });
  if (changed.length && settings.notify) await notifyChanged(changed);
  await updateBadge();
  return results;
}

async function runDueChecks(reason) {
  var data = await getData();
  var now = Date.now();
  var due = data.subs.filter(function (s) { return isOn(s) && (!s.nextCheckAt || s.nextCheckAt <= now + 60000); });
  if (!due.length) return [];
  var results = await runChecks(due, { reason: reason || 'alarm' });
  await reschedule();
  return results;
}

async function checkAll(reason) {
  var data = await getData();
  return runChecks(data.subs, { reason: reason || 'manual' });
}

async function checkPage(url, reason) {
  var data = await getData();
  var key = pageKey(url);
  var subs = data.subs.filter(function (s) { return pageKey(s.url) === key; });
  return runChecks(subs, { reason: reason || 'page' });
}

async function checkOne(id) {
  var data = await getData();
  var sub = null;
  for (var i = 0; i < data.subs.length; i++) if (data.subs[i].id === id) { sub = data.subs[i]; break; }
  if (!sub) return { ok: false, error: '订阅不存在' };
  if (!isOn(sub)) return { ok: false, error: '这个订阅已暂停，先勾选启用' };
  var res = await runCheck(sub, { reason: 'manual' });
  await updateBadge();
  if (res.ok && res.notify) {
    var settings = await getSettings();
    if (settings.notify) await notifyChanged([res]);
  }
  return res;
}

// ---------------------------------------------------------------- notify

async function notifyChanged(results) {
  var list = results.filter(function (r) { return r && r.sub && isOn(r.sub); }).slice(0, 3);
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var sub = r.sub;
    var message;
    if (r.keywordMode) {
      var words = (r.newHits && r.newHits.length ? r.newHits : r.hits || []).join('、');
      message = '关键词命中：' + words;
    } else {
      var added = r.diff ? r.diff.added : 0;
      message = added ? ('发现 ' + added + ' 条新内容') : '板块内容有更新';
    }
    if (r.sub && r.sub.name) message += ' · ' + r.sub.name;
    try {
      chrome.notifications.create('pr|' + sub.id + '|' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '页面更新雷达',
        message: message,
        contextMessage: hostOf(sub.url) + ' · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        priority: 1,
        silent: false
      });
    } catch (e) { /* notifications may be unavailable */ }
  }
}

async function updateBadge() {
  var data = await getData();
  var count = data.subs.filter(function (s) { return isOn(s) && s.hasNew; }).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' });
    if (chrome.action.setBadgeTextColor) {
      try { await chrome.action.setBadgeTextColor({ color: '#06121b' }); } catch (e) {}
    }
    await chrome.action.setBadgeText({ text: count ? (count > 99 ? '99+' : String(count)) : '' });
    await chrome.action.setTitle({ title: count ? '页面更新雷达 · ' + count + ' 个板块有更新' : '页面更新雷达' });
  } catch (e) { /* action unavailable in some contexts */ }
}

async function flashTab(tabId, sub) {
  var payload = { type: 'PR_FLASH', sub: trimSub(sub) };
  try {
    await chrome.tabs.sendMessage(tabId, payload);
    return true;
  } catch (e) { /* no content script yet */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['shared/text.js', 'content/ui.js', 'content/extract.js', 'content/content.js']
    });
    await new Promise(function (r) { setTimeout(r, 200); });
    await chrome.tabs.sendMessage(tabId, payload);
    return true;
  } catch (e) {
    return false;
  }
}

async function focusSub(sub) {
  var key = pageKey(sub.url);
  var tabs = await chrome.tabs.query({});
  var found = null;
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].url && pageKey(tabs[i].url) === key) { found = tabs[i]; break; }
  }
  if (found) {
    try { await chrome.tabs.update(found.id, { active: true }); } catch (e) {}
    if (found.windowId != null) {
      try { await chrome.windows.update(found.windowId, { focused: true }); } catch (e) {}
    }
    await flashTab(found.id, sub);
    return true;
  }
  var tab = await chrome.tabs.create({ url: sub.url, active: true });
  await waitTabComplete(tab.id, TAB_TIMEOUT);
  await flashTab(tab.id, sub);
  return true;
}

// ---------------------------------------------------------------- scheduling

async function reschedule() {
  var data = await getData();
  var live = data.subs.filter(isOn);
  if (!live.length) {
    try { await chrome.alarms.clear(ALARM); } catch (e) {}
    return;
  }
  var now = Date.now();
  var earliest = Infinity;
  for (var i = 0; i < live.length; i++) {
    var t = Number(live[i].nextCheckAt) || 0;
    if (t > 0 && t < earliest) earliest = t;
  }
  if (!isFinite(earliest)) earliest = now + 3600000;
  var when = Math.max(now + MIN_ALARM_DELAY, earliest);
  await chrome.alarms.create(ALARM, { when: when });
}

// ---------------------------------------------------------------- messages

async function handleCreateSub(msg) {
  if (!msg.url || !/^https?:/i.test(msg.url)) return { ok: false, error: '只能订阅 http/https 页面' };
  if (!msg.snapshot || !msg.snapshot.hash) return { ok: false, error: '缺少板块快照' };
  var settings = await getSettings();
  var now = Date.now();
  var key = pageKey(msg.url);
  var created = await withLock(async function () {
    var data = await getData();
    var existing = null;
    for (var i = 0; i < data.subs.length; i++) {
      var s = data.subs[i];
      if (pageKey(s.url) !== key) continue;
      var cands = s.candidates || [s.selector];
      if (cands.indexOf(msg.selector) !== -1 || (msg.candidates || []).indexOf(s.selector) !== -1) { existing = s; break; }
    }
    var id = existing ? existing.id : uid();
    var sub = existing || {
      id: id,
      url: msg.url,
      createdAt: now,
      hasNew: false,
      addedCount: 0,
      validated: false,
      err: null,
      lastError: '',
      lastChangeAt: 0,
      checkedAt: 0,
      lastDiff: null
    };
    sub.url = msg.url;
    sub.name = (msg.name || '').trim() || existing && existing.name || hostOf(msg.url);
    sub.pageTitle = msg.title || '';
    sub.selector = msg.selector || (msg.candidates || [])[0] || null;
    sub.candidates = msg.candidates || [];
    sub.tag = msg.tag || '';
    sub.anchorText = msg.anchorText || '';
    sub.intervalHours = Number(msg.intervalHours) || 0;
    sub.categoryId = validCategoryId(settings, msg.categoryId) || (existing && existing.categoryId) || '';
    sub.enabled = existing ? existing.enabled !== false : true;
    sub.keywords = sanitizeKeywords(msg.keywords);
    sub.keywordMode = sanitizeKeywordMode(msg.keywordMode);
    sub.hits = [];
    sub.hitAt = 0;
    sub.nextCheckAt = now + MIN_ALARM_DELAY;
    sub.validated = false;

    var basePreview = previewOf({
      items: msg.snapshot.items,
      text: msg.snapshot.text,
      textLen: msg.snapshot.textLen,
      at: now,
      via: 'picker'
    });
    data.snaps[id] = {
      hash: msg.snapshot.hash,
      nhash: T.hashText(T.noiseKey(msg.snapshot.text || '')),
      itemKeys: (msg.snapshot.items || []).map(function (i) { return i.key; }),
      items: basePreview.items,
      total: basePreview.total,
      excerpt: basePreview.excerpt,
      textLen: msg.snapshot.textLen || 0,
      at: now,
      via: 'picker'
    };
    if (!existing) data.subs.push(sub);
    data.subs.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    await chrome.storage.local.set({ subs: data.subs, snaps: data.snaps });
    return { sub: sub, created: !existing };
  });
  await reschedule();
  await updateBadge();
  return { ok: true, id: created.sub.id, created: created.created, sub: created.sub, settings: settings };
}

async function handleRemoveSub(id) {
  var removed = await withLock(async function () {
    var data = await getData();
    var next = data.subs.filter(function (s) { return s.id !== id; });
    if (next.length === data.subs.length) return false;
    delete data.snaps[id];
    await chrome.storage.local.set({ subs: next, snaps: data.snaps });
    return true;
  });
  await reschedule();
  await updateBadge();
  return { ok: true, removed: removed };
}

async function handleUpdateSub(msg) {
  var updated = await withLock(async function () {
    var data = await getData();
    var sub = null;
    for (var i = 0; i < data.subs.length; i++) if (data.subs[i].id === msg.id) { sub = data.subs[i]; break; }
    if (!sub) return null;
    if (typeof msg.name === 'string' && msg.name.trim()) sub.name = msg.name.trim().slice(0, 60);
    if (msg.intervalHours != null) {
      var h = Number(msg.intervalHours) || 0;
      sub.intervalHours = h ? clamp(h, 1, 168) : 0;
      sub.nextCheckAt = Date.now() + intervalMs(sub, await getSettings());
    }
    if (msg.url && /^https?:/i.test(msg.url)) sub.url = msg.url;
    if (msg.categoryId != null) {
      sub.categoryId = validCategoryId(await getSettings(), msg.categoryId);
    } else {
      sub.categoryId = sub.categoryId || '';
    }
    if (msg.enabled != null) {      var on = !!msg.enabled;
      if (on !== (sub.enabled !== false)) {
        sub.enabled = on;
        if (on) {
          sub.nextCheckAt = Date.now() + MIN_ALARM_DELAY;
        } else {
          sub.hasNew = false;
          sub.addedCount = 0;
        }
      } else {
        sub.enabled = on;
      }
    } else if (sub.enabled == null) {
      sub.enabled = true;
    }
    if (msg.keywords != null || msg.keywordMode != null) {
      var nextKw = msg.keywords != null ? sanitizeKeywords(msg.keywords) : sanitizeKeywords(sub.keywords);
      var nextMode = msg.keywordMode != null ? sanitizeKeywordMode(msg.keywordMode) : sanitizeKeywordMode(sub.keywordMode);
      var prevKw = sanitizeKeywords(sub.keywords);
      var prevMode = sanitizeKeywordMode(sub.keywordMode);
      var sameKw = prevKw.length === nextKw.length && prevKw.every(function (k, i) { return k === nextKw[i]; });
      sub.keywords = nextKw;
      sub.keywordMode = nextMode;
      if (!sameKw || prevMode !== nextMode) {
        sub.hits = [];
        sub.hasNew = false;
        sub.addedCount = 0;
      }
    } else {
      sub.keywords = sanitizeKeywords(sub.keywords);
      sub.keywordMode = sanitizeKeywordMode(sub.keywordMode);
      sub.hits = Array.isArray(sub.hits) ? sub.hits : [];
    }
    await chrome.storage.local.set({ subs: data.subs });
    return sub;
  });
  await reschedule();
  await updateBadge();
  return updated ? { ok: true, sub: updated } : { ok: false, error: '订阅不存在' };
}

async function handleSaveSettings(patch) {
  var settings = await getSettings();
  var next = Object.assign({}, settings);
  if (patch.intervalHours != null) next.intervalHours = clamp(patch.intervalHours, 1, 168);
  if (patch.startupCheck != null) next.startupCheck = !!patch.startupCheck;
  if (patch.notify != null) next.notify = !!patch.notify;
  if (patch.onlyChanged != null) next.onlyChanged = !!patch.onlyChanged;
  if (patch.panelEnabled != null) next.panelEnabled = !!patch.panelEnabled;
  if (patch.carryCategory != null) next.carryCategory = !!patch.carryCategory;
  if (patch.panelSide === 'left' || patch.panelSide === 'right') next.panelSide = patch.panelSide;
  if (patch.panelOpacity != null) next.panelOpacity = clamp(patch.panelOpacity, 0.3, 1);
  if (Array.isArray(patch.panelHiddenHosts)) next.panelHiddenHosts = patch.panelHiddenHosts.slice(0, 500);
  if (patch.maxItems != null) next.maxItems = clamp(patch.maxItems, 5, 200);
  if (Array.isArray(patch.categories)) {
    var cats = sanitizeCategories(patch.categories);
    if (cats) next.categories = cats;
  }
  await chrome.storage.local.set({ settings: next });

  // Drop subscriptions that point at a category that no longer exists.
  if (Array.isArray(patch.categories)) {
    var keepIds = next.categories.map(function (c) { return c.id; });
    await withLock(async function () {
      var d = await getData();
      var hit = false;
      d.subs.forEach(function (s) {
        if (s.categoryId && keepIds.indexOf(s.categoryId) === -1) { s.categoryId = ''; hit = true; }
      });
      if (hit) await chrome.storage.local.set({ subs: d.subs });
    });
  }

  // Re-space every pending check when the global interval changed.
  if (patch.intervalHours != null) {
    await withLock(async function () {
      var data = await getData();
      data.subs.forEach(function (s) {
        if (!s.intervalHours) s.nextCheckAt = Date.now() + intervalMs(s, next);
      });
      await chrome.storage.local.set({ subs: data.subs });
    });
  }
  await reschedule();
  return { ok: true, settings: next };
}

function normalizeImported(raw) {
  if (!raw || !Array.isArray(raw.subs)) throw new Error('数据格式不正确');
  var out = [];
  raw.subs.forEach(function (s) {
    if (!s || !/^https?:/i.test(s.url || '')) return;
    out.push({
      id: s.id || uid(),
      url: s.url,
      name: (s.name || '').slice(0, 60) || hostOf(s.url),
      pageTitle: s.pageTitle || '',
      selector: s.selector || null,
      candidates: Array.isArray(s.candidates) ? s.candidates.slice(0, 5) : [],
      tag: s.tag || '',
      anchorText: s.anchorText || '',
      intervalHours: Number(s.intervalHours) || 0,
      categoryId: typeof s.categoryId === 'string' ? s.categoryId : '',
      enabled: s.enabled !== false,
      keywords: sanitizeKeywords(s.keywords),
      keywordMode: sanitizeKeywordMode(s.keywordMode),
      hits: [],
      createdAt: s.createdAt || Date.now(),
      checkedAt: 0,
      lastChangeAt: 0,
      hasNew: false,
      addedCount: 0,
      validated: false,
      err: null,
      lastError: '',
      nextCheckAt: Date.now() + MIN_ALARM_DELAY,
      lastDiff: null
    });
  });
  return out;
}

async function handleMessage(msg, sender, sendResponse) {
  var res;
  try {
    switch (msg.type) {
      case 'get-state': {
        var data = await getData();
        res = { ok: true, settings: await getSettings(), subs: data.subs, now: Date.now() };
        break;
      }
      case 'get-preview': {
        var pvData = await getData();
        var pvSettings = await getSettings();
        var pvSub = null;
        for (var pi = 0; pi < pvData.subs.length; pi++) {
          if (pvData.subs[pi].id === msg.id) { pvSub = pvData.subs[pi]; break; }
        }
        if (!pvSub) { res = { ok: false, error: '订阅不存在' }; break; }
        var pvSnap = pvData.snaps[msg.id] || null;
        var pvCat = null;
        (pvSettings.categories || []).forEach(function (c) { if (c.id === pvSub.categoryId) pvCat = c; });
        res = {
          ok: true,
          sub: {
            id: pvSub.id,
            url: pvSub.url,
            name: pvSub.name,
            selector: pvSub.selector,
            checkedAt: pvSub.checkedAt || 0,
            lastChangeAt: pvSub.lastChangeAt || 0,
            hasNew: !!pvSub.hasNew,
            addedCount: pvSub.addedCount || 0,
            err: pvSub.err || null,
            lastDiff: pvSub.lastDiff || null,
            categoryId: pvSub.categoryId || '',
            intervalHours: pvSub.intervalHours || 0,
            enabled: pvSub.enabled !== false,
            keywords: sanitizeKeywords(pvSub.keywords),
            keywordMode: sanitizeKeywordMode(pvSub.keywordMode),
            hits: Array.isArray(pvSub.hits) ? pvSub.hits : []
          },
          category: pvCat,
          preview: pvSnap ? {
            items: (pvSnap.items || []).slice(0, clamp(msg.limit || 12, 3, 30)),
            total: pvSnap.total || (pvSnap.items || []).length,
            excerpt: String(pvSnap.excerpt || ''),
            textLen: pvSnap.textLen || 0,
            at: pvSnap.at || 0,
            via: pvSnap.via || ''
          } : null
        };
        break;
      }
      case 'create-sub':
        res = await handleCreateSub(msg);
        break;
      case 'remove-sub':
        res = await handleRemoveSub(msg.id);
        break;
      case 'update-sub':
        res = await handleUpdateSub(msg);
        break;
      case 'save-settings':
        res = await handleSaveSettings(msg.patch || {});
        break;
      case 'mark-seen': {
        var ids = Array.isArray(msg.ids) ? msg.ids : [];
        if (!ids.length) { res = { ok: true, changed: false }; break; }
        var changedSeen = await withLock(async function () {
          var d = await getData();
          var hit = false;
          d.subs.forEach(function (s) {
            if (ids.indexOf(s.id) !== -1 && (s.hasNew || s.addedCount)) {
              s.hasNew = false;
              s.addedCount = 0;
              hit = true;
            }
          });
          if (hit) await chrome.storage.local.set({ subs: d.subs });
          return hit;
        });
        await updateBadge();
        res = { ok: true, changed: changedSeen };
        break;
      }
      case 'site-panel': {
        var settings = await getSettings();
        var list = (settings.panelHiddenHosts || []).slice();
        var host = String(msg.host || '');
        var at = list.indexOf(host);
        if (msg.hidden && at === -1) list.push(host);
        if (!msg.hidden && at !== -1) list.splice(at, 1);
        await chrome.storage.local.set({ settings: Object.assign({}, settings, { panelHiddenHosts: list }) });
        res = { ok: true, panelHiddenHosts: list };
        break;
      }
      case 'check-now':
        res = await checkOne(msg.id);
        break;
      case 'check-page':
        res = { ok: true, results: await checkPage(msg.url || (sender.tab && sender.tab.url) || '', 'page') };
        break;
      case 'check-all':
        res = { ok: true, results: await checkAll('manual') };
        break;
      case 'open-options':
        chrome.runtime.openOptionsPage();
        res = { ok: true };
        break;
      case 'export-data': {
        var d2 = await getData();
        var exSubs = d2.subs;
        if (Array.isArray(msg.ids)) {
          var wantIds = {};
          msg.ids.forEach(function (id) { wantIds[id] = true; });
          exSubs = d2.subs.filter(function (s) { return wantIds[s.id]; });
        }
        res = { ok: true, settings: await getSettings(), subs: exSubs };
        break;
      }
      case 'import-data': {
        var imported = normalizeImported(msg.data);
        var d3 = await getData();
        var rawCats = msg.data && msg.data.settings && msg.data.settings.categories;
        if (Array.isArray(rawCats)) {
          var icats = sanitizeCategories(rawCats);
          if (icats) {
            await chrome.storage.local.set({ settings: Object.assign(await getSettings(), { categories: icats }) });
            var allowedCats = icats.map(function (c) { return c.id; });
            imported.forEach(function (s) {
              if (s.categoryId && allowedCats.indexOf(s.categoryId) === -1) s.categoryId = '';
            });
          }
        }
        d3.subs = imported;
        d3.snaps = {};
        await chrome.storage.local.set({ subs: d3.subs, snaps: d3.snaps });
        await reschedule();
        await updateBadge();
        res = { ok: true, count: imported.length };
        break;
      }
      case 'import-backup': {
        var backup = msg.data || {};
        var mode = msg.mode === 'replace' ? 'replace' : 'merge';
        var applySettings = msg.applySettings !== false;
        var rawSubs = Array.isArray(backup.subs) ? backup.subs : [];
        var incoming = normalizeImported({ subs: rawSubs });
        var settingsPatch = applySettings ? sanitizeImportedSettings(backup.settings) : {};

        var ibData = await getData();
        var keyOf = function (s) { return pageKey(s.url) + '|' + (s.selector || ''); };
        var existingByKey = {};
        ibData.subs.forEach(function (s) { existingByKey[keyOf(s)] = s; });
        var toAdd = [];
        var toUpdate = [];
        var seenKeys = {};
        incoming.forEach(function (s) {
          var k = keyOf(s);
          if (seenKeys[k]) return;
          seenKeys[k] = true;
          var hit = existingByKey[k];
          if (hit) toUpdate.push({ target: hit, sub: s });
          else toAdd.push(s);
        });

        var categories = Array.isArray(settingsPatch.categories) ? settingsPatch.categories : null;
        var summary = {
          mode: mode,
          applySettings: applySettings && Object.keys(settingsPatch).length > 0,
          total: rawSubs.length,
          add: toAdd.length,
          update: mode === 'replace' ? 0 : toUpdate.length,
          categories: categories ? categories.length : null,
          keywords: incoming.filter(function (s) { return s.keywords && s.keywords.length; }).length
        };
        if (msg.dryRun) {
          res = { ok: true, summary: summary };
          break;
        }

        if (applySettings) {
          var ibSettings = Object.assign({}, await getSettings(), settingsPatch);
          await chrome.storage.local.set({ settings: ibSettings });
          var allowed = (ibSettings.categories || []).map(function (c) { return c.id; });
          incoming.forEach(function (s) {
            if (s.categoryId && allowed.indexOf(s.categoryId) === -1) s.categoryId = '';
          });
        }

        var ibNext = ibData.subs.slice();
        var ibSnaps = ibData.snaps;
        if (mode === 'replace') {
          ibNext = incoming;
          ibSnaps = {};
        } else {
          toUpdate.forEach(function (u) {
            var t = u.target;
            var s = u.sub;
            var prevKw = (t.keywords || []).join('\u0001');
            t.name = s.name;
            t.categoryId = s.categoryId;
            t.intervalHours = s.intervalHours;
            t.keywords = s.keywords;
            t.keywordMode = s.keywordMode;
            t.enabled = s.enabled;
            if (prevKw !== s.keywords.join('\u0001')) {
              t.hits = [];
              t.hasNew = false;
              t.addedCount = 0;
            }
          });
          ibNext = ibNext.concat(toAdd);
        }
        await chrome.storage.local.set({ subs: ibNext, snaps: ibSnaps });
        await reschedule();
        await updateBadge();
        res = {
          ok: true,
          mode: mode,
          added: toAdd.length,
          updated: mode === 'replace' ? 0 : toUpdate.length,
          replaced: mode === 'replace' ? ibNext.length : 0,
          total: ibNext.length,
          count: ibNext.length
        };
        break;
      }
      case 'test-notify':
        try {
          chrome.notifications.create('pr-test', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: '页面更新雷达',
            message: '通知已开启，有更新时会这样提醒你。',
            priority: 1
          });
          res = { ok: true };
        } catch (e) {
          res = { ok: false, error: String(e && e.message || e) };
        }
        break;
      case 'reset-settings':
        await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
        await withLock(async function () {
          var dru = await getData();
          var hit = false;
          dru.subs.forEach(function (s) { if (s.categoryId) { s.categoryId = ''; hit = true; } });
          if (hit) await chrome.storage.local.set({ subs: dru.subs });
        });
        await reschedule();
        res = { ok: true, settings: DEFAULT_SETTINGS };
        break;
      default:
        res = { ok: false, error: 'unknown message: ' + msg.type };
    }
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e) };
  }
  sendResponse(res);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target === 'offscreen') return;
  if (!msg.type) return;
  handleMessage(msg, sender, sendResponse);
  return true;
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== ALARM) return;
  runDueChecks('alarm')
    .catch(function () {})
    .then(function () { setMeta({ lastTickAt: Date.now() }); });
});

chrome.runtime.onStartup.addListener(function () {
  maybeStartupCheck().catch(function () {}).then(reschedule);
});

chrome.runtime.onInstalled.addListener(function () {
  ensureDefaults().then(reschedule).catch(function () {});
});

chrome.notifications.onClicked.addListener(function (nid) {
  if (!nid || nid.indexOf('pr|') !== 0) return;
  var parts = nid.split('|');
  var subId = parts[1];
  (async function () {
    var data = await getData();
    var sub = null;
    for (var i = 0; i < data.subs.length; i++) if (data.subs[i].id === subId) { sub = data.subs[i]; break; }
    if (!sub) return;
    await focusSub(sub);
    await withLock(async function () {
      var d = await getData();
      var s = null;
      for (var j = 0; j < d.subs.length; j++) if (d.subs[j].id === subId) { s = d.subs[j]; break; }
      if (s && s.hasNew) {
        s.hasNew = false;
        s.addedCount = 0;
        await chrome.storage.local.set({ subs: d.subs });
      }
    });
    await updateBadge();
    try { chrome.notifications.clear(nid); } catch (e) {}
  })().catch(function () {});
});

// ---------------------------------------------------------------- boot

async function ensureDefaults() {
  var all = await chrome.storage.local.get(['settings', 'subs', 'snaps', 'meta']);
  var patch = {};
  if (!all.settings) patch.settings = DEFAULT_SETTINGS;
  else patch.settings = Object.assign({}, DEFAULT_SETTINGS, all.settings);
  if (!Array.isArray(all.subs)) patch.subs = [];
  if (!all.snaps || typeof all.snaps !== 'object') patch.snaps = {};
  if (!all.meta || typeof all.meta !== 'object') patch.meta = {};
  await chrome.storage.local.set(patch);
}

// "First launch of the day": run once per local day. Called both from
// chrome.runtime.onStartup and from boot(), because an extension that is loaded
// at browser start (unpacked / freshly installed) does not get onStartup.
async function maybeStartupCheck() {
  var settings = await getSettings();
  if (!settings.startupCheck) return { ran: false, reason: 'disabled' };
  var day = localDay();
  var data = await getData();
  if (data.meta.lastStartupDay === day) return { ran: false, reason: 'done-today' };
  await setMeta({ lastStartupDay: day, lastStartupCheckAt: Date.now() });
  await checkAll('startup');
  return { ran: true };
}

(async function boot() {
  await ensureDefaults();
  await maybeStartupCheck().catch(function () {});
  await updateBadge();
  await reschedule();
})().catch(function () {});

self.addEventListener('install', function () {});
