# 验证记录

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
