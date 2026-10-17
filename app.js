'use strict';

/* ---------- 常量与状态 ---------- */

const APP = 'predict-weekly-vercel';
const DB_NAME = 'predict-weekly-vercel-v2';
// v1：单个 key 存整份快照；v2：按地址分条存储，只写改动过的地址。
const DB_VERSION = 2;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BOM = String.fromCharCode(0xfeff);
const PAGE_SIZE = 100;
const NAME_MAX = 160;
const CURSOR_MAX = 4096;
const LOG_MAX = 120;
const IMPORT_MAX = 512 * 1024 * 1024;
const SAVE_EVERY = 10000;
const PORTFOLIO_URL = 'https://predict.fun/zh-cn/portfolio/';

// 周号规则与 yuce 项目一致：W1 从 2025-12-16 14:00 UTC（北京时间 22:00）开始，
// 每周 7 天；「本周」按当前时间推算，并与数据里见过的最大周号取大。
const WEEK_ANCHOR_START_TS = 1765893600;
const WEEK_SECONDS = 604800;

const STATES = {
  ok:        ['已结算',     'ok'],
  unsettled: ['未结算',     'warn'],
  unknown:   ['结算状态未知', 'warn'],
  invalid:   ['积分无效',   'err'],
  error:     ['查询失败',   'err'],
  pending:   ['待查询',     'muted'],
  missing:   ['该周无记录', 'muted'],
  dropped:   ['接口已不返回', 'warn']
};

const MODES = {
  week:  { label: '所选周积分', head: '周排名',   file: 'week' },
  sum:   { label: '已结算周积分合计', head: '合计排名', file: 'settled-sum' },
  total: { label: '累计总积分', head: '总积分排名', file: 'total-points' },
  pnl:   { label: '所选周官网 PNL', head: '周 PNL 排名', file: 'week-pnl' },
  pnlTotal: { label: '官网累计 PNL', head: '累计 PNL 排名', file: 'total-pnl' },
  fee:   { label: '所选周手续费', head: '手续费排名', file: 'week-fee' },
  feeAll: { label: '全部手续费', head: '全部手续费排名', file: 'all-fee' },
  volume: { label: '所选周交易量', head: '交易量排名', file: 'week-volume' },
  cpp:   { label: '所选周积分成本', head: '积分成本排名', file: 'week-cpp', ascending: true }
};

// 手续费折扣（decimal）；空或非法时与 yuce 一样回退到 0.9。
const FEE_MUL_KEY = 'predict-weekly-vercel.feeMul';
const FEE_MUL_DEFAULT = '0.9';
// 访问密码记在本浏览器里，打开页面自动填上；清空输入框即忘记。
const PASSWORD_KEY = 'predict-weekly-vercel.password';

function feeMultiplier() {
  const raw = ($('feeMul').value || '').trim();
  return (raw ? decimal(raw) : null) || decimal(FEE_MUL_DEFAULT);
}

const $ = id => document.getElementById(id);
const accounts = new Map();
const logs = [];

let discovery = emptyDiscovery();
let db = null;
let task = null;
let page = 1;
let lastRows = [];
let activeWeek = 0;
let weekOptionsKey = '';

// 数据版本：每次改动积分数据后 +1，派生缓存据此失效。
let dataVersion = 0;
const rankCache = new Map();        // 周号 → 该周样本排名
const sumCache = new WeakMap();     // 地址记录 → 已结算周合计
const totalCache = new WeakMap();   // 地址记录 → 解析后的累计总积分
const weekDecimals = new WeakMap(); // 周记录 → 解析后的周积分
const feeDecimals = new WeakMap();  // 周记录 → 解析后的周手续费原值
const feeSumCache = new WeakMap();  // 地址记录 → 全部手续费（按数据版本与折扣缓存）
const periodCache = new Map();      // 周期文本（Intl 格式化较慢，同一周所有地址共用）
let summaryCache = null;
let rowsCache = null;               // 主表行：翻页、搜索、切榜单时不重算
let weekSetCache = null;            // 周下拉框用的周号集合与最新已结算周

// 待写入本机缓存的地址（小写 key）；resetStore 表示要先清空再整体重写。
const dirty = new Set();
let dirtyDiscovery = false;
let resetStore = false;

function touch() {
  dataVersion++;
  rankCache.clear();
  summaryCache = null;
  rowsCache = null;
  weekSetCache = null;
}

// 记录某个地址有改动，下次 save() 只写这些地址。
function markDirty(a) {
  dirty.add(a.address.toLowerCase());
}

function emptyDiscovery() {
  // received：累计接收的总榜条数，接口不给名次时据此补名次（最后一页可能不满）。
  return { cursor: '', pages: 0, finished: false, seen: [], received: 0 };
}

/* ---------- 通用工具 ---------- */

const validAddress = x => typeof x === 'string' && ADDRESS_RE.test(x);
const abortError = () => new DOMException('已停止', 'AbortError');
const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number(value) || fallback));
const shortAddress = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

const escapeHTML = x => String(x ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const toBool = v =>
  v === true || v === 'true' ? true :
  v === false || v === 'false' ? false : null;

const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

const beijingMinute = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});

function timeText(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(+date) ? '—' : beijingTime.format(date);
}

// 某个时刻（毫秒）按锚点推算的周号（至少为 1）。
function weekAt(ms) {
  return Math.max(1, Math.floor((ms / 1000 - WEEK_ANCHOR_START_TS) / WEEK_SECONDS) + 1);
}

// 按当前时间推算的周号（至少为 1）。
const currentWeekNumber = () => weekAt(Date.now());

// 某周按锚点推算的起止时间（UTC 秒）。
function weekBounds(week) {
  const start = WEEK_ANCHOR_START_TS + (week - 1) * WEEK_SECONDS;
  return { start, end: start + WEEK_SECONDS };
}

// 接口给的周起止原值可能是秒、毫秒或日期字符串；解析为毫秒，解析不了返回 null。
function toMillis(value) {
  if (value == null || value === '') return null;

  const raw = String(value).trim();
  const ms = /^\d{9,10}$/.test(raw) ? Number(raw) * 1000
    : /^\d{12,13}$/.test(raw) ? Number(raw)
    : Date.parse(raw);

  return Number.isFinite(ms) ? ms : null;
}

// 周期（北京时间）：优先用接口返回的起止时间，缺失时按锚点推算。
// 同一周的起止对所有地址几乎都相同，按 (周, 起, 止) 缓存，全周导出时不必逐条格式化。
function periodText(week, w) {
  const key = `${week}|${w?.week_start ?? ''}|${w?.week_end ?? ''}`;
  let text = periodCache.get(key);

  if (text === undefined) {
    if (periodCache.size > 5000) periodCache.clear();

    const bounds = weekBounds(week);
    const start = toMillis(w?.week_start) ?? bounds.start * 1000;
    const end = toMillis(w?.week_end) ?? bounds.end * 1000;

    text = `${beijingMinute.format(new Date(start))} ~ ${beijingMinute.format(new Date(end))}`;
    periodCache.set(key, text);
  }

  return text;
}

function message(text) {
  $('status').textContent = text;
}

function progress(done, total) {
  $('progress').hidden = !total;
  $('bar').style.width = total ? `${Math.round(done / total * 100)}%` : '0';
}

function log(text) {
  logs.push(`${new Date().toLocaleTimeString('zh-CN')}  ${text}`);
  if (logs.length > LOG_MAX) logs.shift();
  $('log').textContent = logs.join('\n');
}

function setLocked(locked) {
  document.querySelectorAll('[data-lock]').forEach(el => { el.disabled = locked; });
}

/* ---------- 高精度数字 ----------
   JSON 中的数字 token 保留为字符串，
   积分比较、求和、导出都不经过浮点取整。 */

function parseJSON(text) {
  if (text.startsWith(BOM)) text = text.slice(1);

  return JSON.parse(
    text.replace(
      /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      token => (token[0] === '"' ? token : JSON.stringify(token))
    )
  );
}

function normalize(d) {
  while (d.s && d.n % 10n === 0n) {
    d.n /= 10n;
    d.s--;
  }
  return d;
}

// 解析为 { n: BigInt, s: 小数位数 }，无法解析返回 null。
function decimal(value) {
  if (value == null || typeof value === 'boolean') return null;

  const raw = String(value).trim();
  if (raw.length > 200) return null;

  const m = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!m || Math.abs(Number(m[4] || 0)) > 100) return null;

  let s = (m[3] || '').length - Number(m[4] || 0);
  let n = BigInt(m[2] + (m[3] || '')) * (m[1] === '-' ? -1n : 1n);

  if (s < 0) {
    n *= 10n ** BigInt(-s);
    s = 0;
  }

  return normalize({ n, s });
}

function decimalString(d) {
  const digits = (d.n < 0n ? -d.n : d.n).toString().padStart(d.s + 1, '0');
  const body = d.s ? `${digits.slice(0, -d.s)}.${digits.slice(-d.s)}` : digits;
  return (d.n < 0n ? '-' : '') + body;
}

// 规范化为十进制字符串。
function numeric(value) {
  const d = decimal(value);
  return d ? decimalString(d) : null;
}

function align(x, y) {
  const s = Math.max(x.s, y.s);
  return [x.n * 10n ** BigInt(s - x.s), y.n * 10n ** BigInt(s - y.s), s];
}

function compareDecimals(x, y) {
  const [p, q] = align(x, y);
  return p > q ? 1 : p < q ? -1 : 0;
}

function addDecimals(x, y) {
  const [p, q, s] = align(x, y);
  return normalize({ n: p + q, s });
}

function mulDecimals(x, y) {
  return normalize({ n: x.n * y.n, s: x.s + y.s });
}

// 千分位显示，小数最多保留 4 位；接受字符串或 decimal 对象。
function format(value) {
  if (value == null) return '—';

  const text = typeof value === 'object' ? decimalString(value) : String(value);
  const [int, frac] = text.split('.');

  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac.slice(0, 4) : '');
}

function pointsOf(w) {
  if (!w || w.points === null) return null;

  let d = weekDecimals.get(w);

  if (d === undefined) {
    d = decimal(w.points);
    weekDecimals.set(w, d);
  }

  return d;
}

// 某周手续费（decimal）= 接口 paid_fee_usdt × 手续费折扣；接口不再返回的周不计。
function feeOf(w, mul = feeMultiplier()) {
  if (!w || w.droppedAt || w.paid_fee_usdt == null) return null;

  let raw = feeDecimals.get(w);

  if (raw === undefined) {
    raw = decimal(w.paid_fee_usdt);
    feeDecimals.set(w, raw);
  }

  return raw ? mulDecimals(raw, mul) : null;
}

const volumeDecimals = new WeakMap(); // 周记录 → 解析后的周交易量（付费 + 免费）

// 某周交易量（decimal）= 接口 paid_volume_usdt + free_volume_usdt（口径同 yuce 的“总交易量”），不乘折扣；
// 接口不再返回的周不计，两项都没有时返回 null。
function volumeOf(w) {
  if (!w || w.droppedAt || (w.paid_volume_usdt == null && w.free_volume_usdt == null)) return null;

  let d = volumeDecimals.get(w);

  if (d === undefined) {
    const paid = decimal(w.paid_volume_usdt);
    const free = decimal(w.free_volume_usdt);
    d = paid && free ? addDecimals(paid, free) : (paid || free);
    volumeDecimals.set(w, d);
  }

  return d;
}

// 该地址所有周手续费之和（含未结算周），没有任何手续费数据返回 null。
function feeSum(a, mul = feeMultiplier()) {
  const key = `${dataVersion}|${decimalString(mul)}`;
  const cached = feeSumCache.get(a);
  if (cached && cached.key === key) return cached.sum;

  let sum = null;

  if (a.status === 'ok') {
    for (const w of a.weeks) {
      const d = feeOf(w, mul);
      if (d) sum = sum ? addDecimals(sum, d) : d;
    }
  }

  feeSumCache.set(a, { key, sum });
  return sum;
}

// 积分成本 = 周手续费 ÷ 周积分（Number）。规则同 yuce：
// 都为 0 → null；积分为 0 → Infinity（显示“无积分”，不参与排名）；手续费为 0 → 0（显示“免费”）。
function costPerPoint(fee, points) {
  if (!fee || !points) return null;

  const f = Number(decimalString(fee));
  const p = Number(decimalString(points));
  if (!Number.isFinite(f) || !Number.isFinite(p) || f < 0 || p < 0) return null;
  if (f === 0 && p === 0) return null;
  if (p === 0) return Infinity;
  if (f === 0) return 0;

  return f / p;
}

function cppText(value) {
  if (value == null || Number.isNaN(value) || value < 0) return '—';
  if (value === Infinity) return '无积分';
  if (value === 0) return '免费';
  if (value >= 1) return '$' + value.toFixed(2);
  if (value >= 0.01) return '$' + value.toFixed(4);
  if (value >= 0.0001) return '$' + value.toFixed(5);
  return '$' + value.toExponential(2);
}

function totalOf(a) {
  const cached = totalCache.get(a);
  if (cached && cached.src === a.totalPoints) return cached.d;

  const d = a.totalPoints === null ? null : decimal(a.totalPoints);
  totalCache.set(a, { src: a.totalPoints, d });
  return d;
}

// 所有已结算周的周积分之和（推荐积分不计入）。
function settledSum(a) {
  const cached = sumCache.get(a);
  if (cached && cached.version === dataVersion) return cached;

  let sum = null;
  let count = 0;

  if (a.status === 'ok') {
    for (const w of a.weeks) {
      if (!settledWeek(w)) continue;

      const d = pointsOf(w);
      if (!d) continue;

      count++;
      sum = sum ? addDecimals(sum, d) : d;
    }
  }

  const entry = { version: dataVersion, sum, count };
  sumCache.set(a, entry);
  return entry;
}

/* ---------- 数据模型 ---------- */

// fromApi=true 表示接口响应：手续费字段缺失记为 null；
// 恢复旧缓存时保持 undefined，表示该周是在支持手续费之前查的，可自动补查。
function weeksOf(list, fromApi = false) {
  if (!Array.isArray(list)) {
    throw new Error('响应缺少 weeks 数组，不能当作 0 分。');
  }

  const seen = new Set();

  return list.map(w => {
    const week = Number(w?.week);

    if (!Number.isInteger(week) || week < 1 || week > 10000 || seen.has(week)) {
      throw new Error('周号无效或重复。');
    }

    seen.add(week);

    return {
      week,
      points: numeric(w.points),
      referral_points: numeric(w.referral_points),
      // 该周已付手续费（USD），接口原值；旧缓存没有这个字段时为 null。
      paid_fee_usdt: !fromApi && w.paid_fee_usdt === undefined ? undefined : numeric(w.paid_fee_usdt),
      // 该周交易量（USD）：付费 + 免费，接口原值；旧缓存没有这两个字段时保持 undefined，可自动补查。
      paid_volume_usdt: !fromApi && w.paid_volume_usdt === undefined ? undefined : numeric(w.paid_volume_usdt),
      free_volume_usdt: !fromApi && w.free_volume_usdt === undefined ? undefined : numeric(w.free_volume_usdt),
      calculated: toBool(w.calculated),
      week_start: w.week_start ?? null,
      week_end: w.week_end ?? null,
      updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : null,
      // 最近一次成功查询里接口没再返回这一周（官方可能已修订/清零）。
      droppedAt: typeof w.droppedAt === 'string' ? w.droppedAt : null
    };
  });
}

// 按周号合并：新数据覆盖同一周；接口不再返回的历史周保留但标记 droppedAt，
// 不再参与排名与合计（官方会修订或清零积分，以接口最新返回为准）。
// 新响应缺少周起止时间时沿用旧值。
function mergeWeeks(oldWeeks, newWeeks, updatedAt) {
  const byWeek = new Map(oldWeeks.map(w => [w.week, { ...w, droppedAt: w.droppedAt ?? updatedAt }]));

  for (const w of newWeeks) {
    const old = byWeek.get(w.week);

    byWeek.set(w.week, {
      ...w,
      week_start: w.week_start ?? old?.week_start ?? null,
      week_end: w.week_end ?? old?.week_end ?? null,
      updatedAt,
      droppedAt: null
    });
  }

  return [...byWeek.values()].sort((x, y) => x.week - y.week);
}

function accountOf(raw) {
  const x = typeof raw === 'string' ? { address: raw } : raw;
  const address = String(x?.address ?? x?.wallet ?? x?.wallet_address ?? '').trim();

  if (!validAddress(address)) {
    throw new Error('记录缺少有效钱包地址。');
  }

  const rank = Number(x.rank ?? x.position ?? x.leaderboard?.rank);

  return {
    address,
    name: String(x.name ?? x.username ?? '').slice(0, NAME_MAX),
    totalPoints: numeric(x.totalPoints ?? x.total_points ?? x.leaderboard?.total_points),
    rank: Number.isInteger(rank) && rank > 0 ? rank : null,
    weeks: [],
    status: 'pending',
    error: '',
    fetchedAt: '',
    pnl: null
  };
}

// 官网 PNL 时序只在各周的起止时刻用到，因此不保存逐点数据，只保存各周界的累计值：
// cum[k] = 第 k 周结束时（按锚点推算）的累计 PNL，cum[0] 为第 1 周开始前；
// 最后一项 cum[K] 是查询时刻的最新值（第 K 周尚未结束）。
// 1 万个地址的逐点时序会让本机缓存和断点文件膨胀上百 MB，压缩后每个地址只剩几十个数。
function cumulativeByWeek(points, K) {
  if (!Array.isArray(points)) return [];

  const pts = points
    .map(pt => {
      let x = Number(Array.isArray(pt) ? pt[0] : pt?.x);
      const y = Number(Array.isArray(pt) ? pt[1] : pt?.y);
      if (x > 1e11) x /= 1000;
      return [x, y];
    })
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0]);

  if (!pts.length) return [];

  const cum = [];
  let i = 0;
  let v = 0;

  for (let k = 0; k <= K; k++) {
    const t = WEEK_ANCHOR_START_TS + k * WEEK_SECONDS;
    while (i < pts.length && pts[i][0] <= t) v = pts[i++][1];
    cum.push(v);
  }

  return cum;
}

// 官网 PNL：{ cum, week: 查询时所在周 K, total, error, updatedAt }。
// 兼容旧缓存 / 旧断点里的逐点 points（按 updatedAt 所在周压缩）。
function pnlOf(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  const fetched = Date.parse(updatedAt);
  let week = Number(raw.week);
  let cum;

  if (Array.isArray(raw.cum)) {
    cum = raw.cum.map(Number);
    if (!cum.every(Number.isFinite)) cum = [];
  } else if (Array.isArray(raw.points)) {
    week = Number.isFinite(fetched) ? weekAt(fetched) : currentWeekNumber();
    cum = cumulativeByWeek(raw.points, week);
  } else {
    return null;
  }

  if (cum.length) week = cum.length - 1;
  else if (!Number.isInteger(week) || week < 0) week = Number.isFinite(fetched) ? weekAt(fetched) : 0;

  // null 不能当成 0：未交易或查询失败的地址没有累计值，否则会以 0 进入累计 PNL 榜。
  const total = raw.total == null ? (cum.length ? cum[cum.length - 1] : null) : Number(raw.total);

  return {
    cum,
    week,
    total: Number.isFinite(total) ? total : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : '',
    updatedAt
  };
}

// 某一周的官网 PNL = 周末累计值 − 周初累计值；没有时序或该周晚于查询时刻返回 null。
function weekPnl(a, week) {
  const cum = a.pnl?.cum;
  if (!cum?.length || !(week >= 1) || week >= cum.length) return null;

  return Number((cum[week] - cum[week - 1]).toFixed(4));
}

// PNL 是否需要重新查询：没查过、上次失败、或查询时最新结算周还没结束（该周的值还是半周的）。
function pnlStale(a, settled) {
  return !a.pnl || !!a.pnl.error || a.pnl.week <= settled;
}

function pnlText(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
}

const pnlClass = value => (value > 0 ? ' pnl-pos' : value < 0 ? ' pnl-neg' : '');

function merge(a) {
  const key = a.address.toLowerCase();
  const old = accounts.get(key);

  touch();
  dirty.add(key);

  if (!old) {
    accounts.set(key, a);
    return;
  }

  if (a.name) old.name = a.name;
  if (a.totalPoints != null) old.totalPoints = a.totalPoints;
  if (a.rank != null) old.rank = a.rank;
}

function snapshot() {
  return {
    app: APP,
    version: 4,
    exportedAt: new Date().toISOString(),
    discovery,
    accounts: [...accounts.values()]
  };
}

// 断点文件或本机缓存里的一条地址记录 → 内存对象（字段逐个校验）。
function accountFromRecord(raw) {
  const a = accountOf(raw);

  a.weeks = weeksOf(raw.weeks).sort((x, y) => x.week - y.week);
  a.status = ['ok', 'error'].includes(raw.status) ? raw.status : 'pending';
  a.error = String(raw.error || '').slice(0, 500);
  a.fetchedAt = typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '';
  a.pnl = pnlOf(raw.pnl);

  return a;
}

function discoveryFromRecord(d) {
  const validCursor = x => typeof x === 'string' && x.length <= CURSOR_MAX;

  if (!d || typeof d !== 'object') return emptyDiscovery();

  if (!validCursor(d.cursor) || !Array.isArray(d.seen) || !d.seen.every(validCursor)) {
    throw new Error('断点分页信息无效。');
  }

  const received = Number(d.received);

  return {
    cursor: d.cursor,
    pages: Number(d.pages) || 0,
    finished: d.finished === true,
    seen: d.seen,
    // 旧断点没有 received：按已有名次的地址数估计。
    received: Number.isInteger(received) && received >= 0 ? received : rankedCount()
  };
}

// 用一组记录替换内存数据。strict=false 时跳过损坏的记录（用于本机缓存），否则抛错（用于导入断点）。
function hydrate(records, discoveryRecord, strict = true) {
  const restored = [];
  let skipped = 0;

  for (const raw of records) {
    try {
      restored.push(accountFromRecord(raw));
    } catch (error) {
      if (strict) throw error;
      skipped++;
    }
  }

  accounts.clear();
  restored.forEach(a => accounts.set(a.address.toLowerCase(), a));
  touch();

  try {
    discovery = discoveryFromRecord(discoveryRecord);
  } catch (error) {
    if (strict) throw error;
    discovery = emptyDiscovery();
  }

  if (skipped) log(`本机缓存里有 ${skipped} 条损坏记录已跳过。`);
}

// 导入断点：替换全部数据，并整体重写本机缓存。
function restore(data) {
  if (data?.app !== APP || !Array.isArray(data.accounts)) {
    throw new Error('不是本版本的断点文件。');
  }

  hydrate(data.accounts, data.discovery, true);
  dirty.clear();
  resetStore = true;
  dirtyDiscovery = true;
}

/* ---------- 本机缓存（IndexedDB） ---------- */

const idbRequest = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const idbTransaction = (tx, work) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error || new Error('保存失败'));

  try {
    work(tx);
  } catch (error) {
    reject(error);
    try { tx.abort(); } catch {}
  }
});

// 对象仓库：accounts（key = 小写地址）、meta（discovery）；cache 是 v1 遗留的整份快照，迁移后删除。
function openDB() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);

    open.onupgradeneeded = () => {
      const stores = open.result.objectStoreNames;
      if (!stores.contains('cache')) open.result.createObjectStore('cache');
      if (!stores.contains('accounts')) open.result.createObjectStore('accounts');
      if (!stores.contains('meta')) open.result.createObjectStore('meta');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('缓存被本站其他标签页占用，请关闭它们后刷新。'));
  });
}

// 读取本机缓存；v1 的整份快照会被拆成按地址存储后删除。
async function load() {
  const tx = db.transaction(['accounts', 'meta', 'cache']);
  const [records, meta, legacy] = await Promise.all([
    idbRequest(tx.objectStore('accounts').getAll()),
    idbRequest(tx.objectStore('meta').get('discovery')),
    idbRequest(tx.objectStore('cache').get('snapshot'))
  ]);

  if (records.length || meta) {
    hydrate(records, meta, false);
    // 新仓库已是权威数据，残留的旧快照直接删掉。
    if (legacy) await deleteLegacySnapshot();
  } else if (legacy) {
    hydrate(Array.isArray(legacy.accounts) ? legacy.accounts : [], legacy.discovery, false);
    resetStore = true;
    dirtyDiscovery = true;
    await save();
    // 写入失败时 flush 会把 resetStore 复原并保留旧快照，下次打开再迁移。
    log(resetStore
      ? '旧版缓存迁移未完成，旧数据已保留，刷新后会再试。'
      : `已把旧版整份缓存迁移为按地址存储：${accounts.size} 个地址。`);
  }
}

const deleteLegacySnapshot = () =>
  idbTransaction(db.transaction('cache', 'readwrite'), tx => tx.objectStore('cache').delete('snapshot'));

// 只写改动过的地址；resetStore 时先清空再整体重写（清空数据、导入断点）。
async function flush() {
  if (!resetStore && !dirty.size && !dirtyDiscovery) return;

  const keys = [...dirty];
  const reset = resetStore;
  const meta = dirtyDiscovery || reset;

  dirty.clear();
  resetStore = false;
  dirtyDiscovery = false;

  try {
    await idbTransaction(db.transaction(['accounts', 'meta'], 'readwrite'), tx => {
      const store = tx.objectStore('accounts');

      if (reset) {
        store.clear();
        for (const [key, a] of accounts) store.put(a, key);
      } else {
        for (const key of keys) {
          const a = accounts.get(key);
          if (a) store.put(a, key);
          else store.delete(key);
        }
      }

      if (meta) tx.objectStore('meta').put(discovery, 'discovery');
    });

    if (reset) await deleteLegacySnapshot();

    $('storage').textContent = '';
  } catch {
    // 下次再试；失败的改动不能丢。
    keys.forEach(key => dirty.add(key));
    resetStore ||= reset;
    dirtyDiscovery ||= meta;
    $('storage').textContent = '本机缓存写入失败，请使用“导出断点 JSON”保存进度。';
  }
}

// 并发调用会合并：进行中的保存结束后再补一次，确保最后的改动也落盘。
let saveChain = Promise.resolve();
let saveQueued = false;

function save() {
  if (!db) return Promise.resolve();

  if (!saveQueued) {
    saveQueued = true;
    saveChain = saveChain.then(() => {
      saveQueued = false;
      return flush();
    });
  }

  return saveChain;
}

/* ---------- 排名计算 ---------- */

// 参与排名/合计的有效结算周。
const settledWeek = w => w.calculated === true && !w.droppedAt;

function weekState(w) {
  if (!w) return 'missing';
  if (w.droppedAt) return 'dropped';
  if (w.calculated === false) return 'unsettled';
  if (w.calculated !== true) return 'unknown';
  if (w.points === null) return 'invalid';
  return 'ok';
}

function stateOf(a, w) {
  if (a.status === 'error') return 'error';
  if (a.status !== 'ok') return 'pending';
  return weekState(w);
}

// 按 score（decimal 或 null）降序排名，同分并列（1、1、3）；返回可排名条数。
function assignRanks(rows) {
  let scale = 0;

  for (const r of rows) {
    if (r.score) scale = Math.max(scale, r.score.s);
  }

  for (const r of rows) {
    r.scaled = r.score ? r.score.n * 10n ** BigInt(scale - r.score.s) : null;
  }

  // 同分按地址字符串平局；普通比较比 localeCompare 快一个数量级，地址是十六进制不需要本地化排序。
  const byAddress = (x, y) => (x.a.address < y.a.address ? -1 : x.a.address > y.a.address ? 1 : 0);

  rows.sort((x, y) => {
    if (x.scaled === null || y.scaled === null) {
      return Number(y.scaled !== null) - Number(x.scaled !== null) || byAddress(x, y);
    }

    return y.scaled > x.scaled ? 1 : y.scaled < x.scaled ? -1 : byAddress(x, y);
  });

  let rank = 0;
  let ranked = 0;
  let previous = null;

  for (const r of rows) {
    if (r.scaled === null) {
      r.rank = '';
      continue;
    }

    ranked++;
    if (previous === null || r.scaled !== previous) rank = ranked;

    r.rank = rank;
    previous = r.scaled;
  }

  return ranked;
}

// 主表：所有地址在所选周与所选榜单下的一行数据。
function buildRows(all, week, mode, ascending = false) {
  const mul = feeMultiplier();

  const rows = all.map(a => {
    const w = a.weeks.find(x => x.week === week);
    const key = stateOf(a, w);
    const { sum, count } = settledSum(a);

    const r = {
      a, w, key, sum, count,
      state: STATES[key][0],
      weekScore: key === 'ok' ? pointsOf(w) : null,
      total: totalOf(a),
      pnl: week ? weekPnl(a, week) : null,
      fee: a.status === 'ok' ? feeOf(w, mul) : null,
      feeAll: feeSum(a, mul),
      volume: a.status === 'ok' ? volumeOf(w) : null
    };

    // 积分成本只对可排名的周（已结算、积分有效）计算。
    r.cpp = r.weekScore ? costPerPoint(r.fee, r.weekScore) : null;

    r.pnlTotal = Number.isFinite(a.pnl?.total) ? a.pnl.total : null;

    const basis =
      mode === 'week' ? r.weekScore :
      mode === 'sum' ? r.sum :
      mode === 'total' ? r.total :
      mode === 'pnl' ? (r.pnl == null ? null : decimal(String(r.pnl))) :
      mode === 'fee' ? r.fee :
      mode === 'feeAll' ? r.feeAll :
      mode === 'volume' ? r.volume :
      mode === 'cpp' ? (Number.isFinite(r.cpp) ? decimal(String(r.cpp)) : null) :
      (r.pnlTotal == null ? null : decimal(String(r.pnlTotal)));

    // 升序时取相反数排名：第 1 名 = 最小值（PNL 榜即亏得最多的）。
    r.score = basis ? (ascending ? { n: -basis.n, s: basis.s } : basis) : null;
    r.eligible = r.score !== null;

    return r;
  });

  return { rows, ranked: assignRanks(rows) };
}

// 某一周的完整样本周排名（带缓存），供地址查询和全周导出使用。
function weekRanking(week) {
  let entry = rankCache.get(week);
  if (entry) return entry;

  const rows = [];

  for (const a of accounts.values()) {
    if (a.status !== 'ok') continue;

    const w = a.weeks.find(x => x.week === week);
    const score = w && settledWeek(w) ? pointsOf(w) : null;

    if (score) rows.push({ a, score });
  }

  entry = { ranked: assignRanks(rows), ranks: new Map(rows.map(r => [r.a, r.rank])) };
  rankCache.set(week, entry);
  return entry;
}

// 每一周的样本统计（带缓存）。
function weekSummaries() {
  if (summaryCache) return summaryCache;

  const byWeek = new Map();
  // 折扣只解析一次：40 万条记录逐条读 DOM 再解析，曾占整个统计一半以上的时间。
  const mul = feeMultiplier();

  for (const a of accounts.values()) {
    for (const w of a.weeks) {
      let s = byWeek.get(w.week);

      if (!s) {
        s = {
          week: w.week, week_start: null, week_end: null,
          records: 0, ranked: 0, top: null, topScore: null, sum: null, fee: null, volume: null, updatedAt: ''
        };
        byWeek.set(w.week, s);
      }

      s.records++;

      if (a.status === 'ok') {
        const fee = feeOf(w, mul);
        if (fee) s.fee = s.fee ? addDecimals(s.fee, fee) : fee;
        const volume = volumeOf(w);
        if (volume) s.volume = s.volume ? addDecimals(s.volume, volume) : volume;
      }
      s.week_start ??= w.week_start;
      s.week_end ??= w.week_end;
      if (w.updatedAt && w.updatedAt > s.updatedAt) s.updatedAt = w.updatedAt;

      if (a.status !== 'ok' || !settledWeek(w)) continue;

      const d = pointsOf(w);
      if (!d) continue;

      s.ranked++;
      s.sum = s.sum ? addDecimals(s.sum, d) : d;

      if (!s.topScore || compareDecimals(d, s.topScore) > 0) {
        s.topScore = d;
        s.top = a;
      }
    }
  }

  // 本周即使还没有数据也列出来，便于对照周期。
  const current = currentWeekNumber();

  if (!byWeek.has(current)) {
    byWeek.set(current, {
      week: current, week_start: null, week_end: null,
      records: 0, ranked: 0, top: null, topScore: null, sum: null, fee: null, volume: null, updatedAt: ''
    });
  }

  summaryCache = [...byWeek.values()].sort((x, y) => y.week - x.week);
  return summaryCache;
}

/* ---------- 渲染 ---------- */

// 刷新周下拉框，返回当前选中的周号（0 表示暂无已结算周）。
function syncWeekSelect(all) {
  // 周号集合只随数据变化，按数据版本缓存。
  if (!weekSetCache) {
    const weeks = new Set();
    let latest = 0;

    for (const a of all) {
      for (const w of a.weeks) {
        weeks.add(w.week);
        if (a.status === 'ok' && settledWeek(w)) latest = Math.max(latest, w.week);
      }
    }

    weekSetCache = { weeks, latest };
  }

  const { weeks, latest } = weekSetCache;

  // 下拉框列出第 1 周到本周（或数据里更大的周号）的全部周，标出本周和没有记录的周。
  const current = currentWeekNumber();
  const maxWeek = Math.max(current, ...weeks);
  const select = $('week');
  const selected = select.value;
  const key = `${maxWeek}|${current}|${[...weeks].sort((a, b) => a - b).join(',')}`;

  if (key !== weekOptionsKey) {
    weekOptionsKey = key;

    const options = [];
    for (let w = maxWeek; w >= 1; w--) {
      const tag = w === current ? '（本周）' : weeks.has(w) ? '' : '（无记录）';
      options.push(`<option value="${w}">第 ${w} 周${tag}</option>`);
    }

    select.innerHTML = '<option value="latest">最新已结算周</option>' + options.join('');
  }

  const chosen = Number(selected);
  select.value = selected === 'latest' || (chosen >= 1 && chosen <= maxWeek) ? selected : 'latest';

  return select.value === 'latest' ? latest : Number(select.value);
}

function badge(key) {
  return `<span class="badge badge-${STATES[key][1]}">${STATES[key][0]}</span>`;
}

function rowHTML(r, mode) {
  const a = r.a;
  const ok = a.status === 'ok';

  const num = (basis, text, title) =>
    `<td class="num${basis === mode ? ' basis' : ''}"${title ? ` title="${escapeHTML(title)}"` : ''}>${text}</td>`;

  return `
    <tr>
      <td class="rank${r.rank && r.rank <= 3 ? ' top' : ''}">${r.rank || '—'}</td>
      <td class="name-link" title="点击查看该地址各周积分与排名">${escapeHTML(a.name || '—')}</td>
      <td class="addr"><a class="addr" href="${PORTFOLIO_URL}${escapeHTML(a.address)}" target="_blank" rel="noopener noreferrer"
        title="在 predict.fun 打开该地址的 portfolio">${escapeHTML(a.address)}</a></td>
      ${num('week', ok ? format(r.w?.points) : '—', ok ? r.w?.points : '')}
      ${num('', ok ? format(r.w?.referral_points) : '—')}
      ${num('volume', format(r.volume), r.volume ? `付费 ${r.w.paid_volume_usdt ?? '—'} + 免费 ${r.w.free_volume_usdt ?? '—'}` : '')}
      ${num('fee', format(r.fee), r.fee ? decimalString(r.fee) : '')}
      ${num('feeAll', format(r.feeAll), r.feeAll ? decimalString(r.feeAll) : '')}
      ${num('cpp', cppText(r.cpp), Number.isFinite(r.cpp) ? String(r.cpp) : '')}
      <td class="num${pnlClass(r.pnl)}${mode === 'pnl' ? ' basis' : ''}" title="${escapeHTML(a.pnl?.error || '')}">${pnlText(r.pnl)}</td>
      <td class="num${pnlClass(r.pnlTotal)}${mode === 'pnlTotal' ? ' basis' : ''}">${pnlText(r.pnlTotal)}</td>
      ${num('sum', format(r.sum), r.sum ? `${decimalString(r.sum)}（已结算 ${r.count} 周）` : '')}
      ${num('total', format(a.totalPoints), a.totalPoints)}
      <td title="${escapeHTML(a.error)}">${badge(r.key)}</td>
      <td>${timeText(a.fetchedAt)}</td>
    </tr>`;
}

function weekRowHTML(s) {
  const top = s.top
    ? `${escapeHTML(s.top.name || '')} <a class="addr" href="${PORTFOLIO_URL}${escapeHTML(s.top.address)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(s.top.address)}">${shortAddress(s.top.address)}</a>`
    : '—';

  const tag = s.week === currentWeekNumber() ? ' <span class="badge badge-ok">本周</span>' : '';

  return `
    <tr${s.week === activeWeek ? ' class="active"' : ''}>
      <td>第 ${s.week} 周${tag}</td>
      <td>${escapeHTML(periodText(s.week, s))}</td>
      <td class="num">${s.records.toLocaleString()} / ${s.ranked.toLocaleString()}</td>
      <td>${top}</td>
      <td class="num" title="${s.topScore ? escapeHTML(decimalString(s.topScore)) : ''}">${format(s.topScore)}</td>
      <td class="num" title="${s.sum ? escapeHTML(decimalString(s.sum)) : ''}">${format(s.sum)}</td>
      <td class="num" title="${s.volume ? escapeHTML(decimalString(s.volume)) : ''}">${format(s.volume)}</td>
      <td class="num" title="${s.fee ? escapeHTML(decimalString(s.fee)) : ''}">${format(s.fee)}</td>
      <td>${timeText(s.updatedAt)}</td>
      <td><button class="small" data-week="${s.week}">查看周排名</button></td>
    </tr>`;
}

function renderWeeks() {
  $('weeksBody').innerHTML =
    weekSummaries().map(weekRowHTML).join('') ||
    '<tr><td class="empty" colspan="10">还没有周数据。查询地址后，这里会列出每一周的样本统计。</td></tr>';
}

function render() {
  const all = [...accounts.values()];
  const mode = $('mode').value;
  const ascending = $('order').value === 'asc';

  activeWeek = syncWeekSelect(all);

  // 翻页、搜索、改筛选不重算整表：行数据只随数据版本、榜单、周、排序和折扣变化。
  const rowsKey = `${dataVersion}|${mode}|${activeWeek}|${ascending}|${decimalString(feeMultiplier())}`;

  if (rowsCache?.key !== rowsKey) {
    rowsCache = { key: rowsKey, ...buildRows(all, activeWeek, mode, ascending) };
  }

  const { rows, ranked } = rowsCache;
  lastRows = rows;

  $('s1').textContent = all.length.toLocaleString();
  let okCount = 0;
  let errCount = 0;
  for (const a of all) {
    if (a.status === 'ok') okCount++;
    else if (a.status === 'error') errCount++;
  }
  $('s2').textContent = `${okCount.toLocaleString()} / ${errCount.toLocaleString()}`;
  $('s3').textContent = ranked.toLocaleString();

  let feeWeek = null;
  let feeAll = null;
  let volumeWeek = null;
  for (const r of rows) {
    if (r.fee) feeWeek = feeWeek ? addDecimals(feeWeek, r.fee) : r.fee;
    if (r.feeAll) feeAll = feeAll ? addDecimals(feeAll, r.feeAll) : r.feeAll;
    if (r.volume) volumeWeek = volumeWeek ? addDecimals(volumeWeek, r.volume) : r.volume;
  }
  $('s4').textContent = feeWeek ? format(feeWeek) : '0';
  $('s5').textContent = feeAll ? format(feeAll) : '0';
  $('s6').textContent = volumeWeek ? format(volumeWeek) : '0';

  $('coverage').textContent =
    `总榜已接收 ${discovery.pages} 页（${rankedCount().toLocaleString()} 个带名次地址）；` +
    (discovery.finished ? '已到接口游标末尾，仍不代表全网历史完整覆盖' : '尚未确认采集完成') +
    `。当前榜单：${MODES[mode].label}；所选周：${activeWeek ? `第 ${activeWeek} 周` : '暂无已结算周'}；` +
    `按周期推算现在是第 ${currentWeekNumber()} 周。`;

  $('rankHead').textContent = MODES[mode].head + ($('order').value === 'asc' ? '（升序）' : '');
  const arrow = $('order').value === 'asc' ? ' ▲' : ' ▼';
  document.querySelectorAll('th[data-basis]').forEach(th => {
    const active = th.dataset.basis === mode;
    th.classList.toggle('basis', active);
    th.textContent = th.dataset.label + (active ? arrow : '');
  });

  const query = $('search').value.trim().toLowerCase();
  const onlyEligible = $('settled').checked;

  const filtered = rows.filter(r =>
    (!onlyEligible || r.eligible) &&
    (!query || `${r.a.address} ${r.a.name}`.toLowerCase().includes(query))
  );

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.max(1, Math.min(page, pages));

  $('tbody').innerHTML =
    filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(r => rowHTML(r, mode)).join('') ||
    '<tr><td class="empty" colspan="15">没有符合筛选条件的记录。可取消“仅显示可排名记录”检查缺失或失败。</td></tr>';

  $('pageInfo').textContent = `${page} / ${pages} 页 · 筛选后 ${filtered.length} 条 · 每页 ${PAGE_SIZE} 条`;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;

  renderWeeks();
}

/* ---------- 地址各周排名查询 ---------- */

function lookup(address = $('lookup').value.trim()) {
  const box = $('lookupResult');
  const note = text => { box.innerHTML = `<p class="muted">${escapeHTML(text)}</p>`; };

  if (!validAddress(address)) return note('请输入完整的 0x 钱包地址（40 位十六进制）。');

  const a = accounts.get(address.toLowerCase());
  if (!a) return note('样本中没有这个地址；请先在第 1 步添加，并在第 2 步查询。');

  const { sum, count } = settledSum(a);
  const accountState = a.status === 'ok' ? '已查询' : a.status === 'error' ? `查询失败：${a.error}` : '待查询';

  const meta = `
    <div class="meta">
      <div><b>${escapeHTML(a.name || '未命名')}</b> <a class="addr" href="${PORTFOLIO_URL}${escapeHTML(a.address)}" target="_blank" rel="noopener noreferrer">${escapeHTML(a.address)}</a></div>
      <div><span>查询状态</span> ${escapeHTML(accountState)}</div>
      <div><span>总榜名次</span> ${a.rank ?? '—'}</div>
      <div><span>累计总积分</span> ${format(a.totalPoints)}</div>
      <div><span>已结算周合计</span> ${format(sum)}${count ? `（${count} 周）` : ''}</div>
      <div><span>全部手续费</span> ${format(feeSum(a))}</div>
      <div><span>官网累计 PNL</span> <b class="${pnlClass(a.pnl?.total)}">${pnlText(a.pnl?.total)}</b>${a.pnl?.error ? `（${escapeHTML(a.pnl.error)}）` : ''}</div>
      <div><span>采集时间</span> ${timeText(a.fetchedAt)}</div>
    </div>`;

  if (!a.weeks.length) {
    box.innerHTML = meta + '<p class="muted">该地址还没有周数据。</p>';
    return;
  }

  const mul = feeMultiplier();
  const current = currentWeekNumber();

  const rows = [...a.weeks].sort((x, y) => y.week - x.week).map(w => {
    const key = weekState(w);
    const fee = feeOf(w, mul);
    const volume = volumeOf(w);
    const pnl = weekPnl(a, w.week);
    let rankText = '—';

    if (a.status === 'ok' && key === 'ok') {
      const { ranked, ranks } = weekRanking(w.week);
      rankText = `<b>${ranks.get(a)}</b> / ${ranked.toLocaleString()}`;
    }

    return `
      <tr>
        <td>第 ${w.week} 周${w.week === current ? '（本周）' : ''}</td>
        <td>${escapeHTML(periodText(w.week, w))}</td>
        <td class="num" title="${escapeHTML(w.points ?? '')}">${format(w.points)}</td>
        <td class="num">${format(w.referral_points)}</td>
        <td class="num" title="${volume ? `付费 ${escapeHTML(w.paid_volume_usdt ?? '—')} + 免费 ${escapeHTML(w.free_volume_usdt ?? '—')}` : ''}">${format(volume)}</td>
        <td class="num" title="接口原值 ${escapeHTML(w.paid_fee_usdt ?? '')}">${format(fee)}</td>
        <td class="num">${cppText(key === 'ok' ? costPerPoint(fee, pointsOf(w)) : null)}</td>
        <td class="num${pnlClass(pnl)}">${pnlText(pnl)}</td>
        <td>${badge(key)}</td>
        <td class="num">${rankText}</td>
        <td>${timeText(w.updatedAt)}</td>
      </tr>`;
  });

  box.innerHTML = meta + `
    <div class="tablebox compact">
      <table class="auto">
        <thead>
          <tr>
            <th>周</th><th>周期（北京时间）</th><th class="num">周积分</th><th class="num">推荐积分</th>
            <th class="num">周交易量 (USD)</th><th class="num">周手续费 (USD)</th><th class="num">积分成本 $/积分</th><th class="num">周 PNL (USD)</th><th>结算状态</th><th class="num">样本周排名 / 可排名地址</th><th>数据更新（北京时间）</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
    <p class="muted">${a.status === 'ok' ? '' : '该地址最近一次查询未成功，各周暂不参与排名；重新查询成功后恢复。'}</p>`;
}

function showLookup(address) {
  $('lookup').value = address;
  lookup(address);
  $('lookupCard').scrollIntoView({ block: 'start' });
}

/* ---------- 网络请求 ---------- */

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);

    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

async function fetchProxy(url, signal) {
  const response = await fetch(url, {
    signal,
    cache: 'no-store',
    headers: { 'x-site-password': $('password').value, Accept: 'application/json' }
  });

  const text = await response.text();
  let data;

  try {
    data = parseJSON(text);
  } catch {
    // 5xx 的非 JSON 多半是 Vercel 的函数超时 / 平台错误页，可重试；其余才是没部署。
    const platform = response.status >= 500;
    const fn = url.startsWith('/api/pnl') ? 'api/pnl.js' : 'api/weekly.js';

    throw Object.assign(
      new Error(platform
        ? `代理返回 HTTP ${response.status} 且不是 JSON，可能是函数超时或平台故障。`
        : `代理返回非 JSON（HTTP ${response.status}）；请检查 ${fn} 是否部署。`),
      { code: response.status, fatal: !platform }
    );
  }

  if (response.ok && data?.success !== false) return data;

  throw Object.assign(
    new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`),
    {
      code: response.status,
      fatal: [401, 403, 503].includes(response.status),
      retryAfter: Number(response.headers.get('retry-after'))
    }
  );
}

async function request(action, params, signal) {
  const url = (action === 'pnl' ? '/api/pnl?' : '/api/weekly?') + new URLSearchParams(action === 'pnl' ? params : { action, ...params });

  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw abortError();

    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    const timer = setTimeout(cancel, 25000);
    let delay = 1500 * 2 ** attempt;

    signal.addEventListener('abort', cancel, { once: true });

    try {
      return await fetchProxy(url, ctrl.signal);
    } catch (error) {
      if (signal.aborted) throw abortError();

      if (Number.isFinite(error.retryAfter) && error.retryAfter > 0) {
        delay = Math.max(delay, error.retryAfter * 1000);
      }

      if (delay > 60000) {
        error.fatal = true;
        error.message += ' 上游要求等待较久，请稍后手动继续。';
      }

      const retryable =
        error.code === 429 || error.code >= 500 ||
        error.name === 'AbortError' || error instanceof TypeError;

      if (error.fatal || !retryable || attempt === 2) throw error;

      log(`${error.message}；${Math.ceil(delay / 1000)} 秒后重试。`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }

    await wait(delay, signal);
  }
}

/* ---------- 任务调度 ---------- */

async function run(work, needsPassword = false) {
  if (task) return;

  if (needsPassword && !$('password').value) {
    return message('请先填写网页访问密码 SITE_PASSWORD。');
  }

  task = new AbortController();
  setLocked(true);
  $('stop').disabled = false;

  try {
    await work(task.signal);
  } catch (error) {
    message(task.signal.aborted ? '已停止，数据已保留。' : error.message);
    log(error.message);
  } finally {
    await save();
    task = null;
    setLocked(false);
    $('stop').disabled = true;
    progress(0, 0);
    render();
  }
}

const interval = () => clamp($('interval').value, 100, 10000, 250);
const targetCount = () => clamp($('targetCount').value, 100, 200000, 10000);
const concurrency = () => clamp($('concurrency').value, 1, 10, 4);
const queryPnl = () => $('queryPnl').checked;
// 已从总榜采到的地址数（带名次的），手动导入的地址不算。
const rankedCount = () => { let n = 0; for (const a of accounts.values()) if (a.rank != null) n++; return n; };

// 总榜接口尚未实测，这里兼容几种常见的列表 / 游标字段名。
function leaderboardPage(data) {
  const body = data?.data && !Array.isArray(data.data) && typeof data.data === 'object' ? data.data : data;

  const list = [body?.data, body?.items, body?.results, body?.leaderboard, body?.accounts, body?.users]
    .find(Array.isArray);

  const cursorKeys = ['cursor', 'nextCursor', 'next_cursor', 'endCursor', 'after'];
  const holder = [body, body?.pageInfo, body?.page_info, body?.meta, data]
    .find(x => x && cursorKeys.some(k => Object.hasOwn(x, k)));
  const cursor = holder ? holder[cursorKeys.find(k => Object.hasOwn(holder, k))] : undefined;
  const hasNext = holder?.hasNextPage ?? holder?.has_next_page;

  if (!list) throw new Error('总榜响应里找不到地址列表（data / items / results），已停止。');
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new Error('总榜响应的分页游标不是字符串，已停止。');
  }

  return { list, next: hasNext === false ? '' : (cursor || '') };
}

// 采集总榜地址：直到达到目标地址数、本次页数上限或游标到底。返回是否已满足目标。
async function collect(signal) {
  const target = targetCount();

  if (rankedCount() >= target) {
    message(`已缓存总榜前 ${rankedCount()} 名地址，达到目标 ${target}。`);
    return true;
  }

  if (discovery.finished) {
    message('已到接口游标末尾；要重新采集，先重置游标。');
    return true;
  }

  const max = clamp($('maxPages').value, 1, 2000, 200);

  for (let i = 0; i < max; i++) {
    message(`读取总榜第 ${discovery.pages + 1} 页…（已采集总榜 ${rankedCount()} / 目标 ${target} 名）`);
    progress(rankedCount(), target);

    const data = await request('leaderboard', { after: discovery.cursor }, signal);
    const { list, next } = leaderboardPage(data);

    if (next.length > CURSOR_MAX || (next && (next === discovery.cursor || discovery.seen.includes(next)))) {
      throw new Error('分页游标重复或无效，采集不完整。');
    }

    if (!list.length && next) {
      throw new Error('总榜返回空页但仍有游标，已停止。');
    }

    // 整页验证通过后才写入。接口没给名次时，按总榜顺序补上名次：
    // 名次 = 之前各页累计接收条数 + 本页序号（最后一页可能不满一页，不能用页数 × 本页长度）。
    const offset = discovery.received;
    const batch = list.map((item, i) => {
      const a = accountOf(item);
      if (a.rank == null) a.rank = offset + i + 1;
      return a;
    });
    batch.forEach(merge);

    discovery.pages++;
    discovery.received += list.length;
    discovery.cursor = next;
    discovery.finished = !next;
    if (next) discovery.seen.push(next);
    dirtyDiscovery = true;

    log(`接收第 ${discovery.pages} 页：${batch.length} 条；已采集总榜 ${rankedCount()} 名，本机共 ${accounts.size} 个地址。`);

    render();
    await save();

    if (!next) {
      message(`已到接口游标末尾，共采集总榜 ${rankedCount()} 名。`);
      return true;
    }

    if (rankedCount() >= target) {
      message(`已采集总榜前 ${rankedCount()} 名，达到目标 ${target}。`);
      return true;
    }

    await wait(interval(), signal);
  }

  message(`已达到本次采集页数限制（${max} 页），已采集总榜 ${rankedCount()} 名；再点一次继续。`);
  return false;
}

// 一键流程：采集到目标地址数后，自动逐个查询周积分。
async function pipeline(signal) {
  const reached = await collect(signal);

  if (!reached) {
    log('采集未达目标，本次不自动查询；再点“一键”继续。');
    return;
  }

  await wait(interval(), signal);
  await query('stale', signal);
}

function applyPoints(a, json) {
  const body = Array.isArray(json.weeks) ? json : json.data;

  if (!body || !Array.isArray(body.weeks)) {
    throw new Error('积分响应缺少 weeks 数组。');
  }

  const returned = body.address ?? body.wallet;

  if (returned != null && (!validAddress(returned) || returned.toLowerCase() !== a.address.toLowerCase())) {
    throw new Error('响应地址与查询地址不一致。');
  }

  const weeks = weeksOf(body.weeks, true);
  const now = new Date().toISOString();

  a.weeks = mergeWeeks(a.weeks, weeks, now);
  a.status = 'ok';
  a.error = '';
  a.fetchedAt = now;
  a.totalPoints = numeric(body.leaderboard?.total_points ?? body.leaderboard?.totalPoints) ?? a.totalPoints;

  if (typeof body.name === 'string' && body.name) {
    a.name = body.name.slice(0, NAME_MAX);
  }

  touch();
  markDirty(a);
}

// 样本里已经出现的最新结算周（有任一地址该周 calculated=true）。
function latestSettledWeek() {
  let latest = 0;
  for (const a of accounts.values()) {
    if (a.status !== 'ok') continue;
    for (const w of a.weeks) if (settledWeek(w) && w.week > latest) latest = w.week;
  }
  return latest;
}

// 查询范围：pending = 未成功的地址；
// stale = 未成功 + 还没有最新结算周记录的地址（周结算后才查过的地址会带上该周，其余需要补查）；
// all = 全部。
function needsQuery(a, scope, settled = latestSettledWeek()) {
  if (scope === 'all' || a.status !== 'ok') return true;
  if (scope !== 'stale') return false;
  // PNL 没查过、上次失败（如会话过期）、或还没包含最新结算周：补查。
  if (queryPnl() && pnlStale(a, settled)) return true;
  // 支持手续费 / 交易量之前查过的地址：补查一次拿到各周的手续费与交易量。
  if (a.weeks.some(w => !w.droppedAt && (w.paid_fee_usdt === undefined || w.paid_volume_usdt === undefined))) return true;

  if (!settled) {
    const fetched = Date.parse(a.fetchedAt);
    return !Number.isFinite(fetched) || fetched < weekBounds(currentWeekNumber()).start * 1000;
  }

  return !a.weeks.some(w => w.week === settled && settledWeek(w));
}

// 并发查询：多个 worker 共用一个发车时刻表，整体速率 = 1 / 请求间隔，
// 同时在途的请求数 = 并发数。已结算周的数据合并保存，不会重复请求。
// 官网 PNL 失败不影响积分结果，只记录在 a.pnl.error 里。
async function applyPnl(a, signal) {
  const week = currentWeekNumber();
  const updatedAt = new Date().toISOString();

  try {
    const data = await request('pnl', { address: a.address }, signal);
    // 代理没取完整个时序时，数值不完整：保留已得到的周值，但标记错误，下次“更新”会重查。
    const error = data.truncated === true ? '官网时序未取完整，本次数值可能不完整。' : '';

    a.pnl = pnlOf({ cum: cumulativeByWeek(data.points, week), week, total: data.pnlUsd, error, updatedAt });
    if (error) log(`${a.address}：PNL ${error}`);
  } catch (error) {
    if (signal.aborted) throw error;

    // 未交易的地址：官网无时序，记为空时序；下次结算周更新时再查一次。
    const empty = /没有该地址的 PNL 时序/.test(error.message);
    a.pnl = pnlOf({ cum: [], week, error: empty ? '' : error.message, updatedAt });
    if (!empty) log(`${a.address}：PNL ${error.message}`);
    // 致命错误（如会话过期）要停止整批，但这是 PNL 的问题，不该把积分查询成功的地址标成失败。
    if (error.fatal) throw Object.assign(error, { pnl: true });
  } finally {
    markDirty(a);
  }
}

async function query(scope, signal) {
  const topOnly = $('topOnly').checked;
  const target = targetCount();
  const inScope = a => !topOnly || (a.rank != null && a.rank <= target);
  const ranked = [...accounts.values()].filter(inScope);

  if (topOnly && !ranked.length) {
    return message('没有带总榜名次的地址：请先点“一键”或“仅采集”从总榜采集，或取消“只查总榜前 N 名”。');
  }

  const settled = latestSettledWeek();
  const list = ranked.filter(a => needsQuery(a, scope, settled)).sort((x, y) => (x.rank ?? 1e9) - (y.rank ?? 1e9));

  if (!list.length) {
    return message(
      scope === 'stale'
        ? `范围内的 ${ranked.length} 个地址都已包含最新结算周${settled ? `（第 ${settled} 周）` : ''}，没有需要更新的地址。`
        : `范围内的 ${ranked.length} 个地址都已查询成功；要重查请用“重新查询全部地址”。`
    );
  }

  if (topOnly) log(`本轮只查总榜前 ${target} 名：范围内 ${ranked.length} 个地址，待查 ${list.length} 个。`);

  const workers = Math.min(concurrency(), list.length);
  const gap = interval();
  const startedAt = Date.now();

  // 两条发车时刻表：积分接口一条，PNL 接口一条，各自保证 1 / 间隔 的速率。
  const lanes = [0, 0];
  const takeSlot = async (pnl = false) => {
    const lane = pnl ? 1 : 0;
    const now = Date.now();
    const slot = Math.max(now, lanes[lane]);
    lanes[lane] = slot + gap;
    if (slot > now) await wait(slot - now, signal);
  };

  let index = 0;
  let done = 0;
  let failures = 0;
  let streak = 0;
  let lastRender = 0;
  let lastSave = Date.now();
  let stopError = null;

  const worker = async () => {
    while (!stopError && !signal.aborted) {
      const i = index++;
      if (i >= list.length) return;

      const a = list[i];
      await takeSlot();

      try {
        // 积分与 PNL 走不同上游，各自排队、同时发出，互不拖慢。
        const pnlTask = queryPnl() && (scope === 'all' || a.status !== 'ok' || pnlStale(a, settled))
          ? takeSlot(true).then(() => applyPnl(a, signal))
          : null;

        try {
          applyPoints(a, await request('points', { address: a.address }, signal));
          streak = 0;
        } finally {
          if (pnlTask) await pnlTask.catch(error => { if (signal.aborted || error.fatal) throw error; });
        }
      } catch (error) {
        if (signal.aborted) return;

        // PNL 的致命错误只停止整批，不改写该地址的积分查询结果。
        if (!error.pnl) {
          a.status = 'error';
          a.error = error.message;
          touch();
          markDirty(a);
          failures++;
          streak++;
          log(`${a.address}：${error.message}`);
        }

        if (error.fatal || streak >= 3 || error.code === 429) {
          stopError = new Error('已暂停批量查询：' + error.message);
          return;
        }
      }

      done++;

      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(elapsed, 1);
      const eta = Math.round((list.length - done) / Math.max(rate, 0.01));
      message(`查询 ${done}/${list.length}（${workers} 并发，约 ${rate.toFixed(1)} 个/秒，剩余约 ${eta} 秒）`);
      progress(done, list.length);

      // 地址很多时，渲染按时间节流，避免每次都重算整表；样本越大，整表重算越贵，间隔拉长。
      // 落盘只写本轮改过的地址，很便宜，可以频繁一些，缩小意外关闭时的丢失窗口。
      const renderEvery = accounts.size > 20000 ? 15000 : accounts.size > 5000 ? 8000 : 3000;

      if (done === 1 || Date.now() - lastRender > renderEvery) {
        render();
        lastRender = Date.now();
      }

      if (Date.now() - lastSave > SAVE_EVERY) {
        lastSave = Date.now();
        await save();
      }
    }
  };

  // 等所有 worker 真正结束再返回：停止后不会有 worker 还在后台改数据、重绘或落盘。
  const results = await Promise.allSettled(Array.from({ length: workers }, worker));

  if (signal.aborted) throw abortError();
  if (stopError) throw stopError;

  const crashed = results.find(r => r.status === 'rejected');
  if (crashed) throw crashed.reason;

  message(`本轮查询结束：成功 ${done - failures} 个，失败 ${failures} 个。切换周或榜单无需重新查询。`);
}

/* ---------- 导入导出 ---------- */

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });

  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function csvCell(value) {
  let text = value != null && typeof value === 'object' ? decimalString(value) : String(value ?? '');

  // 避免名称或其他文本被表格软件当作公式执行；纯数字（含负数）不加前缀。
  if (/^[\s\p{Cc}]*[=+\-@]/u.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;

  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCSV(name, rows) {
  download(name, BOM + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}

function exportCSV() {
  render();

  const mode = $('mode').value;
  // 依赖所选周的榜单。
  const weekly = ['week', 'pnl', 'fee', 'cpp', 'volume'].includes(mode);

  if (weekly && !activeWeek) {
    return message('暂无可导出的周；先查询地址或选择已有周。');
  }

  const rows = [[
    '榜单', '排序', '所选周', '排名', '总榜名次', '名称', '钱包地址', '周积分', '推荐积分', '周交易量_USD', '付费交易量_USD', '免费交易量_USD', '周手续费_USD', '全部手续费_USD', '积分成本_USD每积分', '手续费折扣', '周PNL_USD', '官网累计PNL_USD', '已结算周合计', '已结算周数',
    '累计总积分（最近查询值）', '所选周状态', '错误', '采集时间UTC', '周开始原值', '周结束原值'
  ]];

  for (const r of lastRows) {
    const ok = r.a.status === 'ok';

    rows.push([
      MODES[mode].label, $('order').value === 'asc' ? '升序' : '降序', activeWeek || '', r.rank, r.a.rank ?? '', r.a.name, r.a.address,
      ok ? r.w?.points : '', ok ? r.w?.referral_points : '',
      r.volume ? decimalString(r.volume) : '', ok ? r.w?.paid_volume_usdt ?? '' : '', ok ? r.w?.free_volume_usdt ?? '' : '',
      r.fee ? decimalString(r.fee) : '', r.feeAll ? decimalString(r.feeAll) : '',
      Number.isFinite(r.cpp) ? r.cpp : '', decimalString(feeMultiplier()), r.pnl ?? '', r.a.pnl?.total ?? '',
      r.sum, r.count, r.a.totalPoints, r.state, r.a.error, r.a.fetchedAt, r.w?.week_start, r.w?.week_end
    ]);
  }

  const order = $('order').value === 'asc' ? '-asc' : '';
  const name = mode === 'week' ? `predict-week-${activeWeek}${order}-sample.csv` : `predict-${MODES[mode].file}${activeWeek && weekly ? `-week-${activeWeek}` : ''}${order}-sample.csv`;
  downloadCSV(name, rows);

  message(`已导出「${MODES[mode].label}」榜单的全部 ${lastRows.length} 个地址，不受页面筛选和分页影响。`);
}

// 长表：每个地址每一周一行，含该周样本排名。
function exportAllCSV() {
  const items = [];
  const mul = feeMultiplier();

  for (const a of accounts.values()) {
    for (const w of a.weeks) {
      const key = stateOf(a, w);
      let rank = '';
      let ranked = '';

      if (key === 'ok') {
        const entry = weekRanking(w.week);
        rank = entry.ranks.get(a);
        ranked = entry.ranked;
      }

      const fee = feeOf(w, mul);
      const volume = volumeOf(w);

      items.push({
        week: w.week, rank, address: a.address,
        cells: [
          w.week, periodText(w.week, w), rank, ranked, a.name, a.address, w.points, w.referral_points,
          volume ? decimalString(volume) : '', w.paid_volume_usdt ?? '', w.free_volume_usdt ?? '',
          w.paid_fee_usdt ?? '', fee ? decimalString(fee) : '', weekPnl(a, w.week) ?? '',
          STATES[key][0], w.week_start, w.week_end, w.updatedAt
        ]
      });
    }
  }

  if (!items.length) {
    return message('还没有任何周数据可导出。');
  }

  items.sort((x, y) =>
    y.week - x.week ||
    (x.rank || 1e9) - (y.rank || 1e9) ||
    (x.address < y.address ? -1 : x.address > y.address ? 1 : 0)
  );

  downloadCSV('predict-all-weeks-sample.csv', [
    ['周', '周期（北京时间）', '样本周排名', '该周可排名地址数', '名称', '钱包地址', '周积分', '推荐积分', '周交易量_USD', '付费交易量_USD', '免费交易量_USD', '周手续费原值_USD', '周手续费_USD（已打折）', '周PNL_USD', '状态', '周开始原值', '周结束原值', '数据更新时间UTC'],
    ...items.map(item => item.cells)
  ]);

  message(`已导出 ${weekSummaries().length} 周共 ${items.length} 条周记录。`);
}

function addAddresses(text) {
  const found = text.match(/\b0x[0-9a-fA-F]{40}\b/g) || [];

  if (!found.length) {
    throw new Error('未找到有效的 0x 钱包地址。');
  }

  const before = accounts.size;
  found.forEach(address => merge(accountOf(address)));

  message(`新增 ${accounts.size - before} 个地址，当前共 ${accounts.size} 个。`);
}

async function importFile(file) {
  if (!file) return;

  if (file.size > IMPORT_MAX) {
    throw new Error(`文件超过 ${IMPORT_MAX / 1048576} MB，已停止导入。`);
  }

  const text = await file.text();

  if (file.name.toLowerCase().endsWith('.json')) {
    const data = parseJSON(text);

    if (data?.app === APP) {
      if (accounts.size && !confirm('恢复断点将替换当前数据，是否继续？')) return;

      restore(data);
      return message(`已恢复 ${accounts.size} 个地址及采集进度。`);
    }
  }

  // 普通 TXT、CSV、JSON 仅提取钱包地址。
  addAddresses(text);
}

/* ---------- 事件绑定 ---------- */

$('collect').onclick = () => run(collect, true);
$('pipeline').onclick = () => run(pipeline, true);
$('query').onclick = () => run(signal => query('pending', signal), true);
$('update').onclick = () => run(signal => query('stale', signal), true);
$('refresh').onclick = () => run(signal => query('all', signal), true);
$('stop').onclick = () => task?.abort();
$('csv').onclick = exportCSV;
$('csvAll').onclick = exportAllCSV;

$('password').onkeydown = event => {
  if (event.key === 'Enter') $('query').click();
};

// 打开页面自动填上上次的密码；每次改动都保存，清空则忘记。
try {
  const saved = localStorage.getItem(PASSWORD_KEY);
  if (saved) $('password').value = saved;
} catch {}

$('password').oninput = () => {
  try {
    const value = $('password').value;
    if (value) localStorage.setItem(PASSWORD_KEY, value);
    else localStorage.removeItem(PASSWORD_KEY);
  } catch {}
};

$('add').onclick = () => run(async () => {
  addAddresses($('addresses').value);
  $('addresses').value = '';
});

$('resetCursor').onclick = () => run(async () => {
  if (!confirm('重置总榜采集进度？已查询的地址和积分会保留。')) return;

  discovery = emptyDiscovery();
  dirtyDiscovery = true;
  message('总榜游标已重置。');
});

$('clear').onclick = () => run(async () => {
  if (!confirm('清空当前浏览器缓存的所有地址、积分和游标？请先导出备份。')) return;

  accounts.clear();
  discovery = emptyDiscovery();
  touch();
  dirty.clear();
  resetStore = true;
  dirtyDiscovery = true;
  $('lookupResult').innerHTML = '<p class="muted">数据已清空。</p>';
  message('已清空。');
});

// 紧凑 JSON：带缩进的文件会大两倍以上，大样本时可能超出字符串长度上限而失败。
$('backup').onclick = () => {
  try {
    download('predict-weekly-backup.json', JSON.stringify(snapshot()), 'application/json');
    message(`已导出断点 JSON：${accounts.size} 个地址。`);
  } catch (error) {
    message(`导出断点失败：${error.message}`);
  }
};

$('import').onclick = () => {
  $('file').value = '';
  $('file').click();
};

$('file').onchange = () => run(() => importFile($('file').files[0]));

$('mode').onchange = $('order').onchange = $('week').onchange = $('settled').onchange = () => {
  page = 1;
  render();
};

try {
  const saved = localStorage.getItem(FEE_MUL_KEY);
  if (saved && decimal(saved)) $('feeMul').value = saved;
} catch {}

$('feeMul').onchange = () => {
  try { localStorage.setItem(FEE_MUL_KEY, $('feeMul').value.trim()); } catch {}
  touch(); // 历史周概览里的手续费合计按折扣缓存，改折扣后重算。
  render();
};

let searchTimer = 0;

$('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 1;
    render();
  }, 150);
};

$('prev').onclick = () => { page--; render(); };
$('next').onclick = () => { page++; render(); };

// 点击主表中的名称 → 查看该地址各周积分与排名；地址本身是跳转 predict.fun 的链接。
$('tbody').onclick = event => {
  const cell = event.target.closest('td.name-link');
  if (cell) showLookup(cell.parentElement.querySelector('td.addr').textContent.trim());
};

// 点击表头：切换到该列的榜单；再点同一列切换升降序。
document.querySelector('#ranking thead').onclick = event => {
  const th = event.target.closest('th[data-basis]');
  if (!th) return;

  if ($('mode').value === th.dataset.basis) {
    $('order').value = $('order').value === 'asc' ? 'desc' : 'asc';
  } else {
    $('mode').value = th.dataset.basis;
    $('order').value = MODES[th.dataset.basis]?.ascending ? 'asc' : 'desc';
  }

  page = 1;
  render();
};

// 历史周概览中的“查看周排名”。
$('weeksBody').onclick = event => {
  const button = event.target.closest('button[data-week]');
  if (!button) return;

  $('mode').value = 'week';
  $('week').value = button.dataset.week;
  page = 1;
  render();
  $('ranking').scrollIntoView({ block: 'start' });
};

$('lookupBtn').onclick = () => lookup();
$('lookup').onkeydown = event => {
  if (event.key === 'Enter') lookup();
};

window.addEventListener('beforeunload', event => {
  if (task) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ---------- 启动 ---------- */

(async function init() {
  setLocked(true);

  try {
    db = await openDB();

    // 其他标签页升级了数据库结构时主动让出连接，避免互相阻塞。
    db.onversionchange = () => {
      db.close();
      db = null;
      $('storage').textContent = '本站其他标签页更新了缓存结构，请刷新本页；刷新前的改动不会再自动保存。';
    };

    await load();

    message(accounts.size ? `已恢复本机缓存：${accounts.size} 个地址。` : '先添加地址或采集总榜，再查询历史积分。');
  } catch (error) {
    message('未恢复缓存，可以重新导入地址或断点 JSON。');
    $('storage').textContent = `浏览器缓存不可用（${error?.message || error}），请手动导出断点保存。`;
  }

  setLocked(false);
  render();
})();
