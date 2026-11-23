/* Fixture server for PageRadar end-to-end tests. */
import http from 'node:http';

const state = { feed: 0, spa: 0, noise: 0, kw: [], notes: [] };

const CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1c2430}
header{padding:14px 26px;background:#101828;color:#fff;font-weight:600;letter-spacing:.02em}
main{display:flex;gap:22px;padding:22px;max-width:1080px;margin:0 auto;align-items:flex-start}
#feed{flex:1;background:#fff;border-radius:12px;padding:10px 22px 26px;box-shadow:0 1px 3px rgba(16,24,40,.07)}
article{padding:13px 0;border-bottom:1px solid #eef1f5}
article:last-child{border-bottom:0}
article h2{margin:0 0 4px;font-size:16px;line-height:1.4}
article h2 a{color:#155eef;text-decoration:none}
article p{margin:0;color:#5a6478;font-size:13px}
article time{display:block;margin-top:5px;font-size:12px;color:#98a2b3}
aside{width:230px;background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(16,24,40,.07)}
aside h3{margin:0 0 8px;font-size:14px}
.tags span{display:inline-block;margin:0 6px 6px 0;padding:2px 9px;border-radius:99px;background:#eef3ff;color:#155eef;font-size:12px}
#stats{background:#fff;border-radius:12px;padding:18px 22px;max-width:520px;margin:22px auto;font-size:15px}
#stats b{color:#155eef}
`;

const BASE_ITEMS = [
  { id: 1, title: '量子计算芯片实现千次纠错循环', summary: '研究团队在超导量子比特上验证了长时间稳定运行。', time: '3 分钟前' },
  { id: 2, title: '城市轨道交通新线路开始试运行', summary: '首列列车完成全线空载跑合，预计下月开通载客。', time: '28 分钟前' },
  { id: 3, title: '开源数据库发布 9.0 版本', summary: '新版本引入并行查询与更细粒度的权限模型。', time: '1 小时前' },
  { id: 4, title: '深海探测器带回热液区样本', summary: '样本中包含多种此前未记录的微生物群落。', time: '3 小时前' },
  { id: 5, title: '全国青少年科创大赛报名启动', summary: '今年新增人工智能与低碳技术两个赛道。', time: '昨天' }
];

function articleHtml(it) {
  // The inline handlers are deliberate: the offscreen parser must strip them
  // before DOMParser sees the markup, otherwise the extension logs a CSP
  // violation for every fetched page that carries one.
  return `<article data-id="${it.id}" onmouseover="void 0">
      <h2><a href="/post/${it.id}" onclick="void 0">${it.title}</a></h2>
      <p>${it.summary}</p>
      <time>${it.time}</time>
    </article>`;
}

function feedPage() {
  const items = BASE_ITEMS.slice();
  if (state.feed) {
    items.unshift({
      id: 90 + state.feed,
      title: '新增：夜间公交线路调整（第 ' + state.feed + ' 次更新）',
      summary: '自下周一起，6 条夜班线路延长运营时间并加密班次。',
      time: '刚刚'
    });
  }
  state.kw.forEach((word, i) => {
    items.unshift({
      id: 500 + i,
      title: '公告：' + word + ' 相关通知',
      summary: '这条内容里包含关键词「' + word + '」，用来验证关键词提醒。',
      time: '刚刚'
    });
  });
  state.notes.forEach((note, i) => {
    items.unshift({
      id: 700 + i,
      title: '简讯：' + note,
      summary: '这条内容不包含关键词，用来验证关键词模式下的普通更新是否静默。',
      time: '刚刚'
    });
  });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>实验室日报 · 首页</title><style>${CSS}</style></head><body>
<header>实验室日报</header>
<main>
  <section id="feed" class="feed">${items.map(articleHtml).join('')}</section>
  <aside>
    <h3>热门标签</h3>
    <div class="tags"><span>量子</span><span>交通</span><span>开源</span><span>深海</span></div>
    <h3 style="margin-top:16px">关于</h3>
    <p style="font-size:12px;color:#5a6478">这是一个用于测试的静态页面。</p>
  </aside>
</main>
</body></html>`;
}

function spaPage() {
  const items = BASE_ITEMS.slice(0, 3).map((it) => ({
    id: it.id,
    title: it.title + (state.spa ? '（更新 ' + state.spa + '）' : ''),
    summary: it.summary,
    time: it.time
  }));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>动态渲染列表</title><style>${CSS}</style></head><body>
<header>实验室日报 · 动态版</header>
<main>
  <section id="feed" class="feed"></section>
  <aside><h3>热门标签</h3><div class="tags"><span>动态</span></div></aside>
</main>
<script>
setTimeout(function () {
  document.getElementById('feed').innerHTML = ${JSON.stringify(items.map(articleHtml).join('')).replace(/<\//g, '<\\/')};
}, 420);
</script>
</body></html>`;
}

function noisePage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>计数器页</title><style>${CSS}</style></head><body>
<header>计数器页</header>
<section id="stats">
  <p>阅读 <b>${1200 + state.noise * 7}</b> 次 · 点赞 <b>${56 + state.noise * 3}</b> 次 · 更新于 3 分钟前</p>
  <p>本页面只有数字和相对时间在变化，用来验证误报抑制。</p>
</section>
</body></html>`;
}

function cspPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>CSP 严格页面</title></head><body>
<header style="font:600 15px sans-serif;padding:16px;background:#101828;color:#fff">CSP 严格页面</header>
<section id="feed">
  <article><h2><a href="/x/1">受 CSP 限制的页面区块一</a></h2><p>页面禁止内联脚本与内联样式，用来验证悬浮窗样式仍然生效。</p></article>
  <article><h2><a href="/x/2">受 CSP 限制的页面区块二</a></h2><p>如果悬浮窗能正常显示，说明 adoptedStyleSheets 绕过了限制。</p></article>
</section>
</body></html>`;
}

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (path === '/bump') {
      const page = url.searchParams.get('page') || 'feed';
      if (page in state) state[page] += 1;
      const word = (url.searchParams.get('kw') || '').trim();
      if (word) state.kw.push(word);
      const note = (url.searchParams.get('note') || '').trim();
      if (note) state.notes.push(note);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, state }));
      return;
    }
    if (path === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }
    let body = null;
    let headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (path === '/' || path === '/feed') body = feedPage();
    else if (path === '/spa') body = spaPage();
    else if (path === '/noise') body = noisePage();
    else if (path === '/csp') {
      body = cspPage();
      headers['content-security-policy'] = "default-src 'self'; script-src 'none'; style-src 'none'";
    } else if (path.startsWith('/post/')) {
      body = `<!doctype html><meta charset="utf-8"><title>文章</title><h1>文章 ${path.slice(6)}</h1><p>正文内容。</p>`;
    }
    if (body == null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        origin: 'http://127.0.0.1:' + port,
        state,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
  const s = await startServer();
  console.log('fixture server:', s.origin);
}
