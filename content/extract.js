/*
 * PageRadar DOM extraction.
 *
 * Runs in three places, always in an isolated world:
 *   - the normal content script (live page)
 *   - chrome.scripting.executeScript fallback (background tab of a JS-rendered page)
 *   - the offscreen document (parsing fetched HTML with DOMParser)
 *
 * Everything is exposed on window.__PRX so the injected function in
 * background.js can reach it without re-declaring the heuristics.
 */
(function (root) {
  'use strict';
  if (root.__PRX) return;

  var T = root.__PRT;
  if (!T) throw new Error('PageRadar: shared/text.js must load before content/extract.js');

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, IFRAME: 1,
    CANVAS: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, BR: 1, OPTION: 1
  };
  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, DD: 1, DETAILS: 1,
    DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1,
    FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1,
    HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1,
    TABLE: 1, TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1, TR: 1, UL: 1
  };

  function normText(s) { return T.normText(s); }
  function hashText(s) { return T.hashText(s); }

  function isHiddenEl(el) {
    if (el.hasAttribute && (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true')) return true;
    var st = el.style;
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
    return false;
  }

  /**
   * Text of a node, independent of layout so the same markup produces the
   * same string in a live tab and in DOMParser output.
   */
  function domText(node) {
    var out = [];
    (function walk(n) {
      if (n.nodeType === 3) {
        if (n.nodeValue) out.push(n.nodeValue);
        return;
      }
      if (n.nodeType !== 1) return;
      if (SKIP_TAGS[n.tagName]) return;
      if (isHiddenEl(n)) return;
      var block = BLOCK_TAGS[n.tagName] === 1;
      if (block) out.push('\n');
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
      if (block) out.push('\n');
    })(node);
    return normText(out.join(''));
  }

  function stableClass(name) {
    if (!name || name.length > 40 || name.length < 2) return false;
    if (/^\d/.test(name)) return false;
    if (/[^a-zA-Z0-9_-]/.test(name)) return false;
    if (/^(css|sc|jss|emotion|styled|svelte|ng|v|mantine|chakra)-?/i.test(name)) return false;
    // Hashes such as a8f3c2 / css-1x2y3z / sc-bdVaJa
    if (/[0-9]/.test(name) && /[0-9a-f]{5,}/i.test(name)) return false;
    if (/^[a-z0-9]{10,}$/i.test(name) && /[0-9]/.test(name)) return false;
    return true;
  }

  function classSig(el) {
    var out = [];
    var cls = el.classList;
    if (!cls) return '';
    for (var i = 0; i < cls.length && out.length < 3; i++) {
      if (stableClass(cls[i])) out.push(cls[i]);
    }
    out.sort();
    return out.join('.');
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function queryAll(doc, selector) {
    try { return doc.querySelectorAll(selector); } catch (e) { return null; }
  }

  function isUnique(doc, selector) {
    var nodes = queryAll(doc, selector);
    return !!nodes && nodes.length === 1;
  }

  function nthPath(el) {
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && node !== el.ownerDocument.documentElement && guard++ < 24) {
      if (node.id) {
        var byId = '#' + cssEscape(node.id);
        if (isUnique(el.ownerDocument, byId)) { parts.unshift(byId); node = null; break; }
      }
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var index = 1;
        for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.tagName === node.tagName) index++;
        }
        part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function classPath(el, depth) {
    var parts = [];
    var node = el;
    for (var i = 0; i < depth && node && node.nodeType === 1; i++) {
      if (node === el.ownerDocument.documentElement) break;
      var part = node.tagName.toLowerCase();
      var sig = classSig(node);
      if (sig) part += '.' + sig.split('.').map(cssEscape).join('.');
      else if (node !== el) return '';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** Ordered, de-duplicated selectors for the picked element. */
  function candidatesFor(el) {
    var out = [];
    var doc = el.ownerDocument;
    function add(sel) {
      if (!sel || out.indexOf(sel) !== -1) return;
      if (!isUnique(doc, sel)) return;
      out.push(sel);
    }
    if (el.id && stableClass(el.id)) add('#' + cssEscape(el.id));
    var short = el.tagName.toLowerCase() + (classSig(el) ? '.' + classSig(el).split('.').map(cssEscape).join('.') : '');
    add(short);
    add(classPath(el, 2));
    add(classPath(el, 3));
    add(nthPath(el));
    if (!out.length) {
      var fallback = nthPath(el);
      if (fallback) out.push(fallback);
    }
    return out.slice(0, 5);
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var sig = classSig(el);
    if (sig) s += '.' + sig.split('.').slice(0, 2).join('.');
    return s;
  }

  function makeTextLength() {
    var memo = new WeakMap();
    function len(node) {
      var cached = memo.get(node);
      if (cached !== undefined) return cached;
      var n = 0;
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) n += c.nodeValue ? c.nodeValue.length : 0;
        else if (c.nodeType === 1 && !SKIP_TAGS[c.tagName]) n += len(c);
      }
      memo.set(node, n);
      return n;
    }
    return len;
  }

  function resolveUrl(raw, baseUrl) {
    if (!raw) return '';
    try {
      var url = new URL(raw, baseUrl || root.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from'].forEach(function (key) {
        url.searchParams.delete(key);
      });
      return url.href;
    } catch (e) {
      return '';
    }
  }

  function itemTitle(el) {
    var heading = el.querySelector('h1,h2,h3,h4,h5,h6');
    var link = el.matches('a[href]') ? el : el.querySelector('a[href]');
    var text = '';
    if (heading) text = domText(heading);
    if (!text && link) text = domText(link) || link.getAttribute('title') || '';
    if (!text) text = domText(el).split('\n')[0] || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  /**
   * Detect a repeated item list inside a section (articles, rows, cards).
   * Returns [] when the section is better compared as a single text blob.
   */
  function extractItems(section, baseUrl) {
    if (!section || section.nodeType !== 1) return [];
    var textLen = makeTextLength();
    var byParent = new Map();
    var els = section.querySelectorAll('*');
    var limit = Math.min(els.length, 4000);

    for (var i = 0; i < limit; i++) {
      var el = els[i];
      if (SKIP_TAGS[el.tagName]) continue;
      var parent = el.parentElement;
      if (!parent) continue;
      var map = byParent.get(parent);
      if (!map) { map = new Map(); byParent.set(parent, map); }
      var sig = el.tagName + '|' + classSig(el);
      var group = map.get(sig);
      if (!group) { group = { items: [], tag: el.tagName }; map.set(sig, group); }
      if (group.items.length < 400) group.items.push(el);
    }

    var best = null;
    var bestScore = 0;
    byParent.forEach(function (map) {
      map.forEach(function (group) {
        var items = group.items;
        var count = items.length;
        if (count < 2) return;
        var total = 0;
        var links = 0;
        var min = Infinity;
        for (var k = 0; k < count; k++) {
          var l = textLen(items[k]);
          total += l;
          if (l < min) min = l;
          if (l > 0 && items[k].querySelector('a[href]')) links++;
        }
        var avg = total / count;
        if (avg < 5 || total < 30) return;
        if (min === 0 && count < 4) return;
        var linkRatio = links / count;
        if (linkRatio === 0 && avg < 22) return;
        var score = count * Math.min(avg, 140);
        score *= 1 + linkRatio * 0.85;
        score += Math.min(count, 15) * 2;
        // Prefer the deeper, more specific group when scores are close.
        var depth = 0;
        for (var p = items[0].parentElement; p && p !== section && depth < 30; p = p.parentElement) depth++;
        score += depth * 0.6;
        if (score > bestScore) { bestScore = score; best = group; }
      });
    });

    if (!best) return [];
    var out = [];
    var seen = Object.create(null);
    var use = best.items.slice(0, 300);
    for (var j = 0; j < use.length; j++) {
      var node = use[j];
      var title = itemTitle(node);
      if (!title) continue;
      var linkEl = node.matches('a[href]') ? node : node.querySelector('a[href]');
      var href = linkEl ? resolveUrl(linkEl.getAttribute('href'), baseUrl) : '';
      var key = href || ('T:' + title);
      if (seen[key]) {
        var n = 2;
        while (seen[key + '#' + n]) n++;
        key = key + '#' + n;
      }
      seen[key] = 1;
      out.push({ key: key, title: title, url: href });
    }
    return out;
  }

  function snapshotFromElement(el, baseUrl) {
    var text = domText(el);
    var items = extractItems(el, baseUrl);
    return {
      v: 1,
      hash: hashText(text),
      text: text.slice(0, 80000),
      textLen: text.length,
      items: items,
      itemCount: items.length,
      at: Date.now()
    };
  }

  function resolveElement(doc, opts) {
    opts = opts || {};
    var list = [];
    if (opts.selector) list.push(opts.selector);
    if (Array.isArray(opts.candidates)) {
      opts.candidates.forEach(function (c) { if (c && list.indexOf(c) === -1) list.push(c); });
    }
    for (var i = 0; i < list.length; i++) {
      var nodes = queryAll(doc, list[i]);
      if (nodes && nodes.length === 1) return { el: nodes[0], via: list[i] };
    }
    for (var j = 0; j < list.length; j++) {
      var any = queryAll(doc, list[j]);
      if (any && any.length > 1) return { el: any[0], via: list[j] + ' (first of ' + any.length + ')' };
    }
    // Last resort: the same tag carrying the recorded opening text.
    if (opts.anchor && opts.tag) {
      var tagged = doc.getElementsByTagName(opts.tag);
      var needle = opts.anchor.slice(0, 24);
      var found = null;
      var foundLen = Infinity;
      for (var k = 0; k < tagged.length && k < 4000; k++) {
        var text = domText(tagged[k]);
        if (!text || text.indexOf(needle) !== 0) continue;
        if (text.length < opts.anchor.length * 0.4) continue;
        if (text.length > opts.anchor.length * 4 + 400) continue;
        if (text.length < foundLen) { found = tagged[k]; foundLen = text.length; }
      }
      if (found) return { el: found, via: 'anchor-text' };
    }
    return { el: null, via: null };
  }

  function extractFromDocument(doc, opts) {
    var hit = resolveElement(doc, opts);
    if (!hit.el) return { ok: false, reason: 'selector-missing' };
    var snap = snapshotFromElement(hit.el, opts && opts.baseUrl);
    if (!snap.text) return { ok: false, reason: 'section-empty' };
    snap.via = hit.via;
    return Object.assign({ ok: true }, snap);
  }

  function guessTitle(el) {
    if (!el) return '';
    var headings = el.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < headings.length; i++) {
      var t = normText(headings[i].textContent);
      if (t && t.length <= 60) return t;
    }
    var sib = el.previousElementSibling;
    for (var j = 0; sib && j < 3; j++, sib = sib.previousElementSibling) {
      if (/^H[1-6]$/.test(sib.tagName)) {
        var ht = normText(sib.textContent);
        if (ht) return ht.slice(0, 60);
      }
    }
    var docTitle = normText(root.document ? root.document.title : '').split(/[-_|—·]/)[0].trim();
    if (docTitle) return docTitle.slice(0, 60);
    return (root.location && root.location.hostname) || '未命名板块';
  }

  root.__PRX = {
    version: 1,
    normText: normText,
    hashText: hashText,
    domText: domText,
    extractItems: extractItems,
    snapshotFromElement: snapshotFromElement,
    extractFromDocument: extractFromDocument,
    resolveElement: resolveElement,
    candidatesFor: candidatesFor,
    describe: describe,
    guessTitle: guessTitle
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
