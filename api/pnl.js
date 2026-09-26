// 官网 PNL 时序代理：/api/pnl?address=0x...
// 移植自 yuce 的 /api/portfolio-pnl：调用 predict.fun GraphQL 的
// GetAccountPnlTimeseries（interval=MAX，即官网“全部”档），跟随分页取完整时序，
// 返回 { success, address, pnlUsd, timestamp, points: [{ x, y }] }。
// 前端用 points 按周起止时间切分出每周 PNL。
//
// 可选环境变量：PREDICT_GRAPHQL_URL、PREDICT_GRAPHQL_AUTH、PREDICT_GRAPHQL_COOKIE。
// 账户级数据需要登录会话：从已登录的 predict.fun 页面 DevTools → Network 复制
// GraphQL 请求头里的 authorization 和 cookie，配置到 Vercel 环境变量。

import { ADDRESS_RE, reply, authorize, createThrottle } from './_shared.js';

const DEFAULT_GRAPHQL_URL = 'https://graphql.predict.fun/graphql';
const UPSTREAM_TIMEOUT = Math.max(1000, Number(process.env.PREDICT_UPSTREAM_TIMEOUT_MS || 8000));
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_PAGES = 25;

// 官网“全部（ALL）”档实际发送的枚举名是 MAX；保留候选回退链以防上游改名。
const ALL_INTERVAL_CANDIDATES = ['MAX', 'ALL', '_ALL', '_MAX', 'ALL_TIME'];
let resolvedAllInterval = 'MAX';

const throttle = createThrottle(8, 8);

const QUERY = `query GetAccountPnlTimeseries($address: Address!, $filter: TimeseriesFilterInput!, $pagination: ForwardPaginationInput) {
  account(address: $address) {
    pnlTimeseries(filter: $filter, pagination: $pagination) {
      pageInfo { hasNextPage endCursor }
      edges { cursor node { x y } }
    }
  }
}`;

/* ---------- keccak256 / EIP-55（GraphQL 的 account(address:) 需要校验和地址） ---------- */

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const KECCAK_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const U64 = (1n << 64n) - 1n;

export function keccak256(bytes) {
  const rotl = (x, n) => { n = BigInt(n % 64); return n === 0n ? x : ((x << n) | (x >> (64n - n))) & U64; };
  const rate = 136;
  const p = [...bytes, 0x01];
  while (p.length % rate !== 0) p.push(0);
  p[p.length - 1] |= 0x80;
  const st = new Array(25).fill(0n);

  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) lane |= BigInt(p[off + i * 8 + j]) << (8n * BigInt(j));
      st[i] ^= lane;
    }

    for (let round = 0; round < 24; round++) {
      const bc = new Array(5);
      for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
      for (let i = 0; i < 5; i++) {
        const t = bc[(i + 4) % 5] ^ rotl(bc[(i + 1) % 5], 1);
        for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
      }
      let t = st[1];
      for (let i = 0; i < 24; i++) {
        const j = KECCAK_PILN[i];
        const tmp = st[j];
        st[j] = rotl(t, KECCAK_ROTC[i]);
        t = tmp;
      }
      for (let j = 0; j < 25; j += 5) {
        const c = [st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4]];
        for (let i = 0; i < 5; i++) st[j + i] = c[i] ^ ((~c[(i + 1) % 5] & U64) & c[(i + 2) % 5]);
      }
      st[0] ^= KECCAK_RC[round];
    }
  }

  let out = '';
  for (let i = 0; i < 32; i++) out += Number((st[i >> 3] >> (8n * BigInt(i & 7))) & 0xffn).toString(16).padStart(2, '0');
  return out;
}

export function toChecksumAddress(address) {
  const lower = String(address).toLowerCase().replace(/^0x/, '');
  const hash = keccak256([...lower].map(c => c.charCodeAt(0)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    out += /[a-f]/.test(c) && parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/* ---------- GraphQL ---------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function predictGraphql(variables) {
  const headers = {
    Accept: 'application/graphql-response+json, application/json',
    'Content-Type': 'application/json',
    Origin: 'https://predict.fun',
    Referer: 'https://predict.fun/',
    'x-accept-language': 'zh-CN'
  };

  if (process.env.PREDICT_GRAPHQL_AUTH) headers.Authorization = process.env.PREDICT_GRAPHQL_AUTH;
  if (process.env.PREDICT_GRAPHQL_COOKIE) headers.Cookie = process.env.PREDICT_GRAPHQL_COOKIE;

  let upstream = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      upstream = await fetch(process.env.PREDICT_GRAPHQL_URL || DEFAULT_GRAPHQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: QUERY, variables, operationName: 'GetAccountPnlTimeseries' }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT)
      });
    } catch (e) {
      if (attempt === 0) { await sleep(500); continue; }
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw Object.assign(new Error(timedOut ? '官网 PNL 上游请求超时。' : '无法连接官网 GraphQL。'), { status: 504 });
    }

    if (RETRYABLE_STATUS.has(upstream.status) && attempt === 0) { await sleep(500); continue; }
    break;
  }

  const text = await upstream.text();

  if (upstream.status === 401 || upstream.status === 403) {
    throw Object.assign(
      new Error(`官网 GraphQL 拒绝会话（HTTP ${upstream.status}）：PREDICT_GRAPHQL_AUTH / PREDICT_GRAPHQL_COOKIE 缺失或已过期，请在 Vercel 更新。`),
      { status: 502 }
    );
  }

  if (upstream.status === 429) {
    throw Object.assign(new Error('官网 GraphQL 限流，请降低查询速度。'), { status: 429 });
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw Object.assign(new Error('官网 GraphQL 返回的不是 JSON。'), { status: upstream.status || 502 });
  }

  if (!upstream.ok || Array.isArray(json?.errors)) {
    throw Object.assign(
      new Error(json?.errors?.[0]?.message || upstream.statusText || 'GraphQL 请求失败'),
      { status: upstream.status || 502, graphql: true }
    );
  }

  return json;
}

const isIntervalEnumError = err =>
  err?.graphql && /interval|TimeseriesInterval|enum/i.test(err.message) && /invalid|does not exist|cannot represent|expected/i.test(err.message);

// 跟随 hasNextPage 翻页取完整时序。
async function fetchTimeseries(address, interval) {
  const points = [];
  let after = null;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const json = await predictGraphql({
      address,
      filter: { interval },
      ...(after ? { pagination: { after } } : {})
    });

    pages++;

    const ts = json?.data?.account?.pnlTimeseries;

    for (const edge of ts?.edges || []) {
      const x = Number(edge?.node?.x ?? edge?.cursor);
      const y = Number(edge?.node?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }

    if (!ts?.pageInfo?.hasNextPage || !ts.pageInfo.endCursor) break;
    after = ts.pageInfo.endCursor;
    if (pages >= MAX_PAGES) truncated = true;
  }

  points.sort((a, b) => a.x - b.x);
  return { points, truncated };
}

async function fetchWithAllFallback(address) {
  const candidates = [...new Set([resolvedAllInterval, ...ALL_INTERVAL_CANDIDATES])];
  let lastErr = null;

  for (const candidate of candidates) {
    try {
      const result = await fetchTimeseries(address, candidate);
      resolvedAllInterval = candidate;
      return { ...result, interval: candidate };
    } catch (err) {
      lastErr = err;
      if (!isIntervalEnumError(err)) throw err;
    }
  }

  throw lastErr;
}

export default async function handler(req, res) {
  const fail = (status, error, retryAfter) => reply(res, status, { success: false, error }, retryAfter);

  const denied = authorize(req, res);
  if (denied) return fail(...denied);

  const q = new URL(req.url, 'https://localhost').searchParams;

  for (const k of q.keys()) {
    if (k !== 'address' || q.getAll(k).length !== 1) return fail(400, '参数无效或重复。');
  }

  const raw = q.get('address') || '';
  if (!ADDRESS_RE.test(raw)) return fail(400, '钱包地址格式错误。');

  const address = toChecksumAddress(raw);

  if (throttle.acquire()) return fail(429, '请求过快，请稍后继续。', 1);

  try {
    const { points, truncated, interval } = await fetchWithAllFallback(address);

    if (!points.length) {
      return reply(res, 200, { success: false, address, interval, error: '官网没有该地址的 PNL 时序（可能未交易）。', empty: true });
    }

    const latest = points[points.length - 1];

    return reply(res, 200, {
      success: true,
      address,
      interval,
      pnlUsd: latest.y,
      timestamp: latest.x,
      pointCount: points.length,
      ...(truncated ? { truncated: true } : {}),
      points
    });
  } catch (err) {
    const status = [429, 502, 504].includes(err?.status) ? err.status : 502;
    return fail(status, err?.message || '官网 PNL 代理失败。', status === 429 ? 2 : 0);
  } finally {
    throttle.release();
  }
}
