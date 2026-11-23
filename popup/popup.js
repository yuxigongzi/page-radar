/* PageRadar popup. */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var state = null;
  var tab = null;
  var busy = false;

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message }); return; }
          resolve(res || { ok: false, error: 'empty response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function pageKey(u) {
    try {
      var x = new URL(u);
      return x.origin + x.pathname.replace(/\/+$/, '');
    } catch (e) { return String(u || ''); }
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || ''); }
  }

  function intervalLabel(h) {
    if (!h) h = 12;
    if (h >= 24 && h % 24 === 0) return '每 ' + (h / 24) + ' 天';
    return '每 ' + h + ' 小时';
  }

  function timeAgo(ts) {
    if (!ts) return '尚未检查';
    var d = Date.now() - ts;
    if (d < 45000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pageSubs() {
    if (!tab || !tab.url) return [];
    var key = pageKey(tab.url);
    return state.subs.filter(function (s) { return pageKey(s.url) === key; });
  }

  // ---- 主题 ----
  var THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };
  var THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' };
  var THEME_ICONS = {
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="8.3"/><path d="M12 3.7a8.3 8.3 0 0 1 0 16.6Z" fill="currentColor" stroke="none"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M6.2 6.2 4.6 4.6M19.4 19.4l-1.6-1.6M17.8 6.2l1.6-1.6M4.6 19.4l1.6-1.6"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z"/></svg>'
  };

  function themeMode() {
    var t = state && state.settings && state.settings.theme;
    return t === 'light' || t === 'dark' ? t : 'system';
  }

  function mediaLight() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); } catch (e) { return false; }
  }

  function applyTheme() {
    var mode = themeMode();
    var resolved = mode === 'system' ? (mediaLight() ? 'light' : 'dark') : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    var btn = $('#theme');
    if (btn) {
      btn.innerHTML = THEME_ICONS[mode] || THEME_ICONS.system;
      btn.title = '主题：' + THEME_LABEL[mode] + '（点击切换）';
    }
  }

  async function cycleTheme() {
    var next = THEME_CYCLE[themeMode()] || 'system';
    if (state && state.settings) state.settings.theme = next;
    applyTheme();
    await savePatch({ theme: next }, '主题：' + THEME_LABEL[next]);
  }

  function watchSystemTheme() {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () { if (themeMode() === 'system') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {}
  }

  function render() {
    applyTheme();
    var subs = state.subs || [];
    var unread = subs.filter(function (s) { return s.hasNew; }).length;

    var summary = $('#summary');
    if (!subs.length) summary.textContent = '还没有订阅，先框选一个板块';
    else if (unread) {
      summary.replaceChildren();
      var b = el('b', null, String(unread));
      summary.appendChild(b);
      summary.appendChild(document.createTextNode(' 个板块有更新 · 共 ' + subs.length + ' 个订阅'));
    } else {
      summary.textContent = '全部安静 · 共 ' + subs.length + ' 个订阅';
    }
    $('#total').textContent = String(subs.length);

    var url = tab && tab.url || '';
    var supported = /^https?:/i.test(url);
    $('#page-title').textContent = tab ? (tab.title || '当前页面') : '没有活动页面';
    $('#page-host').textContent = supported ? hostOf(url) : (url || '此页面不支持订阅');

    var list = supported ? pageSubs() : [];
    $('#page-count').textContent = list.length + ' 个订阅';
    var body = $('#page-subs');
    body.replaceChildren();
    for (var i = 0; i < list.length; i++) body.appendChild(subRow(list[i]));
    $('#page-empty').style.display = list.length ? 'none' : 'block';
    $('#page-subs').style.display = list.length ? 'flex' : 'none';

    $('#pick').disabled = !supported || busy;
    $('#check-page').disabled = !supported || busy || !list.length;

    var note = $('#page-note');
    note.classList.remove('show', 'warn');
    note.textContent = '';
    if (!supported && url) {
      note.textContent = '浏览器内部页面、扩展商店等页面无法注入脚本，请打开普通网页后使用。';
      note.classList.add('show', 'warn');
    }

    $('#interval').value = String(state.settings.intervalHours || 12);
    $('#startup').checked = !!state.settings.startupCheck;
    $('#notify').checked = !!state.settings.notify;
    $('#panel').checked = !!state.settings.panelEnabled;
  }

  function catOf(sub) {
    var cats = (state.settings && state.settings.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].id === sub.categoryId) return cats[i];
    return null;
  }

  function subRow(sub) {
    var row = el('div', 'sub');
    row.title = '点击预览最近内容';
    var cat = catOf(sub);
    var on = sub.enabled !== false;
    if (!on) row.classList.add('off');
    var dot = el('span', 'dot' + (sub.err ? ' err' : (sub.hasNew && on ? ' new' : '')));
    if (cat && !sub.err && !sub.hasNew) {
      dot.style.background = cat.color;
      dot.style.boxShadow = '0 0 8px ' + cat.color + '99';
    }
    if (!on) {
      dot.style.background = '#4b5563';
      dot.style.boxShadow = 'none';
    }
    var main = el('div', 'sub-main');
    main.appendChild(el('div', 'sub-name', sub.name || hostOf(sub.url)));
    var meta = el('div', 'sub-meta' + (sub.err ? ' err' : ''));
    var kws = sub.keywords || [];
    var hits = sub.hits || [];
    if (!on) meta.textContent = '已暂停 · 不参与定时检查';
    else if (sub.err) meta.textContent = '检查失败：' + sub.err;
    else meta.textContent = (hits.length
      ? '关键词命中：' + hits.join('、')
      : (sub.hasNew
        ? timeAgo(sub.lastChangeAt) + '发现更新'
        : (sub.checkedAt ? timeAgo(sub.checkedAt) + '已检查' : '等待首次检查'))) +
      ' · ' + intervalLabel(sub.intervalHours || state.settings.intervalHours);
    main.appendChild(meta);
    if (sub.note) {
      var noteEl = el('div', 'sub-note', sub.note);
      noteEl.title = '备注：' + sub.note;
      main.appendChild(noteEl);
    }
    row.appendChild(dot);
    row.appendChild(main);
    if (cat) {
      var pill = el('span', 'pill-cat');
      var pdot = el('i');
      pdot.style.background = cat.color;
      pill.appendChild(pdot);
      pill.appendChild(document.createTextNode(cat.name));
      row.appendChild(pill);
    }
    if (!on) row.appendChild(el('span', 'badge off', '暂停'));
    else if (sub.hasNew) row.appendChild(el('span', 'badge', sub.addedCount ? '+' + sub.addedCount : '新'));
    if (on && kws.length) {
      var kwPill = el('span', 'badge kw' + (hits.length ? ' hit' : ''), hits.length ? '词: ' + hits[0] : '词 ' + kws.length);
      kwPill.title = '关键词：' + kws.join('、');
      row.appendChild(kwPill);
    }
    row.addEventListener('click', function () { openPreview(sub.id); });
    return row;
  }

  // ---------------------------------------------------------------- preview

  var pvId = null;

  function pvItem(it, added) {
    var url = it && it.url ? it.url : '';
    var node = document.createElement(url ? 'a' : 'div');
    node.className = 'pv-item' + (added ? ' added' : '');
    node.textContent = (it && it.title) || url || '(无标题)';
    if (url) {
      node.href = url;
      node.target = '_blank';
      node.rel = 'noreferrer';
      node.title = url;
    }
    return node;
  }

  async function openPreview(id) {
    pvId = id;
    document.body.dataset.view = 'preview';
    $('#pv-card').hidden = false;
    $('#pv-title').textContent = '正在读取…';
    $('#pv-meta').replaceChildren();
    $('#pv-body').replaceChildren(el('div', 'pv-note', '正在读取最近一次快照…'));
    $('#pv-check').dataset.id = id;
    var res = await send({ type: 'get-preview', id: id });
    if (pvId !== id) return;
    if (!res.ok) {
      $('#pv-title').textContent = '无法预览';
      $('#pv-body').replaceChildren(el('div', 'pv-note', res.error || '读取失败'));
      return;
    }
    renderPreview(res);
  }

  function closePreview() {
    pvId = null;
    document.body.removeAttribute('data-view');
    $('#pv-card').hidden = true;
  }

  function renderPreview(res) {
    var sub = res.sub || {};
    var pv = res.preview || null;
    var cat = res.category;

    $('#pv-title').textContent = sub.name || hostOf(sub.url);

    var meta = $('#pv-meta');
    meta.replaceChildren();
    if (cat) {
      var pill = el('span', 'pill-cat');
      var dot = el('i');
      dot.style.background = cat.color;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(cat.name));
      meta.appendChild(pill);
    }
    if (sub.err) meta.appendChild(el('span', 'err', '检查失败'));
    else meta.appendChild(el('span', null, pv && pv.at ? timeAgo(pv.at) + '检查' : '尚未检查'));
    if (pv) {
      meta.appendChild(el('span', null, '·'));
      meta.appendChild(el('span', null, (pv.total || 0) + ' 条 · ' + (pv.textLen || 0) + ' 字'));
    }
    if (sub.keywords && sub.keywords.length) {
      var kwPill = el('span', 'pill-kw' + (sub.hits && sub.hits.length ? ' hit' : ''));
      kwPill.textContent = sub.hits && sub.hits.length
        ? '命中：' + sub.hits.join('、')
        : '关键词 ' + sub.keywords.length + ' 个';
      meta.appendChild(kwPill);
    }

    $('#pv-check').dataset.id = sub.id;
    $('#pv-open').onclick = function () {
      chrome.tabs.create({ url: sub.url });
      window.close();
    };

    var body = $('#pv-body');
    body.replaceChildren();
    if (sub.err) {
      body.appendChild(el('div', 'pv-note', '上次检查失败：' + sub.err));
      return;
    }
    if (!pv) {
      body.appendChild(el('div', 'pv-note', '还没有快照。等第一次检查完成后再来看看。'));
      return;
    }
    var sample = (sub.lastDiff && sub.lastDiff.sample) || [];
    var sampleTitles = sample.map(function (it) { return it.title; });
    var kwHits = sub.hits || [];
    if (kwHits.length) {
      body.appendChild(el('h4', null, '关键词命中 · ' + kwHits.length + ' 个'));
      var kwLine = el('div', 'pv-kwline');
      kwHits.forEach(function (k) { kwLine.appendChild(el('span', 'kw-chip', k)); });
      body.appendChild(kwLine);
      (pv.items || []).forEach(function (it) {
        if (sampleTitles.indexOf(it.title) >= 0) return;
        var t = String(it.title || '').toLowerCase();
        for (var i = 0; i < kwHits.length; i++) {
          if (t.indexOf(String(kwHits[i]).toLowerCase()) >= 0) {
            body.appendChild(pvItem(it, true));
            break;
          }
        }
      });
    }
    if (sample.length) {
      var sampleLabel = sub.lastDiff && sub.lastDiff.kind === 'keyword' ? '上次关键词命中' : '上次新增';
      body.appendChild(el('h4', null, sampleLabel + ' · ' + sample.length + ' 条'));
      sample.forEach(function (it) { body.appendChild(pvItem(it, true)); });
    }
    var rest = (pv.items || []).filter(function (it) {
      return sampleTitles.indexOf(it.title) < 0;
    });
    if (rest.length) {
      body.appendChild(el('h4', null, '最近条目'));
      rest.slice(0, 6).forEach(function (it) { body.appendChild(pvItem(it, false)); });
    }
    if (pv.excerpt) {
      body.appendChild(el('h4', null, '正文摘录'));
      body.appendChild(el('div', 'pv-excerpt', pv.excerpt));
    }
    if (!sample.length && !(pv.items || []).length && !pv.excerpt) {
      body.appendChild(el('div', 'pv-note', '这个板块暂时没有可预览的文字。'));
    }
  }

  function saved(text) {
    var n = $('#save-state');
    n.textContent = text || '已保存';
    n.classList.add('show');
    clearTimeout(saved.timer);
    saved.timer = setTimeout(function () { n.classList.remove('show'); }, 1400);
  }

  async function ensureContent(tabId) {
    try {
      var ping = await chrome.tabs.sendMessage(tabId, { type: 'PR_PING' });
      if (ping && ping.ok) return true;
    } catch (e) { /* inject below */ }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['shared/text.js', 'content/ui.js', 'content/extract.js', 'content/content.js']
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function startPicker() {
    if (!tab || !tab.id || busy) return;
    busy = true;
    render();
    var ok = await ensureContent(tab.id);
    if (!ok) {
      busy = false;
      render();
      var note = $('#page-note');
      note.textContent = '无法在当前页面启动框选，请刷新页面或换一个普通网页。';
      note.classList.add('show', 'warn');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PR_START_PICKER' });
      setTimeout(function () { window.close(); }, 180);
    } catch (e) {
      busy = false;
      render();
    }
  }

  async function checkPage() {
    if (!tab || busy) return;
    var list = pageSubs();
    if (!list.length) return;
    busy = true;
    render();
    var note = $('#page-note');
    note.textContent = '正在检查 ' + list.length + ' 个板块…';
    note.classList.add('show');
    var res = await send({ type: 'check-page', url: tab.url });
    busy = false;
    var fresh = await send({ type: 'get-state' });
    if (fresh.ok) state = fresh;
    render();
    if (res && res.ok) {
      var changed = (res.results || []).filter(function (r) { return r.ok && r.changed; }).length;
      note.textContent = changed ? (changed + ' 个板块有更新') : '检查完成，暂无变化';
      note.classList.add('show');
    } else {
      note.textContent = '检查失败：' + ((res && res.error) || '未知错误');
      note.classList.add('show', 'warn');
    }
  }

  async function savePatch(patch, text) {
    var res = await send({ type: 'save-settings', patch: patch });
    if (res && res.ok) {
      state.settings = res.settings;
      saved(text);
      render();
    }
  }

  async function checkPreview() {
    var btn = $('#pv-check');
    var id = btn.dataset.id;
    if (!id || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '检查中…';
    var res = await send({ type: 'check-now', id: id });
    btn.disabled = false;
    btn.textContent = '立即检查';
    if (res.ok) {
      saved(res.changed ? ('发现 ' + ((res.diff && res.diff.added) || 0) + ' 条更新') : '暂无变化');
      await openPreview(id);
      var fresh = await send({ type: 'get-state' });
      if (fresh && fresh.ok) { state = fresh; render(); }
    } else {
      saved('检查失败');
    }
  }

  function bind() {
    $('#theme').addEventListener('click', cycleTheme);
    $('#pv-back').addEventListener('click', closePreview);
    $('#pv-check').addEventListener('click', checkPreview);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.dataset.view === 'preview') closePreview();
    });
    $('#pick').addEventListener('click', startPicker);
    $('#check-page').addEventListener('click', checkPage);
    $('#open-options').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    $('#all-subs').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    $('#interval').addEventListener('change', function (e) {
      savePatch({ intervalHours: Number(e.target.value) }, '间隔已保存');
    });
    $('#startup').addEventListener('change', function (e) {
      savePatch({ startupCheck: e.target.checked }, '已保存');
    });
    $('#notify').addEventListener('change', function (e) {
      savePatch({ notify: e.target.checked }, '已保存');
    });
    $('#panel').addEventListener('change', function (e) {
      savePatch({ panelEnabled: e.target.checked }, '已保存');
    });
  }

  async function init() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0] || null;
    } catch (e) { tab = null; }
    var res = await send({ type: 'get-state' });
    if (!res || !res.ok) {
      $('#summary').textContent = '后台服务未响应，请重新加载扩展';
      return;
    }
    state = res;
    bind();
    watchSystemTheme();
    render();
  }

  init();
})();
