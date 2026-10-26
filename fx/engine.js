/* =============================================================================
   FX Fighter · engine.js
   -----------------------------------------------------------------------------
   真实外汇模拟撮合引擎。纯逻辑、无 DOM，可在 node 里直接跑单元测试。

   价格从哪来（务必看清楚，别误会）：
     · 每一根「日线收盘价」都是真的 —— 欧洲央行 EUR 基准中间价（rates.js，
       经 api.frankfurter.dev 抓取，2022-01 至今，逐交易日）。
     · 日内路径是**布朗桥**：把当天挂在「昨日真实收盘 → 今日真实收盘」之间，
       按 1 分钟一格生成带真实波动率与会话节奏的桥。所以每天的收盘都会精确
       落回真实价，日内是模拟的。真实数据用完之后（最后一个交易日之后），
       收盘价本身也转为模拟，界面上会标「模拟」。
   -----------------------------------------------------------------------------
   券商级规则（都可在界面上核对）：
     · 1 手 = 100,000 基础货币，最小 0.01 手
     · 点差随「时段 / 波动 / 每日 21:00 UTC 结算前后」变化
     · 市价单吃滑点（下单量越大越狠）；限价单不会更差，但跳空按开盘价成交
     · 佣金 $3.5 / 手 / 单边；隔夜利息按利差算，周三三倍
     · 保证金 = 名义价值 ÷ 杠杆；保证金比例 < 100% 追保，< 50% 强平最亏的那一笔
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FX = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var DAY = 86400000;
  var SERVER_OFFSET = 3 * 3600000;   // 服务器时间 = UTC+3（主流零售券商惯例）
  var CONTRACT = 100000;             // 1 手基础货币单位
  var MIN_LOT = 0.01, LOT_STEP = 0.01, MAX_LOT = 100;
  var COMMISSION_PER_LOT = 3.5;      // 每手每单边
  var STOP_OUT = 50, MARGIN_CALL = 100;
  var SWAP_MARKUP = 0.0025;          // 券商在利差上再抽 0.25%（年化）

  /* ---------------------------------------------------------------- 随机数 */
  function RNG(seed) { this.s = (seed >>> 0) || 1; }
  RNG.prototype.next = function () {
    // mulberry32
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    var t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.gauss = function () {
    var u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  RNG.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; };

  /* ------------------------------------------------------------ 市场节奏表 */
  // 波动率时分曲线（UTC 小时）：东京开盘 0-3 起、伦敦 7-16、纽约 12-21 重叠处最高
  var SESSION_VOL = [0.58, 0.52, 0.52, 0.64, 0.76, 0.82, 0.88, 0.96,
                     1.02, 1.06, 1.08, 1.12, 1.28, 1.38, 1.42, 1.34,
                     1.22, 1.12, 1.00, 0.86, 0.76, 0.68, 0.62, 0.58];
  // 点差时分曲线（越大越贵）：流动性最差的凌晨与收盘后最宽
  var SESSION_SPREAD = [1.55, 1.62, 1.60, 1.45, 1.30, 1.18, 1.10, 1.02,
                        0.96, 0.92, 0.90, 0.88, 0.86, 0.86, 0.88, 0.92,
                        0.98, 1.06, 1.16, 1.30, 1.48, 1.62, 1.70, 1.62];

  /* -------------------------------------------------------------- 品种定义 */
  // f(E) = 用 EUR 基准表算出该货币对的即期价；sigma = 日波动率（小数）
  // sp = 基准点差（点）；depth = 深度（手），越大滑点越迟钝；lev = 该品种杠杆上限
  var SYM_DEFS = [
    { n: 'EURUSD', f: function (E) { return E.USD; },            pip: 0.0001, digits: 5, sigma: 0.0048, sp: 0.2, depth: 500, lev: 500 },
    { n: 'GBPUSD', f: function (E) { return E.USD / E.GBP; },    pip: 0.0001, digits: 5, sigma: 0.0058, sp: 0.5, depth: 260, lev: 500 },
    { n: 'USDJPY', f: function (E) { return E.JPY / E.USD; },    pip: 0.01,   digits: 3, sigma: 0.0055, sp: 0.3, depth: 420, lev: 500 },
    { n: 'USDCHF', f: function (E) { return E.CHF / E.USD; },    pip: 0.0001, digits: 5, sigma: 0.0050, sp: 0.6, depth: 220, lev: 400 },
    { n: 'USDCAD', f: function (E) { return E.CAD / E.USD; },    pip: 0.0001, digits: 5, sigma: 0.0042, sp: 0.7, depth: 220, lev: 400 },
    { n: 'AUDUSD', f: function (E) { return E.USD / E.AUD; },    pip: 0.0001, digits: 5, sigma: 0.0068, sp: 0.4, depth: 220, lev: 400 },
    { n: 'NZDUSD', f: function (E) { return E.USD / E.NZD; },    pip: 0.0001, digits: 5, sigma: 0.0072, sp: 0.7, depth: 130, lev: 300 },
    { n: 'EURJPY', f: function (E) { return E.JPY; },            pip: 0.01,   digits: 3, sigma: 0.0060, sp: 0.5, depth: 220, lev: 400 },
    { n: 'EURGBP', f: function (E) { return E.GBP; },            pip: 0.0001, digits: 5, sigma: 0.0040, sp: 0.6, depth: 220, lev: 400 },
    { n: 'EURCHF', f: function (E) { return E.CHF; },            pip: 0.0001, digits: 5, sigma: 0.0032, sp: 0.7, depth: 160, lev: 400 },
    { n: 'GBPJPY', f: function (E) { return E.JPY / E.GBP; },    pip: 0.01,   digits: 3, sigma: 0.0078, sp: 1.0, depth: 130, lev: 300 },
    { n: 'AUDJPY', f: function (E) { return E.JPY / E.AUD; },    pip: 0.01,   digits: 3, sigma: 0.0082, sp: 0.8, depth: 110, lev: 300 },
    { n: 'USDCNY', f: function (E) { return E.CNY / E.USD; },    pip: 0.0001, digits: 4, sigma: 0.0020, sp: 3.0, depth: 40,  lev: 100 }
  ];

  // 政策利率（年化，2026 年的近似值，用来算隔夜利息的利差）
  var POLICY_RATE = { USD: 0.0400, EUR: 0.0215, GBP: 0.0400, JPY: 0.0050, CHF: 0.0025, AUD: 0.0360, CAD: 0.0275, NZD: 0.0250, CNY: 0.0150 };

  /* 交叉盘不给独立的价格路径，一律由两条「美元腿」换算出来。
     理由：真实市场里 EURJPY 和 EURUSD×USDJPY 的差价只有零点几个点，套利会把它压平；
     各自独立乱走的话，点值换算和三角套利都会失真（能差出 1%）。 */
  var DERIVE = {
    EURJPY: ['EURUSD', 'USDJPY', 'mul'],
    EURGBP: ['EURUSD', 'GBPUSD', 'div'],
    EURCHF: ['EURUSD', 'USDCHF', 'mul'],
    GBPJPY: ['GBPUSD', 'USDJPY', 'mul'],
    AUDJPY: ['AUDUSD', 'USDJPY', 'mul']
  };

  /* -------------------------------------------------------------- 世界构建 */
  function buildWorld(real, opts) {
    opts = opts || {};
    if (!real || !real.dates) throw new Error('rates.js 未加载：缺少 window.FX_REAL_DATA');
    var ds = real.dates.split(',');
    var dayStartMs = new Array(ds.length), dates = new Array(ds.length);
    for (var i = 0; i < ds.length; i++) {
      var s = ds[i];
      var y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
      var t = Date.UTC(y, m, d);
      dayStartMs[i] = t;
      dates[i] = s;
    }
    var q = {};
    Object.keys(real.quotes).forEach(function (k) {
      q[k] = real.quotes[k].split(',').map(function (v) { return +v / 100000; });
    });
    var n = dayStartMs.length;
    var symbols = SYM_DEFS.map(function (def) {
      var base = def.n.slice(0, 3), quote = def.n.slice(3);
      var closes = new Array(n);
      for (var i = 0; i < n; i++) {
        var E = { EUR: 1 };
        for (var k in q) E[k] = q[k][i];
        var px = def.f(E);
        closes[i] = (px > 0 && isFinite(px)) ? px : null;
      }
      // 缺口兜底（某天缺报价）：向前填充
      for (var j = 1; j < n; j++) if (!closes[j]) closes[j] = closes[j - 1];
      for (var j2 = 0; j2 < n; j2++) if (!closes[j2]) closes[j2] = 1;
      return {
        name: def.n, base: base, quote: quote, pip: def.pip, digits: def.digits,
        sigma: def.sigma, sp: def.sp, depth: def.depth, lev: def.lev,
        contract: CONTRACT, closes: closes
      };
    });
    // 启动时刻：最后一个真实交易日 08:00 UTC（当天还有大半段真实收盘可以走到）
    var startMs = dayStartMs[n - 1] + 8 * 3600000;
    if (opts.startMs) startMs = opts.startMs;
    return {
      source: real.src || 'ECB',
      generated: real.generated,
      dates: dates, dayStartMs: dayStartMs, n: n,
      symbols: symbols, startMs: startMs,
      rateTable: POLICY_RATE
    };
  }

  /* ---------------------------------------------------------------- 工具 */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function roundLots(v) { return Math.round(clamp(v, MIN_LOT, MAX_LOT) / LOT_STEP) * LOT_STEP; }
  function roundTo(v, digits) { var m = Math.pow(10, digits); return Math.round(v * m) / m; }

  /* ============================================================== Engine */
  function Engine(world, opts) {
    opts = opts || {};
    this.world = world;
    this.seed0 = opts.seed == null ? 20261026 : opts.seed;
    this.rng = new RNG(this.seed0);
    this.leverage = opts.leverage || 100;
    this.balance = opts.balance == null ? 100000 : opts.balance;
    this.startBalance = this.balance;
    this.clock = world.startMs;
    this.speed = opts.speed == null ? 60 : opts.speed;
    this.paused = false;

    this.nextTicket = 100001;
    this.nextOrderId = 500001;
    this.positions = [];      // 持仓（对冲模式：一笔一张单）
    this.orders = [];         // 挂单
    this.history = [];        // 已平仓记录
    this.equityCurve = [];    // [{t, eq}]
    this.diag = {
      slipPips: 0, slipSum: 0, slipCount: 0, maxSlip: 0,
      fills: 0, rejects: 0, stopOuts: 0, swaps: 0, commission: 0, rollovers: 0
    };
    this.lastEquityPush = 0;
    this.lastServerDay = null;
    this.marketWasOpen = null;
    this.events = [];         // 最近的市场事件（回执）

    var self = this;
    this.sym = {};
    world.symbols.forEach(function (s) {
      self.sym[s.name] = {
        def: s, mid: 0, bid: 0, ask: 0, spreadPips: s.sp, dayIdx: -1,
        path: null, pathIdx: -1, ext: {}, bars: {}, lastBarT: {}, pxHistory: {}
      };
    });
    this._extCache = {};
    this.clock = world.startMs;
    var idx0 = this._dayIdx(this.clock);
    world.symbols.forEach(function (s) {
      var st = self.sym[s.name];
      st.dayIdx = idx0;
      self._refreshQuote(st);
    });
    this._seedBars(2);
    Object.keys(this.sym).forEach(function (k) { self._pushEquity(0); });
    this.lastServerDay = this._serverDay(this.clock);
    this.marketWasOpen = this.marketOpen(this.clock);
  }

  Engine.prototype._serverDay = function (ms) { return Math.floor((ms + SERVER_OFFSET) / DAY); };

  Engine.prototype._dayIdx = function (ms) {
    var dayStart = Math.floor(ms / DAY) * DAY;
    var arr = this.world.dayStartMs;
    if (dayStart <= arr[0]) return 0;
    if (dayStart >= arr[arr.length - 1]) {
      return this.world.n - 1 + Math.round((dayStart - arr[arr.length - 1]) / DAY);
    }
    var lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= dayStart) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  Engine.prototype._dayStartForIdx = function (idx) {
    if (idx < this.world.n) return this.world.dayStartMs[idx];
    return this.world.dayStartMs[this.world.n - 1] + DAY * (idx - (this.world.n - 1));
  };

  Engine.prototype._isReal = function (idx) { return idx < this.world.n; };

  Engine.prototype._closeAt = function (name, idx) {
    var w = this.world;
    var def = this.sym[name].def;
    if (DERIVE[name]) {
      var d = DERIVE[name];
      var a = this._closeAt(d[0], idx), b = this._closeAt(d[1], idx);
      return d[2] === 'div' ? a / b : a * b;
    }
    if (idx < 0) return def.closes[0];
    if (idx < w.n) return def.closes[idx];
    var key = name + '#' + idx;
    if (this._extCache[key] != null) return this._extCache[key];
    var prev = this._closeAt(name, idx - 1);
    var dstart = this._dayStartForIdx(idx);
    var dow = new Date(dstart).getUTCDay();
    var c;
    if (dow === 6) {
      c = prev;                            // 周六外汇市场完全不动
    } else {
      // 周日 UTC 21:00 开盘，只剩三个小时，波动按比例缩小到 0.35 倍
      var scale = dow === 0 ? 0.35 : 0.92;
      var rng = new RNG(this._seedFor(name, 900000 + idx));
      var drift = 0.000015 * (rng.next() - 0.5);  // 极小的随机漂移
      c = prev * Math.exp(def.sigma * rng.gauss() * scale + drift);
    }
    this._extCache[key] = c;
    return c;
  };

  /* 生成某天的布朗桥路径（1 分钟一格，端点精确落在两个收盘价上） */
  /* 每条价格路径都用自己的随机源：种子 = 基础种子 ⊕ 品种 ⊕ 交易日。
     这样「第 N 天的路径」是时间的纯函数 —— 反复回到同一天看到的还是同一条路，
     跟用户先看哪个品种、按什么顺序刷新都无关。 */
  Engine.prototype._seedFor = function (name, idx) {
    var h = 2166136261 >>> 0, s = name + '#' + idx;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return (h ^ Math.imul(this.seed0 | 0, 2654435761)) >>> 0;
  };

  Engine.prototype._path = function (name, idx) {
    var st = this.sym[name];
    if (st.pathIdx === idx && st.path) return st.path;
    var def = st.def;
    var y0 = this._closeAt(name, idx - 1);
    var y1 = this._closeAt(name, idx);
    var M = 1440;
    var path = new Float64Array(M + 1);
    var dstart = this._dayStartForIdx(idx);
    var dow = new Date(dstart).getUTCDay();
    var weekend = (dow === 6);
    if (weekend || !(y0 > 0) || !(y1 > 0)) {
      var flat = weekend ? y0 : y1;
      for (var f = 0; f <= M; f++) path[f] = flat;
      st.path = path; st.pathIdx = idx;
      return path;
    }
    var rng = new RNG(this._seedFor(name, idx));
    var sigmaDay = def.sigma;
    var dt = 1 / M;
    var cums = new Float64Array(M + 1);
    var acc = 0;
    for (var i = 0; i < M; i++) {
      var hour = new Date(dstart + i * 60000).getUTCHours();
      acc += sigmaDay * Math.sqrt(dt) * SESSION_VOL[hour] * rng.gauss();
      cums[i + 1] = acc;
    }
    var total = cums[M];
    var l0 = Math.log(y0), l1 = Math.log(y1);
    for (var j = 0; j <= M; j++) {
      var bridge = cums[j] - (j / M) * total;   // 布朗桥：两端归零
      path[j] = Math.exp(l0 + (l1 - l0) * (j / M) + bridge);
    }
    path[0] = y0; path[M] = y1;
    // 周日只在 UTC 21:00 之后交易：开盘前价格不动，开盘后走一小段
    if (dow === 0) {
      var open0 = 21 * 60;
      var base = path[open0], span = y1 - base, raw = path[M] - base;
      for (var s = 0; s < open0; s++) path[s] = y0;
      for (var s2 = open0; s2 <= M; s2++) {
        var k2 = raw !== 0 ? (path[s2] - base) / raw : 0;
        path[s2] = base + span * k2;
      }
      path[open0] = y0; path[M] = y1;
    }
    path = this._applyLive(name, idx, path, dstart);
    st.path = path; st.pathIdx = idx;
    return path;
  };

  /* ------------------------------------------------- 真实 tick 覆盖（实时层）
     live.js 由服务器上的中继每分钟抓一次真实汇率写出来，形如
       { ts, quoteTs, legs:{USD:1.12,...}, tape:{USD:"1793012340:1.11941,..."} }
     tape 里是「当天 UTC 00:00 起」的真实报价。这里把当天已经走完的分钟
     直接换成真实价：覆盖区间用真实值线性插值，覆盖区之前/之后沿用原来的
     布朗桥形状、只做对数平移把它们焊上去 —— 于是图表上今天的行情是真的，
     收盘价仍然会收到 ECB 公布的日线上。 */
  Engine.prototype._applyLive = function (name, idx, path, dstart) {
    var byDay = this.liveTape && this.liveTape[name];
    var tape = byDay && byDay.days && byDay.days[dstart];
    if (!tape || !tape.length) return path;
    var M = 1440, ticks = tape;
    var real = new Float64Array(M + 1), have = new Uint8Array(M + 1);
    for (var i = 0; i < ticks.length; i++) {
      var px = ticks[i][1];
      if (!(px > 0)) continue;
      var mi = Math.floor((ticks[i][0] * 1000 - dstart) / 60000);
      if (mi < 0) mi = 0;
      if (mi > M) mi = M;
      real[mi] = px; have[mi] = 1;
    }
    var first = -1, last = -1;
    for (var m = 0; m <= M; m++) if (have[m]) { if (first < 0) first = m; last = m; }
    if (first < 0) return path;

    // 真实值之间补点
    var prev = first;
    for (var k = first + 1; k <= last; k++) {
      if (have[k]) { prev = k; continue; }
      var nx = k;
      while (nx <= last && !have[nx]) nx++;
      var a = real[prev], b = have[nx] ? real[nx] : a;
      real[k] = a + (b - a) * ((nx > prev) ? (k - prev) / (nx - prev) : 0);
      have[k] = 2;
    }
    tape.covered = [first, last];

    // 覆盖前先记下合成路径在这两个点上的值（后面要拿它们做对数平移的基准）
    var pFirstSynth = path[first], pLastSynth = path[last];
    // 覆盖区之前：把合成形状的「偏离直线」保留，直线两端改成 昨收 → 第一个真实价
    var y0 = path[0], rFirst = real[first];
    if (first > 0 && y0 > 0 && pFirstSynth > 0 && rFirst > 0) {
      var l0 = Math.log(y0), l1 = Math.log(rFirst), lb = Math.log(pFirstSynth);
      for (var j = 1; j < first; j++) {
        var u = j / first;
        var lineOld = l0 + (lb - l0) * u;
        var lineNew = l0 + (l1 - l0) * u;
        path[j] = Math.exp(Math.log(path[j]) - lineOld + lineNew);
      }
    }
    // 覆盖区：真实值
    for (var k2 = first; k2 <= last; k2++) path[k2] = real[k2];
    // 覆盖区之后：从最后一个真实价出发，沿用合成形状走到当天的合成收盘
    if (last < M && real[last] > 0 && pLastSynth > 0) {
      var off = Math.log(real[last]) - Math.log(pLastSynth);
      for (var k3 = last + 1; k3 <= M; k3++) path[k3] = Math.exp(Math.log(path[k3]) + off);
    }
    path[last] = real[last];
    return path;
  };

  /* 把一份 live.js 灌进引擎：清掉路径缓存、重建首页那几根 K 线，再刷新报价。
     live.js 里的 tape 是按【EUR 基准的腿】存的（USD / JPY / GBP / …），
     这里按每个货币对自己的换算公式（SYM_DEFS[i].f）把腿价拼成该品种的真实价序列，
     所以交叉盘的三角一致性跟 rates.js 那条路完全一样。 */
  Engine.prototype.setLive = function (live) {
    if (!live) return 0;
    var self = this;
    // 兼容两种格式：新的 live.days=[{d:<UTC 零点秒>, tape:{腿:"ts:价,..."}}]，旧的 live.tape
    var days = live.days;
    if (!days && live.tape) {
      days = [{ d: Math.floor((live.ts || Date.now() / 1000) / 86400) * 86400, tape: live.tape }];
    }
    if (!days || !days.length) return 0;

    var liveTape = {}, legNames = {}, applied = 0;
    this.liveDiag = { days: days.length, legs: 0, ticks: 0, pairs: 0, reason: 'start' };
    days.forEach(function (day) {
      var dstartMs = day.d * 1000;
      var legMap = {}, stamps = {}, legs = 0;
      Object.keys(day.tape || {}).forEach(function (leg) {
        var m = {};
        String(day.tape[leg] || '').split(',').forEach(function (pair) {
          var c = pair.split(':');
          if (c.length < 2) return;
          var ts = +c[0], px = +c[1];
          if (ts > 0 && px > 0) { m[ts] = px; stamps[ts] = 1; }
        });
        if (Object.keys(m).length >= 2) { legMap[leg] = m; legs++; legNames[leg] = 1; }
      });
      if (!legs) { self.liveDiag.reason = 'no legs with 2+ ticks'; return; }
      var allTs = Object.keys(stamps).map(Number).sort(function (a, b) { return a - b; });
      var names = Object.keys(legMap);
      var series = {};
      self.world.symbols.forEach(function (s) { series[s.name] = []; });
      for (var i = 0; i < allTs.length; i++) {
        var ts = allTs[i], E = { EUR: 1 }, ok = true;
        for (var j = 0; j < names.length; j++) {
          var v = legMap[names[j]][ts];
          if (!v) { ok = false; break; }
          E[names[j]] = v;
        }
        if (!ok) continue;
        for (var k = 0; k < SYM_DEFS.length; k++) {
          var px = SYM_DEFS[k].f(E);
          if (px > 0 && isFinite(px)) series[SYM_DEFS[k].n].push([ts, px]);
        }
      }
      Object.keys(series).forEach(function (name) {
        if (series[name].length < 2) return;
        var e = liveTape[name] || (liveTape[name] = { days: {} });
        e.days[dstartMs] = series[name];
        applied++;
      });
    });
    this.liveDiag.legs = Object.keys(legNames).length;
    this.liveDiag.pairs = applied;
    if (!applied) { this.liveDiag.reason = 'no pair series'; return 0; }
    this.liveDiag.reason = 'ok';

    this.liveTape = liveTape;
    this.liveMeta = {
      ts: (live.ts || 0) * 1000, quoteTs: (live.quoteTs || live.ts || 0) * 1000,
      src: live.src || 'live', legs: Object.keys(legNames), pairs: applied,
      days: Object.keys(days).length
    };
    Object.keys(this.sym).forEach(function (n) { self.sym[n].pathIdx = -1; });
    // 第一次拿到实时数据：把模拟时钟直接搬到最后一个真实 tick 上
    // （内置日线只到上一个交易日，不搬的话还停在几天前的 08:00，看不到真实盘中）
    if (!this._liveJumped) {
      var lastTs = 0;
      Object.keys(this.liveTape).forEach(function (k) {
        var dd = self.liveTape[k].days;
        Object.keys(dd).forEach(function (d) {
          var t = dd[d];
          if (t.length && t[t.length - 1][0] > lastTs) lastTs = t[t.length - 1][0];
        });
      });
      if (lastTs * 1000 > this.clock + 60000) {
        this.clock = lastTs * 1000;
        this.lastEquityPush = 0;
        this._liveJumped = true;
        this.liveJumped = true;
      }
    }
    this._seedBars(2);                 // 用真实 tick 重建今天这一段分钟线
    Object.keys(this.sym).forEach(function (n) { self._refreshQuoteAt(self.sym[n], self.clock); });
    return applied;
  };

  Engine.prototype.marketOpen = function (ms) {
    var d = new Date(ms);
    var dow = d.getUTCDay(), h = d.getUTCHours();
    if (dow === 6) return false;
    if (dow === 0 && h < 21) return false;
    if (dow === 5 && h >= 21) return false;
    return true;
  };

  Engine.prototype._spreadFor = function (def, ms) {
    var h = new Date(ms).getUTCHours();
    var f = SESSION_SPREAD[h];
    // 每日结算（服务器 00:00 = UTC 21:00）前后 20 分钟点差放大
    var m = new Date(ms).getUTCMinutes() + h * 60;
    var minsToRoll = (21 * 60 - m + 1440) % 1440;
    if (minsToRoll <= 20) f *= 3.2;
    // 周末开盘第一小时更宽
    var d = new Date(ms);
    if (d.getUTCDay() === 0 && d.getUTCHours() === 21) f *= 2.0;
    return def.sp * f;
  };

  Engine.prototype._refreshQuote = function (st) {
    var def = st.def;
    var mid = this._priceAt(def.name, this.clock);
    st.mid = mid;
    st.spreadPips = this._spreadFor(def, this.clock);
    var half = st.spreadPips * def.pip / 2;
    st.bid = roundTo(mid - half, def.digits + 1);
    st.ask = roundTo(mid + half, def.digits + 1);
    this._updateBars(st);
  };

  Engine.prototype._priceAt = function (name, ms) {
    var d = DERIVE[name];
    if (d) {
      var a = this._priceAt(d[0], ms), b = this._priceAt(d[1], ms);
      return d[2] === 'div' ? a / b : a * b;
    }
    var st = this.sym[name];
    var idx = this._dayIdx(ms);
    var p = this._path(name, idx);
    var dstart = this._dayStartForIdx(idx);
    var f = clamp((ms - dstart) / DAY, 0, 1);
    var pos = f * 1440;
    var i = Math.floor(pos), t = pos - i;
    var a = p[i], b = p[Math.min(1440, i + 1)];
    return a + (b - a) * t;
  };

  /* --------------------------------------------------------------- K 线 */
  var TFS = [
    { k: 'M1', ms: 60000 }, { k: 'M5', ms: 300000 }, { k: 'M15', ms: 900000 },
    { k: 'H1', ms: 3600000 }, { k: 'H4', ms: 14400000 }, { k: 'D1', ms: DAY }
  ];

  Engine.prototype._updateBars = function (st) {
    var name = st.def.name, def = st.def;
    // 休市（周六、周日 UTC 21:00 前、周五 UTC 21:00 后）不开新 K 线：
    // 否则图上会拉出一长条价位不动、看着像「空白」的死区
    var open = this._tradable(this.clock);
    for (var i = 0; i < TFS.length; i++) {
      var tf = TFS[i];
      var key = name + tf.k;
      var bucket = Math.floor(this.clock / tf.ms) * tf.ms;
      var arr = st.bars[key];
      if (!arr) { arr = st.bars[key] = []; }
      var last = arr[arr.length - 1];
      if (!last || last.t < bucket) {
        if (!open) continue;
        arr.push({ t: bucket, o: st.mid, h: st.mid, l: st.mid, c: st.mid });
        if (arr.length > 1400) arr.splice(0, arr.length - 1400);
      } else {
        if (st.mid > last.h) last.h = st.mid;
        if (st.mid < last.l) last.l = st.mid;
        last.c = st.mid;
      }
    }
  };

  /* 这个时刻市场在不在撮合（周末 / 周五收盘后不交易） */
  Engine.prototype._tradable = function (ms) {
    var d = new Date(ms);
    var dow = d.getUTCDay(), h = d.getUTCHours();
    if (dow === 6) return false;
    if (dow === 0 && h < 21) return false;
    if (dow === 5 && h >= 21) return false;
    return true;
  };

  /* 某天第 mi 分钟的成交价（交叉盘按美元腿现算） */
  Engine.prototype._minutePrice = function (name, idx, mi) {
    var d = DERIVE[name];
    if (d) {
      var a = this._path(d[0], idx)[mi], b = this._path(d[1], idx)[mi];
      return d[2] === 'div' ? a / b : a * b;
    }
    return this._path(name, idx)[mi];
  };

  /* 预热历史：把启动前 N 天按同一套路径模型回放成分钟线，图表一打开就有东西看 */
  Engine.prototype._seedBars = function (days) {
    var self = this;
    var startIdx = this._dayIdx(this.clock);
    var from = Math.max(1, startIdx - (days || 2));
    var savedClock = this.clock;
    Object.keys(this.sym).forEach(function (name) {
      var st = self.sym[name];
      st.bars = {};                       // 重建：先清空，保证时间顺序递增
      var todayHi = -Infinity, todayLo = Infinity;
      for (var idx = from; idx <= startIdx; idx++) {
        var dstart = self._dayStartForIdx(idx);
        var endMin = idx === startIdx ? Math.floor(((savedClock - dstart) / DAY) * 1440) : 1440;
        for (var mi = 0; mi <= endMin; mi++) {
          var t = dstart + mi * 60000;
          // 休市分钟不生成 K 线：图上就没有「价位不动」的假空白
          if (!self._tradable(t)) continue;
          var px = self._minutePrice(name, idx, mi);
          if (idx === startIdx) { if (px > todayHi) todayHi = px; if (px < todayLo) todayLo = px; }
          for (var i = 0; i < TFS.length; i++) {
            var tf = TFS[i];
            if (tf.k === 'D1') continue;          // 日线单独按真实收盘合成
            var key = name + tf.k;
            var bucket = Math.floor(t / tf.ms) * tf.ms;
            var arr = st.bars[key] || (st.bars[key] = []);
            var last = arr[arr.length - 1];
            if (!last || last.t < bucket) {
              arr.push({ t: bucket, o: px, h: px, l: px, c: px });
              if (arr.length > 1400) arr.shift();
            } else {
              if (px > last.h) last.h = px;
              if (px < last.l) last.l = px;
              last.c = px;
            }
          }
        }
      }
      /* D1：历史日线的「开盘＝上一个交易日真实收盘、收盘＝真实收盘」都是真的；
         最高/最低没有免费的历史逐日高低数据，这里按该品种的日波动率给一个估出来的
         影线（视觉上看得出来那天有多闹，但不是官方高低价）。今天那根用实际路径。 */
      var daily = [];
      var dFrom = Math.max(1, startIdx - 180);
      for (var di = dFrom; di <= startIdx - 1; di++) {
        var dowD = new Date(self._dayStartForIdx(di)).getUTCDay();
        if (dowD === 6) continue;     // 周六没有日线（周日 21:00 开盘，占一小段有日线）
        var o = self._closeAt(name, di - 1), c = self._closeAt(name, di);
        var wy = Math.abs(new RNG(self._seedFor(name, 700000 + di)).gauss()) * 0.55 + 0.2;
        var hi = Math.max(o, c) * (1 + st.def.sigma * wy * 0.45);
        var lo = Math.min(o, c) * (1 - st.def.sigma * wy * 0.45);
        daily.push({ t: self._dayStartForIdx(di), o: o, h: hi, l: lo, c: c, est: true });
      }
      if (isFinite(todayHi) && isFinite(todayLo)) {
        daily.push({
          t: self._dayStartForIdx(startIdx), o: self._closeAt(name, startIdx - 1),
          h: todayHi, l: todayLo, c: st.mid || self._closeAt(name, startIdx - 1)
        });
      }
      st.bars[name + 'D1'] = daily.slice(-400);
    });
    // 报价统一在第二遍刷新：这样交叉盘拿到的一定是两条美元腿的最终价
    Object.keys(this.sym).forEach(function (name) {
      var st = self.sym[name];
      self._refreshQuoteAt(st, savedClock);
      self._updateBars(st);              // 补上「此刻」那一根
    });
    this.clock = savedClock;
  };

  Engine.prototype._refreshQuoteAt = function (st, ms) {
    var def = st.def;
    var mid = this._priceAt(def.name, ms);
    st.mid = mid;
    st.spreadPips = this._spreadFor(def, ms);
    var half = st.spreadPips * def.pip / 2;
    st.bid = roundTo(mid - half, def.digits + 1);
    st.ask = roundTo(mid + half, def.digits + 1);
  };

  /* ------------------------------------------------------------ 汇率换算 */
  Engine.prototype.eurMap = function () {
    var p = function (n) { return this.sym[n].mid; }.bind(this);
    var usd = p('EURUSD');
    return {
      EUR: 1, USD: usd, JPY: p('EURJPY'), GBP: p('EURGBP'), CHF: p('EURCHF'),
      AUD: usd / p('AUDUSD'), CAD: usd * p('USDCAD'), NZD: usd / p('NZDUSD'),
      CNY: usd * p('USDCNY')
    };
  };
  Engine.prototype.usdPerQuote = function (quoteCur) {
    if (quoteCur === 'USD') return 1;
    var E = this.eurMap();
    return E.USD / E[quoteCur];
  };
  Engine.prototype.usdPerBase = function (symName) {
    var st = this.sym[symName];
    return st.mid * this.usdPerQuote(st.def.quote);
  };
  Engine.prototype.pipValueUSD = function (symName, lots) {
    var st = this.sym[symName];
    return st.def.pip * lots * CONTRACT * this.usdPerQuote(st.def.quote);
  };

  /* -------------------------------------------------------------- 权益 */
  Engine.prototype.floating = function () {
    var self = this, sum = 0;
    this.positions.forEach(function (p) { sum += self._posPL(p, self._exitPrice(p)); });
    return sum;
  };
  Engine.prototype.equity = function () { return this.balance + this.floating(); };

  Engine.prototype.marginUsed = function () {
    var self = this, sum = 0;
    this.positions.forEach(function (p) {
      var st = self.sym[p.sym];
      var notional = p.lots * CONTRACT * self.usdPerBase(p.sym);
      var lev = Math.min(self.leverage, st.def.lev);
      sum += notional / lev;
    });
    return sum;
  };

  Engine.prototype.account = function () {
    var eq = this.equity(), mar = this.marginUsed();
    return {
      balance: this.balance, equity: eq, margin: mar,
      free: eq - mar, level: mar > 0 ? eq / mar * 100 : 0,
      floating: this.floating(), leverage: this.leverage
    };
  };

  Engine.prototype._exitPrice = function (pos) {
    var st = this.sym[pos.sym];
    return pos.side > 0 ? st.bid : st.ask;
  };

  Engine.prototype._posPL = function (pos, px) {
    var st = this.sym[pos.sym];
    var quotePL = (px - pos.openPx) * pos.side * pos.lots * CONTRACT;
    return quotePL * this.usdPerQuote(st.def.quote);
  };

  /* -------------------------------------------------------------- 滑点 */
  Engine.prototype._slippagePips = function (st, lots) {
    var def = st.def;
    var sizeRatio = lots / def.depth;
    var base = st.spreadPips * 0.12 * (1 + Math.pow(sizeRatio, 0.75) * 1.8);
    var noise = Math.abs(this.rng.gauss());
    var tail = this.rng.next() < 0.02 ? this.rng.next() * st.spreadPips * 4 : 0;
    return base * noise + tail;
  };

  /* -------------------------------------------------------------- 下单 */
  Engine.prototype._log = function (kind, msg, extra) {
    this.events.push({ t: this.clock, kind: kind, msg: msg, extra: extra || null });
    if (this.events.length > 60) this.events.shift();
  };

  Engine.prototype.order = function (req) {
    var self = this;
    var st = this.sym[req.sym];
    if (!st) return { ok: false, err: '未知品种' };
    if (!this.marketOpen(this.clock)) return { ok: false, err: '休市中（周末/收盘）' };
    var lots = roundLots(req.lots);
    if (!(lots >= MIN_LOT)) return { ok: false, err: '手数太小' };
    var side = req.side > 0 ? 1 : -1;
    var type = req.type || 'market';
    var def = st.def;

    if (type === 'market') {
      var price = side > 0 ? st.ask : st.bid;
      var slip = this._slippagePips(st, lots);
      price = side > 0 ? price + slip * def.pip : price - slip * def.pip;
      price = roundTo(price, def.digits);
      this.diag.slipSum += slip; this.diag.slipCount++;
      this.diag.maxSlip = Math.max(this.diag.maxSlip, slip);
      this.diag.slipPips = slip;
      var res = this._openPosition({ sym: req.sym, side: side, lots: lots, price: price, sl: req.sl, tp: req.tp, comment: req.comment || 'market' });
      if (!res.ok) { this.diag.rejects++; this._log('reject', res.err); }
      return res;
    }

    // 挂单：限价 / 止损
    if (!(req.price > 0)) return { ok: false, err: '缺少挂单价' };
    var px = roundTo(req.price, def.digits);
    if (type === 'limit') {
      if (side > 0 && px >= st.ask) return { ok: false, err: '买单限价应低于现价' };
      if (side < 0 && px <= st.bid) return { ok: false, err: '卖单限价应高于现价' };
    } else if (type === 'stop') {
      if (side > 0 && px <= st.ask) return { ok: false, err: '买单止损价应高于现价' };
      if (side < 0 && px >= st.bid) return { ok: false, err: '卖单止损价应低于现价' };
    } else return { ok: false, err: '未知挂单类型' };

    var chk = this._checkStops(side, px, req.sl, req.tp, st);
    if (!chk.ok) return chk;

    var o = {
      id: this.nextOrderId++, sym: req.sym, side: side, lots: lots, price: px,
      type: type, sl: req.sl || 0, tp: req.tp || 0, t: this.clock, status: 'live'
    };
    this.orders.push(o);
    this._log('order', (side > 0 ? '买入' : '卖出') + (type === 'limit' ? '限价' : '止损') + '挂单 ' + req.sym + ' ' + lots + '手 @' + px);
    return { ok: true, order: o };
  };

  Engine.prototype._checkStops = function (side, refPrice, sl, tp, st) {
    var minDist = st.spreadPips * st.def.pip + 2 * st.def.pip;
    if (sl) {
      if (side > 0 && !(sl < refPrice - minDist)) return { ok: false, err: '止损价太近或方向错（多方止损须低于开仓价）' };
      if (side < 0 && !(sl > refPrice + minDist)) return { ok: false, err: '止损价太近或方向错（空方止损须高于开仓价）' };
    }
    if (tp) {
      if (side > 0 && !(tp > refPrice + minDist)) return { ok: false, err: '止盈价太近或方向错' };
      if (side < 0 && !(tp < refPrice - minDist)) return { ok: false, err: '止盈价太近或方向错' };
    }
    return { ok: true };
  };

  Engine.prototype._openPosition = function (o) {
    var st = this.sym[o.sym];
    var notional = o.lots * CONTRACT * this.usdPerBase(o.sym);
    var lev = Math.min(this.leverage, st.def.lev);
    var need = notional / lev;
    var acc = this.account();
    if (need > acc.free) return { ok: false, err: '可用保证金不足（需要 $' + Math.round(need) + '，可用 $' + Math.round(acc.free) + '）' };
    var comm = o.lots * COMMISSION_PER_LOT;
    var pos = {
      ticket: this.nextTicket++, sym: o.sym, side: o.side, lots: o.lots,
      openPx: o.price, openT: this.clock, sl: o.sl || 0, tp: o.tp || 0,
      swap: 0, comm: comm, comment: o.comment || ''
    };
    this.balance -= comm;
    this.diag.commission += comm;
    this.positions.push(pos);
    this.diag.fills++;
    this._log('fill', (pos.side > 0 ? '买入' : '卖出') + ' ' + pos.sym + ' ' + pos.lots + '手 @' + pos.openPx);
    return { ok: true, position: pos };
  };

  Engine.prototype.modify = function (ticket, sl, tp) {
    if (!this.marketOpen(this.clock)) return { ok: false, err: '休市中，改不了止损止盈' };
    var pos = null;
    for (var i = 0; i < this.positions.length; i++) if (this.positions[i].ticket === ticket) pos = this.positions[i];
    if (!pos) return { ok: false, err: '没有这张持仓' };
    var st = this.sym[pos.sym];
    var ref = pos.side > 0 ? st.bid : st.ask;
    if (sl || tp) {
      var chk = this._checkStops(pos.side, ref, sl, tp, st);
      if (!chk.ok) return chk;
    }
    if (sl != null) pos.sl = sl || 0;
    if (tp != null) pos.tp = tp || 0;
    return { ok: true, position: pos };
  };

  Engine.prototype.cancel = function (orderId) {
    for (var i = 0; i < this.orders.length; i++) {
      if (this.orders[i].id === orderId) {
        var o = this.orders.splice(i, 1)[0];
        this._log('cancel', '撤单 ' + o.sym + ' #' + o.id);
        return { ok: true };
      }
    }
    return { ok: false, err: '没有这张挂单' };
  };

  Engine.prototype.close = function (ticket, lots) {
    if (!this.marketOpen(this.clock)) return { ok: false, err: '休市中，无法平仓' };
    var self = this;
    var idx = -1;
    for (var i = 0; i < this.positions.length; i++) if (this.positions[i].ticket === ticket) idx = i;
    if (idx < 0) return { ok: false, err: '没有这张持仓' };
    var pos = this.positions[idx];
    var st = this.sym[pos.sym];
    var closLots = lots ? Math.min(roundLots(lots), pos.lots) : pos.lots;
    if (closLots < pos.lots && pos.lots - closLots < MIN_LOT) closLots = pos.lots; // 残量过小就整平
    var slip = this._slippagePips(st, closLots);
    var px = pos.side > 0 ? st.bid - slip * st.def.pip : st.ask + slip * st.def.pip;
    px = roundTo(px, st.def.digits);
    var pl = this._posPL({ sym: pos.sym, side: pos.side, lots: closLots, openPx: pos.openPx }, px);
    var comm = closLots * COMMISSION_PER_LOT;
    var swapShare = pos.swap * (closLots / pos.lots);
    this.balance += pl - comm + 0;      // swap 已在结算时计入余额，这里只补价差与佣金
    this.diag.commission += comm;
    var rec = {
      ticket: pos.ticket, sym: pos.sym, side: pos.side, lots: closLots,
      openPx: pos.openPx, closePx: px, openT: pos.openT, closeT: this.clock,
      pl: pl, comm: comm + pos.comm * (closLots / pos.lots), swap: swapShare,
      net: pl - comm, pips: (px - pos.openPx) * pos.side / st.def.pip
    };
    this.history.push(rec);
    if (this.history.length > 3000) this.history.shift();
    if (closLots >= pos.lots - 1e-9) {
      this.positions.splice(idx, 1);
    } else {
      pos.lots = roundLots(pos.lots - closLots);
      pos.comm = pos.comm * (1 - closLots / (closLots + pos.lots));
      pos.swap -= swapShare;
    }
    this._log('close', '平仓 ' + rec.sym + ' ' + rec.lots + '手 @' + px + ' → ' + (rec.net >= 0 ? '+' : '') + rec.net.toFixed(2));
    return { ok: true, record: rec };
  };

  Engine.prototype.closeAll = function () {
    var self = this, n = 0;
    this.positions.slice().forEach(function (p) { if (self.close(p.ticket).ok) n++; });
    return n;
  };

  /* --------------------------------------------------------- 撮合 / 结算 */
  Engine.prototype._matchOrders = function () {
    var st, o, i;
    for (i = this.orders.length - 1; i >= 0; i--) {
      o = this.orders[i];
      st = this.sym[o.sym];
      var hit = false, px = 0;
      if (o.type === 'limit') {
        if (o.side > 0 && st.ask <= o.price) { hit = true; px = Math.min(o.price, st.ask); }
        else if (o.side < 0 && st.bid >= o.price) { hit = true; px = Math.max(o.price, st.bid); }
      } else if (o.type === 'stop') {
        if (o.side > 0 && st.ask >= o.price) { hit = true; px = st.ask; }
        else if (o.side < 0 && st.bid <= o.price) { hit = true; px = st.bid; }
      }
      if (!hit) continue;
      this.orders.splice(i, 1);
      var res = this._openPosition({ sym: o.sym, side: o.side, lots: o.lots, price: roundTo(px, st.def.digits), sl: o.sl, tp: o.tp, comment: o.type });
      if (!res.ok) { this.diag.rejects++; this._log('reject', '挂单成交失败：' + res.err); }
    }
  };

  Engine.prototype._matchStops = function () {
    var self = this;
    var toClose = [];
    this.positions.forEach(function (p) {
      var st = self.sym[p.sym];
      var px = p.side > 0 ? st.bid : st.ask;
      if (p.sl) {
        if ((p.side > 0 && px <= p.sl) || (p.side < 0 && px >= p.sl)) {
          toClose.push({ ticket: p.ticket, px: p.sl, why: 'SL' });
        }
      }
      if (p.tp) {
        if ((p.side > 0 && px >= p.tp) || (p.side < 0 && px <= p.tp)) {
          toClose.push({ ticket: p.ticket, px: p.tp, why: 'TP' });
        }
      }
    });
    toClose.forEach(function (c) {
      var pos = null;
      for (var i = 0; i < self.positions.length; i++) if (self.positions[i].ticket === c.ticket) pos = self.positions[i];
      if (!pos) return;
      var st = self.sym[pos.sym];
      // 止损是市价单：跳空时按更差的价成交
      var slip = self._slippagePips(st, pos.lots);
      var px = c.why === 'SL'
        ? (pos.side > 0 ? Math.min(c.px, st.bid) - slip * st.def.pip : Math.max(c.px, st.ask) + slip * st.def.pip)
        : (pos.side > 0 ? Math.max(c.px, st.bid) : Math.min(c.px, st.ask));
      var idx = self.positions.indexOf(pos);
      var pl = self._posPL({ sym: pos.sym, side: pos.side, lots: pos.lots, openPx: pos.openPx }, px);
      var comm = pos.lots * COMMISSION_PER_LOT;
      self.balance += pl - comm;
      self.diag.commission += comm;
      self.history.push({
        ticket: pos.ticket, sym: pos.sym, side: pos.side, lots: pos.lots,
        openPx: pos.openPx, closePx: roundTo(px, st.def.digits), openT: pos.openT, closeT: self.clock,
        pl: pl, comm: pos.comm + comm, swap: pos.swap, net: pl - comm,
        pips: (px - pos.openPx) * pos.side / st.def.pip
      });
      self.positions.splice(idx, 1);
      self._log('close', c.why + ' 触发 ' + pos.sym + ' ' + pos.lots + '手 @' + roundTo(px, st.def.digits));
    });
  };

  Engine.prototype._rollover = function () {
    var self = this;
    var d = new Date(this.clock);
    var closingDow = d.getUTCDay();          // 结算发生在 UTC 21:00，算当天
    var mult = (closingDow === 3) ? 3 : 1;   // 周三三倍隔夜利息
    this.diag.rollovers++;
    this.positions.forEach(function (p) {
      var st = self.sym[p.sym];
      var notional = p.lots * CONTRACT * self.usdPerBase(p.sym);
      var rb = POLICY_RATE[st.def.base] || 0.02;
      var rq = POLICY_RATE[st.def.quote] || 0.02;
      var rate = ((rb - rq) * p.side - SWAP_MARKUP) / 365;
      var swap = notional * rate * mult;
      p.swap += swap;
      self.balance += swap;
      self.diag.swaps += swap;
    });
    this._log('swap', '结算：' + this.positions.length + ' 笔持仓计息' + (mult > 1 ? '（周三三倍）' : ''));
  };

  Engine.prototype._stopOut = function () {
    var guard = 0;
    while (guard++ < 20) {
      var acc = this.account();
      if (acc.margin <= 0) return;
      if (acc.level >= STOP_OUT) return;
      // 强平浮亏最大的一笔（券商的常见做法）
      var worst = null, worstPL = 0;
      for (var i = 0; i < this.positions.length; i++) {
        var p = this.positions[i];
        var pl = this._posPL(p, this._exitPrice(p));
        if (!worst || pl < worstPL) { worst = p; worstPL = pl; }
      }
      if (!worst) return;
      var st = this.sym[worst.sym];
      var slip = this._slippagePips(st, worst.lots) * 2.2;   // 强平按市价，滑点更狠
      var px = worst.side > 0 ? st.bid - slip * st.def.pip : st.ask + slip * st.def.pip;
      var idx = this.positions.indexOf(worst);
      var pl2 = this._posPL({ sym: worst.sym, side: worst.side, lots: worst.lots, openPx: worst.openPx }, px);
      var comm = worst.lots * COMMISSION_PER_LOT;
      this.balance += pl2 - comm;
      this.diag.commission += comm;
      this.diag.stopOuts++;
      this.history.push({
        ticket: worst.ticket, sym: worst.sym, side: worst.side, lots: worst.lots,
        openPx: worst.openPx, closePx: roundTo(px, st.def.digits), openT: worst.openT, closeT: this.clock,
        pl: pl2, comm: worst.comm + comm, swap: worst.swap, net: pl2 - comm, forced: true,
        pips: (px - worst.openPx) * worst.side / st.def.pip
      });
      this.positions.splice(idx, 1);
      this._log('stopout', '强制平仓 ' + worst.sym + ' ' + worst.lots + '手（保证金比例 ' + acc.level.toFixed(1) + '%）');
    }
  };

  Engine.prototype._pushEquity = function (force) {
    if (!force && this.clock - this.lastEquityPush < 300000) return;
    this.lastEquityPush = this.clock;
    this.equityCurve.push({ t: this.clock, eq: this.equity() });
    if (this.equityCurve.length > 4000) this.equityCurve.shift();
  };

  /* ---------------------------------------------------------------- 推进 */
  Engine.prototype.step = function (simSeconds) {
    if (!(simSeconds > 0)) return;
    var open = this.marketOpen(this.clock);
    this.clock += simSeconds * 1000;

    var serverDay = this._serverDay(this.clock);
    var crossedSettle = false;
    if (this.lastServerDay != null && serverDay !== this.lastServerDay) {
      crossedSettle = true;
      this.lastServerDay = serverDay;
    }

    var self = this;
    Object.keys(this.sym).forEach(function (k) { self._refreshQuote(self.sym[k]); });

    if (open && this.marketOpen(this.clock)) {
      this._matchOrders();
      this._matchStops();
    }
    if (crossedSettle) this._rollover();
    this._stopOut();
    this._pushEquity(false);
  };

  /* ------------------------------------------------------------- 统计 */
  Engine.prototype.stats = function () {
    var h = this.history;
    var wins = 0, losses = 0, grossWin = 0, grossLoss = 0, sum = 0, maxWin = 0, maxLoss = 0;
    var pipsSum = 0;
    h.forEach(function (r) {
      var n = r.net;
      sum += n;
      if (n >= 0) { wins++; grossWin += n; } else { losses++; grossLoss += -n; }
      maxWin = Math.max(maxWin, n); maxLoss = Math.min(maxLoss, n);
      pipsSum += r.pips;
    });
    var eq = this.equity();
    var peak = this.startBalance, maxDD = 0;
    this.equityCurve.forEach(function (p) {
      if (p.eq > peak) peak = p.eq;
      var dd = peak > 0 ? (peak - p.eq) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    });
    maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak * 100 : 0);
    return {
      trades: h.length, wins: wins, losses: losses,
      winRate: h.length ? wins / h.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      expectancy: h.length ? sum / h.length : 0,
      netProfit: sum, grossWin: grossWin, grossLoss: grossLoss,
      maxWin: maxWin, maxLoss: maxLoss,
      avgPips: h.length ? pipsSum / h.length : 0,
      commission: this.diag.commission, swap: this.diag.swaps,
      maxDD: maxDD, returnPct: (eq / this.startBalance - 1) * 100,
      forced: h.filter(function (r) { return r.forced; }).length
    };
  };

  /* --------------------------------------------------------- 风险计算器 */
  Engine.prototype.suggestLots = function (symName, stopPips, riskPct) {
    var acc = this.account();
    var st = this.sym[symName];
    var riskMoney = acc.equity * clamp(riskPct, 0.1, 100) / 100;
    var perLot = this.pipValueUSD(symName, 1) * stopPips;
    if (!(perLot > 0)) return 0;
    var byRisk = riskMoney / perLot;
    var lev = Math.min(this.leverage, st.def.lev);
    var marginPerLot = CONTRACT * this.usdPerBase(symName) / lev;
    var byMargin = marginPerLot > 0 ? acc.equity * 0.95 / marginPerLot : 0;
    return roundLots(Math.min(byRisk, byMargin, MAX_LOT));
  };

  /* --------------------------------------------------------- 存档/载入 */
  Engine.prototype.serialize = function () {
    return {
      v: 1, clock: this.clock, balance: this.balance, leverage: this.leverage,
      startBalance: this.startBalance, seed: this.rng.s, seed0: this.seed0,
      positions: this.positions, orders: this.orders, history: this.history.slice(-400),
      diag: this.diag, equityCurve: this.equityCurve.slice(-1500),
      nextTicket: this.nextTicket, nextOrderId: this.nextOrderId,
      lastServerDay: this.lastServerDay
    };
  };

  Engine.prototype.restore = function (snap) {
    if (!snap || snap.v !== 1) return false;
    var self = this;
    this.clock = snap.clock; this.balance = snap.balance; this.leverage = snap.leverage;
    this.startBalance = snap.startBalance; this.rng.s = snap.seed; if (snap.seed0 != null) this.seed0 = snap.seed0;
    this.positions = snap.positions || []; this.orders = snap.orders || [];
    this.history = snap.history || []; this.diag = snap.diag || this.diag;
    this.equityCurve = snap.equityCurve || [];
    this.nextTicket = snap.nextTicket || 100001;
    this.nextOrderId = snap.nextOrderId || 500001;
    this.lastServerDay = snap.lastServerDay;
    this._extCache = {};
    Object.keys(this.sym).forEach(function (k) {
      var st = self.sym[k];
      st.dayIdx = -1; st.path = null; st.pathIdx = -1; st.ext = {};
      self._refreshQuote(st);
    });
    return true;
  };

  /* --------------------------------------------------------------- 导出 */
  Engine.prototype.statementCSV = function () {
    var rows = [['ticket', 'symbol', 'side', 'lots', 'open_time', 'open_px', 'close_time', 'close_px', 'pips', 'pl', 'commission', 'swap', 'net', 'forced']];
    this.history.forEach(function (r) {
      rows.push([
        r.ticket, r.sym, r.side > 0 ? 'BUY' : 'SELL', r.lots,
        isoUTC(r.openT), r.openPx.toFixed(5), isoUTC(r.closeT), r.closePx.toFixed(5),
        r.pips.toFixed(1), r.pl.toFixed(2), (r.comm || 0).toFixed(2), (r.swap || 0).toFixed(2),
        r.net.toFixed(2), r.forced ? 'STOPOUT' : ''
      ]);
    });
    return rows.map(function (r) { return r.join(','); }).join('\n');
  };

  function isoUTC(ms) {
    var d = new Date(ms + SERVER_OFFSET);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  /* ------------------------------------------------------------- 对外 */
  return {
    Engine: Engine,
    buildWorld: buildWorld,
    SYM_DEFS: SYM_DEFS,
    POLICY_RATE: POLICY_RATE,
    TFS: TFS,
    isoUTC: isoUTC,
    roundTo: roundTo,
    roundLots: roundLots,
    constants: {
      DAY: DAY, SERVER_OFFSET: SERVER_OFFSET, CONTRACT: CONTRACT, MIN_LOT: MIN_LOT,
      MAX_LOT: MAX_LOT, COMMISSION_PER_LOT: COMMISSION_PER_LOT,
      STOP_OUT: STOP_OUT, MARGIN_CALL: MARGIN_CALL, SWAP_MARKUP: SWAP_MARKUP
    }
  };
});

