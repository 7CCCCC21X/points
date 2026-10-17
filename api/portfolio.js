// 资金总量代理：/api/portfolio?address=0x...
// 持仓金额 = predict.fun GraphQL GetPortfolio 的 account.statistics.positionsValueUsd（官网 Portfolio 卡片口径，同 yuce）；
// USDT 余额 = BNB 链 USDT 合约 balanceOf(address)，经公共 RPC 读取，不签名、不发交易。
// 返回 { success, address, positionsValueUsd, balanceUsd, portfolioError?, balanceError? }，前端把两项相加为资金总量。
//
// 可选环境变量：BSC_RPC_URLS（逗号分隔，依次尝试）、BSC_USDT_ADDRESS、BSC_USDT_DECIMALS、BSC_RPC_TIMEOUT_MS、
// PREDICT_TOTAL_BUDGET_MS，以及 _graphql.js 里的 PREDICT_GRAPHQL_*。

import { ADDRESS_RE, reply, authorize, createThrottle } from './_shared.js';
import { toChecksumAddress, predictGraphql, isTimeout } from './_graphql.js';

const QUERY = `query GetPortfolio($address: Address!) {
  account(address: $address) {
    statistics { positionsValueUsd }
  }
}`;

const USDT_ADDRESS = (process.env.BSC_USDT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955').trim();
const USDT_DECIMALS = Math.max(0, Math.floor(Number(process.env.BSC_USDT_DECIMALS || 18)));
const RPC_URLS = (process.env.BSC_RPC_URLS ||
  'https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.binance.org,https://bsc-dataseed.defibit.io,https://bsc-dataseed1.ninicoin.io')
  .split(',').map(s => s.trim()).filter(Boolean);
const RPC_TIMEOUT = Math.max(1000, Number(process.env.BSC_RPC_TIMEOUT_MS || 6000));
const TOTAL_BUDGET = Math.max(5000, Number(process.env.PREDICT_TOTAL_BUDGET_MS || 15000));

const throttle = createThrottle(15, 15);

// 代币原始余额（BigInt）→ 十进制字符串，去掉末尾 0。
export function formatScaled(n, decimals) {
  const s = n.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${int}.${frac}` : int;
}

async function fetchPortfolio(address, deadline) {
  const json = await predictGraphql({ query: QUERY, variables: { address }, operationName: 'GetPortfolio' }, deadline);
  const account = json?.data?.account;

  if (!account) throw Object.assign(new Error('官网没有该地址的账户。'), { status: 404 });

  return account.statistics?.positionsValueUsd ?? null;
}

// balanceOf(address) 的 eth_call；依次尝试各 RPC，直到成功或预算用尽。
async function fetchBalance(address, deadline) {
  const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
  let lastError = '未配置 RPC';

  for (const url of RPC_URLS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { lastError = '超时'; break; }

    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDT_ADDRESS, data }, 'latest'] }),
        signal: AbortSignal.timeout(Math.min(RPC_TIMEOUT, remaining))
      });
      const text = await upstream.text();

      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);

      const json = JSON.parse(text);
      if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));

      const result = json?.result;
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error('没有返回 eth_call 结果');

      return formatScaled(BigInt(result.length > 2 ? result : '0x0'), USDT_DECIMALS);
    } catch (e) {
      lastError = isTimeout(e) ? '超时' : (e?.message || String(e));
    }
  }

  throw Object.assign(new Error(`链上 USDT 余额查询失败（${lastError}）。`), { status: 502 });
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
    const deadline = Date.now() + TOTAL_BUDGET;
    const [portfolio, balance] = await Promise.allSettled([fetchPortfolio(address, deadline), fetchBalance(address, deadline)]);

    // 会话过期 / 限流是整体问题：原样返回状态码，前端据此停止或退避。
    if (portfolio.status === 'rejected' && [429, 503].includes(portfolio.reason?.status)) throw portfolio.reason;

    // 两项都失败才算失败；只失败一项时照常返回另一项，并带上错误说明。
    if (portfolio.status === 'rejected' && balance.status === 'rejected') {
      throw Object.assign(new Error(`${portfolio.reason?.message || '持仓查询失败。'} ${balance.reason?.message || ''}`.trim()), { status: 502 });
    }

    return reply(res, 200, {
      success: true,
      address,
      positionsValueUsd: portfolio.status === 'fulfilled' ? portfolio.value : null,
      balanceUsd: balance.status === 'fulfilled' ? balance.value : null,
      ...(portfolio.status === 'rejected' ? { portfolioError: portfolio.reason?.message || '持仓查询失败。' } : {}),
      ...(balance.status === 'rejected' ? { balanceError: balance.reason?.message || '余额查询失败。' } : {})
    });
  } catch (err) {
    const status = [429, 502, 503, 504].includes(err?.status) ? err.status : 502;
    return fail(status, err?.message || '资金总量代理失败。', status === 429 ? 2 : 0);
  } finally {
    throttle.release();
  }
}
