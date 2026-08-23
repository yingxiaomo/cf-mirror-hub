/**
 * 回归测试：node test/test-routes.mjs
 * 覆盖：免前缀路由分发 / 显式前缀兼容 / GitHub 白名单拦截 /
 *       Registry realm 重写 / library 补名 / 重定向跨主机删 Authorization
 * 零依赖，mock 全局 fetch，纯本地运行。
 */
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

// ── mock fetch：记录调用并按 URL 返回预设响应 ──
const calls = [];
let script = null; // (url) => Response
globalThis.fetch = async (url, init = {}) => {
  const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
  calls.push({ url: String(url), auth: h.get('authorization'), cf: init.cf || null, redirect: init.redirect });
  if (script) return script(String(url));
  return new Response(JSON.stringify({ upstream: url }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const mod = (await import('../src/index.js')).default;
const docker = await import('../src/docker.js');
const github = await import('../src/github.js');
const ORIGIN = 'https://hub.example.com';
const fetchAt = async (path, opts = {}) => {
  calls.length = 0;
  return mod.fetch(new Request(ORIGIN + path, opts), {}, {});
};

// ── 1. 免前缀路由分发 ──
{
  const cases = [
    ['/react', 'https://registry.npmjs.org/react'],
    ['/@types/node', 'https://registry.npmjs.org/@types/node'],
    ['/@types%2Fnode', 'https://registry.npmjs.org/@types%2Fnode'],
    ['/lodash/-/lodash.tgz', 'https://registry.npmjs.org/lodash/-/lodash.tgz'],
    ['/-/ping', 'https://registry.npmjs.org/-/ping'],
    ['/npm/react', 'https://registry.npmjs.org/react'],
    ['/releases/24.10.1/', 'https://downloads.openwrt.org/releases/24.10.1/'],
    ['/packages/x/', 'https://downloads.openwrt.org/packages/x/'],
    ['/snapshots/t/', 'https://downloads.openwrt.org/snapshots/t/'],
    ['/owrt/releases/', 'https://downloads.openwrt.org/releases/'],
  ];
  for (const [path, expect] of cases) {
    await fetchAt(path);
    check(`路由 ${path} → ${new URL(expect).host}`, calls[0]?.url === expect);
  }
}

// ── 2. GitHub：免前缀 / 带前缀 / 白名单拦截 ──
{
  await fetchAt('/https://raw.githubusercontent.com/a/b/c');
  check('GitHub 免前缀命中白名单上游', calls[0]?.url === 'https://raw.githubusercontent.com/a/b/c');
  await fetchAt('/gh/https://raw.githubusercontent.com/a/b/c');
  check('GitHub /gh/ 前缀兼容', calls[0]?.url === 'https://raw.githubusercontent.com/a/b/c');

  const bad = await fetchAt('/https://evil.example.org/file');
  check('非白名单 host 403', bad.status === 403);

  // extractTargetPath 边界
  check('extractTargetPath 无前缀', github.extractTargetPath('/https://x/y') === 'https://x/y');
  check('extractTargetPath 带前缀', github.extractTargetPath('/gh/https://x/y') === 'https://x/y');
  check('extractTargetPath 非 GitHub 路径返回 null', github.extractTargetPath('/npm/react') === null);
}

// ── 3. Docker：realm 重写 / library 补名 / 缓存与重定向 ──
{
  script = () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } });
  const ping = await fetchAt('/v2/');
  const wa = ping.headers.get('www-authenticate') || '';
  check('ping 401 realm 重写为本站', wa.includes(`${ORIGIN}/auth/token`));

  check('library 补名（单段名）', docker.normalizeHubPath('/v2/alpine/manifests/latest') === '/v2/library/alpine/manifests/latest');
  check('两段名不补', docker.normalizeHubPath('/v2/user/repo/manifests/1') === '/v2/user/repo/manifests/1');
  check('ghcr 路径解析', JSON.stringify(docker.resolveUpstream('/v2/ghcr/u/i/blobs/x')) === JSON.stringify({ registryBase: 'https://ghcr.io', realPath: '/v2/u/i/blobs/x', isGhcr: true }));

  // GET 带 cacheTtl；POST 不带
  script = () => new Response('{}', { status: 200 });
  await fetchAt('/v2/library/alpine/tags/list', { headers: { authorization: 'Bearer t' } });
  check('GET 带 cacheTtl=3600', calls[0]?.cf?.cacheTtl === 3600);
  await fetchAt('/v2/library/alpine/blobs/uploads/', { method: 'POST' });
  check('POST 不带缓存参数', calls[0]?.cf === null);

  // 三跳重定向：跨主机逐级删 Authorization
  script = (u) => {
    if (u.includes('registry-1.docker.io')) return new Response(null, { status: 307, headers: { location: 'https://cdn.example.com/r' } });
    if (u.includes('cdn.example.com')) return new Response(null, { status: 302, headers: { location: 'https://storage.example.com/final' } });
    return new Response('BLOB', { status: 200 });
  };
  const blob = await fetchAt('/v2/library/alpine/blobs/sha256:x', { headers: { authorization: 'Bearer tok' } });
  check('第一跳带 Bearer', calls[0]?.auth === 'Bearer tok');
  check('跨主机第二跳删除 Authorization', calls[1]?.auth === null);
  check('重定向终点内容正确', (await blob.text()) === 'BLOB');
}

// ── 4. 首页 ──
{
  const home = await fetchAt('/');
  const text = await home.text();
  check('首页 200 且含免前缀示例', home.status === 200 && text.includes('/https://github.com/user/repo'));
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
