/**
 * Docker Registry 加速模块：Docker Hub + ghcr.io
 *
 * Registry v2 令牌流程：
 *   1) 客户端 GET /v2/ → 上游返回 401 + WWW-Authenticate: Bearer realm="https://auth.docker.io/token",...
 *   2) 本模块把 realm 重写为自身 /auth/token
 *   3) 客户端请求 /auth/token?service=...&scope=... → 按 service 分发到 auth.docker.io 或 ghcr.io
 *   4) 拿到 token 后客户端带 Bearer 继续访问 /v2/...
 *
 * 路径约定：
 *   /v2/<name>/...          → registry-1.docker.io（单段名自动补 library/ 前缀）
 *   /v2/ghcr/<name>/...     → ghcr.io（真实仓库名 = <name>）
 *
 * 客户端用法：
 *   Docker Hub：daemon.json 配 registry-mirrors: ["https://<mirror>"]，或 docker pull <mirror>/library/alpine
 *   ghcr：docker pull <mirror>/ghcr/<user>/<image>（全限定名）
 */

import { fetchFollowRedirects } from './http.js';

const HUB_REGISTRY = 'https://registry-1.docker.io';
const HUB_AUTH = 'https://auth.docker.io';
const GHCR_BASE = 'https://ghcr.io';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 解析 /v2/ 后的路径，决定上游与真实路径 */
export function resolveUpstream(pathname) {
  if (pathname.startsWith('/v2/ghcr/')) {
    return {
      registryBase: GHCR_BASE,
      realPath: '/v2/' + pathname.slice('/v2/ghcr/'.length),
      isGhcr: true,
    };
  }
  return { registryBase: HUB_REGISTRY, realPath: pathname, isGhcr: false };
}

/** Docker Hub 单段镜像名自动补 library/（官方镜像）；<owner>/<repo> 两段名保持不变。
 *  行尾锚定：Registry API 的 action 恒为倒数第二段（blobs/uploads、manifests/<ref>、tags/list），
 *  贪婪匹配到最后一处关键字，避免仓库名恰好叫 manifests/blobs/tags 时误判。 */
export function normalizeHubPath(realPath) {
  const m = /^\/v2\/(.+)\/(manifests\/[^/]+|blobs\/[^/]+|tags\/list)(\/)?$/.exec(realPath);
  if (!m) return realPath;
  const [, name, action, trailingSlash] = m;
  if (name.includes('/')) return realPath;
  return `/v2/library/${name}/${action}${trailingSlash || ''}`;
}

/** 清理响应头：去掉 CF 注入头，保留 Registry 协议相关头 */
function responseHeaders(src, extra) {
  const h = new Headers();
  const keep = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'location',
    'www-authenticate',
    'docker-content-digest',
    'docker-distribution-api-version',
    'cache-control',
  ];
  for (const k of keep) {
    const v = src.get(k);
    if (v !== null) h.set(k, v);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

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
  h.delete('cookie'); // 镜像站不需要把浏览器 cookie 发给上游
  return h;
}

/** Registry API 主处理 */
export async function handleDocker(request) {
  const reqUrl = new URL(request.url);
  const { registryBase, realPath, isGhcr } = resolveUpstream(reqUrl.pathname);

  const finalPath = isGhcr ? realPath : normalizeHubPath(realPath);
  const target = registryBase + finalPath + reqUrl.search;

  const init = {
    method: request.method,
    headers: upstreamHeaders(request),
  };
  const isRead = ['GET', 'HEAD'].includes(request.method);
  if (!isRead) {
    init.body = request.body;
  } else {
    // GET/HEAD 开启 CF 边缘缓存 1 小时：同镜像重复拉取命中边缘不回源，
    // 显著减少对上游 registry 的请求次数（缓解 Docker Hub 匿名限流）。
    // 注意取舍：缓存键只含 URL 不含凭据，带 Authorization 拉到的响应可能被
    // 同 URL 的匿名请求命中——不要经本镜像拉取私有镜像（详见 README 已知限制）。
    init.cf = { cacheTtl: 3600 };
  }

  const resp = await fetchFollowRedirects(target, init);

  if (resp.status === 401) {
    const wwwAuth = resp.headers.get('www-authenticate');
    if (wwwAuth) {
      // 把 token realm 指回本镜像，service 原样透传（客户端后续请求 /auth/token 时带回）
      const rewritten = wwwAuth.replace(
        /realm="[^"]*"/i,
        `realm="${reqUrl.origin}/auth/token"`,
      );
      return new Response(resp.body, {
        status: 401,
        headers: responseHeaders(resp.headers, { 'www-authenticate': rewritten }),
      });
    }
  }

  return new Response(resp.body, { status: resp.status, headers: responseHeaders(resp.headers) });
}

/** 将任意字节序列安全编码为 base64（绕开 btoa 的 Latin1 限制） */
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 令牌代理：按 service 分发到对应认证服务器
 *
 * Docker Hub 限流缓解：若部署者通过环境变量配置了 DOCKER_HUB_USERNAME 与 DOCKER_HUB_PAT，
 * 匿名客户端取票时将以该账号身份向 auth.docker.io 认证——限额从「按共享出口 IP」
 * 变为「按账号独享」，规避 CF 出口 IP 段被匿名限流的问题。
 * 优先级：客户端自带 Authorization（docker login 场景）> 服务端凭据 > 纯匿名。
 */
export async function handleAuthToken(request, env = {}) {
  const reqUrl = new URL(request.url);
  const service = reqUrl.searchParams.get('service') || '';
  let scope = reqUrl.searchParams.get('scope') || '';

  let tokenUrl;
  let isGhcr;

  if (service.includes('ghcr')) {
    isGhcr = true;
    tokenUrl = new URL(`${GHCR_BASE}/token`);
    tokenUrl.searchParams.set('service', service || 'ghcr.io');
    // 客户端 pull <mirror>/ghcr/<user>/<img> 会给出 scope=repository:ghcr/<user>/<img>:pull，
    // 需剥掉 "ghcr/" 才是 ghcr.io 的真实仓库 scope
    scope = scope.replace(/repository:ghcr\//g, 'repository:');
  } else {
    isGhcr = false;
    tokenUrl = new URL(`${HUB_AUTH}/token`);
    tokenUrl.searchParams.set('service', service || 'registry.docker.io');
    // 单段名补 library/：repository:alpine:pull → repository:library/alpine:pull
    scope = scope.replace(
      /repository:([^/:]+):/g,
      (full, name) => (name.includes('/') ? full : `repository:library/${name}:`),
    );
  }

  if (scope) tokenUrl.searchParams.set('scope', scope);

  const headers = new Headers({ accept: 'application/json' });
  const auth = request.headers.get('authorization');
  if (auth) {
    headers.set('authorization', auth); // 客户端登录态拉私有镜像时透传 Basic 凭据
  } else if (!isGhcr && env && env.DOCKER_HUB_USERNAME && env.DOCKER_HUB_PAT) {
    try {
      // 防御性清理 BOM/空白（部分终端管道写入 Secret 会夹带），再用 TextEncoder 走字节级 base64
      const clean = (v) => String(v).replace(/^\uFEFF/, '').trim();
      const raw = `${clean(env.DOCKER_HUB_USERNAME)}:${clean(env.DOCKER_HUB_PAT)}`;
      headers.set('authorization', 'Basic ' + bytesToBase64(new TextEncoder().encode(raw)));
    } catch { /* 凭据格式非法时退回匿名 */ }
  }

  const resp = await fetch(tokenUrl.href, { method: 'GET', headers });

  if (!resp.ok) {
    return json({ error: `token upstream ${resp.status}`, target: tokenUrl.href }, 502);
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: responseHeaders(resp.headers),
  });
}
