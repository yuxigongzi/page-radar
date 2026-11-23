/*
 * PageRadar text utilities.
 * Loaded in: content scripts, the offscreen parser, the service worker
 * (via importScripts) and Node tests (via require).
 */
(function (root) {
  'use strict';

  /** Collapse whitespace, strip zero-width chars and blank lines. */
  function normText(input) {
    return String(input == null ? '' : input)
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean)
      .join('\n');
  }

  /** 32-bit FNV-1a over UTF-16 code units, plus the source length. */
  function hashText(str) {
    var s = String(str == null ? '' : str);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + s.length.toString(36);
  }

  // Relative-time fragments are the single biggest source of false positives
  // on boards ("3 分钟前" changes on every check).
  var RELATIVE_TIME_RES = [
    /\d+\s*(?:秒|秒钟|分钟|分|小时|钟头|天|日|周|星期|个月|月|年)\s*(?:前|之前|以前)/g,
    /\d+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|mo|mos|months?)\s+ago\b/gi,
    /(?:刚刚|刚才)(?:\s*\d{1,2}:\d{2})?/g,
    /\b(?:just now)\b/gi
  ];

  function stripRelative(str) {
    var s = String(str == null ? '' : str);
    for (var i = 0; i < RELATIVE_TIME_RES.length; i++) s = s.replace(RELATIVE_TIME_RES[i], ' ');
    return s;
  }

  /** Replace every digit run so "阅读 1234" -> "阅读 #". */
  function stripDigits(str) {
    return String(str == null ? '' : str).replace(/\d+/g, '#');
  }

  /** Comparison key that ignores relative times and pure number changes. */
  function noiseKey(str) {
    return stripDigits(stripRelative(normText(str))).replace(/\s+/g, ' ');
  }

  // Parsing third-party HTML with DOMParser compiles every inline event
  // handler attribute it meets, which the extension CSP then blocks and logs
  // as a violation. The handlers are useless to us, so drop them up front.
  var ON_ATTR_RE = /(\s+)on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

  function stripInlineAttrs(tag) {
    return tag.replace(ON_ATTR_RE, '$1');
  }

  /**
   * Remove on* attributes from every start tag. Quote-aware tag scanning keeps
   * values that contain ">" from breaking the tag apart.
   */
  function stripInlineHandlers(html) {
    var s = String(html == null ? '' : html);
    if (!/\son[a-z]+\s*=/i.test(s)) return s;
    var out = [];
    var i = 0;
    var n = s.length;
    while (i < n) {
      var lt = s.indexOf('<', i);
      if (lt < 0) { out.push(s.slice(i)); break; }
      out.push(s.slice(i, lt));
      var j = lt + 1;
      var quote = 0;
      var closed = false;
      while (j < n) {
        var c = s.charCodeAt(j);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) {
          quote = c;
        } else if (c === 62) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) { out.push(s.slice(lt)); break; }
      out.push(stripInlineAttrs(s.slice(lt, j + 1)));
      i = j + 1;
    }
    return out.join('');
  }

  var api = {
    normText: normText,
    hashText: hashText,
    stripRelative: stripRelative,
    stripDigits: stripDigits,
    noiseKey: noiseKey,
    stripInlineHandlers: stripInlineHandlers
  };

  root.__PRT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
