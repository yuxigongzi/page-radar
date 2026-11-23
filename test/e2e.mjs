/* PageRadar end-to-end test: real Chrome + CDP.
 *
 * Usage: node test/e2e.mjs [--keep] [--chrome <path>]
 * Requires: Google Chrome installed. Uses a throwaway profile.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from './server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test', 'out');
// Branded Google Chrome (>=137) refuses --load-extension, so default to Edge,
// which still allows loading an unpacked extension for testing.
const BROWSER = process.env.BROWSER_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const KEEP = process.argv.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message + (msg.error.data ? ' — ' + msg.error.data : '')));
        else p.resolve(msg.result);
        return;
      }
      const list = this.handlers.get(msg.sessionId || 'browser') || [];
      for (const fn of list) {
        try { fn(msg); } catch (e) { /* ignore */ }
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('websocket 连接失败: ' + url));
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 60000);
    });
  }

  on(sessionId, fn) {
    const list = this.handlers.get(sessionId) || [];
    list.push(fn);
    this.handlers.set(sessionId, list);
  }
}

/* ------------------------------------------------------------------ utils */

const failures = [];
const notes = [];

function ok(cond, message) {
  if (cond) {
    notes.push('  ✓ ' + message);
    return true;
  }
  failures.push(message);
  notes.push('  ✗ ' + message);
  return false;
}

function eq(actual, expected, message) {
  return ok(actual === expected, message + '  (实际: ' + JSON.stringify(actual) + ')');
}

async function waitFor(label, fn, timeout = 12000, interval = 200) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error('等待超时: ' + label + (lastErr ? ' — ' + lastErr.message : ''));
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
    throw new Error('页面执行失败: ' + desc);
  }
  return r.result ? r.result.value : undefined;
}

/* ------------------------------------------------------------------ main */

const server = await startServer();
await fs.mkdir(OUT, { recursive: true });

const profile = path.join(os.tmpdir(), 'pageradar-e2e-' + Date.now());
await fs.mkdir(profile, { recursive: true });
const extraProfiles = [];

const dbgPort = 9300 + Math.floor(Math.random() * 400);
let chrome = null;
let cdp = null;
let control = null;
let extId = '';

function log(...args) { console.log(...args); }

// Launch the browser with the unpacked extension. Edge only loads
// --load-extension on a profile it has not initialised before, so a restart is
// simulated with a fresh profile that inherits the extension storage.
function launch(dir) {
  const dataDir = dir || profile;
  chrome = spawn(BROWSER, [
    '--user-data-dir=' + dataDir,
    '--load-extension=' + ROOT,
    '--disable-extensions-except=' + ROOT,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--remote-debugging-port=' + dbgPort,
    '--remote-allow-origins=*',
    '--window-size=1240,900',
    '--window-position=40,40',
    'about:blank'
  ], { stdio: 'ignore' });
}

// Connect to the DevTools endpoint and attach to the extension service worker.
// When the worker has not started yet (e.g. right after a browser restart), an
// extension page is opened to wake it up.
async function attachBrowser(hintId) {
  const version = await waitFor('DevTools 端口', async () => {
    const res = await fetch('http://127.0.0.1:' + dbgPort + '/json/version');
    if (!res.ok) return null;
    return res.json();
  }, 30000);

  cdp = await CDP.connect(version.webSocketDebuggerUrl);

  const t0 = Date.now();
  let woke = false;
  let swTarget = null;
  while (!swTarget) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('/background/background.js'));
    if (swTarget) break;
    if (Date.now() - t0 > 25000) throw new Error('等待超时: 扩展 service worker');
    if (!woke && hintId && Date.now() - t0 > 6000) {
      woke = true;
      await cdp.send('Target.createTarget', {
        url: 'chrome-extension://' + hintId + '/options/options.html',
        newWindow: true
      }).catch(() => {});
    }
    await sleep(250);
  }

  const attached = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  const session = attached.sessionId;
  await cdp.send('Runtime.enable', {}, session);
  return { sw: session, extId: new URL(swTarget.url).host };
}

async function screenshot(sessionId, name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(OUT, name + '.png');
    await fs.writeFile(file, Buffer.from(r.data, 'base64'));
    return file;
  } catch (e) {
    notes.push('  ! 截图失败 ' + name + ': ' + e.message);
    return null;
  }
}

try {
  /* ---------------------------------------------------------- launch */
  log('\n[1] 启动 Chrome，加载扩展');
  launch();
  const firstAttach = await attachBrowser();
  extId = firstAttach.extId;
  let sw = firstAttach.sw;
  log('    扩展 ID:', extId);

  const swEval = (body) => evaluate(cdp, sw, '(async () => {' + body + '})()');

  const bootState = await waitFor('扩展初始化', async () => {
    const st = await swEval(`
      const all = await chrome.storage.local.get(['settings','subs','snaps','meta']);
      const alarms = await chrome.alarms.getAll();
      return { settings: all.settings, subs: all.subs, meta: all.meta, alarms };
    `);
    return st && st.settings ? st : null;
  }, 10000);
  ok(!!bootState.settings, '默认设置已写入');
  eq(bootState.settings.intervalHours, 12, '默认检查间隔为 12 小时');
  eq(bootState.settings.panelOpacity, 0.92, '默认悬浮窗透明度 92%');

  /* ---------------------------------------------------------- control page */
  const ctl = await cdp.send('Target.createTarget', {
    url: 'chrome-extension://' + extId + '/options/options.html',
    newWindow: true, width: 1240, height: 900
  });
  const ctlAttach = await cdp.send('Target.attachToTarget', { targetId: ctl.targetId, flatten: true });
  control = ctlAttach.sessionId;
  await cdp.send('Page.enable', {}, control);
  await cdp.send('Runtime.enable', {}, control);
  await waitFor('设置页加载', () => evaluate(cdp, control, 'document.readyState === "complete"'));

  const ctlEval = (body) => evaluate(cdp, control, '(async () => {' + body + '})()');
  const sendMsg = (msg) => ctlEval('return await chrome.runtime.sendMessage(' + JSON.stringify(msg) + ');');
  const storage = () => ctlEval('return await chrome.storage.local.get(["subs","snaps","meta","settings"]);');

  /* ---------------------------------------------------------- helpers */
  async function openPage(url) {
    const t = await cdp.send('Target.createTarget', { url, newWindow: true, width: 1240, height: 900 });
    const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const session = a.sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await waitFor('页面加载 ' + url, () => evaluate(cdp, session, 'document.readyState === "complete"'));
    return { targetId: t.targetId, session };
  }

  async function tabIdFor(url) {
    return swEval(`
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find((t) => t.url && t.url.split('#')[0] === ${JSON.stringify(url)});
      return hit ? hit.id : null;
    `);
  }

  async function startPicker(url) {
    const tabId = await tabIdFor(url);
    if (!tabId) throw new Error('找不到标签页: ' + url);
    return swEval(`
      await chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        files: ['shared/text.js','content/ui.js','content/extract.js','content/content.js']
      });
      await new Promise((r) => setTimeout(r, 150));
      return await chrome.tabs.sendMessage(${tabId}, { type: 'PR_START_PICKER' });
    `);
  }

  async function pickSection(session, selector) {
    const hover = await evaluate(cdp, session, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, why: '页面里没有 ' + ${JSON.stringify(selector)} };
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + Math.min(r.width / 2, 140));
        const y = Math.round(r.bottom - 8);
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        window.dispatchEvent(new PointerEvent('pointermove', opts));
        window.dispatchEvent(new PointerEvent('pointerdown', opts));
        const host = document.getElementById('pr-pick-host');
        if (!host || !host.shadowRoot) return { ok: false, why: '选择器没有挂载' };
        const sr = host.shadowRoot;
        const card = sr.querySelector('#pr-card');
        return {
          ok: !!card && !card.hidden,
          label: (sr.querySelector('#pr-el') || {}).textContent || '',
          preview: (sr.querySelector('#pr-prev') || {}).textContent || '',
          cardHidden: card ? card.hidden : null
        };
      })()
    `);
    if (!hover.ok) throw new Error('框选失败: ' + (hover.why || hover.cardHidden));
    return hover;
  }

  async function clickSubscribe(session) {
    return evaluate(cdp, session, `
      (() => {
        const host = document.getElementById('pr-pick-host');
        if (!host || !host.shadowRoot) return { ok: false };
        const btn = host.shadowRoot.querySelector('[data-pick="subscribe"]');
        if (!btn) return { ok: false };
        btn.click();
        return { ok: true };
      })()
    `);
  }

  async function panelInfo(session) {
    return evaluate(cdp, session, `
      (() => {
        const host = document.getElementById('pr-panel-host');
        if (!host || !host.shadowRoot) return { present: false };
        const sr = host.shadowRoot;
        return {
          present: true,
          open: host.getAttribute('data-open'),
          side: host.getAttribute('data-side'),
          rows: sr.querySelectorAll('.row').length,
          dots: Array.from(sr.querySelectorAll('.row .dot')).map((d) => d.className),
          text: (sr.querySelector('#pr-body') || {}).textContent || '',
          adopted: sr.adoptedStyleSheets ? sr.adoptedStyleSheets.length : 0
        };
      })()
    `);
  }

  /* ---------------------------------------------------------- 1. 框选订阅 */
  log('\n[2] 在真实页面上框选板块并订阅');
  const feedUrl = server.origin + '/feed';
  const feed = await openPage(feedUrl);
  await startPicker(feedUrl);
  const pick = await pickSection(feed.session, '#feed');
  ok(pick.ok, '点选后出现确认卡片');
  ok(/section/i.test(pick.label), '选中了 section#feed（' + pick.label + '）');
  ok(pick.preview.includes('条目'), '预览显示识别到的条目数');
  await screenshot(feed.session, '01-picker');

  await clickSubscribe(feed.session);
  const afterCreate = await waitFor('订阅写入', async () => {
    const s = await storage();
    return s.subs && s.subs.length ? s : null;
  });
  const sub = afterCreate.subs[0];
  eq(afterCreate.subs.length, 1, '订阅已创建');
  ok(!!sub.selector, '保存了稳定选择器: ' + sub.selector);
  ok((sub.candidates || []).length >= 1, '保存了候选选择器 ' + JSON.stringify(sub.candidates));
  eq(sub.validated, false, '首次检查前标记为未验证');
  ok(!!afterCreate.snaps[sub.id], '已保存基线快照');
  ok(afterCreate.snaps[sub.id].textLen > 50, '基线快照文本长度 ' + afterCreate.snaps[sub.id].textLen);
  // 首次安装不会触发 onStartup，启动检查在最后「重启浏览器」阶段验证。

  const alarms1 = await ctlEval('return await chrome.alarms.getAll();');
  ok(alarms1.some((a) => a.name === 'pr:tick'), '已安排检查闹钟 pr:tick');

  /* ---------------------------------------------------------- 2. 悬浮窗 */
  log('\n[3] 悬浮窗出现且默认半隐藏');
  await waitFor('悬浮窗挂载', async () => (await panelInfo(feed.session)).present);
  const p1 = await panelInfo(feed.session);
  eq(p1.open, 'false', '默认收起，只在边缘露出一半');
  eq(p1.side, 'right', '默认贴右侧');
  eq(p1.rows, 1, '面板里列出 1 条本页订阅');
  await evaluate(cdp, feed.session, `
    (() => {
      const host = document.getElementById('pr-panel-host');
      host.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
      window.__prPeek = host.getBoundingClientRect().left;
      return true;
    })()
  `);
  await sleep(400);
  const opened = await evaluate(cdp, feed.session, `
    (() => {
      const host = document.getElementById('pr-panel-host');
      return { open: host.getAttribute('data-open'), left: host.getBoundingClientRect().left, peek: window.__prPeek };
    })()
  `);
  eq(opened.open, 'true', '鼠标移上去后展开');
  ok(opened.left < opened.peek, '展开后位置左移（' + Math.round(opened.peek) + ' → ' + Math.round(opened.left) + '）');

  /* ---------------------------------------------------------- 3. 首次检查 */
  log('\n[4] 首次检查只建立基线，不误报');
  const first = await sendMsg({ type: 'check-now', id: sub.id });
  eq(first.ok, true, '首次检查成功');
  eq(first.changed, false, '首次检查不算更新');
  let s2 = await storage();
  eq(s2.subs[0].validated, true, '订阅已验证');
  eq(s2.subs[0].hasNew, false, '没有未读更新');

  /* ---------------------------------------------------------- 4. 真实更新 */
  log('\n[5] 板块出现新内容后能识别并通知');
  await fetch(server.origin + '/bump?page=feed');
  const second = await sendMsg({ type: 'check-now', id: sub.id });
  eq(second.ok, true, '增量检查成功');
  eq(second.changed, true, '识别到更新');
  eq(second.diff && second.diff.added, 1, '新增 1 条');
  s2 = await storage();
  eq(s2.subs[0].hasNew, true, '标记为有未读更新');
  eq(s2.subs[0].addedCount, 1, '未读计数为 1');
  eq(s2.snaps[sub.id].via, 'fetch', '静态页面走 fetch 解析');
  const badge = await ctlEval('return await chrome.action.getBadgeText({});');
  eq(badge, '1', '扩展图标角标显示 1');

  const panelAfter = await waitFor('面板显示更新', async () => {
    const p = await panelInfo(feed.session);
    return p.present && p.dots.some((c) => c.includes('new')) ? p : null;
  });
  ok(panelAfter.text.length > 0, '面板显示更新摘要');
  await screenshot(feed.session, '02-panel-update');

  /* ---------------------------------------------------------- 5. 闹钟 */
  log('\n[6] 闹钟到点自动检查');
  const beforeTick = (await storage()).meta.lastTickAt || 0;
  await swEval('await chrome.alarms.create("pr:tick", { when: Date.now() + 800 }); return true;');
  const ticked = await waitFor('闹钟触发', async () => {
    const m = (await storage()).meta;
    return m.lastTickAt && m.lastTickAt > beforeTick ? m : null;
  }, 20000);
  ok(!!ticked, '闹钟已触发并记录 lastTickAt');

  /* ---------------------------------------------------------- 6. 误报抑制 */
  log('\n[7] 只有数字/相对时间变化时不误报');
  const noiseUrl = server.origin + '/noise';
  const noise = await openPage(noiseUrl);
  await startPicker(noiseUrl);
  await pickSection(noise.session, '#stats');
  await clickSubscribe(noise.session);
  const noiseSub = await waitFor('计数器订阅', async () => {
    const s = await storage();
    return s.subs.find((x) => x.url === noiseUrl) || null;
  });
  await sendMsg({ type: 'check-now', id: noiseSub.id });
  await fetch(server.origin + '/bump?page=noise');
  await fetch(server.origin + '/bump?page=noise');
  const noiseCheck = await sendMsg({ type: 'check-now', id: noiseSub.id });
  eq(noiseCheck.ok, true, '计数器页面检查成功');
  eq(noiseCheck.changed, false, '纯数字变化不当作更新');
  const sNoise = await storage();
  eq(sNoise.subs.find((x) => x.id === noiseSub.id).hasNew, false, '没有误报未读');

  /* ---------------------------------------------------------- 7. 动态页面 */
  log('\n[8] JS 动态渲染的页面用后台标签页兜底');
  const spaUrl = server.origin + '/spa';
  const spa = await openPage(spaUrl);
  await waitFor('动态列表渲染', () => evaluate(cdp, spa.session, 'document.querySelectorAll("#feed article").length >= 3'));
  await startPicker(spaUrl);
  await pickSection(spa.session, '#feed');
  await clickSubscribe(spa.session);
  const spaSub = await waitFor('动态页订阅', async () => {
    const s = await storage();
    return s.subs.find((x) => x.url === spaUrl) || null;
  });
  await sendMsg({ type: 'check-now', id: spaSub.id });
  await fetch(server.origin + '/bump?page=spa');
  const spaCheck = await sendMsg({ type: 'check-now', id: spaSub.id });
  notes.push('    spa: ' + JSON.stringify({ ok: spaCheck.ok, via: spaCheck.via, changed: spaCheck.changed, error: spaCheck.error }));
  eq(spaCheck.ok, true, '动态页检查成功');
  eq(spaCheck.via, 'tab', '静态 HTML 拿不到内容时改用后台标签页渲染');
  eq(spaCheck.changed, true, '动态页的更新也能识别');

  /* ---------------------------------------------------------- 8. CSP 页面 */
  log('\n[9] 严格 CSP 页面上悬浮窗样式仍生效');
  const cspUrl = server.origin + '/csp';
  const csp = await openPage(cspUrl);
  await startPicker(cspUrl);
  await pickSection(csp.session, '#feed');
  await clickSubscribe(csp.session);
  await waitFor('CSP 页悬浮窗', async () => (await panelInfo(csp.session)).present);
  const cspPanel = await panelInfo(csp.session);
  ok(cspPanel.adopted > 0, '通过 adoptedStyleSheets 注入样式（' + cspPanel.adopted + ' 张）');
  await screenshot(csp.session, '03-csp-panel');

  /* ---------------------------------------------------------- 9. 弹窗与设置页 */
  log('\n[10] 工具栏弹窗与设置页渲染');
  const popupUrl = 'chrome-extension://' + extId + '/popup/popup.html';
  const popup = await openPage(popupUrl);
  const popupInfo = await waitFor('弹窗渲染', async () => {
    const r = await evaluate(cdp, popup.session, `
      (() => ({
        summary: (document.getElementById('summary') || {}).textContent || '',
        total: (document.getElementById('total') || {}).textContent || '',
        pick: document.getElementById('pick'),
        pickDisabled: !!(document.getElementById('pick') || {}).disabled,
        note: (document.getElementById('page-note') || {}).textContent || ''
      }))()
    `);
    return r.total && r.total !== '0' ? r : null;
  });
  eq(popupInfo.total, String((await storage()).subs.length), '弹窗显示订阅总数');
  ok(popupInfo.summary.length > 0, '弹窗摘要: ' + popupInfo.summary.slice(0, 40));
  ok(popupInfo.pickDisabled, '扩展页面里禁用框选按钮');
  await screenshot(popup.session, '04-popup');

  // 弹窗里的预览视图：把 chrome.tabs.query 的「当前标签页」伪造为本测试页，
  // 这样弹窗会按真实逻辑渲染出订阅行，再点开预览（真实浏览器里就是普通网页）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const patch = (tabs) => {
          if (!Array.isArray(tabs)) return tabs;
          return tabs.map((t) => Object.assign({}, t, {
            url: ${JSON.stringify(feedUrl)},
            title: '实验室日报'
          }));
        };
        const orig = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = function (q, cb) {
          if (typeof cb === 'function') {
            return orig(q, (tabs) => cb(patch(tabs)));
          }
          return orig(q).then(patch);
        };
        window.__PR_TAB_STUB__ = true;
      })();
    `
  }, popup.session);
  await cdp.send('Page.navigate', { url: popupUrl }, popup.session);
  await waitFor('弹窗刷新（带标签页桩）', () => evaluate(cdp, popup.session, 'document.readyState === "complete"'));
  const stubOn = await evaluate(cdp, popup.session, '!!window.__PR_TAB_STUB__');
  ok(stubOn, '标签页桩已注入弹窗页面');
  const popupRow = await waitFor('弹窗列出订阅行', async () => {
    const r = await evaluate(cdp, popup.session, `
      (() => {
        const rows = document.querySelectorAll('#page-subs .sub');
        return rows.length ? { rows: rows.length, text: rows[0].textContent } : null;
      })()
    `);
    return r;
  }, 10000);
  ok(popupRow.rows >= 1, '弹窗按当前页渲染出订阅行（' + popupRow.rows + ' 行）');
  await evaluate(cdp, popup.session, `(document.querySelector('#page-subs .sub').click(), true)`);
  const popupPv = await waitFor('弹窗预览打开', async () => {
    const r = await evaluate(cdp, popup.session, `
      (() => {
        const card = document.getElementById('pv-card');
        return {
          hidden: card.hidden,
          view: document.body.dataset.view || '',
          title: (document.getElementById('pv-title') || {}).textContent || '',
          items: document.querySelectorAll('#pv-body .pv-item').length,
          excerpt: !!document.querySelector('#pv-body .pv-excerpt')
        };
      })()
    `);
    return !r.hidden && r.view === 'preview' && r.items > 0 ? r : null;
  }, 12000);
  ok(popupPv.items > 0, '弹窗预览列出条目（' + popupPv.items + ' 条）');
  ok(popupPv.excerpt, '弹窗预览显示正文摘录');
  await screenshot(popup.session, '09-popup-preview');
  await evaluate(cdp, popup.session, `(document.getElementById('pv-back').click(), true)`);
  await waitFor('弹窗预览返回列表', () => evaluate(cdp, popup.session, 'document.getElementById("pv-card").hidden === true'), 5000);
  await cdp.send('Page.navigate', { url: popupUrl }, popup.session);
  await waitFor('弹窗恢复', () => evaluate(cdp, popup.session, 'document.readyState === "complete"'));

  const optUrl = 'chrome-extension://' + extId + '/options/options.html';
  // control page is the options page; reload it so it reflects all new subs
  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页刷新', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  const optInfo = await waitFor('设置页渲染', async () => {
    const r = await evaluate(cdp, control, `
      (() => ({
        rows: document.querySelectorAll('.sub-row').length,
        total: document.getElementById('stat-subs').textContent,
        interval: document.getElementById('intervalHours').value,
        opacity: document.getElementById('panelOpacity').value
      }))()
    `);
    return r.rows > 0 ? r : null;
  });
  eq(Number(optInfo.rows), (await storage()).subs.length, '设置页列出全部订阅');
  eq(optInfo.interval, '12', '设置页显示 12 小时');
  await screenshot(control, '05-options');

  /* ---------------------------------------------------------- 10. 改间隔 */
  log('\n[11] 修改检查间隔会持久化并重排');
  const before = (await storage()).subs.map((s) => s.nextCheckAt);
  await evaluate(cdp, control, `
    (() => {
      const sel = document.getElementById('intervalHours');
      sel.value = '6';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const afterInterval = await waitFor('间隔保存并重排', async () => {
    const s = await storage();
    if (s.settings.intervalHours !== 6) return null;
    const moved = s.subs.filter((x, i) => x.nextCheckAt !== before[i]).length;
    return moved > 0 ? s : null;
  }, 15000);
  eq(afterInterval.settings.intervalHours, 6, '全局间隔改为 6 小时');
  const changedNext = afterInterval.subs.filter((s, i) => s.nextCheckAt !== before[i]).length;
  if (!changedNext) {
    notes.push('    before: ' + JSON.stringify(before));
    notes.push('    after:  ' + JSON.stringify(afterInterval.subs.map((s) => s.nextCheckAt)));
  }
  ok(changedNext > 0, '已有订阅的下次检查时间已重排（' + changedNext + ' 条）');

  /* ---------------------------------------------------------- 11. 通知接口 */
  log('\n[12] 系统通知接口可用');
  const testNotify = await sendMsg({ type: 'test-notify' });
  eq(testNotify.ok, true, '测试通知发送成功');

  /* ---------------------------------------------------------- 12. 导出 */
  const exported = await sendMsg({ type: 'export-data' });
  eq(exported.ok, true, '导出数据成功');
  eq(exported.subs.length, afterInterval.subs.length, '导出包含全部订阅');

  /* ---------------------------------------------------------- 12. 预览与分类 */
  log('\n[13] 预览与分类');
  const feedSub = exported.subs.find((s) => s.url === feedUrl);
  ok(!!feedSub, '找到测试订阅');

  const withCats = await sendMsg({
    type: 'save-settings',
    patch: {
      categories: [
        { id: 'c_news', name: '资讯', color: '#5ee0ff' },
        { id: 'c_bad', name: '  颜色非法  ', color: 'red' },
      ],
    },
  });
  eq(withCats.ok, true, '保存分类成功');
  eq(withCats.settings.categories.length, 2, '两个分类已保存');
  eq(withCats.settings.categories[0].name, '资讯', '分类名称保留');
  eq(withCats.settings.categories[1].name, '颜色非法', '分类名称去空格');
  ok(/^#[0-9a-f]{6}$/i.test(withCats.settings.categories[1].color), '非法颜色被替换为调色板颜色（' + withCats.settings.categories[1].color + '）');

  const assigned = await sendMsg({ type: 'update-sub', id: feedSub.id, categoryId: 'c_news' });
  eq(assigned.ok, true, '给订阅设置分类');
  eq((await storage()).subs.find((s) => s.id === feedSub.id).categoryId, 'c_news', '分类已写入订阅');

  const preview = await sendMsg({ type: 'get-preview', id: feedSub.id });
  eq(preview.ok, true, '读取订阅预览成功');
  eq(preview.category && preview.category.id, 'c_news', '预览带上分类信息');
  ok(preview.preview && preview.preview.items.length > 0, '预览含条目（' + ((preview.preview && preview.preview.items.length) || 0) + ' 条）');
  ok(preview.preview && preview.preview.excerpt.length > 0, '预览含正文摘录（' + ((preview.preview && preview.preview.excerpt.length) || 0) + ' 字）');
  ok(preview.preview && preview.preview.total > 0, '预览含条目总数');

  const badPreview = await sendMsg({ type: 'get-preview', id: 'nope' });
  eq(badPreview.ok, false, '不存在的订阅预览会被拒绝');

  const orphan = await sendMsg({ type: 'create-sub', url: server.origin + '/orphan-test', selector: '#feed', categoryId: 'ghost' });
  if (orphan.ok) {
    eq((await storage()).subs.find((s) => s.id === orphan.id).categoryId, '', '未知分类会退化为未分类');
    await sendMsg({ type: 'remove-sub', id: orphan.id });
  }

  // picker 的分类下拉应包含「未分类」+ 已建分类
  await startPicker(feedUrl);
  const catOpts = await waitFor('框选面板含分类下拉', async () => {
    const r = await evaluate(cdp, feed.session, `
      (() => {
        const host = document.getElementById('pr-pick-host');
        const sr = host && host.shadowRoot;
        const sel = sr && sr.querySelector('#pr-cat');
        return sel ? Array.from(sel.options).map((o) => o.textContent) : null;
      })()
    `);
    return r && r.length >= 3 ? r : null;
  }, 8000);
  ok(catOpts.indexOf('未分类') === 0, '分类下拉第一项是未分类');
  ok(catOpts.indexOf('资讯') > 0, '分类下拉包含新建的分类: ' + catOpts.join(' / '));
  await evaluate(cdp, feed.session, `
    (() => {
      const sr = document.getElementById('pr-pick-host').shadowRoot;
      const b = sr.querySelector('[data-pick="cancel"]');
      if (b) b.click();
      return true;
    })()
  `);
  await sleep(300);

  // 设置页的分类区与预览弹窗
  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页刷新（分类）', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  const catUi = await waitFor('设置页分类区渲染', async () => {
    const r = await evaluate(cdp, control, `
      (() => ({
        rows: document.querySelectorAll('#cat-list .cat-item').length,
        chips: Array.from(document.querySelectorAll('#cat-filter .cat-chip')).map((c) => c.textContent.trim()),
        count: (document.getElementById('cat-count') || {}).textContent || '',
        pills: document.querySelectorAll('.sub-row .pill-cat').length
      }))()
    `);
    return r.rows > 0 ? r : null;
  }, 12000);
  eq(catUi.rows, 2, '设置页列出 2 个分类');
  ok(catUi.chips.length >= 2, '分类筛选条: ' + catUi.chips.join(' / '));
  ok(catUi.pills > 0, '订阅行显示分类标签');

  const previewOpened = await evaluate(cdp, control, `
    (() => {
      const row = document.querySelector('.sub-row');
      const btn = row && Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '预览');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  ok(previewOpened, '点击订阅行的预览按钮');
  const modal = await waitFor('预览弹窗打开', async () => {
    const r = await evaluate(cdp, control, `
      (() => {
        const m = document.getElementById('preview');
        return {
          hidden: m.hidden,
          title: (document.getElementById('pv-title') || {}).textContent || '',
          items: document.querySelectorAll('#pv-body .pv-item').length,
          excerpt: !!document.querySelector('#pv-body .pv-excerpt')
        };
      })()
    `);
    return !r.hidden && r.title && r.title !== '正在读取…' ? r : null;
  }, 10000);
  ok(modal.items > 0, '预览弹窗列出条目（' + modal.items + ' 条）');
  ok(modal.excerpt, '预览弹窗显示正文摘录');
  await screenshot(control, '06-preview');
  await evaluate(cdp, control, `(document.getElementById('pv-x').click(), true)`);
  await waitFor('预览弹窗关闭', () => evaluate(cdp, control, 'document.getElementById("preview").hidden === true'), 5000);

  // 按分类筛选
  const filtered = await evaluate(cdp, control, `
    (() => {
      const chips = Array.from(document.querySelectorAll('#cat-filter .cat-chip'));
      const chip = chips.find((c) => c.textContent.indexOf('资讯') >= 0);
      if (!chip) return null;
      chip.click();
      return { rows: document.querySelectorAll('#sub-list .sub-row').length, empty: document.getElementById('sub-empty').textContent.trim() };
    })()
  `);
  ok(filtered && filtered.rows >= 1, '按分类筛选后仍显示对应订阅');
  await evaluate(cdp, control, `
    (() => {
      const chips = Array.from(document.querySelectorAll('#cat-filter .cat-chip'));
      const chip = chips.find((c) => c.textContent.trim().indexOf('全部') === 0);
      if (chip) chip.click();
      return true;
    })()
  `);
  await sleep(220);
  await screenshot(control, '08-options-categories');


  // 悬浮窗里的预览抽屉
  const drawer = await evaluate(cdp, feed.session, `
    (() => {
      const host = document.getElementById('pr-panel-host');
      const sr = host && host.shadowRoot;
      const btn = sr && sr.querySelector('[data-row-preview]');
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true };
    })()
  `);
  ok(drawer.ok, '点击面板里的预览按钮');
  const drawerInfo = await waitFor('面板预览抽屉渲染', async () => {
    const r = await evaluate(cdp, feed.session, `
      (() => {
        const host = document.getElementById('pr-panel-host');
        const sr = host && host.shadowRoot;
        const card = sr && sr.querySelector('#pr-pvx');
        if (!card || card.getAttribute('data-show') !== 'true') return null;
        var hostRect = host.getBoundingClientRect();
        return {
          title: (card.querySelector('.pvxtitle') || {}).textContent || '',
          items: card.querySelectorAll('.pvxitem').length,
          excerpt: !!card.querySelector('.pvxex'),
          open: host.getAttribute('data-open'),
          host: { left: Math.round(hostRect.left), width: Math.round(hostRect.width) },
          drawer: Math.round(card.getBoundingClientRect().left),
          transition: getComputedStyle(card).transform
        };
      })()
    `);
    return r && r.items > 0 ? r : null;
  }, 10000);
  ok(drawerInfo.items > 0, '面板预览抽屉列出条目（' + drawerInfo.items + ' 条）');
  ok(drawerInfo.excerpt, '面板预览抽屉显示正文摘录');
  eq(drawerInfo.open, 'true', '打开预览时悬浮窗自动展开');
  await sleep(520);
  await screenshot(feed.session, '07-panel-preview');
  await evaluate(cdp, feed.session, `
    (() => {
      const host = document.getElementById('pr-panel-host');
      const sr = host && host.shadowRoot;
      const b = sr && sr.querySelector('[data-pv="close"]');
      if (b) b.click();
      return true;
    })()
  `);
  await sleep(300);

  log('\n[14] 点击面板条目后清除未读');
  const unreadId = afterInterval.subs.find((s) => s.hasNew && s.url === feedUrl).id;
  const panelRow = await evaluate(cdp, feed.session, `
    (() => {
      const host = document.getElementById('pr-panel-host');
      const sr = host && host.shadowRoot;
      const rows = sr ? Array.from(sr.querySelectorAll('.row')) : [];
      const row = rows[0];
      if (!row) return { ok: false };
      row.click();
      return { ok: true };
    })()
  `);
  ok(panelRow.ok, '点击了面板里的订阅条目');
  await sleep(900);
  const afterSeen = await storage();
  eq(afterSeen.subs.find((s) => s.id === unreadId).hasNew, false, '未读状态已清除');
  let flashOk = false;
  try {
    await waitFor('板块高亮', () => evaluate(cdp, feed.session, '!!document.getElementById("pr-flash-host")'), 5000, 150);
    flashOk = true;
  } catch (e) {
    const hint = await evaluate(cdp, feed.session, '(document.body.innerText || "").slice(0, 100)').catch(() => '');
    notes.push('    页面提示文字: ' + hint.replace(/\s+/g, ' '));
  }
  ok(flashOk, '被订阅板块出现高亮提示');

  /* ---------------------------------------------------------- 15. 关键词提醒 */
  log('');
  log('[15] 关键词提醒：只在关键词出现时通知');
  const kwSub0 = (await storage()).subs.find((s) => s.url === feedUrl);
  ok(!kwSub0.keywords || kwSub0.keywords.length === 0, '新订阅默认没有关键词');

  let kwUpd = await sendMsg({ type: 'update-sub', id: kwSub0.id, keywords: ['  招聘  ', '招聘', 'x'.repeat(30), '', '报名'] });
  ok(kwUpd.ok, '关键词设置成功');
  eq(kwUpd.sub.keywords.length, 3, '关键词去重、去空、超长截断');
  eq(kwUpd.sub.keywords[0], '招聘', '关键词去掉了首尾空格');
  eq(kwUpd.sub.hits.length, 0, '更新关键词后命中记录被清空');

  kwUpd = await sendMsg({ type: 'update-sub', id: kwSub0.id, keywords: ['招聘'] });
  eq(kwUpd.sub.keywords.join(','), '招聘', '收敛到单个关键词');

  await fetch(server.origin + '/bump?page=feed&kw=' + encodeURIComponent('招聘'));
  let kwRes = await sendMsg({ type: 'check-now', id: kwSub0.id });
  ok(kwRes.ok, '关键词模式检查完成');
  eq(kwRes.keywordMode, true, '进入关键词模式');
  eq(kwRes.notify, true, '关键词首次出现时提醒');
  ok((kwRes.hits || []).indexOf('招聘') >= 0, '命中关键词「招聘」');

  let kwState = await storage();
  let kwSub = kwState.subs.find((s) => s.id === kwSub0.id);
  eq(kwSub.hasNew, true, '关键词命中会被标记为新内容');
  eq(kwSub.lastDiff && kwSub.lastDiff.kind, 'keyword', '记下这是关键词级更新');
  eq(kwSub.addedCount, 1, '新增关键词命中 1 个');

  const kwPanel = await evaluate(cdp, feed.session, `
    (() => {
      const host = document.getElementById('pr-panel-host');
      const sr = host && host.shadowRoot;
      const row = sr && sr.querySelector('.row');
      return {
        badge: !!(row && row.querySelector('.badge.kw')),
        text: row ? row.textContent : ''
      };
    })()
  `);
  ok(kwPanel.badge, '悬浮窗行显示关键词标记');
  ok(/关键词命中/.test(kwPanel.text), '悬浮窗行说明关键词命中');

  kwRes = await sendMsg({ type: 'check-now', id: kwSub0.id });
  eq(kwRes.notify, false, '同样的关键词不会再提醒一次');

  await fetch(server.origin + '/bump?page=feed&note=' + encodeURIComponent('周末闭馆通知'));
  kwRes = await sendMsg({ type: 'check-now', id: kwSub0.id });
  eq(kwRes.changed, true, '板块内容确实变了');
  eq(kwRes.notify, false, '没有新关键词时不发普通更新提醒');

  await sendMsg({ type: 'mark-seen', ids: [kwSub0.id] });
  kwRes = await sendMsg({ type: 'check-now', id: kwSub0.id });
  eq(kwRes.notify, false, '已读后不再重复提醒');

  await sendMsg({ type: 'update-sub', id: kwSub0.id, keywords: [] });
  await fetch(server.origin + '/bump?page=feed&note=' + encodeURIComponent('新版本发布说明'));
  kwRes = await sendMsg({ type: 'check-now', id: kwSub0.id });
  eq(kwRes.keywordMode, false, '清空关键词后回到普通模式');
  eq(kwRes.notify, true, '普通模式下恢复更新提醒');

  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页刷新（关键词）', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  await waitFor('订阅行渲染（关键词）', async () => {
    const n = await evaluate(cdp, control, 'document.querySelectorAll(".sub-row").length');
    return n > 0 ? n : null;
  });
  const kwOpen = await evaluate(cdp, control, `
    (() => {
      const rows = Array.from(document.querySelectorAll('.sub-row'));
      const row = rows.find((r) => (r.querySelector('.sub-meta') || {}).textContent.includes('/feed')) || rows[0];
      const btn = Array.from(row.querySelectorAll('button')).find((b) => /关键词/.test(b.textContent));
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true };
    })()
  `);
  ok(kwOpen.ok, '订阅行里有「关键词」按钮');
  ok(await evaluate(cdp, control, '(document.getElementById("kw-modal") || {}).hidden === false'), '关键词弹窗打开');
  await evaluate(cdp, control, `
    (() => {
      const input = document.getElementById('kw-input');
      input.value = '报名';
      document.getElementById('kw-add').click();
      return true;
    })()
  `);
  eq(await evaluate(cdp, control, 'document.querySelectorAll("#kw-list .kw-chip").length'), 1, '关键词以标签形式显示');
  await sleep(260);
  await screenshot(control, '11-options-keywords');
  await evaluate(cdp, control, 'document.getElementById("kw-save").click()');
  await waitFor('关键词保存后生效', async () => {
    const st = await storage();
    const s = st.subs.find((x) => x.id === kwSub0.id);
    return s && s.keywords && s.keywords.join(',') === '报名' ? 1 : null;
  });
  ok(true, '关键词在设置页保存后生效');


  /* ---------------------------------------------------------- 16. 备份与恢复 */
  log('');
  log('[16] 设置与订阅的导出 / 导入');
  const expAll = await sendMsg({ type: 'export-data' });
  ok(expAll.ok, '导出接口返回设置和订阅');
  const bkPayload = {
    app: 'page-radar',
    kind: 'backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: Object.assign({}, expAll.settings, { panelOpacity: 0.8, startupCheck: false }),
    subs: expAll.subs
  };
  const dryMerge = await sendMsg({ type: 'import-backup', data: bkPayload, mode: 'merge', applySettings: true, dryRun: true });
  ok(dryMerge.ok, '备份文件可被识别');
  eq(dryMerge.summary.total, expAll.subs.length, '备份里的订阅数一致');
  eq(dryMerge.summary.add, 0, '同一页面的订阅不会重复新增');
  eq(dryMerge.summary.update, expAll.subs.length, '合并时会刷新已有订阅的配置');

  const beforeCount = (await storage()).subs.length;
  const merged = await sendMsg({ type: 'import-backup', data: bkPayload, mode: 'merge', applySettings: true });
  ok(merged.ok, '合并导入成功');
  eq(merged.added, 0, '合并后没有多出重复订阅');
  eq((await storage()).subs.length, beforeCount, '合并后订阅数不变');
  eq((await storage()).settings.panelOpacity, 0.8, '导入时恢复了设置（透明度）');
  eq((await storage()).settings.startupCheck, false, '导入时恢复了设置（每天首次检查）');

  const extraSub = Object.assign({}, expAll.subs[0], {
    id: 'imp_extra',
    url: server.origin + '/import-only',
    selector: '#import-only',
    name: '导入新增'
  });
  const replacePayload = Object.assign({}, bkPayload, { subs: expAll.subs.concat([extraSub]) });
  const dryReplace = await sendMsg({ type: 'import-backup', data: replacePayload, mode: 'replace', applySettings: false, dryRun: true });
  eq(dryReplace.summary.total, expAll.subs.length + 1, '覆盖导入统计全部订阅');
  const replaced = await sendMsg({ type: 'import-backup', data: replacePayload, mode: 'replace', applySettings: false });
  ok(replaced.ok, '覆盖导入成功');
  eq(replaced.replaced, expAll.subs.length + 1, '覆盖导入了全部订阅');
  const afterReplace = await storage();
  ok(afterReplace.subs.some((s) => s.id === 'imp_extra'), '覆盖后包含备份里的新订阅');
  eq(Object.keys(afterReplace.snaps || {}).length, 0, '覆盖导入后快照清空');
  eq(afterReplace.settings.panelOpacity, 0.8, '未勾选恢复设置时保持当前设置');

  // 设置页里的完整流程：选文件 → 确认弹窗 → 合并导入
  const bkFile = path.join(os.tmpdir(), 'pageradar-backup-' + Date.now() + '.json');
  const uiPayload = Object.assign({}, bkPayload, {
    settings: Object.assign({}, bkPayload.settings, { panelOpacity: 0.3 }),
    subs: expAll.subs.slice(0, 3)
  });
  await fs.writeFile(bkFile, JSON.stringify(uiPayload, null, 2));
  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页刷新（导入）', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  await waitFor('订阅行渲染（导入）', async () => {
    const n = await evaluate(cdp, control, 'document.querySelectorAll(".sub-row").length');
    return n > 0 ? n : null;
  }, 12000);

  const fileObj = await cdp.send('Runtime.evaluate', {
    expression: 'document.getElementById("import-file")',
    objectGroup: 'pr'
  }, control);
  await cdp.send('DOM.setFileInputFiles', { files: [bkFile], objectId: fileObj.result.objectId }, control);
  await waitFor('导入确认弹窗出现', () => evaluate(cdp, control, 'document.getElementById("im-modal").hidden === false'), 8000);
  const imInfo = await evaluate(cdp, control, `
    (() => ({
      rows: document.querySelectorAll('#im-summary .im-row').length,
      text: document.getElementById('im-summary').textContent,
      mergeText: document.getElementById('im-merge').textContent.trim(),
      settingsChecked: document.getElementById('im-settings').checked
    }))()
  `);
  ok(imInfo.rows >= 3, '导入弹窗列出备份摘要（' + imInfo.rows + ' 行）');
  ok(/备份里的订阅/.test(imInfo.text), '摘要说明备份里的订阅数');
  eq(imInfo.settingsChecked, true, '默认勾选「同时恢复设置」');
  await sleep(280);
  await screenshot(control, '12-options-import');
  await evaluate(cdp, control, 'document.getElementById("im-merge").click()');
  await waitFor('合并导入后设置已恢复', async () => {
    const st = await storage();
    return st.settings.panelOpacity === 0.3 ? 1 : null;
  });
  ok(true, '从设置页选文件导入成功，设置已恢复');
  eq(await evaluate(cdp, control, 'document.getElementById("im-modal").hidden'), true, '导入后弹窗关闭');
  await fs.unlink(bkFile).catch(() => {});

  // 还原设置并清掉临时订阅，避免影响后续断言
  await sendMsg({ type: 'remove-sub', id: 'imp_extra' });
  await sendMsg({ type: 'save-settings', patch: { panelOpacity: 0.92, startupCheck: true } });

  /* ---------------------------------------------------------- 17. 筛选 / 多选 / 批量 */
  log('');
  log('[17] 筛选、多选、批量关键词与批量分类');

  // 先把检查间隔拉长，避免定时检查在断言之间插进来
  await sendMsg({ type: 'update-sub', id: feedSub.id, intervalHours: 168 });

  // 关键词匹配模式：全部出现 vs 任意一个
  await sendMsg({ type: 'mark-seen', ids: [feedSub.id] });
  await sendMsg({ type: 'update-sub', id: feedSub.id, keywords: ['星舰', '极光'], keywordMode: 'all' });
  await fetch(server.origin + '/bump?page=feed&kw=' + encodeURIComponent('星舰'));
  const kwAll1 = await sendMsg({ type: 'check-now', id: feedSub.id });
  eq(kwAll1.notify, false, '「全部出现」模式下只命中一个词时不提醒');
  eq((kwAll1.hits || []).length, 0, '「全部出现」模式下只命中一个词时不算命中');
  await fetch(server.origin + '/bump?page=feed&kw=' + encodeURIComponent('极光'));
  const kwAll2 = await sendMsg({ type: 'check-now', id: feedSub.id });
  ok(kwAll2.ok, '第二次关键词检查成功' + (kwAll2.ok ? '' : '：' + (kwAll2.error || kwAll2.hits)));
  eq(kwAll2.notify, true, '两个关键词都出现时才提醒');
  eq((kwAll2.hits || []).length, 2, '命中词数变为 2');
  await sendMsg({ type: 'mark-seen', ids: [feedSub.id] });

  await sendMsg({ type: 'update-sub', id: feedSub.id, keywordMode: 'any' });
  await fetch(server.origin + '/bump?page=feed&kw=' + encodeURIComponent('星舰'));
  const kwAny = await sendMsg({ type: 'check-now', id: feedSub.id });
  eq(kwAny.notify, true, '「任意一个」模式下命中一个词就提醒');
  await sendMsg({ type: 'mark-seen', ids: [feedSub.id] });
  await sendMsg({ type: 'update-sub', id: feedSub.id, keywords: ['报名'], keywordMode: 'any' });

  // 分类沿用：默认不勾选
  await sendMsg({ type: 'save-settings', patch: { carryCategory: false } });
  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页加载（批量）', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  await waitFor('订阅行渲染（批量）', async () => {
    const n = await evaluate(cdp, control, 'document.querySelectorAll(".sub-row").length');
    return n > 0 ? n : null;
  }, 12000);
  eq(await evaluate(cdp, control, 'document.getElementById("carryCategory").checked'), false, '「沿用上一个分类」默认不勾选');

  const cats0 = (await storage()).settings.categories || [];
  const newsCat = cats0.find((c) => c.id === 'c_news') || cats0[0];
  ok(!!newsCat, '已有可用的分类（' + (newsCat && newsCat.name) + '）');

  await startPicker(feedUrl);
  await pickSection(feed.session, '#feed');
  const catOff = await evaluate(cdp, feed.session, `
    (() => { const h = document.getElementById('pr-pick-host'); return h.shadowRoot.querySelector('#pr-cat').value; })()
  `);
  eq(catOff, '', '未开启沿用时，框选默认「未分类」');
  await evaluate(cdp, feed.session, `
    (() => { const h = document.getElementById('pr-pick-host'); h.shadowRoot.querySelector('[data-pick="cancel"]').click(); return 1; })()
  `);

  // 打开沿用：新订阅默认用上一个订阅的分类
  await sendMsg({ type: 'save-settings', patch: { carryCategory: true } });
  await sleep(240);
  const carrySeed = await sendMsg({
    type: 'create-sub',
    url: server.origin + '/carry-test',
    name: '沿用分类测试',
    selector: '#carry-test',
    candidates: ['#carry-test'],
    categoryId: newsCat.id,
    snapshot: { v: 1, hash: 'seed', text: 'seed', textLen: 4, items: [], itemCount: 0, at: Date.now() }
  });
  ok(carrySeed.ok, '创建了用于测试「沿用分类」的临时订阅');
  await startPicker(feedUrl);
  await pickSection(feed.session, '#feed');
  const catOn = await evaluate(cdp, feed.session, `
    (() => { const h = document.getElementById('pr-pick-host'); return h.shadowRoot.querySelector('#pr-cat').value; })()
  `);
  eq(catOn, newsCat.id, '开启沿用时，框选默认分类等于上一个订阅的分类');
  await evaluate(cdp, feed.session, `
    (() => { const h = document.getElementById('pr-pick-host'); h.shadowRoot.querySelector('[data-pick="cancel"]').click(); return 1; })()
  `);
  await sendMsg({ type: 'remove-sub', id: carrySeed.id });
  await sendMsg({ type: 'save-settings', patch: { carryCategory: false } });

  // 筛选：关键词 / 状态 / 分类
  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页刷新（筛选）', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  await waitFor('订阅行渲染（筛选）', async () => {
    const n = await evaluate(cdp, control, 'document.querySelectorAll(".sub-row").length');
    return n > 0 ? n : null;
  }, 12000);

  const st2 = await storage();
  const expectHas = st2.subs.filter((s) => (s.keywords || []).length > 0).length;
  await evaluate(cdp, control, `
    (() => { const s = document.getElementById('filter-kw'); s.value = 'has'; s.dispatchEvent(new Event('change')); return 1; })()
  `);
  const rowsHas = await evaluate(cdp, control, 'document.querySelectorAll("#sub-list .sub-row").length');
  eq(rowsHas, expectHas, '按「有关键词」筛选出 ' + expectHas + ' 条');
  eq(await evaluate(cdp, control, 'document.getElementById("export-filtered").disabled'), false, '有筛选时「导出筛选结果」可用');

  const expectNew = st2.subs.filter((s) => s.hasNew).length;
  await evaluate(cdp, control, `
    (() => {
      const k = document.getElementById('filter-kw'); k.value = 'all'; k.dispatchEvent(new Event('change'));
      const s = document.getElementById('filter-status'); s.value = 'new'; s.dispatchEvent(new Event('change'));
      return 1;
    })()
  `);
  const rowsNew = await evaluate(cdp, control, 'document.querySelectorAll("#sub-list .sub-row").length');
  eq(rowsNew, expectNew, '按「有新内容」筛选出 ' + expectNew + ' 条');

  const expectCat = st2.subs.filter((s) => s.categoryId === newsCat.id).length;
  await evaluate(cdp, control, `
    (() => {
      const s = document.getElementById('filter-status'); s.value = 'all'; s.dispatchEvent(new Event('change'));
      const chip = Array.from(document.querySelectorAll('#cat-filter .cat-chip')).find((c) => c.dataset.cat === ${JSON.stringify(newsCat.id)});
      if (chip) chip.click();
      return 1;
    })()
  `);
  const rowsCat = await evaluate(cdp, control, 'document.querySelectorAll("#sub-list .sub-row").length');
  eq(rowsCat, expectCat, '按分类筛选出 ' + expectCat + ' 条');

  // 多选 + 批量关键词 + 批量分类
  await evaluate(cdp, control, `
    (() => {
      const chip = Array.from(document.querySelectorAll('#cat-filter .cat-chip')).find((c) => c.dataset.cat === 'all');
      if (chip) chip.click();
      return 1;
    })()
  `);
  await evaluate(cdp, control, 'document.getElementById("sel-toggle").click()');
  eq(await evaluate(cdp, control, 'document.getElementById("batch-bar").hidden'), false, '进入多选后出现批量操作栏');
  await evaluate(cdp, control, 'document.getElementById("sel-all").click()');
  const totalRows = await evaluate(cdp, control, 'document.querySelectorAll("#sub-list .sub-row").length');
  const pickedRows = await evaluate(cdp, control, 'document.querySelectorAll("#sub-list .sub-row.picked").length');
  eq(pickedRows, totalRows, '「全选筛选结果」选中了全部 ' + totalRows + ' 条');
  const pickedIds = await evaluate(cdp, control, 'Array.from(document.querySelectorAll("#sub-list .sub-row.picked")).map((r) => r.dataset.id)');
  await screenshot(control, '13-options-batch');

  await evaluate(cdp, control, 'document.getElementById("batch-kw").click()');
  await waitFor('批量关键词弹窗出现', () => evaluate(cdp, control, 'document.getElementById("kw-modal").hidden === false'), 6000);
  eq(await evaluate(cdp, control, 'document.getElementById("kw-title").textContent.trim()'), '批量关键词', '弹窗标题是「批量关键词」');
  // 故意只把文字打进输入框、不点「添加」，直接点保存：保存时必须把它
  // 当成一个关键词提交，而不是当成空列表把这些订阅的关键词清空。
  await evaluate(cdp, control, `
    (() => {
      document.getElementById('kw-input').value = '内测';
      return 1;
    })()
  `);
  await sleep(120);
  await evaluate(cdp, control, `
    (() => {
      const r = Array.from(document.querySelectorAll('input[name="kw-mode"]')).find((x) => x.value === 'all');
      if (r) r.checked = true;
      return 1;
    })()
  `);
  await evaluate(cdp, control, 'document.getElementById("kw-save").click()');
  await waitFor('批量关键词已生效', async () => {
    const st = await storage();
    const hit = st.subs.filter((s) => pickedIds.indexOf(s.id) >= 0);
    return hit.length && hit.every((s) => (s.keywords || []).indexOf('内测') >= 0) ? 1 : null;
  }, 15000);
  ok(true, '批量关键词已写入全部 ' + pickedIds.length + ' 个选中订阅');

  await evaluate(cdp, control, 'document.getElementById("batch-cat").click()');
  await waitFor('批量分类弹窗出现', () => evaluate(cdp, control, 'document.getElementById("bcat-modal").hidden === false'), 6000);
  await evaluate(cdp, control, `
    (() => {
      document.getElementById('bcat-select').value = ${JSON.stringify(newsCat.id)};
      document.getElementById('bcat-apply').click();
      return 1;
    })()
  `);
  await waitFor('批量分类已生效', async () => {
    const st = await storage();
    const hit = st.subs.filter((s) => pickedIds.indexOf(s.id) >= 0);
    return hit.length && hit.every((s) => s.categoryId === newsCat.id) ? 1 : null;
  }, 15000);
  ok(true, '批量分类已应用到全部选中订阅');

  const expSel = await sendMsg({ type: 'export-data', ids: pickedIds });
  eq((expSel.subs || []).length, pickedIds.length, '按选中导出时只包含选中的 ' + pickedIds.length + ' 个订阅');
  eq(await evaluate(cdp, control, 'document.getElementById("export-selected").disabled'), false, '选中后「导出选中」可用');

  // 还原：清掉批量写入的关键词，退出多选
  for (const id of pickedIds) {
    await sendMsg({ type: 'update-sub', id, keywords: [], keywordMode: 'any' });
  }
  await evaluate(cdp, control, 'document.getElementById("sel-toggle").click()');
  eq(await evaluate(cdp, control, 'document.getElementById("batch-bar").hidden'), true, '退出多选后批量操作栏隐藏');

  /* ---------------------------------------------------------- 18. 勾选是否订阅 */
  log('');
  log('[18] 勾选「是否订阅」，保存后生效');
  const pauseId = feedSub.id;
  await cdp.send('Page.navigate', { url: optUrl }, control);
  await waitFor('设置页刷新（勾选）', () => evaluate(cdp, control, 'document.readyState === "complete"'));
  await waitFor('订阅行渲染（勾选）', async () => {
    const n = await evaluate(cdp, control, 'document.querySelectorAll(".sub-row").length');
    return n > 0 ? n : null;
  }, 12000);

  const beforeToggle = await evaluate(cdp, control, `
    (() => {
      const row = document.querySelector('.sub-row[data-id="${pauseId}"]');
      const box = row && row.querySelector('.sub-on');
      const save = document.getElementById('save-subs');
      return { has: !!box, checked: box ? box.checked : null, saveDisabled: save.disabled, saveText: save.textContent.trim() };
    })()
  `);
  eq(beforeToggle.has, true, '订阅行带「是否订阅」勾选框');
  eq(beforeToggle.checked, true, '默认已勾选');
  eq(beforeToggle.saveDisabled, true, '未改动时保存按钮不可点');

  await evaluate(cdp, control, `
    (() => {
      const row = document.querySelector('.sub-row[data-id="${pauseId}"]');
      const box = row.querySelector('.sub-on');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const pendingUi = await evaluate(cdp, control, `
    (() => {
      const row = document.querySelector('.sub-row[data-id="${pauseId}"]');
      const save = document.getElementById('save-subs');
      return {
        off: row.classList.contains('off'),
        dirty: row.classList.contains('dirty'),
        saveDisabled: save.disabled,
        saveText: save.textContent.trim(),
        hint: document.getElementById('save-hint').textContent
      };
    })()
  `);
  eq(pendingUi.off, true, '取消勾选后这一行立即变暗');
  eq(pendingUi.dirty, true, '未保存的勾选有标记');
  eq(pendingUi.saveDisabled, false, '保存按钮变为可点');
  ok(/1/.test(pendingUi.saveText), '保存按钮显示待保存数量: ' + pendingUi.saveText);
  const preSave = (await storage()).subs.find((s) => s.id === pauseId);
  eq(preSave.enabled !== false, true, '点保存之前后台仍是启用状态');

  await evaluate(cdp, control, 'document.getElementById("save-subs").click()');
  await waitFor('勾选保存后生效', async () => {
    const s = (await storage()).subs.find((x) => x.id === pauseId);
    return s && s.enabled === false ? true : null;
  }, 8000);
  const paused = (await storage()).subs.find((s) => s.id === pauseId);
  eq(paused.enabled, false, '保存后订阅变为暂停');
  eq(paused.hasNew, false, '暂停后清掉未读角标');
  eq(paused.addedCount, 0, '暂停后清掉新增计数');
  const afterSaveUi = await evaluate(cdp, control, `
    (() => {
      const row = document.querySelector('.sub-row[data-id="${pauseId}"]');
      const save = document.getElementById('save-subs');
      return {
        off: row.classList.contains('off'),
        dirty: row.classList.contains('dirty'),
        saveDisabled: save.disabled,
        offTag: !!row.querySelector('.offtag')
      };
    })()
  `);
  eq(afterSaveUi.dirty, false, '保存后待保存标记消失');
  eq(afterSaveUi.saveDisabled, true, '保存后按钮恢复不可点');
  eq(afterSaveUi.offTag, true, '暂停的订阅行显示「已暂停」');
  await screenshot(control, '10-options-pause');

  const pausedCheckedAt = paused.checkedAt;
  const allRes = await sendMsg({ type: 'check-all' });
  eq(allRes.ok, true, '全部检查执行成功');
  const checkedNow = (await storage()).subs.find((s) => s.id === pauseId);
  eq(checkedNow.checkedAt, pausedCheckedAt, '暂停的订阅被跳过（时间戳未变）');
  ok(allRes.results.length < (await storage()).subs.length,
    '检查结果条数少于订阅总数（跳过暂停项）');
  const pausedCheck = await sendMsg({ type: 'check-now', id: pauseId });
  eq(pausedCheck.ok, false, '手动检查暂停的订阅会被拒绝');
  ok(/暂停/.test(pausedCheck.error || ''), '拒绝原因提到暂停: ' + pausedCheck.error);

  const panelPaused = await waitFor('面板显示暂停状态', async () => {
    const r = await evaluate(cdp, feed.session, `
      (() => {
        const host = document.getElementById('pr-panel-host');
        const sr = host && host.shadowRoot;
        const row = sr && sr.querySelector('.row[data-id="${pauseId}"]');
        if (!row) return null;
        const badge = row.querySelector('.badge');
        return {
          off: row.classList.contains('off'),
          badge: badge ? badge.textContent : '',
          meta: (row.querySelector('.meta') || {}).textContent || ''
        };
      })()
    `);
    return r && r.off ? r : null;
  }, 8000);
  eq(panelPaused.badge, '暂停', '面板行标出「暂停」');
  ok(/不参与定时检查/.test(panelPaused.meta), '面板行说明不参与检查');

  await evaluate(cdp, control, `
    (() => {
      const row = document.querySelector('.sub-row[data-id="${pauseId}"]');
      const box = row.querySelector('.sub-on');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('save-subs').click();
      return true;
    })()
  `);
  const resumed = await waitFor('重新勾选后恢复', async () => {
    const s = (await storage()).subs.find((x) => x.id === pauseId);
    return s && s.enabled !== false ? s : null;
  }, 8000);
  eq(resumed.enabled, true, '重新勾选保存后恢复启用');
  const resumeDelay = resumed.nextCheckAt - Date.now();
  ok(resumeDelay <= 60000, '恢复后马上安排了检查（' + Math.round(resumeDelay / 1000) + ' 秒后）');

  /* ---------------------------------------------------------- 14. 每天首次启动 */
  log('\n[18] 重启浏览器，验证「每天首次启动」自动检查');
  const restartAt = Date.now();
  // Pretend the last start-up check was days ago.
  await swEval(`
    const all = await chrome.storage.local.get(['meta']);
    const meta = all.meta || {};
    meta.lastStartupDay = '2000-01-01';
    await chrome.storage.local.set({ meta: meta });
    return true;
  `);
  const oldPid = chrome && chrome.pid;
  const storeSrc = path.join(profile, 'Default', 'Local Extension Settings', extId);
  try { await cdp.send('Browser.close'); } catch (e) { /* ignore */ }
  await waitFor('浏览器进程退出', async () => {
    try {
      const r = await fetch('http://127.0.0.1:' + dbgPort + '/json/version');
      return r.ok ? null : true;
    } catch (e) { return true; }
  }, 15000).catch(() => {});
  try { spawn('taskkill', ['/PID', String(oldPid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  chrome = null;
  await sleep(1500);

  // Edge will not load an unpacked extension into a profile it has seen before,
  // so the restart uses a fresh profile seeded with this extension's storage.
  const secondProfile = path.join(os.tmpdir(), 'pageradar-e2e-restart-' + Date.now());
  extraProfiles.push(secondProfile);
  await fs.mkdir(path.join(secondProfile, 'Default', 'Local Extension Settings'), { recursive: true });
  await fs.cp(storeSrc, path.join(secondProfile, 'Default', 'Local Extension Settings', extId), { recursive: true });

  launch(secondProfile);
  const secondAttach = await attachBrowser(extId);
  sw = secondAttach.sw;
  const swEval2 = (body) => evaluate(cdp, sw, '(async () => {' + body + '})()');

  const startup = await waitFor('启动检查执行', async () => {
    const st = await swEval2(`
      const all = await chrome.storage.local.get(['meta','subs']);
      return { meta: all.meta || {}, subs: all.subs || [] };
    `);
    const stamped = st.meta.lastStartupCheckAt && st.meta.lastStartupCheckAt >= restartAt;
    const done = st.subs.length > 0 && st.subs.every((s) => s.checkedAt >= restartAt);
    return stamped && done ? st : null;
  }, 90000).catch(async (e) => {
    const diag = await swEval2(`
      const all = await chrome.storage.local.get(['meta','subs']);
      return { meta: all.meta || {}, subs: (all.subs || []).map((s) => ({ c: s.checkedAt, e: s.err, v: s.validated })) };
    `).catch((x) => ({ err: String(x) }));
    notes.push('    启动诊断: ' + JSON.stringify(diag).slice(0, 600));
    throw e;
  });

  const td = new Date();
  const todayStr = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
  eq(startup.meta.lastStartupDay, todayStr, '记录了当天日期');
  const checkedOnStart = startup.subs.filter((s) => s.checkedAt >= restartAt).length;
  eq(checkedOnStart, startup.subs.length, '启动时检查了全部订阅');
  ok(startup.subs.every((s) => !s.err || !s.err.length), '启动检查没有报错');
  eq((await swEval2('const a = await chrome.alarms.getAll(); return a.map((x) => x.name).join(",");')), 'pr:tick', '重启后重新安排了检查闹钟');

  log('\n[19] 清理');
} catch (e) {
  failures.push(e && e.stack || String(e));
  log('\n致命错误:', e && e.message || e);
} finally {
  try {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  if (chrome) {
    try { chrome.kill(); } catch (e) { /* ignore */ }
    spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  await sleep(800);
  if (!KEEP) {
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    for (const dir of extraProfiles) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await server.close();

  log('\n' + notes.join('\n'));
  log('');
  if (failures.length) {
    console.error('FAILED (' + failures.length + ')');
    for (const f of failures) console.error(' - ' + f);
    process.exitCode = 1;
  } else {
    log('ALL PASSED — 截图目录: ' + OUT);
  }
  process.exit(failures.length ? 1 : 0);
}
