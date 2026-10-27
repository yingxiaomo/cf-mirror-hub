# CF Mirror Hub

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yingxiaomo/cf-mirror-hub)
[![CI](https://github.com/yingxiaomo/cf-mirror-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/yingxiaomo/cf-mirror-hub/actions/workflows/ci.yml)

托管在 Cloudflare Workers 的聚合镜像加速站，单域名覆盖五类服务，**全部免前缀自动识别**（显式前缀写法仍兼容）：

| 服务 | 免前缀用法 | 上游 |
|---|---|---|
| GitHub | 原链接直接拼接：`https://mirror.example.com/https://github.com/...` | github.com 及各 *.githubusercontent.com |
| Docker Hub | `docker pull mirror.example.com/library/alpine`（`/v2/` 为协议固定路径） | registry-1.docker.io |
| ghcr.io | `docker pull mirror.example.com/ghcr/<user>/<img>` | ghcr.io |
| npm | `npm config set registry https://mirror.example.com`（裸域名） | registry.npmjs.org |
| OpenWrt | opkg 源直接写 `https://mirror.example.com/releases/...` | downloads.openwrt.org |

纯 Worker 直连流式转发：大文件全程不落 Worker 内存；registry 响应在 CF 边缘缓存 1 小时（缓解上游限流）。免费层（~100k 请求/天，10ms CPU/请求）即可运行。

---

## 一、部署

三种方式任选：**一键部署按钮**（最省事） / **零安装粘贴**（适合任何人，1 分钟） / **wrangler CLI**（适合开发者维护迭代）。

### 方式 0：Deploy to Cloudflare 一键部署

点击 README 顶部的 **Deploy to Cloudflare Workers** 按钮，授权后自动把本仓库克隆到你的 GitHub 账号并创建 Worker——按页面引导完成即可，之后同样需要绑定自定义域名。

### 方式 A：零安装（复制单文件粘贴）

仓库根目录的 [`worker.js`](./worker.js) 是自包含的单文件版本，无需 Node/npm/wrangler：

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Create Worker**（名字随意，如 `mirror-hub`）→ 点 **Edit code**
2. 删掉编辑器里的示例代码，把 `worker.js` 的全部内容粘贴进去 → 点右上角 **Deploy**
3. 回到该 Worker 的 **Settings → Domains & Routes → Add → Custom domain** 绑定你的域名（见下文「绑定自定义域名」）

> 修改代码后重新生成单文件：改 `src/` 下源码 → `npm run build:single`。

### 方式 B：wrangler CLI（开发者）

#### 1. 安装依赖并登录 Cloudflare

```bash
npm install
npx wrangler login
```

#### 2. 绑定自定义域名（国内可用的硬性前提）

`*.workers.dev` 在国内被 DNS 污染，必须绑定自己的域名：

- **Dashboard 方式（推荐）**：部署后打开 Workers & Pages → mirror-hub → Settings → Domains & Routes → Add → Custom domain，填入你的子域（如 `mirror.example.com`）。要求该域名的 DNS 已托管在同一个 CF 账号。
- **配置文件方式**：编辑 `wrangler.toml`，取消 `routes` 段注释并填入你的域名，之后 `wrangler deploy` 会自动创建绑定。

#### 3. 部署

```bash
npm run deploy        # 或 npx wrangler deploy
```

本地调试：`npm run dev`（workerd 本地模拟，注意本机网络需可达上游）。

两种方式部署完成后访问 `https://你的域名/` 即可看到使用说明首页。

---

## 二、使用方法

以下 `https://mirror.example.com` 均替换为你自己的镜像域名。

### GitHub 加速

两种写法等价（无前缀自动识别，推荐）：

```text
# 无前缀：直接把原链接拼在域名后
https://mirror.example.com/https://github.com/user/repo/releases/download/v1.0/file.zip
https://mirror.example.com/https://raw.githubusercontent.com/user/repo/main/file.txt
git clone https://mirror.example.com/https://github.com/user/repo.git

# 带前缀（兼容旧用法）
https://mirror.example.com/gh/https://github.com/user/repo/releases/download/v1.0/file.zip
```

支持域名白名单：github.com、raw/gist/codeload/objects/release-assets.githubusercontent.com 等；非白名单 host 一律 403。

### Docker Hub 加速

方式一（推荐）：`registry-mirrors` 自动生效，pull 命令不用改——

```json
// /etc/docker/daemon.json
{ "registry-mirrors": ["https://mirror.example.com"] }
```

```bash
sudo systemctl restart docker
docker pull nginx          # 自动走镜像
```

方式二：全限定名拉取（无需改 daemon.json）——

```bash
docker pull mirror.example.com/library/nginx
docker pull mirror.example.com/user/private-image   # 私有镜像：先 docker login mirror.example.com，凭据经 /auth/token 透传至 auth.docker.io
```

> 注意：`registry-mirrors` 只对 Docker Hub 生效；ghcr/quay 等必须用全限定名。

### ghcr.io 加速

```bash
# 全限定名 + /ghcr/ 前缀
docker pull mirror.example.com/ghcr/<user>/<image>
```

Worker 内部会自动处理 ghcr 的令牌 scope（剥掉 `ghcr/` 前缀后向 `ghcr.io/token` 取票）。

### npm 加速

```bash
# 免前缀（推荐）：registry 直接写裸域名
npm config set registry https://mirror.example.com
# 或单次使用
npm install --registry=https://mirror.example.com
```

packument 元数据中的 tarball 地址会被自动改写为本镜像（免前缀形式），下载同样走加速。**只读**：publish/unpublish 会被拒绝（405）。

### OpenWrt 加速

路由器上执行（以 23.05.x 为例，直接把官方域名替换为本站域名即可）：

```bash
sed -i 's|https://downloads.openwrt.org|https://mirror.example.com|g' /etc/opkg/distfeeds.conf
opkg update
```

固件直链同理：`https://mirror.example.com/releases/23.05.5/targets/...`

### 可选：绑定 Docker Hub 账号提升拉取限额

Docker Hub 按**请求源 IP** 对匿名拉取限流，而 Cloudflare Workers 的出口 IP 是全球租户共享池，容易被限到 429。注册一个免费 Docker 账号并让镜像站以该账号身份取令牌，限额即从「按共享 IP」（100 pulls/6h）变为「按账号独享」（200 pulls/6h）：

1. 到 [hub.docker.com](https://hub.docker.com/settings/personal-access-tokens) 生成一个 **Personal Access Token**（Public Repo Read-only 权限即可）
2. 配置两个环境变量：
   - **CLI 部署**：
     ```bash
     npx wrangler secret put DOCKER_HUB_USERNAME   # 输入你的 Docker Hub 用户名
     npx wrangler secret put DOCKER_HUB_PAT        # 输入你的 PAT
     ```
   - **Dashboard 粘贴部署**：Worker → Settings → Variables and Secrets → Add，类型选 **Secret**，分别添加 `DOCKER_HUB_USERNAME` 与 `DOCKER_HUB_PAT`
3. 无需重新部署代码，下一个请求即生效；删除任一 Secret 则回到匿名模式。

优先级说明：客户端自带登录态（docker login）> 服务端凭据 > 纯匿名；ghcr 拉取不受这两个变量影响。

---

## 三、实现要点（给维护者）

- **全服务免前缀路由**（`src/index.js`）：按序匹配——GitHub 以 `/http(s)://` 开头；npm 强特征为 `/-/` 开头 / 含 `/-/` 段且 `.tgz` 结尾 / 首段 `@scope`；OpenWrt 顶层保留目录（releases/packages/snapshots/docs/misc/downloads）自动转发 downloads.openwrt.org；其余路径兜底视为 npm 包查询。旧显式前缀 `/gh/`、`/npm/`、`/owrt/` 全部兼容。已知取舍：若 npm 恰有与 OpenWrt 顶层目录同名的包（如名为 `releases` 的包），需用 `/npm/releases` 访问。
- **Registry v2 令牌重写**（`src/docker.js` 核心）：客户端 ping `/v2/` 时上游返回 401 + `WWW-Authenticate: Bearer realm="https://auth.docker.io/token"`；Worker 把 realm 重写为自身 `/auth/token`，客户端后续取票请求由 Worker 按 `service` 参数分发到 `auth.docker.io` 或 `ghcr.io/token`。
- **边缘缓存**：registry 的 GET/HEAD 响应带 `cf.cacheTtl: 3600`，同镜像重复拉取命中 CF 边缘节点不回源，从请求量源头缓解 Docker Hub 匿名限流。
- **重定向安全跟随**：Docker blob 与 GitHub release 资产 30x 到对象存储 CDN 时手动逐跳跟随（最多 3 层，共用 `src/http.js`），跨主机跳转删除 `Authorization` 头——预签名 URL 自带鉴权参数，多余 Auth 头会导致 S3 类存储校验失败（400）。
- **官方镜像补名**：Docker Hub 单段镜像名（如 `alpine`）在转发前自动补成 `library/alpine`；以 manifests/blobs/tags 关键字锚定镜像名，避免误伤 `<owner>/<repo>` 两段名。
- **npm 元数据改写**：对 JSON 响应用字符串 `replaceAll('https://registry.npmjs.org/', '<mirror>/')` 而非 parse/stringify，快一个数量级，规避免费层 CPU 上限；同时删除 etag 防止缓存不一致。
- **凭据安全编码**：服务端 Docker Hub 凭据经 BOM/空白清理后用 `TextEncoder` + 分块字节 base64 编码——Worker 环境的 `btoa` 仅支持 Latin1，Secret 值混入非 Latin1 字符时会静默失败。
- **流式转发**：所有二进制响应直接回传 `resp.body`（ReadableStream），等待 I/O 不计 Workers CPU 时间。

## 四、已知限制与风险

1. **Docker Hub 匿名限流**：Docker Hub 按请求源 IP 对匿名拉取限流，而 Cloudflare Workers 的出口 IP 是全球租户共享池，未配置凭据时可能遇到 429。强烈建议按上文配置 `DOCKER_HUB_USERNAME`/`DOCKER_HUB_PAT` 账号凭据（配合边缘缓存基本可消除该问题）；极端情况下可改走 ghcr 同步镜像或自建中转。
2. **免费额度**：约 100k 请求/天。一次 `docker pull` 约产生 3–10 个请求，个人使用绰绰有余；公开传播会很快打爆额度并被滥用风险波及账号。
3. **只读镜像**：不支持 npm publish、不支持推送镜像。
4. **私有镜像请勿经本站拉取**：Registry 响应的边缘缓存键只含 URL、不含客户端凭据，带鉴权拉取到的私有 manifest 理论上可能被缓存后返回给同 URL 的匿名请求。私有镜像请直连官方 registry；公开镜像不受影响。
5. 合规：仅建议个人/小规模自用。

## 五、目录结构

```text
├── wrangler.toml      # Worker 配置（名称、入口、域名绑定）
├── build.mjs          # 单文件版构建脚本（npm run build:single）
├── worker.js          # 自包含单文件产物（Dashboard 粘贴部署用）
├── src/
│   ├── index.js       # 入口 + 免前缀智能路由
│   ├── github.js      # GitHub 反代（白名单校验）
│   ├── docker.js      # Docker Hub + ghcr（token 重写 / 边缘缓存 / library 补名核心）
│   ├── npm.js         # npm 反代 + tarball 地址改写
│   ├── openwrt.js     # OpenWrt 文件反代
│   ├── http.js        # 共享工具：手动跟随重定向（跨主机删 Authorization）
│   └── homepage.js    # 使用说明首页
├── test/
│   └── test-routes.mjs  # 路由回归测试（41 用例零依赖，npm test 一键回归）
└── package.json
```

## License

[MIT](./LICENSE) —— 随意使用、修改、分发；如果这个项目帮到了你，欢迎点个 Star ⭐
