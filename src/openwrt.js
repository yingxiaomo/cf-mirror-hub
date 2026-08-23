/**
 * OpenWrt downloads 加速模块
 *
 * 两种用法等价：
 *   opkg 源直接写 https://<mirror>/releases/...          （免前缀，推荐）
 *   或保留旧写法 https://<mirror>/owrt/releases/...      （兼容）
 *
 * 固件直链同理：https://<mirror>/releases/24.10.x/targets/...
 */

const UPSTREAM = 'https://downloads.openwrt.org';

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
  return h;
}

export async function handleOpenwrt(request) {
  const reqUrl = new URL(request.url);

  // 兼容显式 /owrt/ 前缀；无前缀时 pathname 直接映射上游
  let path = reqUrl.pathname;
  if (path === '/owrt') path = '/';
  else if (path.startsWith('/owrt/')) path = path.slice('/owrt'.length);

  const target = UPSTREAM + path + reqUrl.search;

  const resp = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders(request),
    redirect: 'follow',
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
  });

  // 纯文件反代（ipk / 固件），流式回传；大文件全程不落内存
  return new Response(resp.body, {
    status: resp.status,
    headers: resp.headers,
  });
}
