/*
 * CF Mirror Hub - Cloudflare Workers 聚合镜像加速站（单文件版）
 * 覆盖服务：GitHub 下载/Clone、Docker Hub、ghcr.io、npm registry、OpenWrt downloads
 * 全部免前缀自动识别，显式前缀 /gh/ /npm/ /owrt/ 写法同样兼容。
 *
 * 部署步骤（零安装）：
 *   1. Cloudflare Dashboard -> Workers & Pages -> Create -> Create Worker（名字随意，如 mirror-hub）
 *   2. Edit code -> 删掉示例代码 -> 粘贴本文件全部内容 -> Deploy
 *   3. 该 Worker 的 Settings -> Domains & Routes -> Add Custom Domain 绑定你的域名
 *      （workers.dev 在国内不可用，绑定自定义域名后即可正常使用）
 *
 * 使用速查（MIRROR 替换为你的域名）：
 *   GitHub : https://MIRROR/https://github.com/user/repo/releases/download/v1/file.zip
 *   Docker : daemon.json {"registry-mirrors": ["https://MIRROR"]} 或 docker pull MIRROR/library/alpine
 *   ghcr   : docker pull MIRROR/ghcr/<user>/<image>
 *   npm    : npm config set registry https://MIRROR
 *   OpenWrt: sed -i 's|https://downloads.openwrt.org|https://MIRROR|g' /etc/opkg/distfeeds.conf
 *
 * 免费层限额约 100k 请求/天；仅供个人与小规模使用，请勿公开传播。
 */

// src/github.js
var GH_HOSTS = /* @__PURE__ */ new Set([
  "github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "github-cloud.s3.amazonaws.com"
]);
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function extractTargetPath(pathname) {
  const p = decodeURIComponent(pathname);
  if (p.startsWith("/gh/")) return p.slice("/gh/".length);
  if (/^\/https?:\/\//i.test(p)) return p.slice(1);
  return null;
}
function buildTarget(request, reqUrl) {
  const raw = extractTargetPath(reqUrl.pathname);
  if (!raw) return null;
  const rest = raw.replace(/^(https?:\/)([^/])/, "$1/$2");
  if (!/^https?:\/\//i.test(rest)) return null;
  const withQuery = rest + (reqUrl.search || "");
  try {
    return new URL(withQuery);
  } catch {
    return null;
  }
}
function upstreamRequestHeaders(request, targetHost) {
  const h = new Headers(request.headers);
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  h.delete("cdn-loop");
  h.delete("x-forwarded-for");
  h.delete("x-forwarded-proto");
  h.delete("x-real-ip");
  if (targetHost) h.set("referer", `https://${targetHost}/`);
  return h;
}
async function handleGithub(request) {
  const reqUrl = new URL(request.url);
  const target = buildTarget(request, reqUrl);
  if (!target) {
    return json(
      {
        error: "invalid github url",
        usage: `${reqUrl.origin}/gh/https://github.com/user/repo/releases/download/v1.0.0/file.zip`
      },
      400
    );
  }
  if (!GH_HOSTS.has(target.hostname)) {
    return json({ error: `host not allowed: ${target.hostname}` }, 403);
  }
  const init = {
    method: request.method,
    headers: upstreamRequestHeaders(request, target.hostname),
    redirect: "follow"
    // release 资产会 302 到对象存储，直接跟随并流式回传
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
  }
  const resp = await fetch(target.href, init);
  const headers = new Headers(resp.headers);
  headers.set("x-mirror-target", target.host);
  return new Response(resp.body, { status: resp.status, headers });
}

// src/docker.js
var HUB_REGISTRY = "https://registry-1.docker.io";
var HUB_AUTH = "https://auth.docker.io";
var GHCR_BASE = "https://ghcr.io";
function json2(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function resolveUpstream(pathname) {
  if (pathname.startsWith("/v2/ghcr/")) {
    return {
      registryBase: GHCR_BASE,
      realPath: "/v2/" + pathname.slice("/v2/ghcr/".length),
      isGhcr: true
    };
  }
  return { registryBase: HUB_REGISTRY, realPath: pathname, isGhcr: false };
}
function normalizeHubPath(realPath) {
  const m = /^\/v2\/(.+?)\/(manifests|blobs|tags)((?:\/).*)?$/.exec(realPath);
  if (!m) return realPath;
  const [, name, action, rest] = m;
  if (name.includes("/")) return realPath;
  return `/v2/library/${name}/${action}${rest || ""}`;
}
function responseHeaders(src, extra) {
  const h = new Headers();
  const keep = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "location",
    "www-authenticate",
    "docker-content-digest",
    "docker-distribution-api-version",
    "cache-control"
  ];
  for (const k of keep) {
    const v = src.get(k);
    if (v !== null) h.set(k, v);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
function upstreamHeaders(request) {
  const h = new Headers(request.headers);
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  h.delete("cdn-loop");
  h.delete("x-forwarded-for");
  h.delete("x-forwarded-proto");
  h.delete("x-real-ip");
  h.delete("cookie");
  return h;
}
async function fetchFollowRedirects(url, init, maxRedirects = 3) {
  let current = url;
  let headers = new Headers(init.headers);
  for (let i = 0; i < maxRedirects; i++) {
    const resp = await fetch(current, { ...init, headers, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      const next = new URL(loc, current).href;
      if (new URL(next).host !== new URL(current).host) {
        headers.delete("authorization");
      }
      current = next;
      continue;
    }
    return resp;
  }
  return fetch(current, { ...init, headers });
}
async function handleDocker(request) {
  const reqUrl = new URL(request.url);
  const { registryBase, realPath, isGhcr } = resolveUpstream(reqUrl.pathname);
  const finalPath = isGhcr ? realPath : normalizeHubPath(realPath);
  const target = registryBase + finalPath + reqUrl.search;
  const init = {
    method: request.method,
    headers: upstreamHeaders(request)
  };
  const isRead = ["GET", "HEAD"].includes(request.method);
  if (!isRead) {
    init.body = request.body;
  } else {
    init.cf = { cacheTtl: 3600 };
  }
  const resp = await fetchFollowRedirects(target, init);
  if (resp.status === 401) {
    const wwwAuth = resp.headers.get("www-authenticate");
    if (wwwAuth) {
      const rewritten = wwwAuth.replace(
        /realm="[^"]*"/i,
        `realm="${reqUrl.origin}/auth/token"`
      );
      return new Response(resp.body, {
        status: 401,
        headers: responseHeaders(resp.headers, { "www-authenticate": rewritten })
      });
    }
  }
  return new Response(resp.body, { status: resp.status, headers: responseHeaders(resp.headers) });
}
function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
async function handleAuthToken(request, env = {}) {
  const reqUrl = new URL(request.url);
  const service = reqUrl.searchParams.get("service") || "";
  let scope = reqUrl.searchParams.get("scope") || "";
  let tokenUrl;
  let isGhcr;
  if (service.includes("ghcr")) {
    isGhcr = true;
    tokenUrl = new URL(`${GHCR_BASE}/token`);
    tokenUrl.searchParams.set("service", service || "ghcr.io");
    scope = scope.replace(/repository:ghcr\//g, "repository:");
  } else {
    isGhcr = false;
    tokenUrl = new URL(`${HUB_AUTH}/token`);
    tokenUrl.searchParams.set("service", service || "registry.docker.io");
    scope = scope.replace(
      /repository:([^/:]+):/g,
      (full, name) => name.includes("/") ? full : `repository:library/${name}:`
    );
  }
  if (scope) tokenUrl.searchParams.set("scope", scope);
  const headers = new Headers({ accept: "application/json" });
  const auth = request.headers.get("authorization");
  if (auth) {
    headers.set("authorization", auth);
  } else if (!isGhcr && env && env.DOCKER_HUB_USERNAME && env.DOCKER_HUB_PAT) {
    try {
      const clean = (v) => String(v).replace(/^\uFEFF/, "").trim();
      const raw = `${clean(env.DOCKER_HUB_USERNAME)}:${clean(env.DOCKER_HUB_PAT)}`;
      headers.set("authorization", "Basic " + bytesToBase64(new TextEncoder().encode(raw)));
    } catch {
    }
  }
  const resp = await fetch(tokenUrl.href, { method: "GET", headers });
  if (!resp.ok) {
    return json2({ error: `token upstream ${resp.status}`, target: tokenUrl.href }, 502);
  }
  return new Response(resp.body, {
    status: resp.status,
    headers: responseHeaders(resp.headers)
  });
}

// src/npm.js
var UPSTREAM = "https://registry.npmjs.org";
function upstreamHeaders2(request) {
  const h = new Headers(request.headers);
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  h.delete("cdn-loop");
  h.delete("x-forwarded-for");
  h.delete("x-forwarded-proto");
  h.delete("x-real-ip");
  h.delete("cookie");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }
  return h;
}
async function handleNpm(request) {
  const reqUrl = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response(
      JSON.stringify({ error: "read-only mirror: publish/delete not allowed" }) + "\n",
      { status: 405, headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" } }
    );
  }
  let path = reqUrl.pathname;
  if (path === "/npm") path = "/";
  else if (path.startsWith("/npm/")) path = path.slice("/npm".length);
  const target = UPSTREAM + path + reqUrl.search;
  const headers = upstreamHeaders2(request);
  if (headers === null) {
    return new Response("method not allowed", { status: 405 });
  }
  const resp = await fetch(target, { method: request.method, headers });
  const ct = resp.headers.get("content-type") || "";
  const isJson = ct.includes("json") || ct.includes("javascript");
  if (isJson && request.method === "GET" && resp.ok) {
    let text = await resp.text();
    text = text.replaceAll(`${UPSTREAM}/`, `${reqUrl.origin}/`);
    const out = new Headers();
    out.set("content-type", "application/json; charset=utf-8");
    out.set("cache-control", "public, max-age=120");
    return new Response(text, { status: resp.status, headers: out });
  }
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
}

// src/openwrt.js
var UPSTREAM2 = "https://downloads.openwrt.org";
function upstreamHeaders3(request) {
  const h = new Headers(request.headers);
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  h.delete("cdn-loop");
  h.delete("x-forwarded-for");
  h.delete("x-forwarded-proto");
  h.delete("x-real-ip");
  return h;
}
async function handleOpenwrt(request) {
  const reqUrl = new URL(request.url);
  let path = reqUrl.pathname;
  if (path === "/owrt") path = "/";
  else if (path.startsWith("/owrt/")) path = path.slice("/owrt".length);
  const target = UPSTREAM2 + path + reqUrl.search;
  const resp = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders3(request),
    redirect: "follow",
    ...request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }
  });
  return new Response(resp.body, {
    status: resp.status,
    headers: resp.headers
  });
}

// src/homepage.js
function homepageHtml(origin) {
  const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const o = e(origin);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF Mirror Hub \xB7 \u805A\u5408\u955C\u50CF\u7AD9</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 16px;
    background: #0d1117; color: #c9d1d9;
    font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { color: #58a6ff; font-size: 26px; margin: 0 0 4px; }
  .sub { color: #8b949e; margin-bottom: 32px; }
  h2 { font-size: 17px; color: #79c0ff; border-bottom: 1px solid #21262d; padding-bottom: 6px; margin-top: 36px; }
  pre {
    background: #161b22; border: 1px solid #21262d; border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.6;
  }
  code { font-family: Consolas, "JetBrains Mono", monospace; color: #a5d6ff; }
  p.note { color: #8b949e; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>CF Mirror Hub</h1>
  <div class="sub">Cloudflare Workers \u805A\u5408\u955C\u50CF\u52A0\u901F \xB7 \u5168\u670D\u52A1\u514D\u524D\u7F00\u81EA\u52A8\u8BC6\u522B \xB7 GitHub / Docker Hub / ghcr / npm / OpenWrt</div>

  <h2>GitHub \u52A0\u901F\uFF08\u4E0B\u8F7D / Release / Clone\uFF09</h2>
  <pre><code># \u76F4\u63A5\u628A\u539F\u94FE\u63A5\u62FC\u5728\u57DF\u540D\u540E\uFF08\u81EA\u52A8\u8BC6\u522B\uFF0C\u65E0\u9700\u524D\u7F00\uFF09\u2014\u2014\u63A8\u8350
${o}/https://github.com/user/repo/releases/download/v1.0/file.zip
${o}/https://raw.githubusercontent.com/user/repo/main/README.md

# \u6216\u5E26 /gh/ \u524D\u7F00\uFF0C\u4E24\u79CD\u5199\u6CD5\u7B49\u4EF7
${o}/gh/https://github.com/user/repo/releases/download/v1.0/file.zip

# git clone \u540C\u7406
git clone ${o}/https://github.com/user/repo.git</code></pre>

  <h2>Docker Hub \u52A0\u901F</h2>
  <pre><code># /etc/docker/daemon.json \u52A0\u5165\uFF1A
{ "registry-mirrors": ["${o}"] }
# \u7136\u540E systemctl restart docker\uFF0C\u6B63\u5E38 docker pull nginx \u5373\u53EF\u751F\u6548

# \u6216\u76F4\u63A5\u5168\u9650\u5B9A\u540D\u62C9\u53D6
docker pull ${o}/library/alpine</code></pre>

  <h2>ghcr.io \u52A0\u901F</h2>
  <pre><code># \u5168\u9650\u5B9A\u540D\u62C9\u53D6\uFF08\u6CE8\u610F /ghcr/ \u524D\u7F00\uFF09
docker pull ${o}/ghcr/&lt;user&gt;/&lt;image&gt;</code></pre>

  <h2>npm \u52A0\u901F</h2>
  <pre><code># \u514D\u524D\u7F00\uFF08\u63A8\u8350\uFF09\uFF1Aregistry \u76F4\u63A5\u5199\u88F8\u57DF\u540D
npm config set registry ${o}
# \u6216\u5355\u6B21\u4F7F\u7528\uFF1Anpm install --registry=${o}</code></pre>

  <h2>OpenWrt \u8F6F\u4EF6\u6E90\u52A0\u901F</h2>
  <pre><code># \u514D\u524D\u7F00\uFF08\u63A8\u8350\uFF09\uFF1A\u76F4\u63A5\u628A downloads.openwrt.org \u66FF\u6362\u4E3A\u672C\u57DF\u540D
sed -i 's|https://downloads.openwrt.org|${o}|g' /etc/opkg/distfeeds.conf
opkg update

# \u56FA\u4EF6\u76F4\u94FE\u540C\u7406
${o}/releases/24.10.1/targets/...</code></pre>

  <p class="note">\u4EC5\u9650\u4E2A\u4EBA\u4E0E\u5C0F\u89C4\u6A21\u4F7F\u7528\u3002\u514D\u8D39\u5C42\u9650\u989D\u7EA6 100k \u8BF7\u6C42/\u5929\uFF1B\u8BF7\u52FF\u516C\u5F00\u4F20\u64AD\u672C\u5730\u5740\u3002</p>
</main>
</body>
</html>`;
}

// src/index.js
var OWRT_TOP_DIRS = /^(\/)(releases|packages|snapshots|docs|misc|downloads)(\/|$)/i;
function looksLikeNpm(pathname) {
  if (pathname.startsWith("/-/")) return true;
  if (pathname.includes("/-/") && /\.tgz$/i.test(pathname)) return true;
  const first = pathname.split("/")[1] || "";
  return first.startsWith("@") || first.startsWith("%40");
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/" && request.method === "GET") {
        return new Response(homepageHtml(url.origin), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      if (pathname === "/auth/token") {
        return await handleAuthToken(request, env);
      }
      if (pathname === "/v2" || pathname.startsWith("/v2/")) {
        return await handleDocker(request);
      }
      if (pathname.startsWith("/gh/") || /^\/https?:\/\//i.test(pathname)) {
        return await handleGithub(request);
      }
      if (looksLikeNpm(pathname)) {
        return await handleNpm(request);
      }
      if (pathname === "/owrt" || pathname.startsWith("/owrt/") || OWRT_TOP_DIRS.test(pathname)) {
        return await handleOpenwrt(request);
      }
      if (pathname === "/npm" || pathname.startsWith("/npm/")) {
        return await handleNpm(request);
      }
      return await handleNpm(request);
    } catch (err) {
      return jsonResponse({ error: String(err && err.message || err) }, 502);
    }
  }
};
export {
  index_default as default
};
