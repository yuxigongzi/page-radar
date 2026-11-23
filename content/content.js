/* PageRadar content script: picker, floating panel, toast, flash. */
(function () {
  'use strict';

  if (globalThis.__PR_LOADED__) return;
  globalThis.__PR_LOADED__ = true;

  var X = globalThis.__PRX;
  var UI = globalThis.__PR_UI;
  if (!X || !UI) return;

  var DEFAULTS = {
    intervalHours: 12,
    startupCheck: true,
    notify: true,
    onlyChanged: true,
    panelEnabled: true,
    panelSide: 'right',
    panelOpacity: 0.92,
    panelHiddenHosts: [],
    maxItems: 40
  };

  var state = {
    settings: null,
    subs: [],
    hover: false,
    pinned: false,
    pvOpen: false,
    picking: false,
    href: location.href,
    loading: false
  };

  var panelHost = null;
  var panelRefs = null;
  var seenTimer = null;
  var checking = false;

  // ---------------------------------------------------------------- helpers

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) n = lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function pageKey(u) {
    try {
      var x = new URL(u, location.href);
      return x.origin + x.pathname.replace(/\/+$/, '');
    } catch (e) {
      return String(u || '');
    }
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || ''); }
  }

  function timeAgo(ts) {
    if (!ts) return '尚未检查';
    var d = Date.now() - ts;
    if (d < 45000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 2592000000) return Math.floor(d / 86400000) + ' 天前';
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  function intervalLabel(sub) {
    var h = sub && sub.intervalHours ? sub.intervalHours : (state.settings ? state.settings.intervalHours : 12);
    if (h >= 24 && h % 24 === 0) return '每 ' + (h / 24) + ' 天';
    return '每 ' + h + ' 小时';
  }

  function applySheet(shadow, css) {
    try {
      if ('adoptedStyleSheets' in Document.prototype && typeof CSSStyleSheet === 'function') {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (e) { /* fall through */ }
    var st = document.createElement('style');
    st.textContent = css;
    shadow.appendChild(st);
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message || String(err) }); return; }
          resolve(res || { ok: false, error: 'empty response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function toast(msg, ms) {
    var host = document.getElementById('pr-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'pr-toast-host';
      var shadow = host.attachShadow({ mode: 'open' });
      applySheet(shadow, UI.TOAST_CSS);
      shadow.appendChild(el('div', 'toast'));
      (document.body || document.documentElement).appendChild(host);
    }
    var box = host.shadowRoot.querySelector('.toast');
    box.textContent = msg;
    // restart the transition
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    clearTimeout(host.__prTimer);
    host.__prTimer = setTimeout(function () {
      box.classList.remove('show');
      setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 260);
    }, ms || 2600);
  }

  // ---------------------------------------------------------------- panel

  function pageSubs() {
    var key = pageKey(location.href);
    return state.subs.filter(function (s) { return pageKey(s.url) === key; });
  }

  function ensurePanel() {
    if (panelHost && panelHost.isConnected) return;
    var host = document.createElement('div');
    host.id = 'pr-panel-host';
    host.dataset.side = 'right';
    host.dataset.open = 'false';
    var shadow = host.attachShadow({ mode: 'open' });
    applySheet(shadow, UI.PANEL_CSS);
    shadow.innerHTML = UI.PANEL_TPL;

    panelRefs = {
      shadow: shadow,
      count: shadow.querySelector('#pr-count'),
      body: shadow.querySelector('#pr-body'),
      pin: shadow.querySelector('[data-act="pin"]')
    };

    shadow.addEventListener('click', onPanelClick);
    host.addEventListener('pointerenter', function () {
      state.hover = true;
      syncOpen();
      scheduleSeen();
    });
    host.addEventListener('pointerleave', function () {
      state.hover = false;
      syncOpen();
    });

    (document.documentElement || document.body).appendChild(host);
    panelHost = host;
  }

  function destroyPanel() {
    if (!panelHost) return;
    if (panelHost.parentNode) panelHost.parentNode.removeChild(panelHost);
    panelHost = null;
    panelRefs = null;
  }

  function syncOpen() {
    if (!panelHost) return;
    panelHost.dataset.open = (state.hover || state.pinned || state.pvOpen) ? 'true' : 'false';
    if (panelRefs && panelRefs.pin) panelRefs.pin.classList.toggle('active', state.pinned);
  }

  function onPanelClick(e) {
    var pvAct = e.target.closest ? e.target.closest('[data-pv]') : null;
    if (pvAct) {
      e.stopPropagation();
      var pvActName = pvAct.getAttribute('data-pv');
      if (pvActName === 'check') {
        var checkId = pvAct.getAttribute('data-id');
        closePreview();
        if (checkId) refreshOne(checkId);
      } else if (pvActName === 'seen') {
        var seenId = pvAct.getAttribute('data-id');
        closePreview();
        if (seenId) markSeen([seenId]);
      } else {
        closePreview();
      }
      return;
    }
    var actBtn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (actBtn) {
      var act = actBtn.getAttribute('data-act');
      if (act === 'pin') {
        state.pinned = !state.pinned;
        syncOpen();
      } else if (act === 'close') {
        closePanelForSite();
      } else if (act === 'refresh') {
        refreshPage();
      } else if (act === 'pick') {
        state.pinned = true;
        syncOpen();
        startPicker();
      } else if (act === 'options') {
        send({ type: 'open-options' });
      }
      return;
    }
    var pvRow = e.target.closest ? e.target.closest('[data-row-preview]') : null;
    if (pvRow) {
      e.stopPropagation();
      openPreview(pvRow.getAttribute('data-row-preview'));
      return;
    }
    var refreshBtn = e.target.closest ? e.target.closest('[data-row-refresh]') : null;
    if (refreshBtn) {
      e.stopPropagation();
      var id = refreshBtn.getAttribute('data-row-refresh');
      refreshOne(id);
      return;
    }
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (row) {
      var sub = findSub(row.getAttribute('data-id'));
      if (sub) {
        flashSection(sub);
        markSeen([sub.id]);
      }
    }
  }

  function findSub(id) {
    for (var i = 0; i < state.subs.length; i++) if (state.subs[i].id === id) return state.subs[i];
    return null;
  }

  function closePanelForSite() {
    var host = location.hostname;
    state.hover = false;
    state.pinned = false;
    var list = state.settings ? (state.settings.panelHiddenHosts || []).slice() : [];
    if (list.indexOf(host) === -1) list.push(host);
    if (state.settings) state.settings.panelHiddenHosts = list;
    destroyPanel();
    send({ type: 'site-panel', host: host, hidden: true });
    toast('已关闭本站悬浮窗，可在扩展弹窗中重新开启');
  }

  function renderPanel() {
    var s = state.settings;
    if (!s || !s.panelEnabled) { destroyPanel(); return; }
    if ((s.panelHiddenHosts || []).indexOf(location.hostname) !== -1) { destroyPanel(); return; }
    var subs = pageSubs();
    if (!subs.length) { destroyPanel(); return; }

    ensurePanel();
    panelHost.dataset.side = s.panelSide === 'left' ? 'left' : 'right';
    panelHost.style.setProperty('--pr-opacity', String(clamp(s.panelOpacity == null ? 0.92 : s.panelOpacity, 0.3, 1)));
    panelRefs.count.textContent = String(subs.length);
    renderRows(subs);
    syncOpen();
  }

  function renderRows(subs) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < subs.length; i++) frag.appendChild(buildRow(subs[i]));
    panelRefs.body.replaceChildren(frag);
  }

  function buildRow(sub) {
    var row = el('div', 'row');
    row.setAttribute('data-id', sub.id);
    row.title = (sub.name || sub.pageTitle || hostOf(sub.url)) + '\n' + sub.url;
    var on = sub.enabled !== false;
    if (!on) row.classList.add('off');

    var dot = el('span', 'dot' + (sub.err ? ' err' : (sub.hasNew && on ? ' new' : '')));
    var cat = catOf(sub);
    if (cat && !sub.err && !sub.hasNew) {
      dot.style.background = cat.color;
      dot.style.boxShadow = '0 0 7px ' + tint(cat.color, 0.7);
    }
    if (!on) {
      dot.style.background = '#4b5563';
      dot.style.boxShadow = 'none';
    }
    var main = el('div', 'rowmain');
    var titleLine = el('div', 'rowtitle');
    titleLine.appendChild(el('div', 't', sub.name || sub.pageTitle || hostOf(sub.url)));
    if (!on) titleLine.appendChild(el('span', 'badge off', '暂停'));
    else if (sub.hasNew && !sub.err) {
      titleLine.appendChild(el('span', 'badge', sub.addedCount ? '+' + sub.addedCount : '新'));
    }
    var kws = sub.keywords || [];
    var hits = sub.hits || [];
    if (on && kws.length) {
      var kwBadge = el('span', 'badge kw' + (hits.length ? ' hit' : ''),
        hits.length ? '词: ' + hits[0] : '词 ' + kws.length);
      kwBadge.title = '关键词：' + kws.join('、');
      titleLine.appendChild(kwBadge);
    }
    main.appendChild(titleLine);

    var meta = el('div', 'meta' + (sub.err ? ' err' : ''));
    var bits = [];
    if (!on) {
      bits.push('已暂停 · 不参与定时检查');
    } else if (sub.err) {
      bits.push('检查失败');
      bits.push('·');
      bits.push(intervalLabel(sub));
    } else if (sub.hasNew) {
      bits.push(kws.length ? '关键词命中 · ' + timeAgo(sub.lastChangeAt) : timeAgo(sub.lastChangeAt) + '有更新');
      bits.push('·');
      bits.push(intervalLabel(sub));
    } else {
      bits.push(sub.checkedAt ? timeAgo(sub.checkedAt) + '已检查' : '等待首次检查');
      bits.push('·');
      bits.push(intervalLabel(sub));
    }
    for (var i = 0; i < bits.length; i++) {
      if (bits[i] === '·') meta.appendChild(el('span', 'sep', '·'));
      else meta.appendChild(el('span', null, bits[i]));
    }
    main.appendChild(meta);

    var btn = el('button', 'rowbtn' + (checking ? ' spin' : ''));
    btn.setAttribute('data-row-refresh', sub.id);
    btn.title = '立即检查';
    btn.innerHTML = UI.ICONS.refresh;

    var pvBtn = el('button', 'rowbtn');
    pvBtn.setAttribute('data-row-preview', sub.id);
    pvBtn.title = '预览最近内容';
    pvBtn.innerHTML = UI.ICONS.eye;

    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(pvBtn);
    row.appendChild(btn);
    return row;
  }

  function catOf(sub) {
    var cats = (state.settings && state.settings.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].id === sub.categoryId) return cats[i];
    return null;
  }

  function tint(color, alpha) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!m) return 'rgba(94,224,255,' + alpha + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function scheduleSeen() {
    var ids = pageSubs().filter(function (s) { return s.hasNew; }).map(function (s) { return s.id; });
    if (!ids.length) return;
    clearTimeout(seenTimer);
    seenTimer = setTimeout(function () { markSeen(ids); }, 1200);
  }

  function markSeen(ids) {
    if (!ids || !ids.length) return;
    send({ type: 'mark-seen', ids: ids }).then(function (res) {
      if (res && res.ok && res.changed) loadData();
    });
  }

  async function refreshPage() {
    if (checking) return;
    checking = true;
    if (panelHost) panelHost.dataset.checking = 'true';
    renderRows(pageSubs());
    var res = await send({ type: 'check-page', url: location.href });
    checking = false;
    if (panelHost) panelHost.dataset.checking = 'false';
    if (res && res.ok === false) toast('检查失败：' + (res.error || '未知错误'));
    await loadData();
  }

  async function refreshOne(id) {
    checking = true;
    renderRows(pageSubs());
    var res = await send({ type: 'check-now', id: id });
    checking = false;
    if (res && res.ok === false) toast('检查失败：' + (res.error || '未知错误'));
    await loadData();
  }

  // ---------------------------------------------------------------- preview

  function openPreview(id) {
    if (!panelRefs) return;
    var card = panelRefs.shadow.querySelector('#pr-pvx');
    if (!card) return;
    state.pvOpen = true;
    if (panelHost) panelHost.dataset.preview = 'true';
    syncOpen();
    card.setAttribute('data-show', 'true');
    card.setAttribute('data-id', id);
    card.replaceChildren(el('div', 'pvxnote', '正在读取最近一次快照…'));
    send({ type: 'get-preview', id: id }).then(function (res) {
      if (!card || !card.isConnected) return;
      if (card.getAttribute('data-id') !== id || card.getAttribute('data-show') !== 'true') return;
      if (!res || !res.ok) {
        card.replaceChildren(previewHead('预览', ''), el('div', 'pvxnote', (res && res.error) || '读取失败'));
        return;
      }
      renderPreview(card, res);
    });
  }

  function closePreview() {
    if (!panelRefs) return;
    var card = panelRefs.shadow.querySelector('#pr-pvx');
    if (!card) return;
    state.pvOpen = false;
    if (panelHost) delete panelHost.dataset.preview;
    syncOpen();
    card.setAttribute('data-show', 'false');
    card.removeAttribute('data-id');
  }

  function previewHead(title, subId) {
    var head = el('div', 'pvxhead');
    var back = el('button', 'ibtn');
    back.setAttribute('data-pv', 'back');
    back.title = '返回列表';
    back.innerHTML = UI.ICONS.back;
    head.appendChild(back);
    head.appendChild(el('div', 'pvxtitle', title));
    if (subId) {
      var check = el('button', 'ibtn');
      check.setAttribute('data-pv', 'check');
      check.setAttribute('data-id', subId);
      check.title = '立即检查';
      check.innerHTML = UI.ICONS.refresh;
      head.appendChild(check);
    }
    var close = el('button', 'ibtn danger');
    close.setAttribute('data-pv', 'close');
    close.title = '关闭';
    close.innerHTML = UI.ICONS.close;
    head.appendChild(close);
    return head;
  }

  function previewItem(it, added) {
    var url = it && it.url ? it.url : '';
    var node = document.createElement(url ? 'a' : 'div');
    node.className = 'pvxitem' + (added ? ' added' : '');
    node.textContent = (it && it.title) || url || '(无标题)';
    if (url) {
      node.href = url;
      node.target = '_blank';
      node.rel = 'noreferrer noopener';
      node.title = url;
    }
    return node;
  }

  function renderPreview(card, res) {
    var sub = res.sub || {};
    var pv = res.preview || null;
    var cat = res.category || catOf(sub);
    var frag = document.createDocumentFragment();

    frag.appendChild(previewHead(sub.name || hostOf(sub.url), sub.id));

    var meta = el('div', 'pvxmeta');
    if (cat) {
      var pill = el('span', 'pillcat');
      var cdot = el('i');
      cdot.style.background = cat.color;
      pill.appendChild(cdot);
      pill.appendChild(document.createTextNode(cat.name));
      meta.appendChild(pill);
    }
    if (sub.err) {
      meta.appendChild(el('span', null, '检查失败'));
    } else {
      meta.appendChild(el('span', null, pv && pv.at ? timeAgo(pv.at) + '检查' : '尚未检查'));
    }
    if (pv) {
      meta.appendChild(el('span', null, '·'));
      meta.appendChild(el('span', null, pv.via === 'tab' ? '后台渲染' : '直接抓取'));
      meta.appendChild(el('span', null, '·'));
      meta.appendChild(el('span', null, (pv.total || 0) + ' 条 · ' + (pv.textLen || 0) + ' 字'));
    }
    if (sub.keywords && sub.keywords.length) {
      var kwPill = el('span', 'pillkw' + (sub.hits && sub.hits.length ? ' hit' : ''));
      kwPill.textContent = sub.hits && sub.hits.length
        ? '命中：' + sub.hits.join('、')
        : '关键词 ' + sub.keywords.length + ' 个';
      kwPill.title = '关键词：' + sub.keywords.join('、');
      meta.appendChild(kwPill);
    }
    frag.appendChild(meta);

    var body = el('div', 'pvxbody');
    if (sub.err) {
      body.appendChild(el('div', 'pvxnote', '检查失败：' + sub.err));
    } else if (!pv) {
      body.appendChild(el('div', 'pvxnote', '还没有快照。等第一次检查完成后，这里会显示板块内容。'));
    } else {
      var sample = (sub.lastDiff && sub.lastDiff.sample) || [];
      var sampleTitles = sample.map(function (it) { return it.title; });
      var kwHits = sub.hits || [];
      if (kwHits.length) {
        var secK = el('div', 'pvxsec');
        secK.appendChild(el('h4', null, '关键词命中 · ' + kwHits.length + ' 个'));
        var kwLine = el('div', 'pvxkwline');
        kwHits.forEach(function (k) { kwLine.appendChild(el('span', 'pvxkwchip', k)); });
        secK.appendChild(kwLine);
        (pv.items || []).forEach(function (it) {
          if (sampleTitles.indexOf(it.title) >= 0) return;
          var t = String(it.title || '').toLowerCase();
          for (var i = 0; i < kwHits.length; i++) {
            if (t.indexOf(String(kwHits[i]).toLowerCase()) >= 0) {
              secK.appendChild(previewItem(it, true));
              break;
            }
          }
        });
        body.appendChild(secK);
      }
      if (sample.length) {
        var secA = el('div', 'pvxsec');
        var sampleLabel = sub.lastDiff && sub.lastDiff.kind === 'keyword' ? '上次关键词命中' : '上次新增';
        secA.appendChild(el('h4', null, sampleLabel + ' · ' + sample.length + ' 条'));
        sample.forEach(function (it) { secA.appendChild(previewItem(it, true)); });
        body.appendChild(secA);
      }
      var sampleTitles = sample.map(function (it) { return it.title; });
      var rest = (pv.items || []).filter(function (it) {
        return sampleTitles.indexOf(it.title) < 0;
      });
      if (rest.length) {
        var secB = el('div', 'pvxsec');
        secB.appendChild(el('h4', null, '最近条目 · ' + (pv.total || pv.items.length) + ' 条'));
        rest.forEach(function (it) { secB.appendChild(previewItem(it, false)); });
        body.appendChild(secB);
      }
      if (pv.excerpt) {
        var secC = el('div', 'pvxsec');
        secC.appendChild(el('h4', null, '正文摘录'));
        secC.appendChild(el('div', 'pvxex', pv.excerpt));
        body.appendChild(secC);
      }
      if (!sample.length && !(pv.items || []).length && !pv.excerpt) {
        body.appendChild(el('div', 'pvxnote', '这个板块暂时没有可预览的文字。'));
      }
    }
    frag.appendChild(body);

    var foot = el('div', 'pvxfoot');
    var open = el('a', 'primary', '打开网页');
    open.href = sub.url || '#';
    open.target = '_blank';
    open.rel = 'noreferrer noopener';
    open.style.textDecoration = 'none';
    foot.appendChild(open);
    var tail = el('button', 'ghost', sub.hasNew ? '标记已读' : '关闭');
    tail.setAttribute('data-pv', sub.hasNew ? 'seen' : 'close');
    tail.setAttribute('data-id', sub.id);
    foot.appendChild(tail);
    frag.appendChild(foot);

    card.replaceChildren(frag);
  }

  // ---------------------------------------------------------------- flash

  function flashSection(sub) {
    var hit = X.resolveElement(document, {
      selector: sub.selector,
      candidates: sub.candidates || [],
      anchor: sub.anchorText || '',
      tag: sub.tag || ''
    });
    if (!hit.el) {
      toast('没有找到这个板块，页面可能已改版');
      return;
    }
    try { hit.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { hit.el.scrollIntoView(); }
    setTimeout(function () { showFlashBox(hit.el); }, 520);
  }

  function showFlashBox(target) {
    var old = document.getElementById('pr-flash-host');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var host = document.createElement('div');
    host.id = 'pr-flash-host';
    var shadow = host.attachShadow({ mode: 'open' });
    applySheet(shadow, UI.FLASH_CSS);
    var box = el('div', 'box');
    shadow.appendChild(box);
    (document.documentElement || document.body).appendChild(host);
    var r = target.getBoundingClientRect();
    box.style.left = Math.max(0, r.left - 3) + 'px';
    box.style.top = Math.max(0, r.top - 3) + 'px';
    box.style.width = Math.max(6, r.width + 6) + 'px';
    box.style.height = Math.max(6, r.height + 6) + 'px';
    setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 2400);
  }

  // ---------------------------------------------------------------- picker

  var picker = null;

  function pickerIsOurs(e) {
    if (!picker) return false;
    var path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(picker.host) !== -1;
  }

  function startPicker() {
    if (state.picking) return;
    state.picking = true;
    if (panelHost) panelHost.style.display = 'none';

    var host = document.createElement('div');
    host.id = 'pr-pick-host';
    var shadow = host.attachShadow({ mode: 'open' });
    applySheet(shadow, UI.PICKER_CSS);
    shadow.innerHTML = UI.PICKER_TPL;

    picker = {
      host: host,
      shadow: shadow,
      hl: shadow.querySelector('.hl'),
      tip: shadow.querySelector('.tip'),
      tipTag: shadow.querySelector('#pr-tip-tag'),
      tipSize: shadow.querySelector('#pr-tip-size'),
      hud: shadow.querySelector('#pr-hud-text'),
      card: shadow.querySelector('#pr-card'),
      el: null,
      hoverEl: null,
      mode: 'hover',
      name: shadow.querySelector('#pr-name'),
      interval: shadow.querySelector('#pr-interval'),
      cat: shadow.querySelector('#pr-cat'),
      err: shadow.querySelector('#pr-err'),
      sub: shadow.querySelector('#pr-sub'),
      prev: shadow.querySelector('#pr-prev'),
      elLabel: shadow.querySelector('#pr-el'),
      prevCursor: document.documentElement.style.cursor
    };

    document.documentElement.appendChild(host);
    document.documentElement.style.cursor = 'crosshair';

    shadow.addEventListener('click', onPickerClick);
    window.addEventListener('pointermove', onPickMove, true);
    window.addEventListener('pointerdown', onPickDown, true);
    window.addEventListener('click', onPickBlockClick, true);
    window.addEventListener('keydown', onPickKey, true);
    window.addEventListener('contextmenu', onPickContext, true);

    hint('移动到要订阅的板块上，点击选中');
    fillCatSelect(state.settings ? state.settings.categories : []);
  }

  function fillCatSelect(cats) {
    var sel = picker && picker.cat;
    if (!sel) return;
    sel.replaceChildren();
    sel.appendChild(new Option('未分类', ''));
    (cats || []).forEach(function (c) { sel.appendChild(new Option(c.name, c.id)); });
    sel.value = defaultCategory(cats);
  }

  /** 设置里打开「沿用上一个订阅的分类」时，默认选中最近创建的那条订阅的分类。 */
  function defaultCategory(cats) {
    var settings = state.settings || {};
    if (!settings.carryCategory) return '';
    var subs = (state.subs || []).slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    if (!subs.length) return '';
    var id = subs[0].categoryId || '';
    if (!id) return '';
    var ok = (cats || []).some(function (c) { return c.id === id; });
    return ok ? id : '';
  }

  function onPickContext(e) {
    if (!picker || pickerIsOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onPickMove(e) {
    if (!picker || picker.mode !== 'hover') return;
    if (pickerIsOurs(e)) return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === picker.host) return;
    if (target.closest && target.closest('#pr-panel-host, #pr-pick-host')) return;
    if (target === picker.hoverEl) {
      positionTip(e.clientX, e.clientY);
      return;
    }
    setHover(target, true, e.clientX, e.clientY);
  }

  function setHover(target, withTip, px, py) {
    if (!picker || !target || target.nodeType !== 1) return;
    var tag = target.tagName;
    if (tag === 'HTML' || tag === 'HEAD') return;
    var r = target.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;

    picker.hoverEl = target;
    var hl = picker.hl;
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';

    picker.tipTag.textContent = X.describe(target);
    picker.tipSize.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    picker.tip.style.display = 'flex';
    if (withTip && px != null) positionTip(px, py);
    else positionTip(r.left + Math.min(r.width, 220), r.top - 6);
  }

  function positionTip(px, py) {
    if (!picker) return;
    var tip = picker.tip;
    var w = tip.offsetWidth || 180;
    var h = tip.offsetHeight || 26;
    var left = clamp(px + 16, 8, Math.max(8, window.innerWidth - w - 8));
    var top = py + 20;
    if (top + h > window.innerHeight - 8) top = py - h - 14;
    if (top < 8) top = 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function onPickDown(e) {
    if (!picker) return;
    if (pickerIsOurs(e)) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (picker.mode !== 'hover') return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (target) selectElement(target);
  }

  function onPickBlockClick(e) {
    if (!picker || pickerIsOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onPickKey(e) {
    if (!picker) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exitPicker();
      return;
    }
    if (picker.mode !== 'hover') return;
    var tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      var cur = picker.hoverEl;
      if (!cur) return;
      var next = e.key === 'ArrowUp' ? cur.parentElement : cur.firstElementChild;
      if (!next || next === document.body || next === document.documentElement) return;
      setHover(next, false);
    } else if (e.key === 'Enter') {
      if (picker.hoverEl) {
        e.preventDefault();
        e.stopPropagation();
        selectElement(picker.hoverEl);
      }
    }
  }

  function hint(text) {
    if (picker && picker.hud) picker.hud.textContent = text;
  }

  // A list section reads better named after the page than after its first entry.
  function suggestName(el, snap) {
    var own = el.dataset && el.dataset.prTitle;
    if (own) return own.slice(0, 60);
    if (snap && snap.itemCount >= 3) {
      var page = (document.title || '').split(/[|｜\-–—·:：]/)[0].trim();
      if (page) return page.slice(0, 40);
    }
    return X.guessTitle(el).slice(0, 60);
  }

  function selectElement(target) {
    if (!picker) return;
    var tag = target.tagName;
    if (tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') {
      hint('这是整页，请选择页面里的一个具体板块');
      return;
    }
    var snap = X.snapshotFromElement(target, location.href);
    if (!snap.textLen) {
      hint('这个区域没有文字内容，换一个板块试试');
      return;
    }

    picker.el = target;
    picker.hoverEl = target;
    picker.mode = 'selected';

    var r = target.getBoundingClientRect();
    var hl = picker.hl;
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    picker.tip.style.display = 'none';

    picker.elLabel.textContent = X.describe(target) + (target.id ? '  #' + target.id : '');
    picker.name.value = suggestName(target, snap);
    picker.err.classList.remove('show');
    picker.err.textContent = '';
    picker.sub.disabled = false;
    picker.sub.textContent = '订阅';

    picker.prev.replaceChildren();
    var line = el('div');
    var strong = el('b', null, String(snap.itemCount));
    line.appendChild(strong);
    line.appendChild(document.createTextNode(snap.itemCount
      ? ' 个条目 · 约 ' + snap.textLen + ' 字'
      : ' 段文字 · 约 ' + snap.textLen + ' 字'));
    picker.prev.appendChild(line);
    var samples = (snap.items || []).slice(0, 2);
    for (var i = 0; i < samples.length; i++) {
      picker.prev.appendChild(el('span', 's', '· ' + samples[i].title));
    }
    if (!samples.length) {
      var firstLine = snap.text.split('\n').filter(Boolean)[0] || '';
      if (firstLine) picker.prev.appendChild(el('span', 's', '· ' + firstLine.slice(0, 60)));
    }
    picker.prev.appendChild(el('span', 's', '订阅后按你的间隔检查这块内容的变化'));

    picker.card.hidden = false;
    if (picker.name) { try { picker.name.focus(); picker.name.select(); } catch (e) {} }
    hint('已选中，确认后订阅');
  }

  function enterHoverMode() {
    if (!picker) return;
    picker.mode = 'hover';
    picker.el = null;
    picker.card.hidden = true;
    hint('移动到要订阅的板块上，点击选中');
    if (picker.hoverEl) setHover(picker.hoverEl, false);
  }

  function onPickerClick(e) {
    if (!picker) return;
    var btn = e.target.closest ? e.target.closest('[data-pick]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-pick');
    if (act === 'close' || act === 'cancel') {
      exitPicker();
    } else if (act === 'reselect') {
      enterHoverMode();
    } else if (act === 'up' || act === 'down') {
      if (!picker.el) return;
      var next = act === 'up' ? picker.el.parentElement : picker.el.firstElementChild;
      if (!next || next === document.body || next === document.documentElement) return;
      selectElement(next);
    } else if (act === 'subscribe') {
      doSubscribe();
    }
  }

  async function doSubscribe() {
    if (!picker || !picker.el || picker.sub.disabled) return;
    var target = picker.el;
    var snap = X.snapshotFromElement(target, location.href);
    if (!snap.textLen) {
      showPickError('这个板块已经没有文字内容了，请重新选择');
      return;
    }
    var candidates = X.candidatesFor(target);
    var name = (picker.name.value || '').trim() || suggestName(target, snap);
    picker.sub.disabled = true;
    picker.sub.textContent = '订阅中…';
    picker.err.classList.remove('show');

    var res = await send({
      type: 'create-sub',
      url: location.href,
      title: document.title,
      name: name,
      selector: candidates[0] || null,
      candidates: candidates,
      tag: target.tagName,
      anchorText: X.normText(target.textContent || '').slice(0, 120),
      intervalHours: picker.interval.value ? Number(picker.interval.value) : 0,
      categoryId: picker.cat ? picker.cat.value : '',
      snapshot: snap
    });

    if (res && res.ok) {
      toast('订阅成功，正在建立基线');
      exitPicker();
      await loadData();
    } else {
      picker.sub.disabled = false;
      picker.sub.textContent = '订阅';
      showPickError((res && res.error) || '订阅失败，请重试');
    }
  }

  function showPickError(msg) {
    if (!picker) return;
    picker.err.textContent = msg;
    picker.err.classList.add('show');
  }

  function exitPicker() {
    if (!picker) return;
    var host = picker.host;
    window.removeEventListener('pointermove', onPickMove, true);
    window.removeEventListener('pointerdown', onPickDown, true);
    window.removeEventListener('click', onPickBlockClick, true);
    window.removeEventListener('keydown', onPickKey, true);
    window.removeEventListener('contextmenu', onPickContext, true);
    if (host.parentNode) host.parentNode.removeChild(host);
    document.documentElement.style.cursor = picker.prevCursor || '';
    picker = null;
    state.picking = false;
    if (panelHost) panelHost.style.display = '';
  }

  // ---------------------------------------------------------------- data

  async function loadData() {
    if (state.loading) return;
    state.loading = true;
    try {
      var all = await chrome.storage.local.get(['settings', 'subs']);
      state.settings = Object.assign({}, DEFAULTS, all.settings || {});
      state.subs = Array.isArray(all.subs) ? all.subs : [];
      renderPanel();
    } catch (e) {
      // extension context invalidated — nothing sensible to do
    } finally {
      state.loading = false;
    }
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'PR_FLASH') {
      flashSection(msg.sub || {});
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'PR_START_PICKER') {
      startPicker();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'PR_PING') {
      sendResponse({ ok: true });
      return;
    }
  });

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.settings || changes.subs) loadData();
    });
  }

  window.addEventListener('popstate', function () { scheduleRouteCheck(true); });

  function scheduleRouteCheck(force) {
    if (!force && location.href === state.href) return;
    if (location.href === state.href) return;
    state.href = location.href;
    state.hover = false;
    state.pinned = false;
    renderPanel();
  }

  setInterval(function () { scheduleRouteCheck(false); }, 900);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadData, { once: true });
  } else {
    loadData();
  }
})();
