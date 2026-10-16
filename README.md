# NodeSeek → Telegram 私信转发器（SSH 配置版）

独立部署、单 NodeSeek 账号。**直接在 SSH 终端填写配置，不使用网页，不开放管理端口。** 后台检查论坛私信，将新收到的会话最新消息转发到指定 Telegram 用户或群组。

## 一键安装

以 **root 用户**在 Debian / Ubuntu 服务器执行（root 不需要 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/wangjialiangsaa/nodeseek-tg/main/install.sh | bash -s -- install --repo wangjialiangsaa/nodeseek-tg
```

脚本安装到 `/opt/nodeseek-tg`，缺少 Docker 时使用 Docker 官方安装脚本，然后自动打开 SSH 配置向导。按照提示填写：

1. Telegram Bot Token。
2. 主人数字 Chat ID。
3. 自己的 NodeSeek 数字用户 ID。
4. NodeSeek 登录 Cookie。
5. 获取 Cookie 时浏览器的 User-Agent。
6. 检查间隔（默认 60 秒，最短 30 秒）。
7. 可选 NodeSeek / Telegram HTTP(S) 代理。
8. 是否开启监控。

Token、Cookie 和代理输入会隐藏，不显示星号，粘贴后按回车即可。已有配置回车保留，代理输入 `-` 清除。Ctrl+C 取消且不保存。无需管理员网页密码、域名或防火墙入站端口。普通用户需先切换到 root，或在支持 sudo 的系统上将管道右侧改为 `sudo bash -s -- install --repo wangjialiangsaa/nodeseek-tg`。

如果当前终端不支持交互，安装会跳过向导；使用交互式 SSH（必要时 `ssh -t`）登录后执行下面的 config 命令。无人值守安装可以设置 `NONINTERACTIVE=1`。

## 已安装旧版：更新并在 SSH 配置

旧版安装脚本会更新自身，旧数据库、加密密钥和配置继续保留：

```bash
bash /opt/nodeseek-tg/install.sh update --repo wangjialiangsaa/nodeseek-tg
bash /opt/nodeseek-tg/install.sh config
```

也可以再次执行上面的一键安装命令，下载新版并进入向导。新版容器不再启动网页服务，也不再映射原来的 8787 端口。

## 日常操作

```bash
# 修改配置，保存后恢复后台监控
bash /opt/nodeseek-tg/install.sh config

# 查看容器状态、连接状态和待发送数量（不显示凭据）
bash /opt/nodeseek-tg/install.sh status

# 测试论坛连接 / 发一条 TG 测试消息
bash /opt/nodeseek-tg/install.sh test-nodeseek
bash /opt/nodeseek-tg/install.sh test-telegram

# 立即检查、持续查看后台日志
bash /opt/nodeseek-tg/install.sh check
bash /opt/nodeseek-tg/install.sh logs

# 更新、备份、停止、启动、卸载
bash /opt/nodeseek-tg/install.sh update
bash /opt/nodeseek-tg/install.sh backup
bash /opt/nodeseek-tg/install.sh stop
bash /opt/nodeseek-tg/install.sh start
bash /opt/nodeseek-tg/install.sh uninstall
```

配置和立即检查会暂时停止后台进程，避免并发采集；操作结束或取消后恢复之前运行的服务。原本停止的服务保持停止，使用 start 开启。更新保留数据；卸载保留数据卷和安装目录，不永久删除账号配置。安装脚本支持 `INSTALL_DIR` 指定目录。

## 获取账号信息

- **Bot Token**：向 Telegram 的 `@BotFather` 创建机器人。先向你自己的机器人发送 `/start`。
- **主人 Chat ID**：接收者数字用户 ID，群组通常为负数。可通过可信的 ID 查询工具查询，或自行查看 Telegram `getUpdates` 返回的 `chat.id`；不要把 Bot Token 发给第三方网站。
- **NodeSeek 用户 ID**：打开自己的论坛个人主页，复制 `/space/` 后的数字。
- **Cookie 和 User-Agent**：在浏览器登录 [nodeseek.com](https://www.nodeseek.com)，F12 → Network（网络），刷新私信页面，找到 `notification/message/list` 请求。从 Request Headers 复制完整 `Cookie` 和 `User-Agent` 的值，字段名无需复制。程序不保存论坛密码。
- **代理**：只支持 HTTP(S)，例如 `http://user:pass@IP:port`，用户名或密码中的特殊字符需 URL 编码。服务器 IP 用来 SSH 登录；Bot Token 和主人 Chat ID 不是 IP 地址。

## 消息与登录限制

- 使用非官方接口 `GET /api/notification/message/list`，按 `max_id` 去重。**接口可能仅返回每个会话的最新消息**，同一会话两次检查间多条消息可能只转发最后一条；活跃会话过多、列表截断也可能漏报。不承诺全量历史同步或秒级推送。
- 首次成功连接只记录基线，不推送已有消息。暂停期间不采集，恢复后根据当前列表检查。
- NodeSeek 可能要求 Cloudflare 验证。Cookie、User-Agent 和服务器出口 IP 可能需要匹配；Cookie 导入不保证任意 VPS 可用，不自动绕过验证码。遇到验证后自动退避并提醒。
- 更新同一账号的 Cookie 保留基线和待发队列；更换论坛用户 ID 会重建基线。旧账号还有待发消息时，向导会阻止切换账号，避免丢失。
- 消息先进入 SQLite 持久队列，TG 确认成功后标记已发送。失败、限流和重启后继续重试。网络丢失成功确认时可能产生重复通知（至少一次投递）。
- 不发送论坛回复、不修改论坛消息已读状态、不做签到。

## 数据与备份

Cookie、Token、代理凭据用 AES-256-GCM 加密保存。数据库和 `.secret_key` 保存在 Docker 数据卷里，持有整个数据卷的人能解密凭据，因此备份也需保密。敏感值不进入命令行参数、shell 历史或正常日志。

`backup` 短暂停止服务，将数据库和密钥一起保存为 `/opt/nodeseek-tg/backups/data-日期.tar.gz`。恢复前备份当前数据，并在**空数据卷**内恢复，防止旧 SQLite WAL 文件与备份不匹配：

```bash
cd /opt/nodeseek-tg
docker compose --project-name nodeseek-tg stop
docker compose --project-name nodeseek-tg run --rm --no-deps -T nodeseek-tg tar -xzf - -C /data < backups/你的备份文件.tar.gz
docker compose --project-name nodeseek-tg start
```

旧版 `.env` 文件作为兼容备份保留，新版不再使用其中的网页密码或端口配置。

## 本地开发

需要 Node.js 24 LTS 或更新版本：

```bash
npm ci
npm run config
npm start
```

修改配置前先停止正在运行的本地后台进程。`npm run status` 查看状态；`node src/cli.mjs test-nodeseek` / `test-telegram` 测试连接。默认数据目录 `./data`，通过 `DATA_DIR` 修改。

测试：`npm test`。Linux 上额外执行 `python3 tests/terminal-smoke.py` 验证真实终端隐藏输入和 Ctrl+C。CI 验证 Docker 构建、无网页端口的后台运行、公开链接安装、Docker 内 SSH 向导和备份。

MIT License。与 NodeSeek、Telegram 无官方隶属关系。真实论坛账号和服务器 Cloudflare 通行仍需实际配置后验证。
