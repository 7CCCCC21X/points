// 各 GraphQL 代理共用：EIP-55 校验和地址、带总预算的 predict.fun GraphQL 请求。
// 文件名以下划线开头，Vercel 不会把它当成路由。
// 可选环境变量：PREDICT_GRAPHQL_URL、PREDICT_GRAPHQL_AUTH、PREDICT_GRAPHQL_COOKIE、PREDICT_UPSTREAM_TIMEOUT_MS。
// 账户级数据需要登录会话：从已登录的 predict.fun 页面 DevTools → Network 复制
// GraphQL 请求头里的 authorization 和 cookie，配置到 Vercel 环境变量。

const DEFAULT_GRAPHQL_URL = 'https://graphql.predict.fun/graphql';
export const UPSTREAM_TIMEOUT = Math.max(1000, Number(process.env.PREDICT_UPSTREAM_TIMEOUT_MS || 8000));
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

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

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const isTimeout = e => e && (e.name === 'TimeoutError' || e.name === 'AbortError');
export const timeoutError = (message = '官网 GraphQL 请求超时。') => Object.assign(new Error(message), { status: 504, timeout: true });

// deadline：本次代理请求的总截止时刻（毫秒），单次上游超时不会越过它。
// 抛出的 Error 带 status：503 = 会话缺失/过期（配置问题）、429 = 上游限流、504 = 超时、502 = 其他；graphql: true 表示 GraphQL 层错误。
export async function predictGraphql({ query, variables, operationName }, deadline) {
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
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();

    // 只在预算还够再来一次时才重试。
    const canRetry = attempt === 0 && remaining > UPSTREAM_TIMEOUT / 2;

    try {
      upstream = await fetch(process.env.PREDICT_GRAPHQL_URL || DEFAULT_GRAPHQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables, operationName }),
        signal: AbortSignal.timeout(Math.min(UPSTREAM_TIMEOUT, remaining))
      });
    } catch (e) {
      if (canRetry) { await sleep(500); continue; }
      if (isTimeout(e)) throw timeoutError();
      throw Object.assign(new Error('无法连接官网 GraphQL。'), { status: 504 });
    }

    if (RETRYABLE_STATUS.has(upstream.status) && canRetry) {
      // 不读的响应体要取消，否则连接会挂到被回收为止。
      await upstream.body?.cancel().catch(() => {});
      await sleep(500);
      continue;
    }
    break;
  }

  let text;
  try {
    text = await upstream.text();
  } catch (e) {
    if (isTimeout(e)) throw timeoutError();
    throw Object.assign(new Error('读取官网 GraphQL 响应失败。'), { status: 502 });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    // 503 = 服务端配置问题（与 weekly.js 缺 API Key 一致），前端据此立即停止整批查询，而不是逐个地址重试。
    throw Object.assign(
      new Error(`官网 GraphQL 拒绝会话（HTTP ${upstream.status}）：PREDICT_GRAPHQL_AUTH / PREDICT_GRAPHQL_COOKIE 缺失或已过期，请在 Vercel 更新。`),
      { status: 503 }
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
