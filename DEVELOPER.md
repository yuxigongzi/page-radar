# PageRadar 开发者文档

面向要改代码、加功能、跑测试或重新打包的人。用户向说明见 [README.md](README.md)。

- 运行环境：Chrome / Edge，Manifest V3，最低 116（用到 `offscreen` 与 `adoptedStyleSheets`）
- 构建：**没有构建步骤**。源码即产物，`chrome://extensions` 直接加载 `page-radar/` 目录
- 依赖：运行时零依赖；测试与打包只用 Node 24 内置模块 + Python 3（Pillow 只用于生成图标）

---

## 1. 目录

```
page-radar/
├── manifest.json
├── background/background.js    调度、抓取、解析、比对、通知、所有写操作
├── shared/text.js              文本归一化 / 哈希 / 内联事件属性剥离（三端共用）
├── content/
│   ├── extract.js              DOM 取文本、条目识别、选择器生成与重定位
│   ├── ui.js                   面板 / 框选器 / 提示的样式表与 HTML 模板
│   └── content.js              框选交互、悬浮窗、抽屉预览、闪烁高亮
├── offscreen/offscreen.{html,js}   离屏 DOMParser
├── popup/                      工具栏弹窗
├── options/                    设置与订阅管理页
├── icons/                      icon16/32/48/128
├── tools/
│   ├── make_icons.py           生成图标
│   ├── pack.py                 打 zip + crx（复用 dist/page-radar-key.pem）
│   ├── verify_crx.mjs          校验 crx 结构 / RSA 签名 / 扩展 ID
│   └── check_ids.mjs           检查 JS 里 $('#id') 是否都存在于对应 HTML
└── test/
    ├── server.mjs              本地 fixture 服务
    ├── e2e.mjs                 CDP 端到端测试
    ├── text.test.mjs           文本工具单元测试
    └── out/                    截图输出
```

---

## 2. 运行时结构

四个执行环境，职责严格分开：

| 环境 | 文件 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| Service worker | `background/background.js` | `fetch`、`chrome.*` API、写存储 | 没有 DOM/`DOMParser` |
| 离屏文档 | `offscreen/offscreen.js` | `DOMParser` 解析 HTML 字符串 | 网络、`chrome.tabs` |
| 内容脚本 | `content/*.js` | 读页面 DOM、注入 Shadow DOM UI、定位与高亮板块 | 不能直接抓跨域 HTML（受 CORS 限制） |
| 扩展页 | `popup/`、`options/` | 完整 DOM、`chrome.runtime.sendMessage` | 不能直接跑页面脚本 |

**唯一的写方是 background。** popup / options / content 都只发消息、读 `chrome.storage` 的变更事件，避免多端并发读改写同一份数据。

`manifest.json` 的 `content_scripts` 顺序固定：

```json
["shared/text.js", "content/ui.js", "content/extract.js", "content/content.js"]
```

`text.js` 定义 `globalThis.__PRT`，`extract.js` 定义 `window.__PRX` 并依赖 `__PRT`，`ui.js` 定义 `window.__PR_UI`。三者都是 IIFE + 全局挂载，方便 background 用 `importScripts` / `chrome.scripting.executeScript` 复用同一份代码，也方便 Node 里 `require`（`text.js` 会写 `module.exports`）。

---

## 3. 存储模型

`chrome.storage.local` 四个键：

```js
settings = {
  intervalHours: 12,        // 1..168
  startupCheck: true,       // 每天首次启动检查
  notify: true,             // 系统通知总开关
  onlyChanged: true,        // 忽略纯数字/相对时间变化
  panelEnabled: true,
  panelSide: 'right',       // 'left' | 'right'
  panelOpacity: 0.92,       // 0.3..1
  panelHiddenHosts: [],     // 手动关掉悬浮窗的站点
  maxItems: 40,
  categories: [{ id, name, color }],   // 最多 20 个
  carryCategory: false      // 新订阅沿用上一个订阅的分类
}

subs = [{                   // 数组，按 createdAt 升序
  id, url, name, pageTitle, selector, candidates: [], tag, anchorText,
  categoryId, keywords: [], keywordMode: 'any'|'all', hits: [],
  note,                     // 备注，≤120 字，只用于展示
  intervalHours,            // 0 = 跟随全局
  enabled,                  // false = 暂停
  createdAt, checkedAt, nextCheckAt, lastChangeAt,
  hasNew, addedCount, validated, err, lastError, lastDiff
}]

snaps = { [subId]: {        // 与 subs 分开存，避免面板每次都读大对象
  hash, nhash, itemKeys: [], items: [], total, excerpt,
  textLen, at, via: 'fetch'|'tab'|'picker'
} }

meta = { lastStartupDay: 'YYYY-MM-DD', lastStartupCheckAt, lastTickAt }
```

约定：

- `snaps` 里的 `items/total/excerpt` 是给预览用的截断副本（`previewOf`：条目 ≤12、标题 ≤140 字、正文摘录 900 字）。
- 删除订阅时同步删 `snaps[id]`；导入「覆盖」模式会清空整个 `snaps`。
- `subs`/`snaps` 的读改写全部包在 `withLock()` 里（promise 链串行），避免并发检查互相覆盖。

---

## 4. 消息协议

全部走 `chrome.runtime.sendMessage`，返回 `{ ok, ... }`。`background.js` 的 `handleMessage` 是唯一入口（`msg.target === 'offscreen'` 的消息会被忽略）。

| type | 请求 | 响应 |
| --- | --- | --- |
| `get-state` | — | `{ settings, subs, now }` |
| `get-preview` | `{ id, limit? }` | `{ sub, category, preview }`，订阅不存在时 `{ ok:false, error }` |
| `create-sub` | `{ url, name, pageTitle, selector, candidates, tag, anchorText, categoryId, keywords, keywordMode, note, intervalHours, snapshot }` | `{ id, created, sub, settings }` |
| `remove-sub` | `{ id }` | `{ removed }` |
| `update-sub` | `{ id, name?, url?, enabled?, intervalHours?, categoryId?, keywords?, keywordMode?, note? }` | `{ sub }` |
| `save-settings` | settings 的任意子集 | `{ settings }` |
| `add-category` | `{ name }` | `{ category, settings }`；名称空 / 重名 / 超过 20 个时 `{ ok:false, error }` |
| `mark-seen` | `{ ids: [] }` | `{ changed }` |
| `site-panel` | `{ host, hidden }` | `{ panelHiddenHosts }` |
| `check-now` | `{ id }` | `runCheck` 的结果（暂停时 `{ ok:false, error:'这个订阅已暂停...' }`） |
| `check-page` | `{ url }` | `{ results }` |
| `check-all` | — | `{ results }` |
| `open-options` | — | 打开设置页 |
| `export-data` | `{ ids? }` | `{ settings, subs }`（带 `ids` 时只导出选中） |
| `import-data` | `{ data }` | `{ count }`（旧版：整体替换订阅） |
| `import-backup` | `{ data, mode:'merge'\|'replace', applySettings, dryRun }` | `{ summary }` 或 `{ added, updated, replaced, total, count }` |
| `test-notify` | — | `{ ok }` |
| `reset-settings` | — | `{ settings }` |

内容脚本侧的运行时消息（background → tab）：

- `PR_FLASH` `{ sub }`：滚动到订阅板块并高亮 2 秒
- `PR_START_PICKER`：启动框选
- `PR_PING`：探测内容脚本是否已注入

---

## 5. 调度

- 只有一个闹钟 `pr:tick`，时间 = `max(now + 30s, 所有启用订阅里最早的 nextCheckAt)`。
- 到点后 `runDueChecks()` 只跑到期的那些（`nextCheckAt <= now + 60s`），并发 3（`pool`）。
- 每次写入订阅后 `reschedule()`；没有启用的订阅时清掉闹钟。
- 每个订阅自己记 `nextCheckAt`，所以单订阅间隔与全局间隔可以共存；全局间隔变化时，`intervalHours === 0` 的订阅会被重新排布。

**每天首次启动**：`chrome.runtime.onStartup` 在部分安装形态（解压加载、随浏览器启动的打包扩展）下**不会触发**，因此 `maybeStartupCheck()` 同时从两处调用：

```js
chrome.runtime.onStartup.addListener(() => maybeStartupCheck().then(reschedule));
// boot() 里：ensureDefaults() → maybeStartupCheck() → updateBadge() → reschedule()
```

`maybeStartupCheck()` 用 `meta.lastStartupDay` 与本地 `YYYY-MM-DD` 比较，同一天只跑一次。

---

## 6. 抓取与解析

`fetchSection(sub)` 的决策链：

1. `fetchHtml(url)`：`credentials:'include'`、`redirect:'follow'`、25 秒超时、只接受 `text/html`/`application/xhtml+xml`。
2. `stripInlineHandlers(html)`（`shared/text.js`）：引号感知地剥掉标签上的 `on*="..."`。不剥的话 `DOMParser` 会编译这些内联处理器，触发扩展 CSP `script-src 'self'`，在 `chrome://extensions` 的错误页留下违例记录（处理器本身并不会执行）。
3. `parseHtml()` → 确保 `offscreen/offscreen.html` 存在（`reasons: ['DOM_PARSER']`）→ 发给离屏文档 → `DOMParser.parseFromString` → `window.__PRX.extractFromDocument(doc, opts)`。
4. 解析结果 `!ok`（`selector-missing` / `section-empty`）或 `textLen < 30` 时，`parseViaTab()` 兜底：新建隐藏标签页 → 等 `status === 'complete'` + 700 ms 静置 → 注入 `shared/text.js` + `content/extract.js` → `executeScript` 轮询 `extractFromDocument`（每 300 ms，最多 6 秒，直到 `textLen >= 30`）→ 关闭标签页。

第 4 步是为了 SPA：后台标签页会节流 `setTimeout`，固定延时不可靠，所以改成轮询。

`fetchSection` 的错误会把兜底原因拼进去：`reason + '（后台渲染：' + tabWhy + '）'`。

---

## 7. 变化判定

`computeDiff(prev, next, settings)`：

1. `prev.hash === next.hash` → 没变。
2. `settings.onlyChanged && prev.nhash === hashText(noiseKey(next.text))` → 只有数字/相对时间变了，算噪声。
3. 否则比较 `itemKeys` 集合，返回 `{ changed, added, removed, addedItems }`。

`extractItems()` 的条目键：优先规范化后的文章 URL（去 hash、去 `utm_*`/`spm`/`from`），否则 `"T:" + 标题` 并去重。这样列表加一条就是 `added: 1`，而不是整段文本哈希变化。

`runCheck` 里两条互斥的提醒通道：

```js
var keywordMode = kw.length > 0;
var hitNow = keywordMode && !firstValidation &&
  (kwMode === 'all' ? hits.length === kw.length && prevHits.length < kw.length
                    : newHits.length > 0);
var notify = keywordMode ? hitNow : changed;   // 关键词模式下普通更新静默
```

- `firstValidation`（第一次检查）永远不提醒，避免订阅瞬间误报。
- 关键词命中集合与上次比较，只对「新增命中」提醒；`keepHit` 让未读角标在命中持续存在时保留。
- 关键词列表或匹配方式变化时，`update-sub` 清空 `hits`/`hasNew`/`addedCount`。
- 失败退避：`min(1h, max(10min, interval/2))`。

---

## 8. 选择器与重定位

`candidatesFor(el)` 最多给 5 个：`#id`、`tag.class`、类路径（深度 2 / 3）、`nth-of-type` 路径。

`resolveElement(doc, { selector, candidates, anchor, tag })` 依次尝试：

1. 选择器唯一命中；
2. 候选里唯一命中；
3. 候选里第一个命中（可能多个）；
4. 锚文本兜底：取原锚文本前 24 字，在同 tag 元素里找文本以它开头的那个。

这套组合是为了应对改版：类名变了还有 nth 路径，结构变了还有锚文本。

---

## 9. 界面注入

- 所有页面内 UI 都是 `attachShadow({ mode: 'open' })` + `adoptedStyleSheets` 注入样式，页面 CSP（`style-src 'none'` 之类）不影响；不支持时回退 `<style>` 元素。
- 样式表由 `CSSStyleSheet.replaceSync` 构造一次并缓存（`__PR_UI.PANEL_CSS` 等是字符串数组）。
- 悬浮窗状态机：`data-open`（展开/收起，收起时 `translateX(±50%)` 露出半个）、`data-side`、`data-checking`（顶部进度条）、`data-preview`（抽屉打开时把面板撑高到 `min(70vh, 560px)`）。`syncOpen()` 的展开条件是 `hover || pinned || pvOpen`。
- 页面侧只做展示；所有状态改动都发回 background，改完靠 `storage.onChanged` 重渲染。
- 框选卡片里的分类下拉末项是 `+ 新建分类…`（value `__new__`），选中后展开 `#pr-newcat` 输入行，提交时发 `add-category` 而不是自己拼 `save-settings`，避免和设置页并发写覆盖；创建成功后用返回的 `settings` 重填下拉并选中新分类。
- 悬浮窗每行有铅笔按钮（`data-row-note`）：就地插入 `.noteedit` 输入框，回车/保存发 `update-sub { note }`，成功后只更新该行的 `.note` 节点，不整块重渲染，避免闪烁。

---

## 10. 测试

### 本地 fixture

`test/server.mjs` 起一个 HTTP 服务（随机端口），页面：

| 路径 | 用途 |
| --- | --- |
| `/feed` | 静态列表，`section#feed` 里 5 条文章，带 `onmouseover`/`onclick` 内联属性（验证剥离） |
| `/spa` | `section#feed` 由 `setTimeout(420)` 填充（验证隐藏标签页兜底） |
| `/noise` | 只有数字与相对时间变化的统计块（验证噪声抑制） |
| `/csp` | 响应头 `default-src 'self'; script-src 'none'; style-src 'none'`（验证 Shadow DOM 样式） |
| `/bump?page=feed&kw=招聘` | 追加一条含关键词的文章 |
| `/bump?page=feed&note=…` | 追加一条普通文章（验证关键词模式下静默） |
| `/state` | 返回当前 fixture 状态 |

### 端到端

```bash
node test/e2e.mjs            # 默认 Microsoft Edge
node test/e2e.mjs --keep     # 保留临时配置
BROWSER_PATH=/path/to/chrome node test/e2e.mjs
node test/text.test.mjs      # 文本工具单元测试
node tools/check_ids.mjs     # JS 里的 $('#id') 与 HTML 对账
```

`e2e.mjs` 是一个手写的精简 CDP 客户端（Node 24 自带 `WebSocket`）：拉起浏览器 → 用 `--load-extension` 加载本目录 → 找到 `/background/background.js` 的 service_worker target → 通过它在页面里 `chrome.scripting.executeScript`、`chrome.tabs.sendMessage`，并用一个选项页作为「控制台」调 `chrome.runtime.sendMessage`。

**已知坑：**

- **正式版 Chrome 会忽略 `--load-extension`**（日志 `--disable-extensions-except is not allowed in Google Chrome, ignoring.`），所以默认用 Edge。
- **Edge 只在「从未使用过的 profile」上加载 `--load-extension` 扩展**。重启场景的模拟办法：新开一个 profile，把旧 profile 的 `Default/Local Extension Settings/<extId>` 拷过去。
- `Target.createTarget` 传 `width/height` 时必须同时 `newWindow: true`。
- 同一天内的「启动检查」需要先把 `meta.lastStartupDay` 改成过去的日期，否则会被日锁挡住。
- 关键词断言要用全新词：fixture 的 `state.kw` 会跨阶段累积；`matchKeywords` 的 `all` 模式在缺词时返回 `[]`。

测试阶段（`e2e.mjs` 里从 `[1]` 到 `[21]`）：默认设置 → 框选 → 订阅与基线 → 悬浮窗收起/展开 → 手动检查 → 更新与通知 → 噪声 → SPA → CSP → 弹窗/设置页渲染 → 改间隔重排 → 预览与分类 → 标为已读 → 刷新与闪烁 → 关键词 → 备份导入导出 → 筛选/多选/批量 → 框选卡片新建分类与悬浮窗备注 → 勾选暂停 → 重启后当天首次检查 → 清理。截图写到 `test/out/`。

---

## 11. 打包

```bash
python tools/pack.py          # → dist/page-radar-<version>.zip 和 .crx
node tools/verify_crx.mjs dist/page-radar-<version>.crx
```

- `pack.py` 读取 `manifest.json` 的版本号，打进 `manifest.json`、`README.md`、`DEVELOPER.md`、`background/`、`content/`、`offscreen/`、`popup/`、`options/`、`icons/`、`shared/`，排除 `test/`、`tools/`、`dist/`。
- CRX 用 `dist/page-radar-key.pem` 签名（不存在则生成并保存）。**同一把钥匙 → 同一个扩展 ID**，覆盖安装不丢数据。换机器必须带上这个 pem。
- 扩展 ID 由公钥 SHA-256 的前 16 字节按 `a`–`p` 映射得到（`verify_crx.mjs` 里有实现）。当前 ID：`dpoeapfhmckplfackhnbohmelanlofba`。
- CRX3 结构：`Cr24` + version 3 + header 长度 + header（`sha256_with_rsa` 证明 + 签名）+ zip。
- 也可以让 Edge 打包：`msedge.exe --pack-extension=<dir> --pack-extension-key=<pem>`，产物是 CRX3。

改完代码后记得同步三处版本号：`manifest.json`、`options/options.html` 页脚、`README.md` 里引用的 crx 文件名。`tools/bump.mjs` 会一次改完这三处：

```bash
node tools/bump.mjs 1.5.4            # 只改版本号
node tools/bump.mjs 1.5.4 --check    # 预览会改哪些文件，不落盘
node tools/bump.mjs 1.5.4 --pack     # 改完直接打包
```

### 发布新版本

日常发版四步：

```bash
node tools/bump.mjs 1.5.4 --pack        # 版本号 + zip/crx
node test/e2e.mjs                       # 全量回归（约 4 分钟）
git add -A && git commit -m "chore: v1.5.4"
git tag v1.5.4 && git push origin main --tags
```

推 tag 后 `.github/workflows/release.yml` 会自动：校验 tag 与 manifest 版本一致 → 跑 `test/text.test.mjs` → `python3 tools/pack.py --zip-only` → 建 Release（自动生成 release notes）并把 zip 挂成附件。**不需要再手动上传 zip**；想调整文案就在 Release 页面点编辑。

CI 不产 crx：签名需要 `dist/page-radar-key.pem`，那把钥匙只留在本地。要发 crx 就本地 `python tools/pack.py` 之后手动拖到 Release 附件里（可选，Chrome 正式版本来也拦非商店 crx）。

---

## 12. 调试

- **Service worker 日志**：`chrome://extensions` → 该扩展的「Service Worker」链接。
- **离屏文档**：同一页面的「检查视图」下拉里有 offscreen 目标；它不走 CDP attach，调试时只能在代码里临时 `console.log`。
- **内容脚本**：页面 DevTools Console 选该扩展的上下文；框选器/面板都在 Shadow DOM 里，用 `document.querySelector('pr-panel-host')?.shadowRoot` 之类探查。
- **存储**：`chrome.storage.local.get(null, console.log)` 在 SW 控制台执行。
- **强制立即检查**：设置页「全部立即检查」，或 SW 里 `checkAll('manual')`。
- **看下次检查时间**：`chrome.storage.local.get('subs')` 里每条都有 `nextCheckAt`。

---

## 13. 设计取舍

- **不用内容脚本抓 HTML**：内容脚本 `fetch` 别的页面受 CORS 限制，且拿不到带 Cookie 的完整文档，所以统一由 SW 抓。
- **不上 `tabs` 权限**：`host_permissions: <all_urls>` 已足够读标签页 URL；少一个权限少一份安装警告。若某天 `chrome.tabs.query` 拿不到 url，再补。
- **快照与订阅分开存**：面板/弹窗每次都读 `subs`，把可能几百 KB 的 `snaps` 隔离出去。
- **单闹钟而非每订阅一个**：`chrome.alarms` 数量与唤醒次数都更省，缺点是每次都要重算最早时间。
- **`firstValidation` 不提醒**：订阅当下就把「有更新」推给用户是噪声。
- **关键词模式静默普通更新**：用户设关键词的意图就是「只对这些词感兴趣」，两条通道同时提醒会互相稀释。

---

## 14. 已知限制

- canvas、跨域 iframe、闭合 Shadow DOM 内部无法框选或抓取文本。
- 定时检查依赖浏览器运行；浏览器完全退出期间不检查。
- 登录态依赖浏览器 Cookie，抓取不带用户手动填写的表单状态。
- 页面若在首次渲染后异步替换整个列表容器（改版），可能连续两次判定为变化；`candidates` + 锚文本只能缓解，不能根治。
- 悬浮窗透明度对 `opacity < 0.3` 的极端值可读性差，设置页下限锁在 30%。
