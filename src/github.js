/**
 * GitHub 加速模块（gh-proxy 模式）
 *
 * 两种用法等价（自动识别，无需强制前缀）：
 *   https://<mirror>/https://github.com/<user>/<repo>/releases/download/v1/file.zip
 *   https://<mirror>/gh/https://github.com/<user>/<repo>/releases/download/v1/file.zip
 * 同样支持 raw / codeload / gist / git clone（smart HTTP）。
 */

import { fetchFollowRedirects } from './http.js';

const GH_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'github-cloud.s3.amazonaws.com',
]);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 从 pathname 提取目标 URL 字符串（兼容 /gh/ 前缀与无前缀自动识别两种形式） */
export function extractTargetPath(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null; // 非法百分号编码（如 %zz）：交由调用方按 400 拒绝
  }
  if (p.startsWith('/gh/')) return p.slice('/gh/'.length);
  if (/^\/https?:\/\//i.test(p)) return p.slice(1); // 无前缀：去掉开头 '/'
  return null;
}

/** 从请求构造上游目标 URL */
export function buildTarget(request, reqUrl) {
  const raw = extractTargetPath(reqUrl.pathname);
  if (!raw) return null;

  // 兼容部分客户端把 "//" 折叠为 "/" 的情况：https:/x → https://x
  const rest = raw.replace(/^(https?:\/)([^/])/, '$1/$2');

  if (!/^https?:\/\//i.test(rest)) return null;

  const withQuery = rest + (reqUrl.search || '');
  try {
    return new URL(withQuery);
  } catch {
    return null;
  }
}

/** 清理转发给上游的请求头：去掉镜像站自身的痕迹头 */
export function upstreamRequestHeaders(request, targetHost) {
  const h = new Headers(request.headers);
  h.delete('cf-connecting-ip');
  h.delete('cf-ipcountry');
  h.delete('cf-ray');
  h.delete('cf-visitor');
  h.delete('cdn-loop');
  h.delete('x-forwarded-for');
  h.delete('x-forwarded-proto');
  h.delete('x-real-ip');
  h.delete('cookie'); // 不把镜像域名上的 cookie 转发给 GitHub
  if (targetHost) h.set('referer', `https://${targetHost}/`);
  return h;
}

export async function handleGithub(request) {
  const reqUrl = new URL(request.url);
  const target = buildTarget(request, reqUrl);

  if (!target) {
    return json(
      {
        error: 'invalid github url',
        usage: `${reqUrl.origin}/gh/https://github.com/user/repo/releases/download/v1.0.0/file.zip`,
      },
      400,
    );
  }

  if (!GH_HOSTS.has(target.hostname)) {
    return json({ error: `host not allowed: ${target.hostname}` }, 403);
  }

  const init = {
    method: request.method,
    headers: upstreamRequestHeaders(request, target.hostname),
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body; // git clone 的 POST /git-upload-pack 走这里
  }

  // release 资产会 302 到对象存储，手动逐跳跟随；跨主机跳转删 Authorization，
  // 避免客户端令牌被转发给 CDN（S3 遇到「Auth 头 + 预签名参数」双重鉴权会 400）
  const resp = await fetchFollowRedirects(target.href, init);

  const headers = new Headers(resp.headers);
  headers.delete('set-cookie'); // 上游会话 cookie 不落镜像域名
  headers.set('x-mirror-target', resp.url ? new URL(resp.url).host : target.host);
  return new Response(resp.body, { status: resp.status, headers });
}
