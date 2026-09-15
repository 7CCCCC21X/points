import { createHash, timingSafeEqual } from 'node:crypto';

// 只读代理：不接收私钥、不签名、不下单。
// 目标地址固定，不能用作任意 URL 代理。

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const POINTS_API = 'https://indexer.predalpha.xyz/api/predict/points/';
const LEADERBOARD_API = 'https://api.predict.fun/v1/leaderboard';
const LEADERBOARD_PAGE = '100';

const PASSWORD_MIN = 16;
const PASSWORD_MAX = 1024;
const CURSOR_MAX = 4096;
const BODY_MAX = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT = 18000;

// 实例级保护，不是跨实例的全局限流。公开使用还应配置 Vercel WAF。
const RATE_PER_SECOND = 8;
const MAX_CONCURRENT = 8;
const hits = [];
let active = 0;

const sha256 = value => createHash('sha256').update(value).digest();
const sameSecret = (a, b) => timingSafeEqual(sha256(a), sha256(b));

function reply(res, status, body, retryAfter) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function throttled() {
  const now = Date.now();
  while (hits.length && hits[0] <= now - 1000) hits.shift();

  if (hits.length >= RATE_PER_SECOND || active >= MAX_CONCURRENT) return true;

  hits.push(now);
  return false;
}

// 上游 Retry-After 可能是秒数或 HTTP 日期；缺失按 1 秒，无法解析按 5 秒。
function retryAfterSeconds(raw) {
  if (!raw) return 1;

  const seconds = Number.isFinite(Number(raw))
    ? Number(raw)
    : (Date.parse(raw) - Date.now()) / 1000;

  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 5;
}

function upstreamError(status, action) {
  const leaderboard = action === 'leaderboard';

  if (status === 404) {
    return leaderboard
      ? '官方总榜路由返回 404：不能确认该接口当前可用。请先导入地址。'
      : '第三方积分接口或该地址的数据不存在（404），不会记成 0 分。';
  }

  if (status === 401 || status === 403) {
    return leaderboard
      ? '官方总榜鉴权失败，请核对 API Key 和接口访问权限。'
      : '第三方积分服务拒绝访问。';
  }

  if (status === 429) return '上游限流，请降低查询速度。';

  return `上游返回 HTTP ${status}。`;
}

// 读取正文，超过上限返回 null。
async function readLimited(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.length;

    if (size > limit) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

// 根据查询参数决定上游地址；失败时返回 { error: [status, message] }。
function resolveTarget(q) {
  const action = q.get('action');
  const allowed = action === 'points' ? ['action', 'address'] : ['action', 'after'];

  for (const k of q.keys()) {
    if (!allowed.includes(k) || q.getAll(k).length !== 1) {
      return { error: [400, '参数无效或重复。'] };
    }
  }

  if (action === 'points') {
    const address = q.get('address') || '';

    if (!ADDRESS_RE.test(address)) {
      return { error: [400, '钱包地址格式错误。'] };
    }

    return { action, url: POINTS_API + address, headers: { Accept: 'application/json' } };
  }

  if (action === 'leaderboard') {
    const key = (process.env.PREDICT_API_KEY || '').trim();

    if (!key) {
      return { error: [503, '服务端未配置 PREDICT_API_KEY；也可先导入钱包地址查询。'] };
    }

    const after = q.get('after') || '';

    if (after.length > CURSOR_MAX || /[\x00-\x1f]/.test(after)) {
      return { error: [400, '分页游标无效。'] };
    }

    // 此路由的权限及 first / after 参数仍需真实 API Key 联调。
    const target = new URL(LEADERBOARD_API);
    target.searchParams.set('first', LEADERBOARD_PAGE);
    if (after) target.searchParams.set('after', after);

    return { action, url: target.href, headers: { Accept: 'application/json', 'x-api-key': key } };
  }

  return { error: [400, 'action 必须是 points 或 leaderboard。'] };
}

export default async function handler(req, res) {
  const fail = (status, error, retryAfter) =>
    reply(res, status, { success: false, error }, retryAfter);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(405, '仅允许 GET 请求。');
  }

  const password = process.env.SITE_PASSWORD || '';

  if (password.length < PASSWORD_MIN) {
    return fail(503, `请在 Vercel 设置至少 ${PASSWORD_MIN} 位 SITE_PASSWORD 后重新部署。`);
  }

  const supplied = req.headers['x-site-password'];

  if (typeof supplied !== 'string' || supplied.length > PASSWORD_MAX || !sameSecret(supplied, password)) {
    return fail(401, '网页访问密码错误；这里填写 SITE_PASSWORD，不是 API Key。');
  }

  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return fail(403, '请从自己的 Vercel 网页发起请求。');
      }
    } catch {
      return fail(403, '无效 Origin。');
    }
  }

  const target = resolveTarget(new URL(req.url, 'https://localhost').searchParams);

  if (target.error) return fail(...target.error);

  if (throttled()) return fail(429, '请求过快，请稍后继续。', 1);

  active++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const upstream = await fetch(target.url, {
      headers: target.headers,
      signal: controller.signal,
      redirect: 'error'
    });

    if (!upstream.ok) {
      await upstream.body?.cancel();

      return fail(
        upstream.status,
        upstreamError(upstream.status, target.action),
        upstream.status === 429 ? retryAfterSeconds(upstream.headers.get('retry-after')) : 0
      );
    }

    if (!upstream.body) return fail(502, '上游没有返回正文。');

    const text = await readLimited(upstream.body, BODY_MAX);

    if (text === null) return fail(502, '上游单次响应超过 2 MB，已停止。');

    try {
      JSON.parse(text);
    } catch {
      return fail(502, '上游返回的不是 JSON，可能是拦截页。');
    }

    // 原文透传，不把高精度积分重新序列化为浮点数。
    return reply(res, 200, text);
  } catch {
    return controller.signal.aborted
      ? fail(504, '上游请求超时。')
      : fail(502, '无法连接上游，或上游发生了重定向。');
  } finally {
    clearTimeout(timer);
    active--;
  }
}
