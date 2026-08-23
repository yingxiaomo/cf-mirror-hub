/**
 * CF Mirror Hub — Cloudflare Workers 聚合镜像站
 *
 * 全服务免前缀自动识别（显式前缀写法仍兼容）：
 *   /                              → 使用说明首页
 *   /https://github.com/...        → GitHub 加速（原链接直接拼接；/gh/ 前缀亦兼容）
 *   /v2/...                        → Docker Hub Registry API（/v2/ 为协议固定路径，
 *                                    docker pull <mirror>/library/alpine 即免前缀使用）
 *   /v2/ghcr/<name>/...            → ghcr.io Registry API
 *   /auth/token                    → Registry 令牌代理（按 service 分发 auth.docker.io / ghcr.io）
 *   /<pkg>、/<pkg>/-/<f>.tgz、/-/*、/@scope/... → npm registry 反代（tarball 地址自动改写）
 *   /releases/...、/packages/... 等 OpenWrt 顶层目录 → downloads.openwrt.org 反代
 *
 * 识别规则（按序匹配，先命中先用）：
 *   GitHub   : 路径以 /http(s):// 开头（白名单校验兜底安全）
 *   OpenWrt  : 首段 ∈ {releases, packages, snapshots, docs, misc, downloads}
 *   npm 强特征: 以 /-/ 开头 | 含 /-/ 段且以 .tgz 结尾 | 首段为 @scope
 *   npm 兜底 : 其余一切路径视为 npm 包元数据查询
 */

import { handleGithub } from './github.js';
import { handleDocker, handleAuthToken } from './docker.js';
import { handleNpm } from './npm.js';
import { handleOpenwrt } from './openwrt.js';
import { homepageHtml } from './homepage.js';

/** OpenWrt downloads 根目录的顶层保留名（真实站点仅此几项，npm 包名撞名时用 /npm/ 前缀访问） */
const OWRT_TOP_DIRS = /^(\/)(releases|packages|snapshots|docs|misc|downloads)(\/|$)/i;

/** npm 路径强特征 */
function looksLikeNpm(pathname) {
  if (pathname.startsWith('/-/')) return true; // npm API：/-/ping、/-/whoami...
  if (pathname.includes('/-/') && /\.tgz$/i.test(pathname)) return true; // tarball
  const first = pathname.split('/')[1] || '';
  return first.startsWith('@') || first.startsWith('%40'); // scoped packument
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // 首页
      if (pathname === '/' && request.method === 'GET') {
        return new Response(homepageHtml(url.origin), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      // Docker Registry API（协议固定路径，本就无前缀概念）
      if (pathname === '/auth/token') {
        return await handleAuthToken(request, env);
      }
      if (pathname === '/v2' || pathname.startsWith('/v2/')) {
        return await handleDocker(request);
      }

      // GitHub 加速：/https://... 自动识别（/gh/ 前缀兼容）
      if (pathname.startsWith('/gh/') || /^\/https?:\/\//i.test(pathname)) {
        return await handleGithub(request);
      }

      // npm 强特征（优先于 OpenWrt，避免 .tgz 等歧义）
      if (looksLikeNpm(pathname)) {
        return await handleNpm(request);
      }

      // OpenWrt：显式 /owrt/ 兼容 或 顶层保留目录自动识别
      if (
        pathname === '/owrt' ||
        pathname.startsWith('/owrt/') ||
        OWRT_TOP_DIRS.test(pathname)
      ) {
        return await handleOpenwrt(request);
      }

      // npm 显式前缀兼容
      if (pathname === '/npm' || pathname.startsWith('/npm/')) {
        return await handleNpm(request);
      }

      // 兜底：视为 npm 包元数据查询（未知路径由上游返回 404）
      return await handleNpm(request);
    } catch (err) {
      return jsonResponse({ error: String((err && err.message) || err) }, 502);
    }
  },
};
