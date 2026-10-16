# SSH 配置与账号密码登录设计

2026-10-16：增加账号密码登录。配置仍通过 SSH 输入，默认无公开管理端口。Chromium/Xvfb 使用服务器出口，必要时由用户通过临时 noVNC 和 SSH 隧道手动验证。登录和私信接口都验证成功才保存新配置；后台通过同一浏览器传输轮询，不在失效后自动反复提交密码。密码和浏览器 storage state 用原 AES-256-GCM 存储，运行缓存放在容器 tmpfs。

`config` / `login` 临时容器只映射服务器 `127.0.0.1:6080`，每次生成随机 RFB 密码并仅在 SSH 显示；正常后台容器不映射端口。验证完成、失败或 15 分钟超时后关闭入口，安装脚本恢复原服务运行状态。登录核对论坛 `window.__config__.user` 中的实际 ID；会话回写比较加密配置版本，连接测试不回写会话。手动验证不保证论坛接受服务器 IP。

以下为原 SSH Cookie 版设计；当前增加 `login` 命令、菜单 11 和浏览器适配器，保留 Cookie 模式。

2026-10-16：按用户要求将网页配置改为 SSH 交互式终端，单账号独立部署。

- 删除网页静态资源、HTTP 管理服务、网页管理员密码流程，不映射任何端口。
- src/terminal.mjs 以 readline 终端模式读取，Token、Cookie 和代理输入不回显，关闭历史，Ctrl+C 不保存。
- src/cli.mjs 提供 config、status、test-nodeseek、test-telegram、check；复用原加密配置、校验、论坛/TG 适配器和队列。
- install.sh 首次安装在 /dev/tty 启动 Docker 交互式向导，支持 curl 管道安装。已有服务修改配置前停止，成功或取消后恢复原运行状态；非交互安装可跳过。
- 原数据库和密钥保留。Cookie 更新保留基线和待发队列；有待发消息时禁止切换 UID。
- src/main.mjs 只运行后台监控和心跳，src/health.mjs 检查心跳；不运行 HTTP 服务。
- 自动测试覆盖配置、回车保留、取消、凭据保护、真实 Linux PTY 和 Docker 向导。首次真实论坛联调仍待用户提供登录状态。
