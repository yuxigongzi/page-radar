/* PageRadar options page. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var state = null;
  var toastTimer = 0;
  // 勾选改动先暂存，点「保存更改」后才写入后台（保存后生效）。
  var pending = {};

  var INTERVALS = [
    { v: 0, t: '跟随全局' },
    { v: 1, t: '每 1 小时' },
    { v: 3, t: '每 3 小时' },
    { v: 6, t: '每 6 小时' },
    { v: 12, t: '每 12 小时' },
    { v: 24, t: '每 24 小时' },
    { v: 48, t: '每 2 天' },
    { v: 168, t: '每 7 天' }
  ];

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

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || ''); }
  }

  function pageKey(u) {
    try {
      var x = new URL(u);
      return x.origin + x.pathname.replace(/\/+$/, '');
    } catch (e) { return String(u || ''); }
  }

  function timeAgo(ts) {
    if (!ts) return '尚未检查';
    var d = Date.now() - ts;
    if (d < 45000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function timeUntil(ts) {
    if (!ts) return '即将';
    var d = ts - Date.now();
    if (d <= 0) return '即将';
    if (d < 3600000) return Math.ceil(d / 60000) + ' 分钟后';
    if (d < 86400000) return Math.round(d / 3600000) + ' 小时后';
    return Math.round(d / 86400000) + ' 天后';
  }

  function intervalLabel(sub) {
    var h = sub.intervalHours || (state.settings.intervalHours || 12);
    if (h >= 24 && h % 24 === 0) return '每 ' + (h / 24) + ' 天';
    return '每 ' + h + ' 小时';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function toast(text, bad) {
    var n = $('#toast');
    n.textContent = text;
    n.classList.remove('bad');
    if (bad) n.classList.add('bad');
    n.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { n.classList.remove('show'); }, 2400);
  }

  var filter = { cat: 'all', kw: 'all', status: 'all' };
  var selectMode = false;
  var picked = {};

  function catList() {
    return (state.settings && state.settings.categories) || [];
  }

  function catById(id) {
    var cats = catList();
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i];
    return null;
  }

  function matchesFilter(sub) {
    if (filter.cat === 'none') { if (sub.categoryId) return false; }
    else if (filter.cat !== 'all') { if (sub.categoryId !== filter.cat) return false; }
    var kw = sub.keywords || [];
    if (filter.kw === 'has' && !kw.length) return false;
    if (filter.kw === 'none' && kw.length) return false;
    if (filter.kw.indexOf('k:') === 0) {
      var word = filter.kw.slice(2).toLowerCase();
      if (!kw.some(function (k) { return k.toLowerCase() === word; })) return false;
    }
    if (filter.status === 'on' && sub.enabled === false) return false;
    if (filter.status === 'off' && sub.enabled !== false) return false;
    if (filter.status === 'new' && !sub.hasNew) return false;
    if (filter.status === 'err' && !sub.err) return false;
    return true;
  }

  function filteredSubs() {
    return (state.subs || []).filter(matchesFilter);
  }

  function filterActive() {
    return filter.cat !== 'all' || filter.kw !== 'all' || filter.status !== 'all';
  }

  function renderCats() {
    var cats = catList();
    var subs = state.subs || [];

    $('#cat-count').textContent = cats.length ? cats.length + ' 个分类' : '还没有分类';

    var bar = $('#cat-filter');
    bar.replaceChildren();
    function chip(label, key, color) {
      var btn = el('button', 'cat-chip');
      btn.type = 'button';
      btn.dataset.cat = key;
      btn.dataset.on = String(filter.cat === key);
      if (color) {
        var dot = el('i');
        dot.style.background = color;
        btn.appendChild(dot);
      }
      btn.appendChild(document.createTextNode(label));
      var n = el('b');
      if (key === 'all') n.textContent = String(subs.length);
      else if (key === 'none') n.textContent = String(subs.filter(function (s) { return !s.categoryId; }).length);
      else n.textContent = String(subs.filter(function (s) { return s.categoryId === key; }).length);
      btn.appendChild(n);
      bar.appendChild(btn);
    }
    chip('全部', 'all', null);
    if (subs.some(function (s) { return !s.categoryId; })) chip('未分类', 'none', '#7d879a');
    cats.forEach(function (c) { chip(c.name, c.id, c.color); });
    renderFilterSelects();

    var list = $('#cat-list');
    list.replaceChildren();
    if (!cats.length) {
      list.appendChild(el('div', 'pv-note', '还没有分类。先添加一个，就能给订阅分组了。'));
    }
    cats.forEach(function (c) {
      var row = el('div', 'cat-item');
      var swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.className = 'cat-swatch-input';
      swatch.value = c.color;
      swatch.title = '点一下换个颜色';
      var input = document.createElement('input');
      input.className = 'sub-name-input';
      input.value = c.name;
      input.maxLength = 20;
      input.title = '点一下可以改名';
      var count = subs.filter(function (s) { return s.categoryId === c.id; }).length;
      var meta = el('span', 'muted', count + ' 个订阅');
      var del = el('button', 'btn mini danger', '删除');
      input.addEventListener('change', async function () {
        var name = input.value.trim();
        if (!name) { input.value = c.name; return; }
        var next = catList().map(function (x) {
          return x.id === c.id ? { id: x.id, name: name, color: x.color } : x;
        });
        var res = await patch({ categories: next }, '分类已重命名');
        if (res.ok) reload();
      });
      swatch.addEventListener('change', async function () {
        var next = catList().map(function (x) {
          return x.id === c.id ? { id: x.id, name: x.name, color: swatch.value } : x;
        });
        var res = await patch({ categories: next }, '分类颜色已更新');
        if (res.ok) reload();
      });
      del.addEventListener('click', async function () {
        if (!window.confirm('删除分类「' + c.name + '」？其中的订阅会变成未分类。')) return;
        var next = catList().filter(function (x) { return x.id !== c.id; });
        var res = await patch({ categories: next }, '分类已删除');
        if (res.ok) {
          if (filter.cat === c.id) filter.cat = 'all';
          reload();
        }
      });
      row.appendChild(swatch);
      row.appendChild(input);
      row.appendChild(meta);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function renderFilterSelects() {
    var subs = state.subs || [];
    var kwSel = $('#filter-kw');
    var words = [];
    subs.forEach(function (s) {
      (s.keywords || []).forEach(function (k) {
        if (!words.some(function (w) { return w.toLowerCase() === k.toLowerCase(); })) words.push(k);
      });
    });
    if (filter.kw.indexOf('k:') === 0) {
      var cur = filter.kw.slice(2).toLowerCase();
      if (!words.some(function (w) { return w.toLowerCase() === cur; })) filter.kw = 'all';
    }
    kwSel.replaceChildren();
    var add = function (value, label) {
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      kwSel.appendChild(o);
    };
    add('all', '全部关键词');
    add('has', '有关键词');
    add('none', '无关键词');
    words.forEach(function (w) { add('k:' + w, '包含「' + w + '」'); });
    kwSel.value = filter.kw;
    $('#filter-status').value = filter.status;
  }

  function renderSubs() {
    var list = $('#sub-list');
    var all = state.subs || [];
    var subs = filteredSubs();
    var alive = {};
    all.forEach(function (s) { alive[s.id] = true; });
    Object.keys(picked).forEach(function (id) { if (!alive[id]) delete picked[id]; });
    $('#stat-subs').textContent = String(all.length);
    list.replaceChildren();

    var empty = $('#sub-empty');
    empty.style.display = subs.length ? 'none' : 'block';
    empty.textContent = all.length
      ? '当前筛选下还没有订阅，换一个分类看看。'
      : '还没有订阅。打开一个网页，点击工具栏里的雷达图标，选择「框选本页板块」。';
    list.style.display = subs.length ? 'flex' : 'none';
    if (!subs.length) return;

    var groups = {};
    var order = [];
    subs.forEach(function (s) {
      var k = pageKey(s.url);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(s);
    });

    list.classList.toggle('selecting', selectMode);
    order.forEach(function (k) {
      groups[k].forEach(function (sub) { list.appendChild(subRow(sub)); });
    });
    updateBatchUi();
  }

  function pickedIds() {
    return Object.keys(picked).filter(function (id) { return picked[id]; });
  }

  function updateBatchUi() {
    var n = pickedIds().length;
    var toggle = $('#sel-toggle');
    if (toggle) toggle.textContent = selectMode ? '退出多选' : '多选';
    var bar = $('#batch-bar');
    if (bar) bar.hidden = !selectMode;
    var list = $('#sub-list');
    if (list) list.classList.toggle('selecting', selectMode);
    var count = $('#batch-count');
    if (count) count.textContent = '已选 ' + n + ' 个';
    ['#batch-kw', '#batch-cat', '#export-selected'].forEach(function (sel) {
      var b = $(sel);
      if (b) b.disabled = !n;
    });
    var ef = $('#export-filtered');
    if (ef) ef.disabled = !filterActive();
  }

  function setSelectMode(on) {
    selectMode = !!on;
    if (!selectMode) picked = {};
    renderSubs();
  }

  function subRow(sub) {
    var row = el('div', 'sub-row');
    row.dataset.id = sub.id;

    var savedOn = sub.enabled !== false;
    var effOn = Object.prototype.hasOwnProperty.call(pending, sub.id) ? pending[sub.id] : savedOn;
    var dirty = effOn !== savedOn;
    if (!effOn) row.classList.add('off');
    if (dirty) row.classList.add('dirty');
    if (selectMode) {
      row.title = '点一下选中这条订阅';
      if (picked[sub.id]) row.classList.add('picked');
      row.addEventListener('click', function (e) {
        if (e.target.closest('input, select, button, a')) return;
        picked[sub.id] = !picked[sub.id];
        row.classList.toggle('picked', !!picked[sub.id]);
        updateBatchUi();
      });
    }

    var on = document.createElement('input');
    on.type = 'checkbox';
    on.className = 'sub-on';
    on.checked = effOn;
    on.title = effOn ? '已勾选：按时检查这个板块' : '未勾选：暂停检查这个板块';
    on.addEventListener('change', function () {
      if (on.checked === savedOn) delete pending[sub.id];
      else pending[sub.id] = on.checked;
      on.title = on.checked ? '已勾选：按时检查这个板块' : '未勾选：暂停检查这个板块';
      var isDirty = Object.prototype.hasOwnProperty.call(pending, sub.id);
      row.classList.toggle('off', !on.checked);
      row.classList.toggle('dirty', isDirty);
      updateSaveUi();
    });

    var dot = el('span', 'dot' + (sub.err ? ' err' : (sub.hasNew && effOn ? ' new' : '')));
    var cat = catById(sub.categoryId);
    if (cat && !sub.err && !sub.hasNew) {
      dot.style.background = cat.color;
      dot.style.boxShadow = '0 0 9px ' + cat.color + '99';
    }
    if (!effOn) {
      dot.style.background = '#4b5563';
      dot.style.boxShadow = 'none';
    }

    var info = el('div', 'sub-info');
    var input = document.createElement('input');
    input.className = 'sub-name-input';
    input.value = sub.name || hostOf(sub.url);
    input.title = '点一下可以改名';
    input.maxLength = 60;
    input.addEventListener('change', async function () {
      var name = input.value.trim();
      if (!name) { input.value = sub.name || hostOf(sub.url); return; }
      var res = await send({ type: 'update-sub', id: sub.id, name: name });
      if (res.ok) { sub.name = res.sub.name; toast('名称已保存'); }
      else toast('保存失败：' + res.error, true);
    });

    var meta = el('div', 'sub-meta');
    if (cat) {
      var pill = el('span', 'pill-cat');
      var pdot = el('i');
      pdot.style.background = cat.color;
      pill.appendChild(pdot);
      pill.appendChild(document.createTextNode(cat.name));
      meta.appendChild(pill);
    }
    if (sub.keywords && sub.keywords.length) {
      var kwPill = el('span', 'pill-kw' + (sub.hits && sub.hits.length ? ' hit' : ''));
      kwPill.textContent = (sub.hits && sub.hits.length
        ? '命中 ' + sub.hits.join('、')
        : '关键词 ' + sub.keywords.length + ' 个') + (sub.keywordMode === 'all' ? ' · 全部' : '');
      kwPill.title = '关键词：' + sub.keywords.join('、') + (sub.keywordMode === 'all' ? '（全部出现才提醒）' : '（任一出现就提醒）');
      meta.appendChild(kwPill);
    }
    var link = document.createElement('a');
    link.href = sub.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = hostOf(sub.url) + new URL(sub.url).pathname;
    link.title = sub.url;
    meta.appendChild(link);

    meta.appendChild(el('span', 'sep', '·'));
    meta.appendChild(el('span', null, intervalLabel(sub)));

    meta.appendChild(el('span', 'sep', '·'));
    var hasKw = sub.keywords && sub.keywords.length;
    if (!effOn) {
      meta.appendChild(el('span', 'offtag', '已暂停'));
    } else if (sub.err) {
      meta.appendChild(el('span', 'err', '检查失败：' + (sub.err || '').slice(0, 60)));
    } else if (hasKw && sub.hasNew) {
      meta.appendChild(el('span', 'hittext', '关键词命中 · ' + timeAgo(sub.lastChangeAt)));
    } else if (hasKw) {
      meta.appendChild(el('span', null, timeAgo(sub.checkedAt) + '检查 · 下次 ' + timeUntil(sub.nextCheckAt)));
    } else if (sub.hasNew) {
      meta.appendChild(el('span', null, (sub.addedCount ? sub.addedCount + ' 条更新' : '有新内容') + ' · ' + timeAgo(sub.lastChangeAt)));
    } else {
      meta.appendChild(el('span', null, timeAgo(sub.checkedAt) + '检查 · 下次 ' + timeUntil(sub.nextCheckAt)));
    }

    info.appendChild(input);
    info.appendChild(meta);
    if (sub.note) {
      var noteLine = el('div', 'sub-note');
      noteLine.textContent = sub.note;
      noteLine.title = '备注：' + sub.note;
      info.appendChild(noteLine);
    }

    var actions = el('div', 'sub-actions');

    var catSel = document.createElement('select');
    catSel.className = 'cat-select';
    catSel.title = '把这个订阅放进分类';
    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '未分类';
    catSel.appendChild(noneOpt);
    catList().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      catSel.appendChild(opt);
    });
    catSel.value = cat ? cat.id : '';
    catSel.addEventListener('change', async function () {
      var res = await send({ type: 'update-sub', id: sub.id, categoryId: catSel.value });
      if (res.ok) { toast(catSel.value ? '已归入分类' : '已移出分类'); reload(); }
      else toast('保存失败：' + res.error, true);
    });

    var sel = document.createElement('select');
    INTERVALS.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = String(o.v);
      opt.textContent = o.t;
      sel.appendChild(opt);
    });
    sel.value = String(sub.intervalHours || 0);
    sel.title = '单独设置这个订阅的检查间隔';
    sel.addEventListener('change', async function () {
      var res = await send({ type: 'update-sub', id: sub.id, intervalHours: Number(sel.value) });
      if (res.ok) { toast('间隔已更新'); reload(); }
      else toast('保存失败：' + res.error, true);
    });

    var preview = el('button', 'btn mini', '预览');
    preview.addEventListener('click', function () { openPreview(sub.id); });

    var kwBtn = el('button', 'btn mini', sub.keywords && sub.keywords.length ? '关键词·' + sub.keywords.length : '关键词');
    kwBtn.title = sub.keywords && sub.keywords.length
      ? '只看这些关键词的提醒：' + sub.keywords.join('、')
      : '设置关键词提醒：只在这些词出现时通知';
    if (sub.keywords && sub.keywords.length && sub.hits && sub.hits.length) kwBtn.classList.add('hot');
    kwBtn.addEventListener('click', function () { openKw(sub); });

    var check = el('button', 'btn mini', '检查');
    if (!savedOn) {
      check.disabled = true;
      check.title = '已暂停的订阅不参与检查，先勾选并保存';
    }
    check.addEventListener('click', async function () {
      check.disabled = true;
      check.textContent = '检查中';
      var res = await send({ type: 'check-now', id: sub.id });
      check.disabled = false;
      check.textContent = '检查';
      if (res.ok) {
        toast(res.changed ? ('发现 ' + ((res.diff && res.diff.added) || 0) + ' 条更新') : '检查完成，暂无变化');
        reload();
      } else {
        toast('检查失败：' + res.error, true);
        reload();
      }
    });

    var open = el('button', 'btn mini', '打开');
    open.addEventListener('click', function () {
      chrome.tabs.create({ url: sub.url });
    });

    var del = el('button', 'btn mini danger', '删除');
    del.addEventListener('click', async function () {
      if (!window.confirm('删除订阅「' + (sub.name || hostOf(sub.url)) + '」？此操作不可撤销。')) return;
      var res = await send({ type: 'remove-sub', id: sub.id });
      if (res.ok) { toast('已删除'); reload(); }
      else toast('删除失败：' + res.error, true);
    });

    actions.appendChild(catSel);
    actions.appendChild(sel);
    actions.appendChild(preview);
    actions.appendChild(kwBtn);
    actions.appendChild(check);
    actions.appendChild(open);
    actions.appendChild(del);

    row.appendChild(on);
    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(actions);
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
    var modal = $('#preview');
    modal.hidden = false;
    $('#pv-title').textContent = '正在读取…';
    $('#pv-meta').replaceChildren();
    $('#pv-body').replaceChildren(el('div', 'pv-note', '正在读取最近一次快照…'));
    $('#pv-open').setAttribute('href', '#');
    $('#pv-seen').style.display = 'none';
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
    $('#preview').hidden = true;
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
    if (sub.err) meta.appendChild(el('span', 'err', '检查失败：' + sub.err));
    else meta.appendChild(el('span', null, pv && pv.at ? timeAgo(pv.at) + '检查' : '尚未检查'));
    if (sub.keywords && sub.keywords.length) {
      meta.appendChild(el('span', null, '·'));
      var kwPill = el('span', 'pill-kw' + (sub.hits && sub.hits.length ? ' hit' : ''));
      kwPill.textContent = '关键词' + (sub.keywordMode === 'all' ? '（全部）' : '（任一）') + '：' + sub.keywords.join('、');
      meta.appendChild(kwPill);
    }
    if (pv) {
      meta.appendChild(el('span', null, '·'));
      meta.appendChild(el('span', null, pv.via === 'tab' ? '后台渲染' : '直接抓取'));
      meta.appendChild(el('span', null, '·'));
      meta.appendChild(el('span', null, (pv.total || 0) + ' 条 · ' + (pv.textLen || 0) + ' 字'));
    }

    $('#pv-open').setAttribute('href', sub.url || '#');

    var seen = $('#pv-seen');
    seen.style.display = sub.hasNew ? '' : 'none';
    seen.dataset.id = sub.id;
    $('#pv-check').dataset.id = sub.id;

    var body = $('#pv-body');
    body.replaceChildren();

    if (sub.err) {
      body.appendChild(el('div', 'pv-note', '上次检查失败：' + sub.err));
      return;
    }
    if (!pv) {
      body.appendChild(el('div', 'pv-note', '还没有快照。等第一次检查完成后，这里会显示板块内容。'));
      return;
    }

    var kwHits = sub.hits || [];
    if (kwHits.length) {
      body.appendChild(el('h4', null, '关键词命中 · ' + kwHits.length + ' 个'));
      var kwLine = el('div', 'pv-kwline');
      kwHits.forEach(function (k) {
        var chip = el('span', 'kw-chip');
        chip.appendChild(document.createTextNode(k));
        kwLine.appendChild(chip);
      });
      body.appendChild(kwLine);
      var hitItems = (pv.items || []).filter(function (it) {
        return kwHits.some(function (k) {
          return String(it.title || '').toLowerCase().indexOf(String(k).toLowerCase()) >= 0;
        });
      });
      hitItems.forEach(function (it) { body.appendChild(pvItem(it, true)); });
    }

    var sample = (sub.lastDiff && sub.lastDiff.sample) || [];
    if (sample.length) {
      var sampleTitle = sub.lastDiff && sub.lastDiff.kind === 'keyword' ? '上次关键词命中' : '上次新增';
      body.appendChild(el('h4', null, sampleTitle + ' · ' + sample.length + ' 条'));
      sample.forEach(function (it) { body.appendChild(pvItem(it, true)); });
    }
    var sampleTitles = sample.map(function (it) { return it.title; });
    var rest = (pv.items || []).filter(function (it) {
      return sampleTitles.indexOf(it.title) < 0;
    });
    if (rest.length) {
      body.appendChild(el('h4', null, '最近条目 · ' + (pv.total || pv.items.length) + ' 条'));
      rest.forEach(function (it) { body.appendChild(pvItem(it, false)); });
    }
    if (pv.excerpt) {
      body.appendChild(el('h4', null, '正文摘录'));
      body.appendChild(el('div', 'pv-excerpt', pv.excerpt));
    }
    if (!sample.length && !(pv.items || []).length && !pv.excerpt) {
      body.appendChild(el('div', 'pv-note', '这个板块暂时没有可预览的文字。'));
    }
  }

  function renderSettings() {
    var s = state.settings;
    $('#intervalHours').value = String(s.intervalHours || 12);
    $('#startupCheck').checked = !!s.startupCheck;
    $('#notify').checked = !!s.notify;
    $('#onlyChanged').checked = !!s.onlyChanged;
    $('#carryCategory').checked = !!s.carryCategory;
    $('#panelEnabled').checked = !!s.panelEnabled;
    $('#panelSide').value = s.panelSide === 'left' ? 'left' : 'right';
    $('#panelOpacity').value = String(Math.round((s.panelOpacity != null ? s.panelOpacity : 0.92) * 100));
    $('#opacityValue').textContent = Math.round((s.panelOpacity != null ? s.panelOpacity : 0.92) * 100) + '%';
    renderHiddenHosts();
  }

  function renderHiddenHosts() {
    var box = $('#hidden-hosts');
    var hosts = state.settings.panelHiddenHosts || [];
    box.replaceChildren();
    if (!hosts.length) {
      box.appendChild(el('span', 'muted', '暂无。'));
      return;
    }
    hosts.forEach(function (host) {
      var chip = el('span', 'chip', host);
      var btn = el('button', null, '恢复');
      btn.addEventListener('click', async function () {
        var res = await send({ type: 'site-panel', host: host, hidden: false });
        if (res.ok) {
          state.settings.panelHiddenHosts = res.panelHiddenHosts;
          renderHiddenHosts();
          toast('该网站的悬浮窗已恢复');
        }
      });
      chip.appendChild(btn);
      box.appendChild(chip);
    });
  }

  async function patch(p, okText) {
    var res = await send({ type: 'save-settings', patch: p });
    if (res.ok) {
      state.settings = res.settings;
      if (okText) toast(okText);
    } else {
      toast('保存失败：' + res.error, true);
    }
    return res;
  }

  // ---- 关键词提醒 ----
  var kwId = '';
  var kwDraft = [];
  var kwTargets = null;

  function getKwMode() {
    var pickedRadio = document.querySelector('input[name="kw-mode"]:checked');
    return pickedRadio && pickedRadio.value === 'all' ? 'all' : 'any';
  }

  function setKwMode(mode) {
    var v = mode === 'all' ? 'all' : 'any';
    document.querySelectorAll('input[name="kw-mode"]').forEach(function (r) {
      r.checked = r.value === v;
    });
  }

  function openKw(sub) {
    kwId = sub.id;
    kwTargets = null;
    kwDraft = (sub.keywords || []).slice();
    $('#kw-title').textContent = '关键词提醒';
    $('#kw-sub').textContent = (sub.name || hostOf(sub.url)) + ' · ' + hostOf(sub.url);
    setKwMode(sub.keywordMode);
    $('#kw-input').value = '';
    renderKw();
    $('#kw-modal').hidden = false;
    $('#kw-input').focus();
  }

  function openBatchKw(ids) {
    kwId = '';
    kwTargets = ids.slice();
    kwDraft = [];
    $('#kw-title').textContent = '批量关键词';
    $('#kw-sub').textContent = '应用到选中的 ' + ids.length + ' 个订阅（覆盖它们原有的关键词）';
    setKwMode('any');
    $('#kw-input').value = '';
    renderKw();
    $('#kw-modal').hidden = false;
    $('#kw-input').focus();
  }

  function closeKw() {
    $('#kw-modal').hidden = true;
    kwId = '';
    kwTargets = null;
    kwDraft = [];
  }

  function renderKw() {
    var list = $('#kw-list');
    list.replaceChildren();
    if (!kwDraft.length) {
      list.appendChild(el('div', 'kw-empty', '还没有关键词。添加后会只在这些词出现时提醒。'));
      return;
    }
    kwDraft.forEach(function (k, i) {
      var chip = el('span', 'kw-chip');
      chip.appendChild(document.createTextNode(k));
      var x = el('button', null, '×');
      x.title = '移除这个关键词';
      x.addEventListener('click', function () {
        kwDraft.splice(i, 1);
        renderKw();
      });
      chip.appendChild(x);
      list.appendChild(chip);
    });
  }

  function addKw() {
    var input = $('#kw-input');
    var word = input.value.trim().replace(/\s+/g, ' ');
    if (!word) { input.focus(); return; }
    if (word.length > 24) { toast('关键词最长 24 个字', true); return; }
    var lower = word.toLowerCase();
    if (kwDraft.some(function (k) { return k.toLowerCase() === lower; })) {
      toast('这个关键词已经加过了', true);
      input.select();
      return;
    }
    if (kwDraft.length >= 12) { toast('最多 12 个关键词', true); return; }
    kwDraft.push(word);
    input.value = '';
    input.focus();
    renderKw();
  }

  function kwTargetIds() {
    if (kwTargets) return kwTargets.slice();
    return kwId ? [kwId] : [];
  }

  async function applyKw(words, text) {
    var ids = kwTargetIds();
    if (!ids.length) return;
    var mode = getKwMode();
    var btn = $('#kw-save');
    btn.disabled = true;
    var bad = 0;
    for (var i = 0; i < ids.length; i++) {
      var res = await send({ type: 'update-sub', id: ids[i], keywords: words, keywordMode: mode });
      if (!res.ok) bad++;
    }
    btn.disabled = false;
    if (bad) toast('有 ' + bad + ' 项保存失败', true);
    else toast(text);
    return bad;
  }

  async function saveKw() {
    var ids = kwTargetIds();
    if (!ids.length) return;
    // 输入框里还有没按「添加」的文字时，直接保存会把它当空气泡丢掉；
    // 先提交一次，只有提交失败（太长/重复）才中断。
    var input = $('#kw-input');
    if (input && input.value.trim()) {
      addKw();
      if (input.value.trim()) return;
    }
    var batch = !!kwTargets;
    if (!kwDraft.length && batch) {
      var ok = window.confirm('关键词是空的：保存会清空这 ' + ids.length + ' 个订阅原有的关键词，确定继续？');
      if (!ok) return;
    }
    var bad = await applyKw(kwDraft.slice(), batch
      ? '已把关键词应用到 ' + ids.length + ' 个订阅'
      : (kwDraft.length ? '关键词已保存，只在这些词出现时提醒' : '已恢复普通更新提醒'));
    if (bad) return;
    closeKw();
    reload();
  }

  async function clearKw() {
    if (!kwTargetIds().length) return;
    kwDraft = [];
    renderKw();
    var bad = await applyKw([], '已清空关键词，恢复普通更新提醒');
    if (!bad) reload();
  }

  // ---- 批量分类 ----
  var bcatIds = [];

  function openBatchCat(ids) {
    bcatIds = ids.slice();
    $('#bcat-meta').textContent = '应用到选中的 ' + ids.length + ' 个订阅';
    var sel = $('#bcat-select');
    sel.replaceChildren();
    sel.appendChild(new Option('未分类', ''));
    catList().forEach(function (c) { sel.appendChild(new Option(c.name, c.id)); });
    var first = (state.subs || []).find(function (s) { return s.id === ids[0]; });
    sel.value = (first && first.categoryId) || '';
    $('#bcat-modal').hidden = false;
  }

  function closeBatchCat() {
    $('#bcat-modal').hidden = true;
    bcatIds = [];
  }

  async function applyBatchCat() {
    var ids = bcatIds.slice();
    if (!ids.length) return;
    var catId = $('#bcat-select').value;
    var bad = 0;
    for (var i = 0; i < ids.length; i++) {
      var res = await send({ type: 'update-sub', id: ids[i], categoryId: catId });
      if (!res.ok) bad++;
    }
    closeBatchCat();
    if (bad) toast('有 ' + bad + ' 项保存失败', true);
    else toast('已把 ' + ids.length + ' 个订阅移到' + (catId ? '「' + ((catById(catId) || {}).name || '分类') + '」' : '未分类'));
    reload();
  }

  // ---- 备份与恢复 ----
  var importData = null;

  function stampName() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  function downloadJson(payload, name) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  async function exportBackup(scope) {
    var ids = null;
    if (scope === 'picked') ids = pickedIds();
    else if (scope === 'filtered') ids = filteredSubs().map(function (s) { return s.id; });
    if (ids && !ids.length) { toast('还没有选中任何订阅', true); return; }
    var res = await send(ids ? { type: 'export-data', ids: ids } : { type: 'export-data' });
    if (!res.ok) { toast('导出失败：' + res.error, true); return; }
    var subs = scope === 'settings' ? [] : (res.subs || []);
    var payload = {
      app: 'page-radar',
      kind: scope === 'settings' ? 'settings' : 'backup',
      scope: scope,
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: res.settings,
      subs: subs
    };
    var suffix = scope === 'filtered' ? '-filtered' : (scope === 'picked' ? '-selected' : '');
    downloadJson(payload, 'page-radar-' + (scope === 'settings' ? 'settings' : 'backup') + suffix + '-' + stampName() + '.json');
    if (scope === 'settings') {
      toast('已导出设置（分类 ' + ((res.settings && res.settings.categories) || []).length + ' 个）');
    } else {
      toast('已导出 ' + subs.length + ' 个订阅和设置');
    }
  }

  function openImport(data, summary) {
    importData = data;
    var hasSettings = !!data.settings;
    $('#im-settings').disabled = !hasSettings;
    $('#im-settings').checked = hasSettings;
    var when = data.exportedAt ? new Date(data.exportedAt) : null;
    $('#im-meta').textContent = (when && !isNaN(when)
      ? '导出于 ' + when.toLocaleString('zh-CN')
      : '备份文件') + (data.kind === 'settings' ? ' · 仅设置' : '');

    var box = $('#im-summary');
    box.replaceChildren();
    var addRow = function (label, value) {
      var r = el('div', 'im-row');
      r.appendChild(el('span', null, label));
      r.appendChild(el('b', null, value));
      box.appendChild(r);
    };
    addRow('备份里的订阅', summary.total + ' 个');
    if (summary.add) addRow('可以新增', summary.add + ' 个');
    if (summary.update) addRow('与已有订阅重合', summary.update + ' 个');
    if (summary.categories != null) addRow('分类', summary.categories + ' 个');
    if (summary.keywords) addRow('带关键词的订阅', summary.keywords + ' 个');
    addRow('当前订阅', (state.subs || []).length + ' 个');

    var merge = $('#im-merge');
    var replace = $('#im-replace');
    if (!summary.total) {
      merge.textContent = '只导入设置';
      replace.style.display = 'none';
    } else {
      merge.textContent = '合并导入';
      replace.style.display = '';
    }
    $('#im-modal').hidden = false;
  }

  function closeImport() {
    $('#im-modal').hidden = true;
    importData = null;
  }

  async function runImport(mode) {
    if (!importData) return;
    var applySettings = $('#im-settings').checked && !$('#im-settings').disabled;
    $('#im-merge').disabled = true;
    $('#im-replace').disabled = true;
    var res = await send({ type: 'import-backup', data: importData, mode: mode, applySettings: applySettings });
    $('#im-merge').disabled = false;
    $('#im-replace').disabled = false;
    if (!res.ok) { toast('导入失败：' + res.error, true); return; }
    closeImport();
    var msg = mode === 'replace'
      ? '已覆盖导入 ' + res.replaced + ' 个订阅'
      : '已导入：新增 ' + res.added + ' 个，更新 ' + res.updated + ' 个';
    toast(msg + (applySettings ? '，设置已恢复' : ''));
    reload();
  }

  async function reload() {
    var res = await send({ type: 'get-state' });
    if (!res.ok) {
      toast('后台服务未响应，请重新加载扩展', true);
      return;
    }
    state = res;
    // 订阅可能已被删除：清掉不再存在的待保存勾选。
    var ids = {};
    (res.subs || []).forEach(function (s) { ids[s.id] = true; });
    Object.keys(pending).forEach(function (id) {
      if (!ids[id]) delete pending[id];
      else if (pending[id] === ((res.subs.find(function (s) { return s.id === id; }) || {}).enabled !== false)) delete pending[id];
    });
    renderCats();
    renderSubs();
    renderSettings();
    updateSaveUi();
    updateStorageNote();
  }

  function updateSaveUi() {
    var n = Object.keys(pending).length;
    var btn = $('#save-subs');
    btn.disabled = !n;
    btn.textContent = n ? '保存更改 (' + n + ')' : '保存更改';
    $('#save-hint').textContent = n ? '有 ' + n + ' 项勾选待保存' : '勾选表示订阅，改完点保存';
  }

  async function savePending() {
    var ids = Object.keys(pending);
    if (!ids.length) return;
    var btn = $('#save-subs');
    btn.disabled = true;
    btn.textContent = '保存中…';
    var bad = 0;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var res = await send({ type: 'update-sub', id: id, enabled: pending[id] });
      if (!res.ok) bad++;
    }
    pending = {};
    if (bad) toast('有 ' + bad + ' 项保存失败', true);
    else toast('已保存，勾选已生效');
    await reload();
  }

  async function updateStorageNote() {
    try {
      var used = await chrome.storage.local.getBytesInUse(null);
      $('#storage-note').textContent = '本地占用 ' + (used / 1024).toFixed(1) + ' KB · 不上传任何数据';
    } catch (e) { /* ignore */ }
  }

  function bind() {
    $('#cat-filter').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.cat-chip') : null;
      if (!chip) return;
      filter.cat = chip.dataset.cat || 'all';
      renderCats();
      renderSubs();
    });

    $('#cat-add').addEventListener('click', async function () {
      var nameEl = $('#cat-name');
      var name = nameEl.value.trim();
      if (!name) { toast('先给分类起个名字', true); nameEl.focus(); return; }
      if (catList().some(function (c) { return c.name === name; })) {
        toast('已经有同名分类了', true);
        return;
      }
      var color = $('#cat-color').value || '#5ee0ff';
      var id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var next = catList().concat([{ id: id, name: name, color: color }]);
      var res = await patch({ categories: next }, '分类已添加');
      if (res.ok) {
        nameEl.value = '';
        reload();
      }
    });

    $('#cat-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#cat-add').click();
    });

    $('#pv-x').addEventListener('click', closePreview);    $('#preview').addEventListener('click', function (e) {
      if (e.target === $('#preview')) closePreview();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#im-modal').hidden) closeImport();
      else if (!$('#bcat-modal').hidden) closeBatchCat();
      else if (!$('#kw-modal').hidden) closeKw();
      else if (!$('#preview').hidden) closePreview();
    });

    $('#kw-x').addEventListener('click', closeKw);
    $('#kw-modal').addEventListener('click', function (e) {
      if (e.target === $('#kw-modal')) closeKw();
    });
    $('#kw-add').addEventListener('click', addKw);
    $('#kw-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addKw(); }
    });
    $('#kw-save').addEventListener('click', saveKw);
    $('#kw-clear').addEventListener('click', clearKw);

    $('#pv-check').addEventListener('click', async function () {
      var id = $('#pv-check').dataset.id;
      if (!id) return;
      $('#pv-check').disabled = true;
      var res = await send({ type: 'check-now', id: id });
      $('#pv-check').disabled = false;
      if (res.ok) {
        toast(res.changed ? ('发现 ' + ((res.diff && res.diff.added) || 0) + ' 条更新') : '检查完成，暂无变化');
        openPreview(id);
        reload();
      } else {
        toast('检查失败：' + res.error, true);
      }
    });

    $('#pv-seen').addEventListener('click', async function () {
      var id = $('#pv-seen').dataset.id;
      if (!id) return;
      await send({ type: 'mark-seen', ids: [id] });
      closePreview();
      reload();
    });

    $('#intervalHours').addEventListener('change', function (e) {
      patch({ intervalHours: Number(e.target.value) }, '检查间隔已保存');
    });
    $('#startupCheck').addEventListener('change', function (e) {
      patch({ startupCheck: e.target.checked }, '已保存');
    });
    $('#notify').addEventListener('change', function (e) {
      patch({ notify: e.target.checked }, '已保存');
    });
    $('#onlyChanged').addEventListener('change', function (e) {
      patch({ onlyChanged: e.target.checked }, '已保存');
    });
    $('#carryCategory').addEventListener('change', function (e) {
      patch({ carryCategory: e.target.checked }, e.target.checked ? '新订阅会沿用上一个的分类' : '新订阅默认未分类');
    });
    $('#panelEnabled').addEventListener('change', function (e) {
      patch({ panelEnabled: e.target.checked }, '已保存');
    });
    $('#panelSide').addEventListener('change', function (e) {
      patch({ panelSide: e.target.value }, '已保存');
    });

    var opacity = $('#panelOpacity');
    var opacityTimer = 0;
    opacity.addEventListener('input', function () {
      $('#opacityValue').textContent = opacity.value + '%';
      clearTimeout(opacityTimer);
      opacityTimer = setTimeout(function () {
        patch({ panelOpacity: Number(opacity.value) / 100 });
      }, 260);
    });

    $('#check-all').addEventListener('click', async function () {
      var btn = $('#check-all');
      btn.disabled = true;
      btn.textContent = '检查中…';
      var res = await send({ type: 'check-all' });
      btn.disabled = false;
      btn.textContent = '全部检查';
      if (res.ok) {
        var changed = (res.results || []).filter(function (r) { return r.ok && r.changed; }).length;
        toast(changed ? (changed + ' 个订阅有更新') : '检查完成，暂无变化');
        reload();
      } else {
        toast('检查失败：' + res.error, true);
      }
    });

    $('#save-subs').addEventListener('click', savePending);

    $('#test-notify').addEventListener('click', async function () {
      var res = await send({ type: 'test-notify' });
      toast(res.ok ? '已发送测试通知' : ('发送失败：' + res.error), !res.ok);
    });

    $('#export-all').addEventListener('click', function () { exportBackup('all'); });
    $('#export-settings').addEventListener('click', function () { exportBackup('settings'); });
    $('#export-filtered').addEventListener('click', function () { exportBackup('filtered'); });
    $('#export-selected').addEventListener('click', function () { exportBackup('picked'); });

    $('#sel-toggle').addEventListener('click', function () { setSelectMode(!selectMode); });
    $('#sel-all').addEventListener('click', function () {
      filteredSubs().forEach(function (s) { picked[s.id] = true; });
      renderSubs();
    });
    $('#sel-none').addEventListener('click', function () {
      picked = {};
      renderSubs();
    });
    $('#batch-kw').addEventListener('click', function () {
      var ids = pickedIds();
      if (!ids.length) { toast('先选中要设置的订阅', true); return; }
      openBatchKw(ids);
    });
    $('#batch-cat').addEventListener('click', function () {
      var ids = pickedIds();
      if (!ids.length) { toast('先选中要设置的订阅', true); return; }
      openBatchCat(ids);
    });

    $('#filter-kw').addEventListener('change', function (e) {
      filter.kw = e.target.value;
      renderSubs();
    });
    $('#filter-status').addEventListener('change', function (e) {
      filter.status = e.target.value;
      renderSubs();
    });

    $('#bcat-x').addEventListener('click', closeBatchCat);
    $('#bcat-cancel').addEventListener('click', closeBatchCat);
    $('#bcat-apply').addEventListener('click', applyBatchCat);
    $('#bcat-modal').addEventListener('click', function (e) {
      if (e.target === $('#bcat-modal')) closeBatchCat();
    });

    $('#import').addEventListener('click', function () { $('#import-file').click(); });

    $('#import-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = async function () {
        var data;
        try { data = JSON.parse(String(reader.result)); }
        catch (err) { toast('文件不是有效的 JSON', true); return; }
        if (!data || typeof data !== 'object') { toast('文件内容不是备份格式', true); return; }
        if (!Array.isArray(data.subs) && !data.settings) { toast('备份里既没有订阅也没有设置', true); return; }
        var dry = await send({ type: 'import-backup', data: data, mode: 'merge', applySettings: true, dryRun: true });
        if (!dry.ok) { toast('无法读取备份：' + dry.error, true); return; }
        openImport(data, dry.summary);
      };
      reader.readAsText(file);
    });

    $('#im-x').addEventListener('click', closeImport);
    $('#im-cancel').addEventListener('click', closeImport);
    $('#im-modal').addEventListener('click', function (e) {
      if (e.target === $('#im-modal')) closeImport();
    });
    $('#im-merge').addEventListener('click', function () { runImport('merge'); });
    $('#im-replace').addEventListener('click', function () { runImport('replace'); });

    $('#reset').addEventListener('click', async function () {
      if (!window.confirm('恢复默认设置？订阅本身不会被删除。')) return;
      var res = await send({ type: 'reset-settings' });
      if (res.ok) { toast('已恢复默认设置'); reload(); }
      else toast('重置失败：' + res.error, true);
    });

    $('#clear-subs').addEventListener('click', async function () {
      var n = (state.subs || []).length;
      if (!n) { toast('当前没有订阅'); return; }
      if (!window.confirm('确定清空全部 ' + n + ' 个订阅？此操作不可撤销。')) return;
      var ids = (state.subs || []).map(function (s) { return s.id; });
      for (var i = 0; i < ids.length; i++) await send({ type: 'remove-sub', id: ids[i] });
      picked = {};
      toast('已清空全部订阅');
      reload();
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.subs || changes.settings) reload();
    });
  }

  async function init() {
    bind();
    await reload();
  }

  init();
})();
