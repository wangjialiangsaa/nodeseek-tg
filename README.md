# NodeSeek → Telegram 私信转发器

独立部署的 NodeSeek 论坛私信监控程序。中文网页配置，单管理员、单论坛账号，将新收到的会话最新消息转发到指定 Telegram 用户或群组。

## 能做什么

- 网页填写 Bot Token、主人 Chat ID、NodeSeek Cookie、自己的论坛用户 ID、浏览器 User-Agent。
- 定时检查（默认 60 秒，最短 30 秒），首次成功连接跳过现有消息。
- 消息 ID 去重、SQLite 持久队列、重启恢复、Telegram 失败重试与限流退避。
- Cookie 失效和 Cloudflare 验证提醒，页面显示状态与运行记录。
- 分别设置 NodeSeek 与 Telegram 的 HTTP(S) 代理。
- 管理员密码登录、凭据加密保存，API 不返回已保存的 Cookie、Token 或代理凭据。
- Docker Compose 部署，附安装、更新、备份、停止和保留数据卸载脚本。

## 先了解两个限制

本程序使用非官方接口 `GET /api/notification/message/list`，公开实现返回 `success` 和 `msgArray`，以 `max_id` 识别消息。**该列表可能只包含每个会话的最新消息**：同一会话在两次检查间收到多条时，可能只转发最后一条。本程序不声称完整历史同步、秒级推送或全量消息无遗漏。活跃会话过多、列表截断也可能造成漏报。

NodeSeek 可能要求 Cloudflare 验证。Cookie 导入并不保证任意 VPS IP 可用，`cf_clearance` 等凭据可能与 User-Agent、出口 IP 绑定。请先使用面板测试论坛连接；必要时在与服务器相同出口的浏览器中登录获取凭据。程序不会自动绕过验证码，不保存论坛密码。首次真实账号联调尚未完成。

## 安装

支持主流 Debian / Ubuntu Linux 服务器（amd64 / arm64），需要 root 权限和访问 GitHub、Docker 镜像源、NodeSeek、Telegram 的网络。没有 Docker 时，脚本调用 Docker 官方安装脚本；已有 Docker 需支持 Compose v2。

以 root 用户从本仓库完整源码目录执行（root 不需要安装或使用 sudo）：

```bash
bash install.sh install
```

脚本将程序安装到 `/opt/nodeseek-tg`，自动生成初始管理员密码，并在启动健康检查通过后显示。默认绑定服务器 `127.0.0.1:8787`，在你的电脑建立 SSH 隧道：

```bash
ssh -L 8787:127.0.0.1:8787 root@你的服务器IP
```

然后打开 **http://127.0.0.1:8787**。配置的是机器人 Token 和主人数字 Chat ID；它们不是 IP 地址。服务器 IP 用于 SSH 和访问面板，代理 IP 可选。

也可以直接从 [GitHub 仓库](https://github.com/wangjialiangsaa/nodeseek-tg) 下载脚本并一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/nodeseek-tg/main/install.sh | bash -s -- install --repo wangjialiangsaa/nodeseek-tg
```

上面的命令用于 root 用户。如果当前是普通用户且系统支持 sudo，将管道右侧改为 `sudo bash -s -- install --repo wangjialiangsaa/nodeseek-tg`；如果没有 sudo，请先切换到 root 再执行。出现 `sudo: command not found` 后的 curl `(23)` 通常是管道接收端退出的连带错误。

如需直接监听服务器 IP，root 用户首次安装使用 `BIND_IP=0.0.0.0 bash install.sh install`。面板包含登录凭据，正式公网访问请配置 HTTPS 反向代理；不要通过公网明文 HTTP 传输 Cookie 和 Bot Token。

## 配置

1. 在 Telegram 找到 `@BotFather`，创建机器人并复制 Bot Token。
2. 向你的机器人发送 `/start`。填写接收者数字 Chat ID；群组需将机器人加入并填负数群组 ID。可用可信的 ID 查询工具取得自己的数字用户 ID，或自己调用 Telegram `getUpdates` 查看收到消息的 `chat.id`，不要将 Bot Token 发给第三方网站。
3. 在浏览器登录 [nodeseek.com](https://www.nodeseek.com)，打开私信页面。
4. F12 → Network（网络），刷新私信页面，找到 `notification/message/list` 请求。在 Request Headers 中复制 `Cookie` 和 `User-Agent` 的完整值（不包含 `Cookie:` 这一字段名）。
5. 打开自己的 NodeSeek 个人主页，复制 `/space/` 后的数字 ID。
6. 填写面板并保存，先测试 Telegram 和论坛连接。手动测试共用 30 秒间隔，先测试一项，30 秒后测试另一项。
7. 开启监控并保存。首次成功检查建立基线，此后收到新私信时通知。

密码、Cookie 和代理密码不提交 GitHub。已有敏感字段在面板中不会回显，留空保存表示保留原值。代理只支持 HTTP(S)，支持 `http://用户名:密码@IP:端口`，用户名或密码里的特殊字符须 URL 编码。

**更新同一账号的 Cookie 会保留基线和待发送队列**。更换论坛用户 ID 才会重建基线并清空未发送旧队列，请先等待队列发送完毕。暂停监控期间不采集新消息；恢复时根据当前列表继续检查。管理员会话有效期 12 小时，重启后需重新登录。

## 管理与更新

```bash
bash /opt/nodeseek-tg/install.sh status
bash /opt/nodeseek-tg/install.sh logs
bash /opt/nodeseek-tg/install.sh backup
bash /opt/nodeseek-tg/install.sh update --repo wangjialiangsaa/nodeseek-tg
bash /opt/nodeseek-tg/install.sh stop
bash /opt/nodeseek-tg/install.sh start
bash /opt/nodeseek-tg/install.sh uninstall
```

在线安装时保存仓库信息，后续 `update` 无需再传 `--repo`。更新保留 `.env` 和数据卷，但不提供代码自动回滚。卸载停止并删除容器，**保留数据卷和安装目录**。脚本不提供无确认的数据永久删除操作。

备份会短暂停止服务，将数据库与 `.secret_key` 一起保存到 `backups/data-日期.tar.gz`。该文件含可恢复凭据，请妥善保管。恢复到相同 Compose 项目时：

```bash
cd /opt/nodeseek-tg
docker compose --project-name nodeseek-tg stop
docker compose --project-name nodeseek-tg run --rm --no-deps -T nodeseek-tg tar -xzf - -C /data < backups/你的备份文件.tar.gz
docker compose --project-name nodeseek-tg start
```

恢复前先做当前数据备份；应将备份解压到空的数据卷，避免旧 SQLite WAL 文件与备份不匹配。安装文件 `.env` 也应单独保存在私有备份中。

忘记管理员密码时：

```bash
cd /opt/nodeseek-tg
read -rsp '新密码（至少12位）：' NS_NEW_PASSWORD; echo
docker compose --project-name nodeseek-tg stop
ADMIN_PASSWORD="$NS_NEW_PASSWORD" docker compose --project-name nodeseek-tg run --rm --no-deps -T -e ADMIN_PASSWORD nodeseek-tg node src/main.mjs --reset-password
unset NS_NEW_PASSWORD
docker compose --project-name nodeseek-tg start
```

## HTTPS 反向代理

默认仅监听回环地址，适合 SSH 隧道或本机 Nginx / Caddy。配置反向代理到 `127.0.0.1:8787`，保留原始 `Host` 头。在 `/opt/nodeseek-tg/.env` 中设置：

```dotenv
COOKIE_SECURE=true
PUBLIC_URL=https://你的域名
```

运行 `docker compose --project-name nodeseek-tg up -d` 使配置生效。`PUBLIC_URL` 必须是浏览器实际访问的 HTTPS 来源，不包含额外路径。

## 本地开发

需要 Node.js **24 LTS 或更新版本**：

```bash
npm ci
npm test
npm start
```

首次启动未提供 `ADMIN_PASSWORD` 时会在终端显示随机管理员密码。默认数据目录为 `./data`，可通过 `DATA_DIR` 修改。默认端口 8787，通过 `PORT`、`HOST` 修改。

Node.js 内置 HTTP、SQLite 和 crypto，唯一运行依赖为 `undici`（支持 HTTP(S) 代理）。运行数据与解密密钥保存在同一个数据目录。密码只存储带随机盐的 scrypt 摘要，连接凭据用 AES-256-GCM 加密；持有整个数据卷的人可解密凭据，所以备份也须保密。

## 投递语义与故障处理

- Telegram 成功确认后才将队列记录标记发送成功。
- 发送失败会持久保存并退避重试；若 Telegram 已接收但网络丢失确认，重试可能产生重复通知（至少一次投递）。
- NodeSeek 登录失效、验证阻断、接口格式变化在状态切换时提醒一次，并自动降低检查频率。
- Cookie 恢复后重新采集。接口格式异常不会初始化空基线或把消息标记已读。
- 不发送论坛回复、不改变论坛消息已读状态、不做签到。
- 对于无法连到 Telegram 的服务器，先配置 Telegram HTTP 代理；机器人 Token 无效或未 `/start` 也会导致待发送队列积压。

## 验证范围

自动测试覆盖论坛列表解析、收发过滤、首次基线、重启去重、持久重试、状态提醒、管理登录、跨站请求阻止、配置脱敏以及本地真实 HTTP 适配器。Linux CI 额外运行 Bash 语法检查、Compose 校验、Docker 构建和容器健康检查。

没有真实论坛和 TG 凭据时，测试使用合成响应与本地 HTTP 服务，不能替代真实账号联调。Windows 本地无 Bash / Docker 时，相应服务器检查不视为已验证。

MIT License。与 NodeSeek、Telegram 无官方隶属关系。
