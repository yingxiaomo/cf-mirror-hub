/**
 * 单文件版构建脚本：把 src/ 打包为自包含的 worker.js
 * 用途：粘贴到 Cloudflare Dashboard 在线编辑器直接部署，无需 npm/wrangler
 * 重新生成：npm run build:single
 */
import { build } from 'esbuild';

const banner = `/*
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
 */`;

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  outfile: 'worker.js',
  banner: { js: banner },
  logLevel: 'info',
});
