/* Shared UI strings for the PageRadar content script (shadow DOM). */
(function (root) {
  'use strict';

  var PANEL_CSS = [
    ':host{all:initial;position:fixed!important;top:50%!important;z-index:2147483000!important;display:block!important;width:336px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;font-size:13px;line-height:1.4;color:#e8ecf5;direction:ltr;opacity:var(--pr-opacity,.92);transform:translateY(-50%);transition:transform .42s cubic-bezier(.22,.9,.24,1),opacity .25s ease;will-change:transform;pointer-events:auto}',
    ':host([data-side="right"]){right:0!important;left:auto!important}',
    ':host([data-side="left"]){left:0!important;right:auto!important}',
    ':host([data-open="false"][data-side="right"]){transform:translateY(-50%) translateX(var(--pr-peek,50%))}',
    ':host([data-open="false"][data-side="left"]){transform:translateY(-50%) translateX(calc(-1 * var(--pr-peek,50%)))}',
    ':host([data-open="true"]){opacity:1}',
    '.panel{position:relative;display:flex;flex-direction:column;max-height:min(74vh,640px);background:linear-gradient(180deg,rgba(21,25,36,.97),rgba(11,14,21,.98));border:1px solid rgba(255,255,255,.09);border-right:0;border-radius:18px 0 0 18px;box-shadow:-22px 0 60px rgba(0,0,0,.42),0 18px 60px rgba(0,0,0,.35);overflow:hidden;backdrop-filter:blur(18px) saturate(1.25)}',
    ':host([data-side="left"]) .panel{border-radius:0 18px 18px 0;border-left:0;border-right:1px solid rgba(255,255,255,.09);box-shadow:22px 0 60px rgba(0,0,0,.42),0 18px 60px rgba(0,0,0,.35)}',
    '.panel::before{content:"";position:absolute;left:-20%;right:-20%;top:-90px;height:180px;background:radial-gradient(50% 100% at 35% 100%,rgba(94,224,255,.22),transparent 70%);pointer-events:none}',
    '.progress{position:absolute;left:0;right:0;top:0;height:2px;overflow:hidden;opacity:0;pointer-events:none}',
    ':host([data-checking="true"]) .progress{opacity:1}',
    '.progress::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,#5ee0ff,transparent);animation:prslide 1.15s linear infinite}',
    '.head{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 10px 8px 14px}',
    '.brand{display:flex;align-items:center;gap:8px;min-width:0}',
    '.logo{width:18px;height:18px;color:#6ee7ff;flex:none;filter:drop-shadow(0 0 6px rgba(110,231,255,.45))}',
    '.name{font-size:13px;font-weight:700;letter-spacing:.02em;white-space:nowrap}',
    '.count{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:rgba(94,224,255,.15);color:#9beaff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center}',
    '.hactions{display:flex;gap:2px;opacity:0;transform:translateX(4px);transition:.2s}',
    ':host([data-open="true"]) .hactions{opacity:1;transform:none}',
    '.ibtn{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:#7c879c;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}',
    '.ibtn:hover{background:rgba(255,255,255,.08);color:#c7e9ff}',
    '.ibtn.danger:hover{background:rgba(255,107,107,.12);color:#ff8f8f}',
    '.ibtn svg{width:15px;height:15px}',
    '.body{padding:2px 8px 6px;overflow-y:auto;overscroll-behavior:contain}',
    '.body::-webkit-scrollbar{width:6px}',
    '.body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}',
    '.row{display:flex;align-items:center;gap:6px;padding:9px 6px 9px 9px;border-radius:12px;cursor:pointer;transition:background .15s}',
    '.row:hover{background:rgba(255,255,255,.05)}',
    '.row.off{opacity:.55}',
    '.row.off .t{text-decoration:none;color:#9aa6bb}',
    '.rowmain{min-width:0;flex:1}',
    '.rowtitle{display:flex;align-items:center;gap:7px}',
    '.dot{width:6px;height:6px;border-radius:50%;background:#3ddc97;box-shadow:0 0 7px rgba(61,220,151,.75);flex:none}',
    '.dot.new{background:#5ee0ff;box-shadow:0 0 8px rgba(94,224,255,.9);animation:prpulse 1.8s ease-in-out infinite}',
    '.dot.err{background:#ff6b6b;box-shadow:0 0 8px rgba(255,107,107,.8)}',
    '.t{font-size:12.5px;font-weight:600;color:#eef2fa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}',
    '.badge{flex:none;font-size:9.5px;font-weight:700;color:#0a141b;background:linear-gradient(135deg,#5ee0ff,#7aa2ff);padding:1px 6px;border-radius:99px}',
    '.badge.off{color:#fbe1c4;background:rgba(242,153,74,.16)}',
    '.badge.kw{color:#ffe1c2;background:rgba(242,153,74,.16)}',
    '.badge.kw.hit{color:#1b0f04;background:linear-gradient(135deg,#ffb36b,#f2994a)}',
    '.meta{margin-top:4px;font-size:10.5px;color:#8590a5;display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.meta .sep{color:#3b4354}',
    '.meta.err{color:#e88383}',
    '.note{margin-top:4px;font-size:10.5px;color:#9fb0c6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.note::before{content:"\\270E";margin-right:4px;color:#5f7590;font-size:10px}',
    '.noteedit{display:flex;align-items:center;gap:5px;margin-top:5px}',
    '.noteedit input{flex:1;min-width:0;height:25px;padding:0 7px;border-radius:7px;border:1px solid rgba(94,224,255,.35);background:rgba(255,255,255,.05);color:#e9eef8;font-size:11px;font-family:inherit;outline:none}',
    '.noteedit .nbtn{flex:none;height:25px;padding:0 8px;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#c7cfdd;font-size:10.5px;cursor:pointer;font-family:inherit}',
    '.noteedit .nbtn:hover{background:rgba(255,255,255,.09)}',
    '.noteedit .nbtn.ok{border:0;background:linear-gradient(135deg,#5ee0ff,#6f8dff);color:#06121b;font-weight:700}',
    '.rowbtn{flex:none;width:24px;height:24px;border-radius:8px;border:0;background:transparent;color:#67718a;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:.15s;padding:0}',
    '.row:hover .rowbtn{opacity:1}',
    '.rowbtn:hover{background:rgba(255,255,255,.08);color:#bfe9ff}',
    '.rowbtn svg{width:13px;height:13px}',
    '.rowbtn.spin svg{animation:prspin .9s linear infinite}',
    '.foot{display:flex;gap:8px;padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,.055);background:rgba(255,255,255,.012)}',
    '.primary{flex:1;height:34px;border:0;border-radius:10px;background:linear-gradient(135deg,#5ee0ff,#6f8dff);color:#06121b;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;box-shadow:0 6px 20px rgba(94,224,255,.16);font-family:inherit}',
    '.primary svg{width:14px;height:14px}',
    '.primary:hover{filter:brightness(1.06)}',
    '.ghost{height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#c7cfdd;font-size:12px;cursor:pointer;font-family:inherit}',
    '.ghost:hover{background:rgba(255,255,255,.07)}',
    '.pvx{position:absolute;inset:0;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(17,21,31,.995),rgba(9,12,18,.995));z-index:6;transform:translateX(102%);transition:transform .3s cubic-bezier(.22,.9,.24,1),visibility .3s;visibility:hidden}',
    ':host([data-preview="true"]) .panel{height:min(70vh,560px)}',
    ':host([data-side="left"]) .pvx{transform:translateX(-102%)}',
    '.pvx[data-show="true"]{transform:none;visibility:visible}',
    '.pvxhead{display:flex;align-items:center;gap:6px;padding:11px 8px 8px 10px}',
    '.pvxtitle{flex:1;min-width:0;font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pvxmeta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:0 12px 8px;font-size:10.5px;color:#8590a5}',
    '.pillcat{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border-radius:99px;background:rgba(255,255,255,.06);font-size:10px;color:#cfd8e8}',
    '.pillcat i{width:6px;height:6px;border-radius:50%;background:#5ee0ff;flex:none}',
    '.pillkw{display:inline-flex;align-items:center;padding:1px 7px;border-radius:99px;background:rgba(242,153,74,.14);font-size:10px;color:#ffe1c2}',
    '.pillkw.hit{color:#1b0f04;background:linear-gradient(135deg,#ffb36b,#f2994a);font-weight:700}',
    '.pvxkwline{display:flex;flex-wrap:wrap;gap:5px;margin:2px 0 8px}',
    '.pvxkwchip{font-size:10.5px;color:#ffe1c2;background:rgba(242,153,74,.14);padding:1px 7px;border-radius:99px}',
    '.pvxbody{flex:1;overflow-y:auto;padding:0 12px 10px;overscroll-behavior:contain}',
    '.pvxbody::-webkit-scrollbar{width:6px}',
    '.pvxbody::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}',
    '.pvxsec{margin-top:10px}',
    '.pvxsec>h4{margin:0 0 5px;font-size:9.5px;letter-spacing:.1em;color:#6f7a90;font-weight:700}',
    '.pvxitem{display:block;font-size:11.5px;color:#cfd8e8;text-decoration:none;padding:5px 0 5px 11px;position:relative;border-bottom:1px solid rgba(255,255,255,.045);line-height:1.4;cursor:pointer}',
    '.pvxitem::before{content:"";position:absolute;left:1px;top:11px;width:4px;height:4px;border-radius:50%;background:#3ddc97;flex:none}',
    '.pvxitem.added::before{background:#5ee0ff}',
    '.pvxitem:hover{color:#fff;background:rgba(255,255,255,.04)}',
    '.pvxex{font-size:11px;line-height:1.62;color:#98a3b8;white-space:pre-wrap;word-break:break-word;max-height:168px;overflow:hidden}',
    '.pvxnote{font-size:10.5px;color:#6f7a90;padding:10px 0;line-height:1.5}',
    '.pvxfoot{display:flex;gap:8px;padding:9px 12px 12px;border-top:1px solid rgba(255,255,255,.055)}',
    '@keyframes prpulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '@keyframes prspin{to{transform:rotate(360deg)}}',
    '@keyframes prslide{from{transform:translateX(-100%)}to{transform:translateX(100%)}}'
  ].join('\n');

  var PICKER_CSS = [
    ':host{all:initial;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;direction:ltr}',
    '.hl{position:fixed;border:1.5px solid #5ee0ff;background:rgba(94,224,255,.1);border-radius:4px;box-shadow:0 0 0 9999px rgba(3,5,9,.5),inset 0 0 0 1px rgba(94,224,255,.22),0 0 28px rgba(94,224,255,.22);transition:left .06s linear,top .06s linear,width .06s linear,height .06s linear;pointer-events:none;display:none}',
    '.hud{position:fixed;top:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:rgba(12,16,24,.94);border:1px solid rgba(94,224,255,.28);color:#dbe7f7;font-size:12.5px;padding:9px 14px;border-radius:999px;box-shadow:0 10px 40px rgba(0,0,0,.45);backdrop-filter:blur(12px);pointer-events:none;white-space:nowrap}',
    '.hud b{color:#8feaff}',
    '.kbd{border:1px solid rgba(255,255,255,.16);border-radius:5px;padding:1px 5px;font-size:10px;color:#9aa6bb;background:rgba(255,255,255,.04)}',
    '.tip{position:fixed;display:none;align-items:center;gap:6px;background:rgba(10,14,21,.95);border:1px solid rgba(255,255,255,.12);padding:5px 9px;border-radius:7px;font-size:11px;color:#cfe0f4;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;max-width:min(440px,72vw)}',
    '.tip b{color:#7fe8ff;font-weight:600;white-space:nowrap}',
    '.tip i{color:#7f8ba0;font-style:normal;white-space:nowrap}',
    '.card{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);width:412px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);overflow:auto;background:linear-gradient(180deg,rgba(20,25,36,.985),rgba(11,14,21,.985));border:1px solid rgba(94,224,255,.22);border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.6);padding:16px;color:#e6ecf7;pointer-events:auto;box-sizing:border-box}',
    '.card[hidden]{display:none}',
    '.card::-webkit-scrollbar{width:6px}',
    '.card::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}',
    '.chead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
    '.ct{font-size:15px;font-weight:700;letter-spacing:.01em}',
    '.ce{font-size:11px;color:#7e8aa0;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pv{margin:12px 0 4px;padding:10px 12px;border-radius:11px;background:rgba(94,224,255,.055);border:1px solid rgba(94,224,255,.12);font-size:11.5px;color:#a9b6c9;line-height:1.6}',
    '.pv b{color:#bfeaff;font-weight:700}',
    '.pv .s{display:block;color:#7f8ba0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.field{display:flex;align-items:center;gap:10px;margin-top:10px}',
    '.field>span{width:64px;flex:none;font-size:11.5px;color:#8d99ad}',
    '.newcat{display:flex;align-items:center;gap:6px;margin-top:8px;padding-left:74px}',
    '.newcat[hidden]{display:none}',
    '.newcat input{flex:1;min-width:0;height:30px;font-size:12px}',
    '.newcat .nbtn{flex:none;height:30px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#c7cfdd;font-size:11.5px;cursor:pointer;font-family:inherit}',
    '.newcat .nbtn:hover{background:rgba(255,255,255,.09)}',
    '.newcat .nbtn.ok{border:0;background:linear-gradient(135deg,#5ee0ff,#6f8dff);color:#06121b;font-weight:700}',
    'input,select{flex:1;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#e9eef8;padding:0 10px;font-size:12.5px;outline:none;font-family:inherit;box-sizing:border-box}',
    'input:focus,select:focus{border-color:rgba(94,224,255,.55);box-shadow:0 0 0 3px rgba(94,224,255,.1)}',
    'select option{background:#121620;color:#e9eef8}',
    '.adjust{display:flex;gap:8px;margin-top:10px}',
    '.adjust button{flex:1;height:30px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#a9b6c9;font-size:11.5px;cursor:pointer;font-family:inherit}',
    '.adjust button:hover{background:rgba(255,255,255,.07);color:#dbe7f7}',
    '.cfoot{display:flex;gap:8px;margin-top:14px}',
    '.cbtn{height:36px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#c7cfdd;font-size:12.5px;padding:0 14px;cursor:pointer;font-family:inherit}',
    '.cbtn:hover{background:rgba(255,255,255,.07)}',
    '.cbtn.primary{flex:1;border:0;background:linear-gradient(135deg,#5ee0ff,#6f8dff);color:#06121b;font-weight:700;box-shadow:0 8px 24px rgba(94,224,255,.18)}',
    '.cbtn.primary:hover{filter:brightness(1.06)}',
    '.cbtn[disabled]{opacity:.55;cursor:default;filter:none}',
    '.err{margin-top:10px;font-size:11.5px;color:#ff9b9b;display:none}',
    '.err.show{display:block}',
    '.ibtn{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:#7c879c;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none}',
    '.ibtn:hover{background:rgba(255,255,255,.08);color:#c7e9ff}',
    '.ibtn svg{width:15px;height:15px}',
    '@keyframes prfade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.card{animation:prfade .18s ease-out}'
  ].join('\n');

  var TOAST_CSS = [
    ':host{all:initial;position:fixed!important;left:50%!important;bottom:28px!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:block!important;pointer-events:none!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;direction:ltr}',
    '.toast{background:rgba(16,20,29,.97);border:1px solid rgba(94,224,255,.28);color:#dce6f5;font-size:12.5px;line-height:1.5;padding:10px 16px;border-radius:999px;box-shadow:0 12px 40px rgba(0,0,0,.55);opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;max-width:min(560px,82vw);text-align:center}',
    '.toast.show{opacity:1;transform:none}'
  ].join('\n');

  var FLASH_CSS = [
    ':host{all:initial;position:fixed!important;inset:0!important;z-index:2147483001!important;display:block!important;pointer-events:none!important}',
    '.box{position:fixed;border:2px solid #5ee0ff;border-radius:6px;background:rgba(94,224,255,.1);box-shadow:0 0 0 1px rgba(94,224,255,.35),0 0 40px rgba(94,224,255,.35);animation:prflash 2.2s ease-out forwards;pointer-events:none}',
    '@keyframes prflash{0%{opacity:0;transform:scale(.995)}12%{opacity:1}70%{opacity:1}100%{opacity:0}}'
  ].join('\n');

  var ICONS = {
    radar: '<svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6" opacity=".4"/><circle cx="12" cy="12" r="4.6" opacity=".7"/><path d="M12 12 18.3 6.2"/><path d="M12 12a8.6 8.6 0 0 1 8.6-8.6" opacity="0"/><path d="M12 3.4a8.6 8.6 0 0 1 8.6 8.6" opacity=".9"/><circle cx="16.5" cy="8.6" r="1.5" fill="currentColor" stroke="none"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7Z"/><path d="M12 15v6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 12S5.6 5.8 12 5.8 21.8 12 21.8 12 18.4 18.2 12 18.2 2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="2.9"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z"/><path d="M14 7.5l3 3"/></svg>'
  };

  var PANEL_TPL = [
    '<div class="panel" part="panel">',
    '<div class="progress"></div>',
    '<div class="head">',
    '<div class="brand">' + ICONS.radar + '<span class="name">更新雷达</span><span class="count" id="pr-count">0</span></div>',
    '<div class="hactions">',
    '<button class="ibtn" data-act="pin" title="固定展开" aria-label="固定展开">' + ICONS.pin + '</button>',
    '<button class="ibtn" data-act="refresh" title="立即检查本页" aria-label="立即检查本页">' + ICONS.refresh + '</button>',
    '<button class="ibtn danger" data-act="close" title="关闭悬浮窗" aria-label="关闭悬浮窗">' + ICONS.close + '</button>',
    '</div>',
    '</div>',
    '<div class="body" id="pr-body"></div>',
    '<div class="pvx" id="pr-pvx" data-show="false"></div>',
    '<div class="foot">',
    '<button class="primary" data-act="pick">' + ICONS.plus + '框选新板块</button>',
    '<button class="ghost" data-act="options">管理</button>',
    '</div>',
    '</div>'
  ].join('');

  var PICKER_TPL = [
    '<div class="hl"></div>',
    '<div class="hud"><b>点击选择</b><span id="pr-hud-text">要订阅的板块</span><span class="kbd">↑↓ 调整</span><span class="kbd">Esc 取消</span></div>',
    '<div class="tip"><b id="pr-tip-tag"></b><i id="pr-tip-size"></i></div>',
    '<div class="card" id="pr-card" hidden>',
    '<div class="chead"><div><div class="ct">订阅这个板块</div><div class="ce" id="pr-el"></div></div><button class="ibtn" data-pick="close" aria-label="取消">' + ICONS.close + '</button></div>',
    '<div class="pv" id="pr-prev"></div>',
    '<label class="field"><span>名称</span><input id="pr-name" maxlength="60" placeholder="给这个板块起个名字"></label>',
    '<div class="field"><span>检查间隔</span><select id="pr-interval">' +
      '<option value="">跟随全局设置</option>' +
      '<option value="1">每 1 小时</option>' +
      '<option value="3">每 3 小时</option>' +
      '<option value="6">每 6 小时</option>' +
      '<option value="12">每 12 小时</option>' +
      '<option value="24">每 24 小时</option>' +
      '<option value="48">每 2 天</option>' +
      '<option value="168">每 7 天</option>' +
    '</select></div>',
    '<div class="field"><span>分类</span><select id="pr-cat"></select></div>',
    '<div class="newcat" id="pr-newcat" hidden><input id="pr-newcat-name" maxlength="20" placeholder="新分类名称"><button class="nbtn ok" data-pick="newcat-ok">添加</button><button class="nbtn" data-pick="newcat-cancel">取消</button></div>',
    '<div class="adjust"><button data-pick="up">↑ 扩大选区</button><button data-pick="down">↓ 缩小选区</button></div>',
    '<div class="err" id="pr-err"></div>',
    '<div class="cfoot"><button class="cbtn" data-pick="reselect">重选</button><button class="cbtn" data-pick="cancel">取消</button><button class="cbtn primary" data-pick="subscribe" id="pr-sub">订阅</button></div>',
    '</div>'
  ].join('');

  root.__PR_UI = {
    PANEL_CSS: PANEL_CSS,
    PICKER_CSS: PICKER_CSS,
    TOAST_CSS: TOAST_CSS,
    FLASH_CSS: FLASH_CSS,
    ICONS: ICONS,
    PANEL_TPL: PANEL_TPL,
    PICKER_TPL: PICKER_TPL
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
