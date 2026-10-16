# NodeSeek Telegram Implementation Plan

**Goal:** 独立部署的中文配置面板与 NodeSeek 私信 TG 通知服务。
**Architecture:** 一个 Node.js 24 进程、SQLite 事务队列、独立 HTTP 适配器、Docker Compose。
**Spec:** design.md

## 约束

- 不接触父目录已有项目；所有文件在 nodeseek-tg 内。
- Node.js >=24，唯一运行依赖 undici；测试用 node:test。
- NodeSeek 非官方接口必须严格检查结构，不承诺全量历史消息。
- 敏感字段 AES-256-GCM 加密，不返回面板、不写日志。
- 首次基线与新消息入队均事务化；失败持久重试。

## 执行顺序

1. [x] tests/core.test.mjs 先验证 normalizeMessages、Store.ingest、Monitor.tick 的消息契约、过滤、首次基线、去重、失败与重启行为。运行 node --test 观察缺少模块失败。
2. [x] src/store.mjs、nodeseek.mjs、telegram.mjs、monitor.mjs 实现上述接口。运行测试验证成功。
3. [x] tests/server.test.mjs 验证管理员登录、会话、同源写保护、敏感字段脱敏、配置验证与本地 HTTP 上游。先运行失败，再实现 src/server.mjs、config.mjs 和 public/ 页面。
4. [x] 创建 tests/install.test.mjs、GitHub Actions、Dockerfile、compose.yaml、install.sh、README.md、LICENSE、.gitignore。Linux CI 已通过 Docker 构建、完整安装、健康检查、备份和卸载。
5. [x] 执行完整测试、本地面板冒烟与依赖审核；审查队列、状态、凭据边界。修复后重新验证，结果见 verification.md。
6. [x] 初始化独立 Git 仓库，只提交本项目；已在用户授权的 GitHub 账号 wangjialiangsaa 下创建并发布 nodeseek-tg 仓库，安装脚本公开下载返回 HTTP 200。

由当前会话顺序执行，不需要另建聊天或子代理。
