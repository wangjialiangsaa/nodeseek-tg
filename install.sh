#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
NodeSeek TG 安装与管理
  bash install.sh                     # 打开交互式数字菜单
  bash install.sh menu
  bash install.sh install [--repo OWNER/REPO] [--branch main]
  bash install.sh update [--repo OWNER/REPO]
  bash install.sh config | status | logs | test-nodeseek | test-telegram | check
  bash install.sh stop | start | backup | uninstall
默认目录 /opt/nodeseek-tg，可设置 INSTALL_DIR。卸载保留数据库和配置。
所有配置在 SSH 终端填写，不需要网页或开放端口。
设置 NONINTERACTIVE=1 可跳过安装后的配置向导（用于无人值守部署）。
EOF
}
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
action="${1:-menu}"
if [[ "$action" == --help || "$action" == -h ]]; then usage; exit 0; fi
if (($#)); then shift; fi
repo="${NODESEEK_TG_REPO:-}"
branch="${NODESEEK_TG_BRANCH:-main}"
branch_given=false
while (($#)); do
  case "$1" in
    --repo) (($# >= 2)) || fail '--repo 缺少仓库名称'; repo="$2"; shift 2 ;;
    --branch) (($# >= 2)) || fail '--branch 缺少分支'; branch="$2"; branch_given=true; shift 2 ;;
    *) fail "未知参数：$1" ;;
  esac
done
[[ -z "$repo" || "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail '仓库格式应为 OWNER/REPO'
[[ "$branch" =~ ^[A-Za-z0-9_./-]+$ && "$branch" != *..* ]] || fail '分支名称无效'
case "$action" in menu|install|update|config|status|logs|test-nodeseek|test-telegram|check|stop|start|backup|uninstall) ;; *) usage; fail '未知操作' ;; esac
[[ "$(uname -s)" == Linux ]] || fail '安装脚本需要 Linux 服务器；本地开发请使用 npm start'
[[ "$EUID" -eq 0 ]] || fail '请使用 root 或 sudo 运行安装脚本'
install_dir="${INSTALL_DIR:-/opt/nodeseek-tg}"
[[ "$install_dir" == /* && "$install_dir" != / && "$install_dir" != *..* && "$install_dir" != *$'\n'* ]] || fail 'INSTALL_DIR 必须是独立的绝对目录'
staging=''
cleanup() { if [[ -n "$staging" && -d "$staging" ]]; then rm -rf -- "$staging"; fi; }
trap cleanup EXIT
trap 'printf "操作失败，原配置与数据保留；请检查上方错误。\n" >&2' ERR
compose() { (cd "$install_dir" && docker compose --project-name nodeseek-tg "$@"); }
was_running=false
resume_service() {
  if [[ "$was_running" == true ]]; then compose up -d --wait --wait-timeout 120; fi
}
configure_service() {
  [[ -r /dev/tty && -w /dev/tty ]] || fail '需要交互式 SSH 终端，请使用 ssh -t 登录后运行 config'
  if [[ -n "$(compose ps --status running -q nodeseek-tg)" ]]; then was_running=true; fi
  compose stop
  trap 'resume_service >/dev/null || true; cleanup' EXIT
  compose run --rm --no-deps -it nodeseek-tg node src/cli.mjs config </dev/tty
  resume_service
  was_running=false
  trap cleanup EXIT
}
show_menu() {
  [[ -t 1 && -r /dev/tty ]] || fail '菜单需要交互式 SSH 终端，请使用 ssh -t 登录'
  local choice menu_action
  while true; do
    cat <<'EOF'

========== NodeSeek → Telegram ==========
  1. 填写 / 修改配置
  2. 查看运行状态
  3. 发送 Telegram 测试消息
  4. 测试 NodeSeek 登录连接
  5. 立即检查新私信
  6. 查看运行日志（Ctrl+C 停止查看）
  7. 停止服务
  8. 启动服务
  9. 备份数据
 10. 更新程序
  0. 退出菜单
EOF
    if ! IFS= read -r -p '请选择 [0-10]：' choice </dev/tty; then return 0; fi
    case "$choice" in
      0) return 0 ;;
      1) menu_action=config ;;
      2) menu_action=status ;;
      3) menu_action=test-telegram ;;
      4) menu_action=test-nodeseek ;;
      5) menu_action=check ;;
      6) menu_action=logs ;;
      7) menu_action=stop ;;
      8) menu_action=start ;;
      9) menu_action=backup ;;
      10) menu_action=update ;;
      *) printf '无效选项，请输入 0–10。\n'; continue ;;
    esac
    if INSTALL_DIR="$install_dir" bash "$install_dir/install.sh" "$menu_action"; then
      printf '\n操作完成，已返回菜单。\n'
    else
      printf '\n操作未完成，原配置保留；可查看上方提示后重试。\n'
    fi
  done
}

if [[ "$action" == install || "$action" == update ]]; then
  if [[ "$action" == update ]]; then
    [[ -f "$install_dir/compose.yaml" ]] || fail '找不到已安装程序，请先 install'
    if [[ -z "$repo" && -f "$install_dir/.repository" ]]; then repo="$(cat "$install_dir/.repository")"; fi
    if [[ "$branch_given" == false && -f "$install_dir/.branch" ]]; then branch="$(cat "$install_dir/.branch")"; fi
    [[ "$branch" =~ ^[A-Za-z0-9_./-]+$ && "$branch" != *..* ]] || fail '保存的分支名称无效'
  fi
  if ! command -v curl >/dev/null; then
    command -v apt-get >/dev/null || fail '请先安装 curl 和 Docker Compose v2'
    apt-get update
    apt-get install -y curl ca-certificates
  fi
  staging="$(mktemp -d -t nodeseek-tg.XXXXXXXX)"
  if ! command -v docker >/dev/null; then
    printf '正在安装 Docker（官方安装脚本）…\n'
    curl --fail --location --silent --show-error --proto '=https' https://get.docker.com -o "$staging/docker-install.sh"
    sh "$staging/docker-install.sh"
  fi
  docker compose version >/dev/null || fail '需要 Docker Compose v2；请安装 docker-compose-plugin'
  if command -v systemctl >/dev/null; then systemctl enable --now docker; fi
  docker info >/dev/null || fail 'Docker 服务未运行'
  script_dir=''
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; fi
  if [[ -n "$repo" ]]; then
    [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail '保存的仓库名称无效'
    printf '正在下载 %s（%s）…\n' "$repo" "$branch"
    curl --fail --location --silent --show-error --proto '=https' "https://github.com/$repo/archive/refs/heads/$branch.tar.gz" -o "$staging/source.tar.gz"
    mkdir "$staging/source"
    tar -xzf "$staging/source.tar.gz" -C "$staging/source" --strip-components=1
    source_dir="$staging/source"
  elif [[ -n "$script_dir" && -f "$script_dir/package-lock.json" && -f "$script_dir/src/main.mjs" ]]; then
    source_dir="$script_dir"
  else
    fail '请传入 --repo OWNER/REPO，或从完整仓库目录执行 install.sh'
  fi
  [[ -f "$source_dir/compose.yaml" && -f "$source_dir/package-lock.json" ]] || fail '仓库缺少部署文件'
  mkdir -p "$install_dir"
  if [[ "$source_dir" != "$install_dir" ]]; then
    for file in src Dockerfile compose.yaml package.json package-lock.json install.sh README.md LICENSE; do cp -a "$source_dir/$file" "$install_dir/"; done
    cp "$source_dir/.dockerignore" "$install_dir/.dockerignore"
  fi
  if [[ -n "$repo" ]]; then printf '%s' "$repo" > "$install_dir/.repository"; printf '%s' "$branch" > "$install_dir/.branch"; fi
  # Remove only obsolete web application files. Keep the existing database,
  # encryption key, backups and .env from older installations.
  if [[ -f "$install_dir/src/server.mjs" ]]; then rm -- "$install_dir/src/server.mjs"; fi
  for old_asset in index.html app.js style.css; do
    if [[ -f "$install_dir/public/$old_asset" ]]; then rm -- "$install_dir/public/$old_asset"; fi
  done
  if [[ -d "$install_dir/public" ]]; then rmdir -- "$install_dir/public" 2>/dev/null || true; fi
  compose up -d --build --wait --wait-timeout 120
  printf '\n服务已启动。管理目录：%s\n' "$install_dir"
  printf 'SSH 配置：bash %s/install.sh config\n' "$install_dir"
  printf '交互式菜单：bash %s/install.sh\n' "$install_dir"
  if [[ "$action" == install && "${NONINTERACTIVE:-0}" != 1 ]]; then
    if [[ -t 1 && -r /dev/tty ]]; then configure_service; else printf '当前无交互终端，已跳过向导；请在 SSH 中执行上面的 config 命令。\n'; fi
  fi
  printf '后续操作：bash %s/install.sh status（或 test-nodeseek / test-telegram / logs / backup）\n' "$install_dir"
  exit 0
fi

[[ -f "$install_dir/compose.yaml" ]] || fail '找不到已安装程序'
case "$action" in
  menu) show_menu ;;
  config) configure_service ;;
  status) compose ps; compose run --rm --no-deps -T nodeseek-tg node src/cli.mjs status ;;
  test-nodeseek|test-telegram) compose run --rm --no-deps -T nodeseek-tg node src/cli.mjs "$action" ;;
  check)
    if [[ -n "$(compose ps --status running -q nodeseek-tg)" ]]; then was_running=true; fi
    compose stop
    trap 'resume_service >/dev/null || true; cleanup' EXIT
    compose run --rm --no-deps -T nodeseek-tg node src/cli.mjs check
    resume_service
    was_running=false
    trap cleanup EXIT
    ;;
  logs) compose logs --tail=100 -f ;;
  stop) compose stop ;;
  start) compose up -d --wait --wait-timeout 120 ;;
  uninstall) compose down; printf '服务已卸载，配置文件和 Docker 数据卷已保留。\n' ;;
  backup)
    mkdir -p "$install_dir/backups"
    backup_file="$install_dir/backups/data-$(date +%Y%m%d-%H%M%S).tar.gz"
    umask 077
    compose stop
    trap 'compose start >/dev/null || true; cleanup' EXIT
    compose run --rm --no-deps -T nodeseek-tg tar -czf - -C /data . > "$backup_file"
    compose start
    chmod 600 "$backup_file"
    printf '已备份数据库与加密密钥：%s\n' "$backup_file"
    ;;
esac
