/* =============================================================================
   FX Fighter · ui.js — 终端界面、自绘 K 线、下单交互
   ========================================================================== */
(function () {
  'use strict';

  var FX = window.FX;
  var C = FX.constants;
  var DAY = 86400000;

  /* ---------------------------------------------------------------- 启动 */
  var world;
  try {
    world = FX.buildWorld(window.FX_REAL_DATA);
  } catch (e) {
    document.body.innerHTML = '<pre style="color:#ff9a9b;padding:24px;font:14px/1.6 monospace">' +
      'rates.js 没加载成功：' + e.message + '\n\n请把 index.html、rates.js、engine.js、ui.js 放在同一个目录下打开。</pre>';
    return;
  }

  var eng = new FX.Engine(world, { seed: 20261026, balance: 100000, leverage: 100 });

  var SYMS = world.symbols.map(function (s) { return s.name; });
  var state = {
    sym: 'EURUSD',
    tf: 'M15',
    zoom: 1,
    offset: 0,
    colorMode: 'intl',      // intl: 绿涨红跌 / cn: 红涨绿跌
    speed: 1,                // 默认 1×：进站就是实时，接上实时数据后自动对齐
    showMA: true
  };

  /* ---------------------------------------------------------------- 存档 */
  var LS_KEY = 'fxfighter.v1';
  function saveState() {
    try {
      var snap = eng.serialize();
      snap.ui = { sym: state.sym, tf: state.tf, colorMode: state.colorMode, speed: state.speed, zoom: state.zoom, offset: state.offset };
      localStorage.setItem(LS_KEY, JSON.stringify(snap));
      return true;
    } catch (e) { return false; }
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      var snap = JSON.parse(raw);
      if (!eng.restore(snap)) return false;
      if (snap.ui) {
        if (SYMS.indexOf(snap.ui.sym) >= 0) state.sym = snap.ui.sym;
        if (['M1','M5','M15','H1','H4','D1'].indexOf(snap.ui.tf) >= 0) state.tf = snap.ui.tf;
        if (snap.ui.colorMode) state.colorMode = snap.ui.colorMode;
        if (snap.ui.speed != null) state.speed = snap.ui.speed;
        // 进站一律从 1× 起（有实时数据就贴着实时走），倍速是本次会话里的临时选择
        state.speed = 1;
        if (snap.ui.zoom) state.zoom = snap.ui.zoom;
        if (snap.ui.offset) state.offset = snap.ui.offset;
      }
      return true;
    } catch (e) { return false; }
  }
  var restored = loadState();

  /* ---------------------------------------------------------------- 工具 */
  var $ = function (id) { return document.getElementById(id); };
  function fmtPx(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(digits == null ? 5 : digits);
  }
  function fmtMoney(v, sign) {
    if (v == null || !isFinite(v)) return '—';
    var s = (v < 0 ? '-' : (sign && v > 0 ? '+' : '')) + '¥' + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s;
  }
  function fmtNum(v) { return (v == null || !isFinite(v)) ? '—' : v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtPct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function prettyDate(s) { return String(s).replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3'); }
  // 涨跌用色：intl = 绿涨红跌；cn = 红涨绿跌（跟原站点一样可切）
  function dirClass(v) {
    if (v === 0) return 'dim';
    var good = v > 0;
    if (state.colorMode === 'cn') good = !good;
    // good 表示"涨"用绿
    if (state.colorMode === 'cn') return v > 0 ? 'dn' : 'up';   // 红涨
    return v > 0 ? 'up' : 'dn';
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  var COL = { up: '#2bd6a0', dn: '#ff4d5e' };
  function upDown(v) {
    // 返回 {涨色, 跌色} 已按当前习惯排好
    return state.colorMode === 'cn' ? { up: COL.dn, dn: COL.up } : { up: COL.up, dn: COL.dn };
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ------------------------------------------------------- 品种列表渲染 */
  function symRow(name) {
    var s = eng.sym[name], def = s.def;
    var closes = def.closes;
    var ref = closes[closes.length - 1];
    var chg = (s.mid / ref - 1) * 100;
    var el = document.createElement('div');
    el.className = 'symrow' + (name === state.sym ? ' active' : '');
    el.dataset.sym = name;
    el.innerHTML =
      '<div><div class="nm">' + name + '</div>' +
      '<div class="sub">' + def.base + '/' + def.quote + ' · <span class="sp' + (s.spreadPips > def.sp * 2.2 ? ' wide' : '') + '">' + s.spreadPips.toFixed(1) + '点</span></div></div>' +
      '<div><div class="px">' + fmtPx(s.mid, def.digits) + '</div>' +
      '<div class="chg ' + dirClass(chg) + '">' + fmtPct(chg) + '</div></div>';
    return el;
  }
  function renderSymList() {
    var box = $('symList');
    var scrollTop = box.scrollTop;
    box.innerHTML = '';
    SYMS.forEach(function (n) { box.appendChild(symRow(n)); });
    box.scrollTop = scrollTop;
    $('symCount').textContent = SYMS.length + ' 个';
  }

  /* ------------------------------------------------------------- 图表 */
  var chartCv = $('chart'), chartCtx = chartCv.getContext('2d');
  var eqCv = $('eqChart'), eqCtx = eqCv.getContext('2d');
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  function sizeCanvas(cv, ctx) {
    var r = cv.getBoundingClientRect();
    var w = Math.max(10, Math.floor(r.width)), h = Math.max(10, Math.floor(r.height));
    if (cv.width !== w * DPR || cv.height !== h * DPR) {
      cv.width = w * DPR; cv.height = h * DPR;
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    return { w: w, h: h };
  }

  var mouse = { x: -1, y: -1, inside: false };
  var panning = false, panStart = null;

  function curBars() {
    var s = eng.sym[state.sym];
    return s.bars[state.sym + state.tf] || [];
  }

  function niceStep(range, target) {
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function drawChart() {
    var box = $('chartBox');
    var { w, h } = sizeCanvas(chartCv, chartCtx);
    var ctx = chartCtx;
    ctx.clearRect(0, 0, w, h);

    var padR = 66, padB = 20, padT = 8, padL = 6;
    var plotW = w - padR - padL, plotH = h - padB - padT;
    var bars = curBars();
    var def = eng.sym[state.sym].def;
    var n = bars.length;
    var cnt = Math.max(20, Math.min(n, Math.round((plotW / 8) * state.zoom)));
    var end = Math.max(cnt, n - Math.round(state.offset));
    var start = Math.max(0, end - cnt);
    var vis = bars.slice(start, end);
    if (!vis.length) return;

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < vis.length; i++) {
      if (vis[i].l < lo) lo = vis[i].l;
      if (vis[i].h > hi) hi = vis[i].h;
    }
    // 持仓线也纳入范围
    eng.positions.forEach(function (p) {
      if (p.sym !== state.sym) return;
      [p.openPx, p.sl, p.tp].forEach(function (v) { if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    });
    if (!isFinite(lo) || !isFinite(hi)) return;
    var pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.0004 || 0.0001;
    lo -= pad; hi += pad;

    var y = function (p) { return padT + plotH - (p - lo) / (hi - lo) * plotH; };
    var cw = plotW / vis.length;
    var bw = Math.max(1, Math.min(14, cw * 0.66));

    // 网格 + 价格轴
    var step = niceStep(hi - lo, 6);
    ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'middle';
    var startTick = Math.ceil(lo / step) * step;
    for (var p = startTick; p < hi; p += step) {
      var yy = Math.round(y(p)) + 0.5;
      ctx.strokeStyle = '#161c28'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillStyle = '#5f6b80';
      ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(def.digits > 3 ? def.digits - 1 : def.digits), padL + plotW + 6, yy);
    }

    // 时间轴
    var tStep = Math.max(1, Math.round(vis.length / Math.max(3, Math.floor(plotW / 78))));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var j = 0; j < vis.length; j += tStep) {
      var d = srvDate(vis[j].t);
      var lbl = (state.tf === 'D1' || state.tf === 'H4')
        ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate()
        : p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
      ctx.fillStyle = '#4b566a';
      ctx.fillText(lbl, padL + j * cw + cw / 2, padT + plotH + 5);
    }

    // 均线
    if (state.showMA && n > 30) {
      drawMA(ctx, bars, start, end, 20, 'rgba(240,185,11,.75)', y, cw, padL);
      drawMA(ctx, bars, start, end, 50, 'rgba(192,125,255,.6)', y, cw, padL);
    }

    // 蜡烛
    var ud = upDown(0);
    for (var k = 0; k < vis.length; k++) {
      var b = vis[k];
      var x = padL + k * cw + cw / 2;
      var rise = b.c >= b.o;
      var col = rise ? ud.up : ud.dn;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      // 影线
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y(b.h));
      ctx.lineTo(Math.round(x) + 0.5, y(b.l));
      ctx.stroke();
      // 实体
      var yo = y(b.o), yc = y(b.c);
      var top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - bw / 2, top, bw, hgt);
    }

    // 现价线
    var s = eng.sym[state.sym];
    var lastY = y(s.mid);
    ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(120,170,255,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, lastY); ctx.lineTo(padL + plotW, lastY); ctx.stroke();
    ctx.setLineDash([]);
    var px = fmtPx(s.mid, def.digits);
    ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    var tw = ctx.measureText(px).width + 10;
    ctx.fillStyle = rise ? '#123a30' : (state.colorMode === 'cn' ? '#3a1218' : '#3a1218');
    ctx.fillStyle = '#1b2b46';
    ctx.fillRect(padL + plotW + 2, lastY - 8, Math.max(tw, 58), 16);
    ctx.strokeStyle = '#3b5c92'; ctx.strokeRect(padL + plotW + 2, lastY - 8, Math.max(tw, 58), 16);
    ctx.fillStyle = '#cfe0ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(px, padL + plotW + 7, lastY);

    // 持仓线
    eng.positions.forEach(function (pp) {
      if (pp.sym !== state.sym) return;
      lineAt(ctx, y(pp.openPx), padL, plotW, '#9fb3c8', [2, 3], '开仓 ' + fmtPx(pp.openPx, def.digits));
      if (pp.sl) lineAt(ctx, y(pp.sl), padL, plotW, '#ff6b78', [1, 3], 'SL ' + fmtPx(pp.sl, def.digits));
      if (pp.tp) lineAt(ctx, y(pp.tp), padL, plotW, '#2bd6a0', [1, 3], 'TP ' + fmtPx(pp.tp, def.digits));
    });

    // 十字光标
    if (mouse.inside && mouse.x > padL && mouse.x < padL + plotW) {
      var idx = Math.floor((mouse.x - padL) / cw);
      idx = Math.max(0, Math.min(vis.length - 1, idx));
      var bx = padL + idx * cw + cw / 2;
      ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(160,180,210,.35)';
      ctx.beginPath(); ctx.moveTo(bx, padT); ctx.lineTo(bx, padT + plotH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, mouse.y); ctx.lineTo(padL + plotW, mouse.y); ctx.stroke();
      ctx.setLineDash([]);
      var hv = lo + (padT + plotH - mouse.y) / plotH * (hi - lo);
      ctx.fillStyle = '#222c3e';
      ctx.fillRect(padL + plotW + 2, mouse.y - 8, 60, 16);
      ctx.fillStyle = '#dfe6f2'; ctx.textAlign = 'left';
      ctx.fillText(hv.toFixed(def.digits), padL + plotW + 7, mouse.y);
      showTip(vis[idx], mouse.x, mouse.y, def);
    } else {
      $('tip').style.opacity = 0;
    }
  }

  function lineAt(ctx, yy, cl, cw, color, dash, label) {
    ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cl, yy); ctx.lineTo(cl + cw, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(label, cl + 4, yy - 1);
  }

  function drawMA(ctx, bars, start, end, period, color, y, cw, padL) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
    var started = false;
    for (var i = start; i < end; i++) {
      if (i < period) continue;
      var sum = 0;
      for (var k = i - period + 1; k <= i; k++) sum += bars[k].c;
      var v = sum / period;
      var x = padL + (i - start) * cw + cw / 2;
      if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
    }
    ctx.stroke();
  }

  function showTip(b, mx, my, def) {
    var tip = $('tip');
    var d = srvDate(b.t);
    var t = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) +
      ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
    var chg = (b.c - b.o);
    tip.innerHTML = t + (b.est ? '（收盘真实·影线估算）' : '') + '\n' +
      '开 ' + fmtPx(b.o, def.digits) + '  高 ' + fmtPx(b.h, def.digits) + '\n' +
      '低 ' + fmtPx(b.l, def.digits) + '  收 ' + fmtPx(b.c, def.digits) + '\n' +
      '幅度 ' + (chg / b.o * 100).toFixed(3) + '%';
    var box = $('chartBox').getBoundingClientRect();
    var x = mx + 14, yTop = my - 60;
    if (x + 160 > box.width) x = mx - 170;
    if (yTop < 0) yTop = 4;
    tip.style.left = x + 'px';
    tip.style.top = yTop + 'px';
    tip.style.opacity = 1;
  }

  function drawEquity() {
    var { w, h } = sizeCanvas(eqCv, eqCtx);
    var ctx = eqCtx;
    ctx.clearRect(0, 0, w, h);
    var pts = eng.equityCurve.slice(-600);
    if (eng.equity() !== null) pts = pts.concat([{ t: eng.clock, eq: eng.equity() }]);
    if (pts.length < 2) return;
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { if (p.eq < lo) lo = p.eq; if (p.eq > hi) hi = p.eq; });
    var base = eng.startBalance;
    lo = Math.min(lo, base); hi = Math.max(hi, base);
    var pad = (hi - lo) * 0.18 || 100;
    lo -= pad; hi += pad;
    var padR = 66, padT = 14, padB = 6, padL = 6;
    var plotW = w - padR - padL, plotH = h - padT - padB;
    var y = function (v) { return padT + plotH - (v - lo) / (hi - lo) * plotH; };
    var x = function (i) { return padL + i / (pts.length - 1) * plotW; };

    // 本金虚线
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#2f3b52'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y(base)); ctx.lineTo(padL + plotW, y(base)); ctx.stroke();
    ctx.setLineDash([]);

    var last = pts[pts.length - 1].eq;
    var good = last >= base;
    var col = good ? COL.up : COL.dn;
    if (state.colorMode === 'cn') col = good ? COL.dn : COL.up;
    ctx.beginPath();
    pts.forEach(function (p, i) { i ? ctx.lineTo(x(i), y(p.eq)) : ctx.moveTo(x(i), y(p.eq)); });
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.lineTo(x(pts.length - 1), padT + plotH); ctx.lineTo(padL, padT + plotH); ctx.closePath();
    var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, col + '44'); grad.addColorStop(1, col + '00');
    ctx.fillStyle = grad; ctx.fill();

    ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = '#8d99ad'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtMoney(last), padL + plotW + 6, y(last));
    ctx.fillStyle = '#4b566a';
    ctx.fillText(fmtMoney(hi), padL + plotW + 6, padT + 4);
    ctx.fillText(fmtMoney(lo), padL + plotW + 6, padT + plotH - 4);
  }

  /* ------------------------------------------------------------ 头部信息 */
  var SRV_OFF = 8 * 3600000;
  function srvDate(ms) { return new Date(ms + SRV_OFF); }          // 服务器时间 UTC+8（北京）
  function p2(n) { return ('0' + n).slice(-2); }

  function renderHeader() {
    var s = eng.sym[state.sym], def = s.def;
    var closes = def.closes;
    var ref = closes[closes.length - 1];
    var chgAbs = s.mid - ref;
    var chgPct = (s.mid / ref - 1) * 100;
    var bars = curBars();
    var lastBar = bars[bars.length - 1];
    $('qName').textContent = state.sym;
    $('qPair').textContent = def.base + ' / ' + def.quote + ' · ' + (DEF_ROLE[state.sym] || '') + ' · 杠杆上限 1:' + def.lev;
    $('qPrice').textContent = fmtPx(s.mid, def.digits);
    $('qBidAsk').innerHTML = '买 <b>' + fmtPx(s.bid, def.digits) + '</b> · 卖 <b>' + fmtPx(s.ask, def.digits) + '</b> · 点差 <b>' + s.spreadPips.toFixed(1) + ' 点</b>';
    $('qChg').className = 'mono ' + dirClass(chgPct);
    $('qChg').textContent = (chgAbs >= 0 ? '+' : '') + chgAbs.toFixed(def.digits);
    $('qPct').className = 'mono';
    $('qPct').style.color = chgPct >= 0 ? upDown(0).up : upDown(0).dn;
    $('qPct').textContent = fmtPct(chgPct) + '（较 ' + prettyDate(world.dates[world.n - 1]) + ' 收盘）';

    var html = '';
    if (lastBar) {
      html += '<span>' + state.tf + ' 开 <b>' + fmtPx(lastBar.o, def.digits) + '</b></span>';
      html += '<span>高 <b>' + fmtPx(lastBar.h, def.digits) + '</b></span>';
      html += '<span>低 <b>' + fmtPx(lastBar.l, def.digits) + '</b></span>';
      html += '<span>收 <b>' + fmtPx(lastBar.c, def.digits) + '</b></span>';
    }
    var pv = eng.pipValueUSD(state.sym, 1);
    html += '<span>1 手 1 点 <b>' + fmtMoney(pv) + '</b></span>';
    html += '<span>1 手 = <b>10 万 ' + def.base + '</b></span>';
    $('qStats').innerHTML = html;
    $('ticketSym').textContent = state.sym + ' · ' + def.digits + ' 位小数';
    $('buyPx').textContent = fmtPx(s.ask, def.digits);
    $('sellPx').textContent = fmtPx(s.bid, def.digits);
    $('lotsUnit').textContent = '1 手 = 10 万 ' + def.base;
  }

  var DEF_ROLE = {
    EURUSD: '欧元/美元 · 最活跃的直盘',
    GBPUSD: '英镑/美元 · 波动偏大',
    USDJPY: '美元/日元 · 点值随汇率变',
    USDCHF: '美元/瑞郎',
    USDCAD: '美元/加元 · 跟油价反向',
    AUDUSD: '澳元/美元 · 商品货币',
    NZDUSD: '纽元/美元',
    EURJPY: '欧元/日元 · 交叉盘（由两条美元腿换算）',
    EURGBP: '欧元/英镑 · 点差相对宽',
    EURCHF: '欧元/瑞郎',
    GBPJPY: '英镑/日元 · 波动最猛的那一类',
    AUDJPY: '澳元/日元 · 风险情绪的放大镜',
    USDCNY: '美元/人民币（ECB 中间价口径）'
  };

  /* ------------------------------------------------------------ 下单面板 */
  function getLots() {
    var v = parseFloat($('lots').value);
    if (!isFinite(v)) v = 0.1;
    return FX.roundLots(v);
  }
  function renderCalc() {
    var lots = getLots();
    var s = eng.sym[state.sym], def = s.def;
    var notional = lots * C.CONTRACT * eng.usdPerBase(state.sym);
    var lev = Math.min(eng.leverage, def.lev);
    var margin = notional / lev;
    var pipv = eng.pipValueUSD(state.sym, lots);
    var slP = parseFloat($('slPips').value);
    var risk = isFinite(slP) && slP > 0 ? pipv * slP : null;
    var comm = lots * C.COMMISSION_PER_LOT * 2;
    var html = '名义价值 <b>' + fmtMoney(notional) + '</b> · 保证金 <b>' + fmtMoney(margin) + '</b>（1:' + lev + '）<br>' +
      '每点 <b>' + fmtMoney(pipv) + '</b> · 往返佣金 <b>' + fmtMoney(comm) + '</b>';
    if (risk) html += ' · 打到止损亏 <b' + (risk / eng.equity() > 0.1 ? ' style="color:#ffb060"' : '') + '>' + fmtMoney(risk) + '</b>（占净值 ' + (risk / eng.equity() * 100).toFixed(1) + '%）';
    $('calc').innerHTML = html;
  }

  function buildOrder() {
    var lots = getLots();
    var slP = parseFloat($('slPips').value), tpP = parseFloat($('tpPips').value);
    return { sym: state.sym, lots: lots, slPips: isFinite(slP) ? slP : 0, tpPips: isFinite(tpP) ? tpP : 0 };
  }

  function trade(side) {
    var s = eng.sym[state.sym], def = s.def;
    var o = buildOrder();
    var ref = side > 0 ? s.ask : s.bid;
    var sl = o.slPips > 0 ? +(ref - side * o.slPips * def.pip).toFixed(def.digits) : 0;
    var tp = o.tpPips > 0 ? +(ref + side * o.tpPips * def.pip).toFixed(def.digits) : 0;
    var r = eng.order({ sym: state.sym, side: side, lots: o.lots, type: 'market', sl: sl, tp: tp, comment: 'manual' });
    if (!r.ok) return toast('下单失败：' + r.err);
    toast((side > 0 ? '买入' : '卖出') + ' ' + o.lots + ' 手 ' + state.sym + ' @' + fmtPx(r.position.openPx, def.digits));
    refreshPanels(true);
  }

  /* ------------------------------------------------------------- 账户区 */
  function renderAccount() {
    var a = eng.account();
    var lvl = a.margin > 0 ? a.level : null;
    var lvlTxt = lvl == null ? '—' : lvl.toFixed(1) + '%';
    var warnCls = lvl == null ? '' : (lvl < C.MARGIN_CALL ? 'dn' : 'up');
    if (lvl != null && lvl < C.MARGIN_CALL) lvlTxt += ' 追保';
    $('acctBalance').textContent = fmtMoney(a.balance);
    $('acctEquity').textContent = fmtMoney(a.equity);
    $('acctEquity').className = 'v ' + (a.equity >= eng.startBalance ? 'up' : 'dn');
    $('acctMargin').textContent = fmtMoney(a.margin);
    $('acctFree').textContent = fmtMoney(a.free);
    $('acctFloat').textContent = fmtMoney(a.floating, true);
    $('acctFloat').className = 'v ' + (a.floating >= 0 ? 'up' : 'dn');
    $('acctLevel').textContent = lvlTxt;
    $('acctLevel').className = 'v ' + warnCls;
    $('acctLeverage').textContent = '1:' + eng.leverage;
    $('topEquity').textContent = fmtMoney(a.equity);
    $('topEquity').style.color = a.equity >= eng.startBalance ? COL.up : COL.dn;
    $('topFree').textContent = fmtMoney(a.free);
    $('topLevel').textContent = lvlTxt;
    $('topLevel').style.color = lvl != null && lvl < C.MARGIN_CALL ? COL.dn : '#dfe6f2';
  }

  function renderPositions() {
    var tb = $('positions');
    if (!eng.positions.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">没有持仓</td></tr>';
    } else {
      var html = '';
      eng.positions.forEach(function (p) {
        var s = eng.sym[p.sym], def = s.def;
        var now = p.side > 0 ? s.bid : s.ask;
        var pl = eng._posPL(p, now);
        var pips = (now - p.openPx) * p.side / def.pip;
        var marks = (p.sl ? ' SL ' + fmtPx(p.sl, def.digits) : '') + (p.tp ? ' TP ' + fmtPx(p.tp, def.digits) : '');
        html += '<tr title="#' + p.ticket + (marks ? ' · ' + marks.trim() : '') + '">' +
          '<td>' + p.sym.slice(0, 6) + '</td>' +
          '<td class="' + (p.side > 0 ? 'up' : 'dn') + '">' + (p.side > 0 ? '多' : '空') + '</td>' +
          '<td>' + p.lots.toFixed(2) + '</td>' +
          '<td>' + fmtPx(p.openPx, def.digits) + '</td>' +
          '<td title="' + (pips >= 0 ? '+' : '') + pips.toFixed(1) + ' 点">' + fmtPx(now, def.digits) + '</td>' +
          '<td class="' + (pl >= 0 ? 'up' : 'dn') + '" title="' + (pips >= 0 ? '+' : '') + pips.toFixed(1) + ' 点 · 已扣佣金 ' + fmtMoney(p.comm) + '">' + fmtMoney(pl, true) + '</td>' +
          '<td class="nowrap"><button class="mini" data-close="' + p.ticket + '" title="平掉这笔">平</button>' +
          '<button class="mini" data-half="' + p.ticket + '" title="平掉一半">半</button>' +
          '<button class="mini" data-mod="' + p.ticket + '" title="改止损/止盈">改</button></td>' +
        '</tr>';
      });
      tb.innerHTML = html;
    }
    $('posCount').textContent = eng.positions.length + ' 笔';
  }

  function renderOrders() {
    var tb = $('orders');
    if (!eng.orders.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">没有挂单</td></tr>';
    } else {
      var html = '';
      eng.orders.forEach(function (o) {
        html += '<tr>' +
          '<td>' + o.sym + '</td>' +
          '<td class="' + (o.side > 0 ? 'up' : 'dn') + '">' + (o.side > 0 ? '买' : '卖') + (o.type === 'limit' ? '限价' : '止损') + '</td>' +
          '<td>' + o.lots.toFixed(2) + '</td>' +
          '<td>' + fmtPx(o.price, eng.sym[o.sym].def.digits) + '</td>' +
          '<td><button class="mini" data-cancel="' + o.id + '">撤</button></td>' +
        '</tr>';
      });
      tb.innerHTML = html;
    }
    $('ordCount').textContent = eng.orders.length + ' 张';
  }

  function renderHistory() {
    var tb = $('history');
    var h = eng.history.slice(-40).reverse();
    if (!h.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">还没平过仓</td></tr>';
    } else {
      var html = '';
      h.forEach(function (r) {
        html += '<tr>' +
          '<td>' + r.sym + (r.forced ? ' <span class="dim2" title="强制平仓">⚠</span>' : '') + '</td>' +
          '<td class="' + (r.side > 0 ? 'up' : 'dn') + '">' + (r.side > 0 ? '多' : '空') + '</td>' +
          '<td>' + r.lots.toFixed(2) + '</td>' +
          '<td>' + (r.pips >= 0 ? '+' : '') + r.pips.toFixed(1) + '</td>' +
          '<td class="' + (r.net >= 0 ? 'up' : 'dn') + '">' + fmtMoney(r.net, true) + '</td>' +
        '</tr>';
      });
      tb.innerHTML = html;
    }
    $('histCount').textContent = eng.history.length + ' 笔';
  }

  function renderStats() {
    var s = eng.stats();
    var cells = [
      ['交易笔数', s.trades],
      ['胜率', s.trades ? s.winRate.toFixed(1) + '%' : '—'],
      ['盈亏比 PF', s.trades ? (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)) : '—'],
      ['每笔期望', fmtMoney(s.expectancy, true)],
      ['平均点数', s.avgPips.toFixed(1)],
      ['最大回撤', s.maxDD.toFixed(1) + '%'],
      ['累计佣金', fmtMoney(-s.commission)],
      ['累计隔夜息', fmtMoney(s.swap, true)],
      ['已实现盈亏', fmtMoney(s.netProfit, true)],
      ['收益率', fmtPct(s.returnPct)],
      ['强平次数', s.forced],
      ['平均滑点', (eng.diag.slipCount ? (eng.diag.slipSum / eng.diag.slipCount) : 0).toFixed(2) + ' 点']
    ];
    $('stats').innerHTML = cells.map(function (c) {
      return '<div class="cell"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>';
    }).join('');
  }

  function renderStatus() {
    var open = eng.marketOpen(eng.clock);
    var s = eng.sym[state.sym];
    $('statusTime').textContent = FX.isoUTC(eng.clock) + ' (UTC+8)';
    $('statusSpread').textContent = s.spreadPips.toFixed(1) + ' 点';
    $('statusSlip').textContent = eng.diag.slipPips ? eng.diag.slipPips.toFixed(2) + ' 点' : '0';
    $('connDot').className = 'dot' + (open ? '' : ' off');
    var idx = eng._dayIdx(eng.clock);
    var isReal = eng._isReal(idx);
    var src;
    if (live.ok) {
      var ageMin = Math.round((Date.now() - live.ts) / 60000);
      src = 'ECB 日线至 ' + prettyDate(world.dates[world.n - 1]) + ' · 真实盘中 ' + liveClock(live.ts) +
        (ageMin >= 2 ? '（' + ageMin + ' 分钟前）' : '');
    } else {
      src = (isReal ? 'ECB 真实收盘 · 锚定至 ' + prettyDate(world.dates[world.n - 1]) : '模拟日（真实数据已走完）');
    }
    $('statusSrc').innerHTML = src + ' · ' + (open ? '市场开盘中' : '休市');
    $('statusLeft').textContent = eng.positions.length + ' 持仓 · ' + eng.orders.length + ' 挂单 · ' + (state.speed ? (state.speed === 1 ? '实时' : state.speed + '×') : '暂停');
    $('closedNotice').hidden = open;
    renderLiveChip();
  }

  /* ------------------------------------------------------- 实时数据（live.js）
     服务器上有个常驻中继每分钟抓一次真实汇率（不管有没有人来玩），
     写成 fx/live.js。这里用 <script> 拉它，天然跨域，Pages 版也能读服务器那份。 */
  var live = { ok: false, ts: 0, src: '', quoteTs: 0, legs: 0, pairs: 0, days: 0, apiSource: '' };

  /* 报价「多久以前」的人话写法：45秒 / 12分钟 / 3小时20分 */
  function fmtAge(min) {
    if (min < 1) return Math.max(1, Math.round(min * 60)) + ' 秒';
    if (min < 60) return Math.round(min) + ' 分钟';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }
  var LIVE_URL = /(^|\.)github\.io$/i.test(location.hostname)
    ? 'https://ikuyo.xyz/fx/live.js'
    : 'live.js';

  function liveClock(ms) {
    var d = srvDate(ms);
    return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }

  function renderLiveChip() {
    var el = $('liveChip');
    if (!el) return;
    var ageMin = live.ts ? (Date.now() - live.ts) / 60000 : Infinity;
    var ahead = (live.ok && live.quoteTs) ? (eng.clock - live.quoteTs) / 60000 : 0;
    var cls, txt, tip;
    if (live.ok && ageMin < 3 && ahead > 10) {
      cls = 'warn'; txt = '● 超前 ' + Math.round(ahead) + 'm';
      tip = '服务器数据是新的，但你点了倍速，模拟时钟已经跑到真实时间之后 ' + Math.round(ahead) + ' 分钟\n' +
        '再往后走的价格是模型生成的（回到 1× 就重新对齐）\n源：' + live.src;
    } else if (live.ok && ageMin < 3) {
      cls = 'ok'; txt = '● 实时 ' + liveClock(live.ts);
      tip = '真实盘中报价，服务器每 2 分钟同步一次（没有人玩的时候也在同步）\n源：' + live.src +
        '\n覆盖 ' + (live.days || 1) + ' 天真实 tick：' + live.legs + ' 条 EUR 基准腿 → ' + live.pairs + ' 个品种' +
        '\n最近一条报价：' + liveClock(live.quoteTs || live.ts);
    } else if (live.ok && ageMin < 720) {
      // 中继受限（上游限流 / 网络抖动）：真实 tick 还在，只是不再刷新，别急着说「离线」
      cls = 'warn'; txt = '● 报价 ' + fmtAge(ageMin) + '前';
      tip = '最后一条真实报价在 ' + fmtAge(ageMin) + '前，中继这阵子没拿到新数据（多半是上游免费额度限流）' +
        '\n图上已经走过的真实 tick 仍然有效，之后的行情按模型走，告警恢复后自动续上' +
        '\n源：' + live.src;
    } else {
      cls = 'off'; txt = '○ 离线（内置数据）';
      tip = '没拿到实时报价：' + (live.apiSource || 'live.js 不可达') + '\n行情按内置 ECB 日线 + 模型走';
    }
    el.className = 'livechip ' + cls;
    el.textContent = txt;
    el.title = tip;
  }

  /* --------------------------------------------- 同步时钟（拨回实时）
     倍速会把模拟时钟甩到真实时间前面，超前之后看到的价格就不再是真实盘中了。
     这个按钮把时钟按回服务器最新的真实 tick 上（路径、K 线、净值曲线一起重算）。 */
  function fmtSpan(ms) {
    var m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
  }

  function syncClock(opts) {
    // 按钮 / T 键 / 1× 自动同步都走这里：切到 1×，再把时钟按到最新真实报价
    var quiet = opts && opts.quiet;
    if (state.speed !== 1) setSpeed(1);
    if (!live.ok || !live.quoteTs) {
      if (!quiet) toast('已切到 1×，但还没有实时报价（离线，价格按内置数据走）');
      return false;
    }
    var gap = eng.clock - live.quoteTs;
    // 中继断了（报价超过半小时）就别按旧 tick 拖时钟回去，只在 1× 下按模型继续走
    var ageMin = live.ts ? (Date.now() - live.ts) / 60000 : 0;
    if (ageMin > 30) {
      if (!quiet) toast('实时报价停在 ' + fmtAge(ageMin) + '前，先按 1× 走模型，中继恢复后自动对齐');
      return false;
    }
    if (Math.abs(gap) < 30000) {
      if (!quiet) toast('已经在实时上了（' + liveClock(live.quoteTs) + '）');
      return false;
    }
    eng.seekTo(live.quoteTs, { trimEquity: gap > 0 });
    state.offset = 0;
    state.zoom = 1;
    refreshPanels(true);
    drawChart();
    drawEquity();
    saveState();
    if (!quiet) {
      toast((gap > 0 ? '时钟已回拨 ' : '时钟已前进 ') + fmtSpan(gap) +
        ' · 对齐到实时 ' + liveClock(live.quoteTs));
    } else {
      toast('已自动对齐实时 ' + liveClock(live.quoteTs));
    }
    return true;
  }

  /* 1× 时自动贴着真实时间跑：只在「明显偏离」时才动，避免和 60 秒一次的报价更新互相拉扯 */
  var lastAutoSync = 0;
  function maybeAutoSync() {
    if (state.speed !== 1 || !live.ok || !live.quoteTs) return;
    var now = performance.now();
    if (now - lastAutoSync < 4000) return;
    var fresh = (Date.now() - live.ts) < 180000;          // 报价两分钟内算新鲜
    if (!fresh) return;
    var gap = eng.clock - live.quoteTs;
    if (gap > 90000 || gap < -240000) {
      lastAutoSync = now;
      syncClock({ quiet: true });
    }
  }

  function applyLive(L) {
    if (!L || !(L.days || L.tape)) return false;
    // 太旧的 live.js 不用（比如本地留的旧快照），免得把几小时前的价格当成「现在」
    if (L.ts && (Date.now() / 1000 - L.ts) > 3 * 3600) {
      live.ok = false; live.ts = (L.ts || 0) * 1000;
      live.apiSource = 'live.js 已过期 ' + Math.round((Date.now() / 1000 - L.ts) / 3600) + ' 小时';
      return false;
    }
    var legs = eng.setLive(L);
    if (!legs) return false;
    live.ok = true;
    live.ts = (L.ts || 0) * 1000;
    live.quoteTs = (L.quoteTs || L.ts || 0) * 1000;
    live.src = L.src || 'live.js';
    live.legs = L.legs ? Object.keys(L.legs).length : 0;
    live.pairs = legs;
    live.days = L.days ? L.days.length : 1;
    live.apiSource = '';
    return true;
  }

  var liveTimer = null;
  function setSpeed(v) {
    state.speed = v;
    document.querySelectorAll('#speeds button').forEach(function (b) {
      var on = +b.dataset.sp === v;
      b.classList.toggle('on', on);
      if (+b.dataset.sp === 1) b.textContent = '实时';
    });
    var sl = $('statusLeft');
    if (sl) {
      sl.textContent = eng.positions.length + ' 持仓 · ' + eng.orders.length + ' 挂单 · ' +
        (v ? (v === 1 ? '实时' : v + '×') : '暂停');
    }
    renderLiveChip();
  }

  function loadLive() {
    var s = document.createElement('script');
    s.src = LIVE_URL + '?t=' + Date.now();
    s.onload = function () {
      s.remove();
      var first = !live.ok;
      if (applyLive(window.FX_LIVE)) {
        refreshPanels(true);
        if (first) {
          // 第一次拿到实时数据：一律切到 1× 并立刻对齐到最新真实报价
          if (state.speed !== 1) setSpeed(1);
          syncClock({ quiet: true });
          toast('已接入真实盘中报价（' + live.src + '）· 1× 实时，自动同步');
        }
      } else {
        live.ok = false; live.apiSource = window.FX_LIVE ? 'live.js 内容为空' : 'live.js 无数据';
        renderLiveChip();
      }
    };
    s.onerror = function () {
      s.remove();
      live.ok = false; live.apiSource = '取 ' + LIVE_URL + ' 失败';
      renderLiveChip();
    };
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------ 面板刷新 */
  var lastPanel = 0;
  var seenEvents = 0;
  function drainEvents() {
    // 把引擎里的「强平」「拒单」这类自己发生的事冒出来（成交/平仓不打扰，日志里都有）
    var evs = eng.events;
    if (seenEvents > evs.length) seenEvents = 0;
    for (var i = seenEvents; i < evs.length; i++) {
      var e = evs[i];
      if (e.kind === 'stopout') toast('⚠ 强制平仓：' + e.msg);
      else if (e.kind === 'reject') toast('下单被拒：' + e.msg);
    }
    seenEvents = evs.length;
  }
  function refreshPanels(force) {
    var now = performance.now();
    if (!force && now - lastPanel < 180) return;
    lastPanel = now;
    drainEvents();
    renderHeader();
    renderAccount();
    renderPositions();
    renderOrders();
    renderHistory();
    renderStats();
    renderStatus();
    renderCalc();
    renderSymPrices();
  }

  function renderSymPrices() {
    var rows = document.querySelectorAll('#symList .symrow');
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i], name = el.dataset.sym;
      if (!name) continue;
      var s = eng.sym[name], def = s.def;
      var px = el.querySelector('.px'), ch = el.querySelector('.chg'), sp = el.querySelector('.sp');
      if (px) px.textContent = fmtPx(s.mid, def.digits);
      var closes = def.closes, ref = closes[closes.length - 1];
      var chg = (s.mid / ref - 1) * 100;
      if (ch) { ch.textContent = fmtPct(chg); ch.className = 'chg ' + dirClass(chg); }
      if (sp) { sp.textContent = s.spreadPips.toFixed(1) + '点'; sp.className = 'sp' + (s.spreadPips > def.sp * 2.2 ? ' wide' : ''); }
    }
  }

  /* -----------------------------------------------------------------循环 */
  var lastFrame = performance.now();
  var acc = 0;
  function loop(ts) {
    var dt = Math.min(0.25, (ts - lastFrame) / 1000);
    lastFrame = ts;
    if (state.speed > 0) {
      var simSec = dt * state.speed;
      // 大倍速时切成小步，避免一次跳过太多价格采样点
      var maxStep = 15;
      var left = simSec;
      var guard = 0;
      while (left > 0.001 && guard++ < 60) {
        var step = Math.min(maxStep, left);
        eng.step(step);
        left -= step;
      }
    }
    drawChart();
    drawEquity();
    refreshPanels(false);
    maybeAutoSync();
    requestAnimationFrame(loop);
  }

  /* -----------------------------------------------------------------事件 */
  function bind() {
    $('symList').addEventListener('click', function (e) {
      var row = e.target.closest('.symrow');
      if (!row) return;
      state.sym = row.dataset.sym;
      state.offset = 0;
      document.querySelectorAll('.symrow').forEach(function (r) { r.classList.toggle('active', r.dataset.sym === state.sym); });
      refreshPanels(true);
    });

    $('tfs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tf]');
      if (!b) return;
      state.tf = b.dataset.tf;
      state.offset = 0;
      state.zoom = 1;
      document.querySelectorAll('#tfs button').forEach(function (x) { x.classList.toggle('on', x === b); });
    });

    $('speeds').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-sp]');
      if (!b) return;
      var v = +b.dataset.sp;
      setSpeed(v);
      if (v === 1) syncClock();     // 点「实时」= 贴回服务器最新报价
    });

    var chip = $('liveChip');
    if (chip) chip.addEventListener('click', function () { loadLive(); });

    $('levSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-lev]');
      if (!b) return;
      var lev = +b.dataset.lev;
      var a = eng.account();
      if (a.margin > 0 && a.equity / (a.margin * eng.leverage / lev) * 100 < 60) {
        return toast('杠杆降到 1:' + lev + ' 会让保证金比例跌破 60%，先减仓');
      }
      eng.leverage = lev;
      document.querySelectorAll('#levSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      refreshPanels(true);
    });

    $('lotsPreset').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-lots]');
      if (!b) return;
      $('lots').value = b.dataset.lots;
      document.querySelectorAll('#lotsPreset button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderCalc();
    });
    $('lotsUp').onclick = function () { $('lots').value = FX.roundLots(getLots() + 0.01).toFixed(2); renderCalc(); };
    $('lotsDown').onclick = function () { $('lots').value = Math.max(0.01, FX.roundLots(getLots() - 0.01)).toFixed(2); renderCalc(); };
    $('lots').oninput = renderCalc;
    $('slPips').oninput = renderCalc;
    $('tpPips').oninput = renderCalc;

    $('btnBuy').onclick = function () { trade(1); };
    $('btnSell').onclick = function () { trade(-1); };

    $('btnPlace').onclick = function () {
      var type = $('ordType').value;
      var s = eng.sym[state.sym], def = s.def;
      var px = parseFloat($('ordPrice').value);
      if (!isFinite(px) || px <= 0) {
        // 没填就按现价往外推 15 点预填
        px = +(state.sym ? (type === 'limit' ? s.bid - 15 * def.pip : s.ask + 15 * def.pip) : 0).toFixed(def.digits);
        $('ordPrice').value = px;
        return toast('已把价格填成 ' + fmtPx(px, def.digits) + '，再点一次「挂」');
      }
      var o = buildOrder();
      var side = px < s.mid ? 1 : -1;   // 挂单方向按价格位置推：低于现价＝买入
      if (type === 'stop') side = px > s.mid ? 1 : -1;
      var r = eng.order({ sym: state.sym, side: side, lots: o.lots, type: type, price: px, comment: 'pending' });
      if (!r.ok) return toast('挂单失败：' + r.err);
      toast('已挂 ' + (side > 0 ? '买' : '卖') + (type === 'limit' ? '限价' : '止损') + ' ' + o.lots + ' 手 @' + fmtPx(px, def.digits));
      refreshPanels(true);
    };

    $('btnCloseAll').onclick = function () {
      var n = eng.closeAll();
      toast(n ? '平掉 ' + n + ' 笔' : '没有持仓');
      refreshPanels(true);
    };
    $('btnCancelAll').onclick = function () {
      var n = eng.orders.length;
      eng.orders.slice().forEach(function (o) { eng.cancel(o.id); });
      toast(n ? '撤销 ' + n + ' 张挂单' : '没有挂单');
      refreshPanels(true);
    };

    document.addEventListener('click', function (e) {
      var c = e.target.closest('button[data-close]');
      if (c) {
        var r = eng.close(+c.dataset.close);
        if (!r.ok) toast(r.err); else toast('平仓 ' + fmtMoney(r.record.net, true));
        refreshPanels(true);
        return;
      }
      var hf = e.target.closest('button[data-half]');
      if (hf) {
        var tk = +hf.dataset.half;
        var pp = null;
        eng.positions.forEach(function (p) { if (p.ticket === tk) pp = p; });
        if (!pp) return;
        var r2 = eng.close(tk, pp.lots / 2);
        toast(r2.ok ? '平掉一半 · ' + fmtMoney(r2.record.net, true) : r2.err);
        refreshPanels(true);
        return;
      }
      var md = e.target.closest('button[data-mod]');
      if (md) {
        var ticket = +md.dataset.mod;
        var pos = null;
        eng.positions.forEach(function (p) { if (p.ticket === ticket) pos = p; });
        if (!pos) return;
        var dig = eng.sym[pos.sym].def.digits;
        var a1 = prompt(pos.sym + ' 止损价（留空＝取消止损）', pos.sl ? pos.sl.toFixed(dig) : '');
        if (a1 === null) return;
        var a2 = prompt(pos.sym + ' 止盈价（留空＝取消止盈）', pos.tp ? pos.tp.toFixed(dig) : '');
        if (a2 === null) return;
        var rm = eng.modify(ticket, a1 ? +a1 : 0, a2 ? +a2 : 0);
        toast(rm.ok ? '已改 ' + pos.sym + ' 止损/止盈' : rm.err);
        refreshPanels(true);
        return;
      }
      var x = e.target.closest('button[data-cancel]');
      if (x) { eng.cancel(+x.dataset.cancel); refreshPanels(true); return; }
    });

    $('btnCsv').onclick = function () {
      if (!eng.history.length) return toast('还没有成交记录');
      var csv = '\ufeff' + eng.statementCSV();
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'fx-fighter-statement-' + FX.isoUTC(eng.clock).replace(/[: ]/g, '-') + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('已导出 ' + eng.history.length + ' 笔成交记录');
    };

    // 图表交互
    var box = $('chartBox');
    box.addEventListener('mousemove', function (e) {
      var r = box.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.inside = true;
      if (panning && panStart) {
        var dx = e.clientX - panStart.x;
        var perBar = Math.max(2, (r.width - 72) / Math.max(20, Math.round(((r.width - 72) / 8) * state.zoom)));
        state.offset = Math.max(0, Math.min(4000, panStart.off + dx / perBar));
      }
    });
    box.addEventListener('mouseleave', function () { mouse.inside = false; panning = false; });
    box.addEventListener('mousedown', function (e) {
      panning = true; panStart = { x: e.clientX, off: state.offset };
    });
    window.addEventListener('mouseup', function () { panning = false; });
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY > 0 ? 1.15 : 0.87;
      state.zoom = Math.max(0.12, Math.min(9, state.zoom * f));
    }, { passive: false });
    box.addEventListener('dblclick', function () { state.zoom = 1; state.offset = 0; });

    $('btnColor').onclick = function () {
      state.colorMode = state.colorMode === 'cn' ? 'intl' : 'cn';
      $('btnColor').textContent = state.colorMode === 'cn' ? '红涨' : '绿涨';
      refreshPanels(true);
    };
    $('btnHelp').onclick = function () { $('help').hidden = false; };
    $('helpClose').onclick = function () { $('help').hidden = true; };
    $('help').addEventListener('click', function (e) { if (e.target === $('help')) $('help').hidden = true; });

    $('btnReset').onclick = function () {
      if (!confirm('清空账户、持仓、挂单、成交记录，回到 10 万本金。确定？')) return;
      localStorage.removeItem(LS_KEY);
      eng = new FX.Engine(world, { seed: 20261026, balance: 100000, leverage: 100 });
      state.speed = 60; state.zoom = 1; state.offset = 0;
      document.querySelectorAll('#speeds button').forEach(function (x) { x.classList.toggle('on', x.dataset.sp === '60'); });
      refreshPanels(true);
      toast('已重开账户');
    };

    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowUp') { e.preventDefault(); trade(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); trade(-1); }
      else if (e.key === ' ') { e.preventDefault(); $('btnCloseAll').click(); }
      else if (e.key === 'Escape') { $('btnCancelAll').click(); }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); syncClock(); }
    });

    window.addEventListener('beforeunload', saveState);
    setInterval(saveState, 4000);
    window.addEventListener('resize', function () { drawChart(); drawEquity(); });
  }

  /* ------------------------------------------------------------ 帮助面板 */
  function helpHTML() {
    var last = world.dates[world.n - 1];
    return [
      '<p>这是一台 <b>13 个货币对</b> 的外汇模拟终端：欧洲央行真实日线打底，',
      '配一套照零售券商写的撮合规则。下面把「哪些是真的、哪些是模型」一条条摊开写清楚。</p>',

      '<h4>一、数据哪部分是真的</h4>',
      '<ul>',
      '<li><b>每个交易日的收盘价是真的</b>：欧洲央行（ECB）欧元基准中间价，逐交易日，',
      '从 2022-01 到 <b>' + prettyDate(last) + '</b>，共 ' + world.n + ' 个交易日，随页面一起打包在 <code>rates.js</code> 里（抓取脚本 <code>tools/build_rates.py</code> 也在）。</li>',
      '<li><b>13 个品种全部由这张 EUR 基准表换算出来</b>：EURUSD 取 USD 那条，USDJPY = JPY÷USD，GBPUSD = USD÷GBP……',
      '交叉盘（EURJPY / EURGBP / EURCHF / GBPJPY / AUDJPY）不是独立乱走的，一律按两条美元腿相乘除，所以三角一致性是严格的 0 偏差。</li>',
      '<li><b>实时盘中也是真的（最近这几小时）</b>：服务器上有个常驻中继，每分钟抓一次真实汇率写进 <code>live.js</code>，',
      '页面顶栏的「● 实时」就是它。今天已经走过的每一分钟都会被换成真实报价，13 个品种按同一套三角公式由 8 条 EUR 基准腿折出来。',
      '中继没跑起来、或者进入深夜休市的时候，会显示「N 分钟前」或「离线」。</li>',
      '<li><b>更早的日内路径是模拟的</b>：中继上线之前的分钟、以及还没走到的未来，用布朗桥把当天挂在「昨天真实收盘 → 今天真实收盘」之间，',
      '波动率按品种、按 UTC 小时（东京 / 伦敦 / 纽约重叠时段最猛）加权，所以 <b>每天 23:59 的价格会精确落回真实收盘</b>，中间怎么走是模型生成的。</li>',
      '<li>真实数据用完之后（最后一个交易日之后），收盘价本身也转为模拟（按品种日波动率生成），底部状态栏会标「模拟日」。</li>',
      '<li><b>日线的历史高低点不是官方数据</b>：没有免费的历史逐日高低价，D1 那根蜡烛的开／收是真的，上下影线是按波动率估的，鼠标悬停会标出来。</li>',
      '</ul>',

      '<h4>二、撮合规则（这些是照着零售券商的做法写的）</h4>',
      '<table>',
      '<tr><th>项目</th><th>规则</th></tr>',
      '<tr><td>合约</td><td>1 手 = 100,000 基础货币，最小 0.01 手，步长 0.01</td></tr>',
      '<tr><td>报价</td><td>买价 = 中间价 + 点差/2，卖价 = 中间价 − 点差/2；点差随 <b>时段</b>、<b>波动</b>、<b>每日结算前后 20 分钟</b>变化（结算前后放大 3 倍以上）</td></tr>',
      '<tr><td>点值</td><td>1 点 = <code>pip × 手数 × 100,000 × 报价货币兑美元的汇率</code>。EURUSD 1 手 1 点 = $10；USDJPY 1 手 1 点 ≈ $6.4（随汇率浮动）</td></tr>',
      '<tr><td>佣金</td><td>$3.5 / 手 / 单边，开仓和平仓各收一次（往返 $7）</td></tr>',
      '<tr><td>滑点</td><td>市价单吃滑点：<b>点差 × 0.12 × (1 + (手数/深度)^0.75 × 1.8) × |N(0,1)|</b>，另有 2% 概率出现尾部大滑点；手数越大、品种越薄越狠。限价单不会比挂单价差，但跳空时按开盘价成交</td></tr>',
      '<tr><td>保证金</td><td>名义价值 ÷ 杠杆，杠杆 1:10 ~ 1:500，且受品种上限约束（USDCNY 只到 1:100）</td></tr>',
      '<tr><td>隔夜利息</td><td>按两种货币的政策利率差算：<code>名义价值 × ((r基础 − r报价) × 方向 − 0.25%) ÷ 365</code>，每天服务器 00:00 结算，<b>周三三倍</b></td></tr>',
      '<tr><td>追保／强平</td><td>保证金比例 &lt; 100% 提示追保；&lt; <b>50%</b> 强平浮亏最大的那一笔（按市价 + 2.2 倍滑点），直到比例回到 50% 以上</td></tr>',
      '<tr><td>休市</td><td>周五 21:00 UTC（北京周六 05:00）到周日 21:00 UTC（北京周一 05:00）之间不撮合；休市期间价格冻结、挂单不成交</td></tr>',
      '<tr><td>止损/止盈</td><td>距离必须大于「点差 + 2 点」，否则报 Invalid stops；止损按市价成交（会滑点），止盈按限价成交（不会更差）</td></tr>',
      '</table>',

      '<h4>三、没有模拟的东西（别把它当成真实成交）</h4>',
      '<ul>',
      '<li><b>新闻跳空</b>：非农、CPI、央行决议那一下的瞬间跳空没有单独建模，只有布朗桥自带的波动。</li>',
      '<li><b>流动性深度</b>：深度只是滑点公式里的一个常数，没有真正的盘口撮合，不会出现「单子太大打不动」的排队。</li>',
      '<li><b>隔夜利息</b>用政策利率近似，真实券商在利差上还会加浮动加点，数字会不一样。</li>',
      '<li><b>周末缺口</b>：周一开盘价是按模型生成的，不是真实跳空幅度。</li>',
      '<li><b>点值换算</b>用的是当前中间价，真实券商按结算价，会有几分钱的差别。</li>',
      '<li>所有成交都发生在你自己的浏览器里，<b>不联网、不接券商、不涉及任何真实资金</b>，也不是投资建议。</li>',
      '</ul>',

      '<h4>四、怎么玩</h4>',
      '<ul>',
      '<li>左边挑品种，中间选周期（M1 ~ D1），滚轮缩放、拖动平移、双击复位。</li>',
      '<li>右边填手数和杠杆，可以直接市价做多做空，也可以挂限价/止损单、设止损止盈（填「点」数）。</li>',
      '<li>键盘：<code>↑</code> 做多、<code>↓</code> 做空、<code>空格</code> 一键平仓、<code>Esc</code> 撤销全部挂单、<code>T</code> 同步时钟。</li>',
      '<li><b>时钟超前了怎么办</b>：进站默认就是行情速度里的 <b>实时</b>（1×），顶栏 <b>● 实时 HH:MM</b> 亮绿表示正贴着服务器最新报价，',
      '偏离超过 1.5 分钟会自动拉回来，不用管。点 10× 以上跑一阵，模拟时钟会甩到真实时间前面，那时候价格是模型生成的；',
      '随时点 <b>实时</b>（或按 <code>T</code>）就切回 1× 并对齐到最新真实报价，路径／K 线／净值曲线一起重算。</li>',
      '<li>顶栏调行情速度（1× = 实时，1800× = 1 秒走半小时），账户会自动存档在你的浏览器里。</li>',
      '</ul>'
    ].join('');
  }

  /* -----------------------------------------------------------------启动 */
  document.querySelectorAll('#speeds button').forEach(function (b) { b.classList.toggle('on', +b.dataset.sp === state.speed); });
  document.querySelectorAll('#tfs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tf === state.tf); });
  $('btnColor').textContent = state.colorMode === 'cn' ? '红涨' : '绿涨';
  $('helpBody').innerHTML = helpHTML();
  // 调试/自动化测试句柄（也方便你自己在控制台里看引擎状态）
  Object.defineProperty(window, 'FXAPP', {
    value: {
      get engine() { return eng; },
      world: world,
      state: state,
      refresh: function () { refreshPanels(true); },
      trade: trade,
      save: saveState,
      sync: syncClock,
      autoSync: maybeAutoSync
    },
    configurable: true
  });
  renderSymList();
  bind();
  refreshPanels(true);
  loadLive();
  setInterval(loadLive, 60000);
  // 后台标签页 rAF 会被节流，另开一条慢速兜底：回到前台 15 秒内一定对齐
  setInterval(function () { maybeAutoSync(); }, 15000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - live.ts > 45000) loadLive();
  });
  requestAnimationFrame(loop);
  if (restored) toast('已恢复上次的账户与进度');
})();




