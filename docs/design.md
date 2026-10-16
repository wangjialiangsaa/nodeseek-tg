# NodeSeek 私信 Telegram 转发器

2026-10-16；独立部署、单管理员、单 NodeSeek 账号，用户已确认独立部署方案。

## 使用流程

Linux 服务器执行仓库中的 install.sh，生成管理员初始密码并启动 Docker Compose。访问服务器的 8787 端口登录中文面板，填写 Telegram Bot Token、主人 Chat ID、NodeSeek Cookie、自己的 NodeSeek 用户 ID 和浏览器 User-Agent。可选分别配置 NodeSeek、Telegram 的 HTTP(S) 代理。测试连接、开启监控后，每 60 秒检查一次，最短 30 秒。

Cookie 导入是第一版的登录方式，不保存论坛密码，不承诺自动解决 Cloudflare 验证。Cookie、User-Agent 和服务器出口 IP 可能需要匹配。用户先向机器人发送 /start。面板只接受一个管理员，采用密码登录、HttpOnly 会话 Cookie、同源请求验证、限速；公网使用 HTTPS 反向代理或 SSH 隧道。

## 架构

Node.js 24 LTS 内置 HTTP 服务、SQLite 持久化、crypto 加密。仅用 undici 提供 HTTP(S) 出站代理。src/store.mjs 管理数据库和凭据；src/nodeseek.mjs 解析非官方消息接口；src/telegram.mjs 发送消息；src/monitor.mjs 管理采集和持久重试队列；src/server.mjs 提供管理 API 与静态网页。

接口是 GET https://www.nodeseek.com/api/notification/message/list，公开实现的响应包含 success 和 msgArray，每个会话可能只有最新消息 max_id、sender_id、receiver_id、sender_name、content。实际账号响应仍需联调。只处理 receiver_id 等于配置用户 ID 且 sender_id 不等于自己的记录。保留未知结构错误，禁止将接口异常当成空列表初始化。

## 消息与失败处理

第一次成功获取只建基线。后续新 max_id 原子写入 SQLite 已见记录与待发送队列；确认 TG 成功后标记成功。失败采用退避重试、遵守 TG retry_after；重启后继续。NodeSeek 鉴权失效或 Cloudflare 拦截会退避并仅在状态切换时通知主人。修改 TG 配置或更新同一账号的 Cookie 不重建基线，保留待发消息；修改 NodeSeek UID 才重建基线并清空旧队列，避免串号。监控关闭时停止采集和队列发送。

Telegram 网络超时可能发生已发出但未确认，重试存在小概率重复，这是至少一次投递的限制。论坛接口只返回会话最新消息，间隔内同一会话多条消息可能只转发最后一条；不声称全量历史同步或秒级推送。消息直接使用纯文本，避免论坛 HTML 或 TG Markdown 注入。

## 部署与验证

Docker 数据卷保存 SQLite、加密密钥、密码摘要。install.sh 支持全新安装、更新、查看日志、停止和卸载，卸载默认保留数据；外部下载失败立即退出，禁止在失败后伪报成功。GitHub Actions 运行 Node 内置测试。测试覆盖响应解析、收发过滤、首次基线、重启去重、发送失败重试、鉴权和凭据保护、真实本地 HTTP 端到端接口。

本地测试不替代 NodeSeek 实际账号和 Telegram 真机联调。发布仅提交本项目目录，运行数据、Cookie、Token 和管理员密码全部忽略。
