/* Offscreen DOM parser for fetched HTML. Has DOMParser, no network. */
(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'offscreen' || msg.type !== 'parse') return;
    try {
      var html = String(msg.html || '');
      // Inline handlers would be compiled by the parser and blocked by the
      // extension CSP (console noise on chrome://extensions), so strip them.
      if (window.__PRT && window.__PRT.stripInlineHandlers) {
        html = window.__PRT.stripInlineHandlers(html);
      }
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var opts = msg.opts || {};
      if (!opts.baseUrl) {
        var baseEl = doc.querySelector('base[href]');
        opts.baseUrl = baseEl ? baseEl.getAttribute('href') : '';
      }
      var res = window.__PRX.extractFromDocument(doc, opts);
      sendResponse(res);
    } catch (e) {
      sendResponse({ ok: false, reason: 'parse-error', error: String(e && e.message || e) });
    }
  });
})();
