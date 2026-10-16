# SSH 配置版设计

2026-10-16：按用户要求将网页配置改为 SSH 交互式终端，单账号独立部署。

- 删除网页静态资源、HTTP 管理服务、网页管理员密码流程，不映射任何端口。
- src/terminal.mjs 以 readline 终端模式读取，Token、Cookie 和代理输入不回显，关闭历史，Ctrl+C 不保存。
- src/cli.mjs 提供 config、status、test-nodeseek、test-telegram、check；复用原加密配置、校验、论坛/TG 适配器和队列。
- install.sh 首次安装在 /dev/tty 启动 Docker 交互式向导，支持 curl 管道安装。已有服务修改配置前停止，成功或取消后恢复原运行状态；非交互安装可跳过。
- 原数据库和密钥保留。Cookie 更新保留基线和待发队列；有待发消息时禁止切换 UID。
- src/main.mjs 只运行后台监控和心跳，src/health.mjs 检查心跳；不运行 HTTP 服务。
- 自动测试覆盖配置、回车保留、取消、凭据保护、真实 Linux PTY 和 Docker 向导。首次真实论坛联调仍待用户提供登录状态。
