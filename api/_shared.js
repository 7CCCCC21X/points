// 各代理函数共用：密码校验、Origin 校验、统一响应、实例级限流。
// 文件名以下划线开头，Vercel 不会把它当成路由。

import { createHash, timingSafeEqual } from 'node:crypto';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const PASSWORD_MIN = 16;
const PASSWORD_MAX = 1024;

const sha256 = value => createHash('sha256').update(value).digest();
const sameSecret = (a, b) => timingSafeEqual(sha256(a), sha256(b));

export function reply(res, status, body, retryAfter) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// 通过返回 null；否则返回 [status, message]。
export function authorize(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return [405, '仅允许 GET 请求。'];
  }

  const password = process.env.SITE_PASSWORD || '';

  if (password.length < PASSWORD_MIN) {
    return [503, `请在 Vercel 设置至少 ${PASSWORD_MIN} 位 SITE_PASSWORD 后重新部署。`];
  }

  const supplied = req.headers['x-site-password'];

  if (typeof supplied !== 'string' || supplied.length > PASSWORD_MAX || !sameSecret(supplied, password)) {
    return [401, '网页访问密码错误；这里填写 SITE_PASSWORD，不是 API Key。'];
  }

  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return [403, '请从自己的 Vercel 网页发起请求。'];
      }
    } catch {
      return [403, '无效 Origin。'];
    }
  }

  return null;
}

// 实例级保护，不是跨实例的全局限流。公开使用还应配置 Vercel WAF。
export function createThrottle(perSecond, maxConcurrent) {
  const hits = [];
  let active = 0;

  return {
    // 返回 false 表示放行（并计入一次在途请求），true 表示应拒绝。
    acquire() {
      const now = Date.now();
      while (hits.length && hits[0] <= now - 1000) hits.shift();

      if (hits.length >= perSecond || active >= maxConcurrent) return true;

      hits.push(now);
      active++;
      return false;
    },
    release() {
      active--;
    }
  };
}

// 上游 Retry-After 可能是秒数或 HTTP 日期；缺失按 1 秒，无法解析按 5 秒。
export function retryAfterSeconds(raw) {
  if (!raw) return 1;

  const seconds = Number.isFinite(Number(raw))
    ? Number(raw)
    : (Date.parse(raw) - Date.now()) / 1000;

  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 5;
}
