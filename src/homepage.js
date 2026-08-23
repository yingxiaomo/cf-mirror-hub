/**
 * 首页：使用说明
 */

export function homepageHtml(origin) {
  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const o = e(origin);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF Mirror Hub · 聚合镜像站</title>
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
  <div class="sub">Cloudflare Workers 聚合镜像加速 · 全服务免前缀自动识别 · GitHub / Docker Hub / ghcr / npm / OpenWrt</div>

  <h2>GitHub 加速（下载 / Release / Clone）</h2>
  <pre><code># 直接把原链接拼在域名后（自动识别，无需前缀）——推荐
${o}/https://github.com/user/repo/releases/download/v1.0/file.zip
${o}/https://raw.githubusercontent.com/user/repo/main/README.md

# 或带 /gh/ 前缀，两种写法等价
${o}/gh/https://github.com/user/repo/releases/download/v1.0/file.zip

# git clone 同理
git clone ${o}/https://github.com/user/repo.git</code></pre>

  <h2>Docker Hub 加速</h2>
  <pre><code># /etc/docker/daemon.json 加入：
{ "registry-mirrors": ["${o}"] }
# 然后 systemctl restart docker，正常 docker pull nginx 即可生效

# 或直接全限定名拉取
docker pull ${o}/library/alpine</code></pre>

  <h2>ghcr.io 加速</h2>
  <pre><code># 全限定名拉取（注意 /ghcr/ 前缀）
docker pull ${o}/ghcr/&lt;user&gt;/&lt;image&gt;</code></pre>

  <h2>npm 加速</h2>
  <pre><code># 免前缀（推荐）：registry 直接写裸域名
npm config set registry ${o}
# 或单次使用：npm install --registry=${o}</code></pre>

  <h2>OpenWrt 软件源加速</h2>
  <pre><code># 免前缀（推荐）：直接把 downloads.openwrt.org 替换为本域名
sed -i 's|https://downloads.openwrt.org|${o}|g' /etc/opkg/distfeeds.conf
opkg update

# 固件直链同理
${o}/releases/24.10.1/targets/...</code></pre>

  <p class="note">仅限个人与小规模使用。免费层限额约 100k 请求/天；请勿公开传播本地址。</p>
</main>
</body>
</html>`;
}
