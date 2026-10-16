# 验证记录

## 账号密码登录版

2026-10-16：在用户服务器的隔离 staging 目录构建镜像成功。27 项 Node 测试在真实 Linux Docker 全部通过，0 跳过；包含 Chromium 读取带 HttpOnly Cookie 的模拟私信接口、noVNC 页面启动与关闭、RFB 仅提供密码认证、只保留论坛会话数据、密码不回显及加密、登录失败保留原配置与待发队列、取消后的回滚和旧会话并发回写保护。浏览器测试同时使用只读文件系统、256 MB tmpfs、128 MB shm、cap_drop ALL 和 no-new-privileges。真实 Linux PTY 配置隐藏输入、取消、数字菜单及错误恢复均通过。

真实 RFB 密码挑战/应答认证通过，随机密码文件与标准 x11vnc 格式一致。独立审查发现并修复取消时序、账号身份核对、跨轮询旧会话覆盖及临时桌面认证问题。

真实论坛的 HTTP 直接访问及旧 Cookie 模式在服务器收到 Cloudflare 403；用户已同意手动浏览器验证。账号登录和实际私信读取需以接下来的现场结果为准，模拟测试不代表 Cloudflare 通行。

## SSH 配置版（当前）

数字菜单验证已通过：直接运行 install.sh 打开菜单，选择状态、失败后重选、非法编号和退出均由真实 Linux PTY 测试通过。完整 Linux CI：https://github.com/wangjialiangsaa/nodeseek-tg/actions/runs/38848133679 ，代码版本 391a8053db15294e13bc377e83d8d098b01f8976。

2026-10-16：本地 17 项测试，16 通过，1 项 Bash 检查因 Windows 缺少 Bash 跳过；依赖审计 0 已知漏洞。

真实 Windows PTY 已验证 Token / Cookie 输入不回显、配置保存、Ctrl+C 取消。实际后台进程已验证心跳健康，不启动 HTTP 服务。独立审查发现旧更新器要求 public 目录，已保留仅兼容用途的 .gitkeep；PR 安装测试已改为检出源码。

Linux CI 已通过：17 项测试全部成功，0 跳过；真实 Linux PTY 和 Docker 内终端配置、隐藏输入、Ctrl+C 取消、公开链接安装、399b38a 旧版更新器升级、无管理端口的后台健康检查及备份均成功。

CI 证据：https://github.com/wangjialiangsaa/nodeseek-tg/actions/runs/38847680519 ，代码版本 a0d49557d9b34f013d1512dc2642bce7b9bae4db。

本地模拟终端测试目录 tmp/nodeseek-ssh-terminal-test 的删除被自动审批策略拦截，暂时保留；仅含合成凭据，未纳入仓库或源码包。真实 NodeSeek/TG 账号联调仍待用户服务器配置。

## 网页版（历史记录）

2026-10-16，Windows 本地，Node.js 24.21.0。

- `npm test`：16 项，15 通过，0 失败，1 项因本地没有可用 Bash 而跳过。
- `npm audit --omit=dev`：0 已知漏洞。
- Chrome / Playwright：真实启动程序，登录、配置保存、敏感字段清空、刷新保持设置、退出全部通过；390px 手机视口无横向溢出，浏览器 JavaScript 错误为 0。
- 独立代码审查：修复 Cookie 更新清空待发队列的问题；修复备份/恢复用户与容器权限冲突；修复关闭时等待未完成 HTTP 请求；修复更新显式分支被保存值覆盖的问题。
- 所有凭据测试使用合成数据，本地 Chrome 测试临时数据库已清理。
- Linux GitHub CI 已通过：16 项测试全部成功、0 跳过；Bash 语法检查、Compose 校验、Docker 构建、容器健康检查均成功。
- 在 Linux CI 中从公开 GitHub 链接一条命令下载并安装，服务健康检查通过；实际备份生成非空压缩包，随后卸载成功并保留数据。
- CI 证据：https://github.com/wangjialiangsaa/nodeseek-tg/actions/runs/38845061245 ，代码版本 99bb09051e52991f6b74edef1dee85597734a1d4。
- NodeSeek 真实账号、Cloudflare 通行与 Telegram 真机联调尚未执行，需要用户登录状态与服务器。
- 已发布到 https://github.com/wangjialiangsaa/nodeseek-tg ，README 包含可直接执行的安装命令。

本地预览截图在忽略目录 `screenshots/desktop.png` 和 `screenshots/mobile.png`，未纳入发布。
