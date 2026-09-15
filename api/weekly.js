import { createHash, timingSafeEqual } from 'node:crypto';

// 只读代理：不接收私钥、不签名、不下单。
// 目标地址固定，不能用作任意 URL 代理。
const hits = [];
let active = 0;

const hash = value =>
  createHash('sha256').update(value).digest();

function reply(res, status, body, retryAfter) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
  }

  res.end(
    typeof body === 'string'
      ? body
      : JSON.stringify(body)
  );
}

export default async function handler(req, res) {
  const fail = (status, error, retryAfter) =>
    reply(res, status, { success: false, error }, retryAfter);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(405, '仅允许 GET 请求。');
  }

  const password = process.env.SITE_PASSWORD || '';

  if (password.length < 16) {
    return fail(
      503,
      '请在 Vercel 设置至少 16 位 SITE_PASSWORD 后重新部署。'
    );
  }

  const supplied = req.headers['x-site-password'];

  if (
    typeof supplied !== 'string' ||
    supplied.length > 1024 ||
    !timingSafeEqual(hash(supplied), hash(password))
  ) {
    return fail(
      401,
      '网页访问密码错误；这里填写 SITE_PASSWORD，不是 API Key。'
    );
  }

  if (req.headers.origin) {
    try {
      if (
        new URL(req.headers.origin).host !== req.headers.host
      ) {
        return fail(
          403,
          '请从自己的 Vercel 网页发起请求。'
        );
      }
    } catch {
      return fail(403, '无效 Origin。');
    }
  }

  const q = new URL(
    req.url,
    'https://localhost'
  ).searchParams;

  const action = q.get('action');

  const allowed =
    action === 'points'
      ? ['action', 'address']
      : ['action', 'after'];

  for (const k of q.keys()) {
    if (
      !allowed.includes(k) ||
      q.getAll(k).length !== 1
    ) {
      return fail(400, '参数无效或重复。');
    }
  }

  let url;

  const headers = {
    Accept: 'application/json'
  };

  if (action === 'points') {
    const address = q.get('address') || '';

    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return fail(400, '钱包地址格式错误。');
    }

    url =
      `https://indexer.predalpha.xyz/api/predict/points/${address}`;

  } else if (action === 'leaderboard') {
    const key = (
      process.env.PREDICT_API_KEY || ''
    ).trim();

    if (!key) {
      return fail(
        503,
        '服务端未配置 PREDICT_API_KEY；也可先导入钱包地址查询。'
      );
    }

    const after = q.get('after') || '';

    if (
      after.length > 4096 ||
      /[\x00-\x1f]/.test(after)
    ) {
      return fail(400, '分页游标无效。');
    }

    // 此路由的权限及 first / after 参数
    // 仍需真实 API Key 联调。
    const target = new URL(
      'https://api.predict.fun/v1/leaderboard'
    );

    target.searchParams.set('first', '100');

    if (after) {
      target.searchParams.set('after', after);
    }

    url = target.href;
    headers['x-api-key'] = key;

  } else {
    return fail(
      400,
      'action 必须是 points 或 leaderboard。'
    );
  }

  // 实例级保护，不是跨实例的全局限流。
  // 公开使用还应配置 Vercel WAF。
  const now = Date.now();

  while (
    hits.length &&
    hits[0] <= now - 1000
  ) {
    hits.shift();
  }

  if (
    hits.length >= 3 ||
    active >= 3
  ) {
    return fail(
      429,
      '请求过快，请稍后继续。',
      1
    );
  }

  hits.push(now);
  active++;

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    18000
  );

  try {
    const upstream = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'error'
    });

    if (!upstream.ok) {
      let message =
        `上游返回 HTTP ${upstream.status}。`;

      if (upstream.status === 404) {
        message =
          action === 'leaderboard'
            ? '官方总榜路由返回 404：不能确认该接口当前可用。请先导入地址。'
            : '第三方积分接口或该地址的数据不存在（404），不会记成 0 分。';
      }

      if (
        [401, 403].includes(upstream.status)
      ) {
        message =
          action === 'leaderboard'
            ? '官方总榜鉴权失败，请核对 API Key 和接口访问权限。'
            : '第三方积分服务拒绝访问。';
      }

      let retry = 0;

      if (upstream.status === 429) {
        message = '上游限流，请降低查询速度。';

        const raw =
          upstream.headers.get('retry-after');

        retry = raw
          ? (
              Number.isFinite(Number(raw))
                ? Number(raw)
                : (
                    Date.parse(raw) - Date.now()
                  ) / 1000
            )
          : 0;

        retry = Number.isFinite(retry)
          ? Math.max(1, Math.ceil(retry))
          : 5;
      }

      await upstream.body?.cancel();

      return fail(
        upstream.status,
        message,
        retry
      );
    }

    const reader =
      upstream.body?.getReader();

    if (!reader) {
      return fail(
        502,
        '上游没有返回正文。'
      );
    }

    let size = 0;
    const chunks = [];

    while (true) {
      const {
        done,
        value
      } = await reader.read();

      if (done) break;

      size += value.length;

      if (size > 2 * 1024 * 1024) {
        await reader.cancel();

        return fail(
          502,
          '上游单次响应超过 2 MB，已停止。'
        );
      }

      chunks.push(Buffer.from(value));
    }

    const text = Buffer
      .concat(chunks)
      .toString('utf8');

    try {
      JSON.parse(text);
    } catch {
      return fail(
        502,
        '上游返回的不是 JSON，可能是拦截页。'
      );
    }

    // 原文透传，不把高精度积分
    // 重新序列化为浮点数。
    return reply(res, 200, text);

  } catch {
    return fail(
      controller.signal.aborted ? 504 : 502,
      controller.signal.aborted
        ? '上游请求超时。'
        : '无法连接上游，或上游发生了重定向。'
    );

  } finally {
    clearTimeout(timer);
    active--;
  }
}
