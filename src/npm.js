/**
 * npm registry 加速模块
 *
 * 两种用法等价：
 *   npm config set registry https://<mirror>        （免前缀，推荐）
 *   npm config set registry https://<mirror>/npm    （兼容旧配置）
 *
 * 关键点：packument（包元数据 JSON）里的 dist.tarball 是上游绝对 URL，
 * 必须把响应体中 https://registry.npmjs.org/ 前缀改写为本镜像，
 * 否则 npm 下载 tarball 时仍走官方源。
 * 采用字符串替换而非 JSON.parse/stringify —— 快一个数量级，避免触碰免费层 CPU 上限。
 */

const UPSTREAM = 'https://registry.npmjs.org';

/** 清理转发给上游的请求头 */
function upstreamHeaders(request) {
  const h = new Headers(request.headers);
  h.delete('cf-connecting-ip');
  h.delete('cf-ipcountry');
  h.delete('cf-ray');
  h.delete('cf-visitor');
  h.delete('cdn-loop');
  h.delete('x-forwarded-for');
  h.delete('x-forwarded-proto');
  h.delete('x-real-ip');
  h.delete('cookie');
  // 镜像站是只读代理，去掉 publish 相关的写语义头，避免误导
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null; // 由调用方拒绝
  }
  return h;
}

export async function handleNpm(request) {
  const reqUrl = new URL(request.url);

  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(
      JSON.stringify({ error: 'read-only mirror: publish/delete not allowed' }) + '\n',
      { status: 405, headers: { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' } },
    );
  }

  // 兼容显式 /npm/ 前缀；无前缀时 pathname 即包路径
  let path = reqUrl.pathname;
  if (path === '/npm') path = '/';
  else if (path.startsWith('/npm/')) path = path.slice('/npm'.length);

  // pathname 已保留 %2f 等编码（scoped 包），直接拼接即可
  const target = UPSTREAM + path + reqUrl.search;

  const headers = upstreamHeaders(request);
  if (headers === null) {
    return new Response('method not allowed', { status: 405 });
  }

  const resp = await fetch(target, { method: request.method, headers });

  const ct = resp.headers.get('content-type') || '';
  const isJson = ct.includes('json') || ct.includes('javascript');

  // packument 元数据 → 改写 tarball 地址后返回（统一改写为免前缀形式）
  if (isJson && request.method === 'GET' && resp.ok) {
    let text = await resp.text();
    text = text.replaceAll(`${UPSTREAM}/`, `${reqUrl.origin}/`);

    const out = new Headers();
    out.set('content-type', 'application/json; charset=utf-8');
    out.set('cache-control', 'public, max-age=120'); // 元数据短缓存
    return new Response(text, { status: resp.status, headers: out });
  }

  // tarball 与其他响应直接流式透传
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
}
