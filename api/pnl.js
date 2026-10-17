// 官网 PNL 时序代理：/api/pnl?address=0x...
// 移植自 yuce 的 /api/portfolio-pnl：调用 predict.fun GraphQL 的
// GetAccountPnlTimeseries（interval=MAX，即官网“全部”档），跟随分页取完整时序，
// 返回 { success, address, pnlUsd, timestamp, points: [{ x, y }] }。
// 前端用 points 按周界切分出每周 PNL，本机只保存各周界的累计值。
//
// 可选环境变量见 _graphql.js；另有 PREDICT_TOTAL_BUDGET_MS（整次请求总预算，默认 20000）。

import { ADDRESS_RE, reply, authorize, createThrottle } from './_shared.js';
import { keccak256, toChecksumAddress, predictGraphql, timeoutError } from './_graphql.js';

export { keccak256, toChecksumAddress };

// 整次请求（含翻页与重试）的总预算：vercel.json 里 maxDuration 是 30 秒，超时会被平台杀掉并返回非 JSON 错误页，
// 这里主动在预算内停下，返回已取到的部分并标记 truncated。
const TOTAL_BUDGET = Math.max(5000, Number(process.env.PREDICT_TOTAL_BUDGET_MS || 20000));
const MAX_PAGES = 25;

// 官网“全部（ALL）”档实际发送的枚举名是 MAX；保留候选回退链以防上游改名。
const ALL_INTERVAL_CANDIDATES = ['MAX', 'ALL', '_ALL', '_MAX', 'ALL_TIME'];
let resolvedAllInterval = 'MAX';

const throttle = createThrottle(15, 15);

const QUERY = `query GetAccountPnlTimeseries($address: Address!, $filter: TimeseriesFilterInput!, $pagination: ForwardPaginationInput) {
  account(address: $address) {
    pnlTimeseries(filter: $filter, pagination: $pagination) {
      pageInfo { hasNextPage endCursor }
      edges { cursor node { x y } }
    }
  }
}`;

const graphql = (variables, deadline) =>
  predictGraphql({ query: QUERY, variables, operationName: 'GetAccountPnlTimeseries' }, deadline);

const isIntervalEnumError = err =>
  err?.graphql && /interval|TimeseriesInterval|enum/i.test(err.message) && /invalid|does not exist|cannot represent|expected/i.test(err.message);

// 跟随 hasNextPage 翻页取完整时序；超出页数上限或总预算时停下并标记 truncated。
async function fetchTimeseries(address, interval, deadline) {
  const points = [];
  let after = null;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    if (Date.now() >= deadline) { truncated = true; break; }

    let json;
    try {
      json = await graphql({
        address,
        filter: { interval },
        ...(after ? { pagination: { after } } : {})
      }, deadline);
    } catch (err) {
      // 已经取到一部分时，超时只截断而不整体失败。
      if (err?.timeout && points.length) { truncated = true; break; }
      throw err;
    }

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

async function fetchWithAllFallback(address, deadline) {
  const candidates = [...new Set([resolvedAllInterval, ...ALL_INTERVAL_CANDIDATES])];
  let lastErr = null;

  for (const candidate of candidates) {
    try {
      const result = await fetchTimeseries(address, candidate, deadline);
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
    const { points, truncated, interval } = await fetchWithAllFallback(address, Date.now() + TOTAL_BUDGET);

    // 一页都没取到就超时：是超时不是“未交易”，交给前端重试。
    if (truncated && !points.length) throw timeoutError('官网 PNL 上游请求超时。');

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
    const status = [429, 502, 503, 504].includes(err?.status) ? err.status : 502;
    return fail(status, err?.message || '官网 PNL 代理失败。', status === 429 ? 2 : 0);
  } finally {
    throttle.release();
  }
}
