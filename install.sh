#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
NodeSeek TG 安装与管理
  bash install.sh install [--repo OWNER/REPO] [--branch main]
  bash install.sh update [--repo OWNER/REPO]
  bash install.sh status | logs | stop | start | backup | uninstall
默认目录 /opt/nodeseek-tg，可设置 INSTALL_DIR。卸载保留数据库和配置。
默认只监听 127.0.0.1；首次安装可设置 BIND_IP、PORT。
EOF
}
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
action="${1:-install}"
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
case "$action" in install|update|status|logs|stop|start|backup|uninstall) ;; *) usage; fail '未知操作' ;; esac
[[ "$(uname -s)" == Linux ]] || fail '安装脚本需要 Linux 服务器；本地开发请使用 npm start'
[[ "$EUID" -eq 0 ]] || fail '请使用 root 或 sudo 运行安装脚本'
install_dir="${INSTALL_DIR:-/opt/nodeseek-tg}"
[[ "$install_dir" == /* && "$install_dir" != / && "$install_dir" != *..* && "$install_dir" != *$'\n'* ]] || fail 'INSTALL_DIR 必须是独立的绝对目录'
staging=''
cleanup() { if [[ -n "$staging" && -d "$staging" ]]; then rm -rf -- "$staging"; fi; }
trap cleanup EXIT
trap 'printf "操作失败，原配置与数据保留；请检查上方错误。\n" >&2' ERR
compose() { (cd "$install_dir" && docker compose --project-name nodeseek-tg "$@"); }

if [[ "$action" == install || "$action" == update ]]; then
  if [[ "$action" == update ]]; then
    [[ -f "$install_dir/compose.yaml" ]] || fail '找不到已安装程序，请先 install'
    if [[ -z "$repo" && -f "$install_dir/.repository" ]]; then repo="$(cat "$install_dir/.repository")"; fi
    if [[ "$branch_given" == false && -f "$install_dir/.branch" ]]; then branch="$(cat "$install_dir/.branch")"; fi
    [[ "$branch" =~ ^[A-Za-z0-9_./-]+$ && "$branch" != *..* ]] || fail '保存的分支名称无效'
  fi
  if ! command -v curl >/dev/null || ! command -v openssl >/dev/null; then
    command -v apt-get >/dev/null || fail '请先安装 curl、openssl 和 Docker Compose v2'
    apt-get update
    apt-get install -y curl ca-certificates openssl
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
    for file in src public Dockerfile compose.yaml package.json package-lock.json install.sh README.md LICENSE; do cp -a "$source_dir/$file" "$install_dir/"; done
    cp "$source_dir/.dockerignore" "$install_dir/.dockerignore"
  fi
  if [[ -n "$repo" ]]; then printf '%s' "$repo" > "$install_dir/.repository"; printf '%s' "$branch" > "$install_dir/.branch"; fi
  first_install=false
  if [[ ! -f "$install_dir/.env" ]]; then
    umask 077
    initial_password="$(openssl rand -hex 18)"
    bind_ip="${BIND_IP:-127.0.0.1}"
    port="${PORT:-8787}"
    [[ "$bind_ip" =~ ^[0-9.]+$ ]] || fail 'BIND_IP 请使用 IPv4 地址'
    [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || fail 'PORT 无效'
    printf 'ADMIN_PASSWORD=%s\nBIND_IP=%s\nPORT=%s\nCOOKIE_SECURE=false\nPUBLIC_URL=\n' "$initial_password" "$bind_ip" "$port" > "$install_dir/.env"
    first_install=true
  fi
  chmod 600 "$install_dir/.env"
  compose up -d --build --wait --wait-timeout 120
  printf '\n服务已启动。管理目录：%s\n' "$install_dir"
  if [[ "$first_install" == true ]]; then printf '首次管理员密码：%s\n监听地址：%s:%s\n' "$initial_password" "$bind_ip" "$port"; fi
  printf '默认访问方式：ssh -L 8787:127.0.0.1:8787 root@服务器IP，然后打开 http://127.0.0.1:8787\n'
  printf '后续操作：bash %s/install.sh status（或 update / logs / backup）\n' "$install_dir"
  exit 0
fi

[[ -f "$install_dir/compose.yaml" ]] || fail '找不到已安装程序'
case "$action" in
  status) compose ps ;;
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
