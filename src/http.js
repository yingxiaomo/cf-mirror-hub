/**
 * 跨模块共享的 HTTP 工具
 */

/**
 * 手动跟随重定向的 fetch。
 * 对象存储 CDN（Docker blob 的 production.cloudflare.com 预签名 URL、
 * GitHub release 资产的 objects.githubusercontent.com 等）会 30x 跳转，
 * 跨主机跳转时必须删除 Authorization 头——预签名 URL 自带鉴权参数，
 * 多出的 Auth 头会导致 S3 类存储校验失败（400 Only one auth mechanism allowed）。
 */
export async function fetchFollowRedirects(url, init, maxRedirects = 3) {
  let current = url;
  let headers = new Headers(init.headers);
  for (let i = 0; i < maxRedirects; i++) {
    const resp = await fetch(current, { ...init, headers, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      const next = new URL(loc, current).href;
      if (new URL(next).host !== new URL(current).host) {
        headers.delete('authorization');
      }
      current = next;
      continue;
    }
    return resp;
  }
  // 超出层数：最后一跳交给运行时自动跟随兜底
  return fetch(current, { ...init, headers });
}
