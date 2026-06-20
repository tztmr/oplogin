#!/usr/bin/env bash
# 使用方式：
# chmod +x ./deploy-oplogin.sh
# bash ./deploy-oplogin.sh

set -euo pipefail

if [[ -t 1 ]]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'; NC=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; NC=''
fi

info() { printf "${B}[INFO]${NC} %s\n" "$1"; }
warn() { printf "${Y}[WARN]${NC} %s\n" "$1"; }
error() { printf "${R}[ERROR]${NC} %s\n" "$1" >&2; }
ok() { printf "${G}[OK]${NC} %s\n" "$1"; }

APP_SLUG="oplogin"
DEFAULT_REPO_URL="git@github.com:tztmr/oplogin.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="/opt/oplogin"
DEFAULT_APP_NAME="oplogin"
DEFAULT_PORT="4399"
STATE_DIR="${HOME}/.${APP_SLUG}-deploy"
STATE_FILE="${STATE_DIR}/state.env"
PROJECT_DIR=""

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return $?
  fi
  if command_exists sudo; then
    sudo "$@"
    return $?
  fi
  return 1
}

ensure_root_capability() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  if ! command_exists sudo; then
    error "需要 root 或 sudo 权限"
    exit 1
  fi
  if ! sudo -n true 2>/dev/null; then
    error "当前账号需要先具备 sudo 授权"
    exit 1
  fi
}

prompt_default() {
  local prompt="$1" default_value="${2:-}" answer=""
  if [[ -n "$default_value" ]]; then
    printf '%s [%s]: ' "$prompt" "$default_value" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r answer
  answer="$(trim "$answer")"
  [[ -z "$answer" ]] && answer="$default_value"
  printf '%s' "$answer"
}

ask_yes_no() {
  local prompt="$1" default_value="${2:-y}" answer="" hint="[Y/n]"
  [[ "$default_value" == "n" ]] && hint="[y/N]"
  while true; do
    printf '%s %s: ' "$prompt" "$hint" >&2
    read -r answer
    answer="$(trim "$answer")"
    [[ -z "$answer" ]] && answer="$default_value"
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    case "$answer" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "请输入 y 或 n" ;;
    esac
  done
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  (( "$1" >= 1 && "$1" <= 65535 ))
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
}

save_state() {
  ensure_state_dir
  {
    printf 'PROJECT_DIR=%q\n' "$PROJECT_DIR"
    printf 'REPO_URL=%q\n' "$REPO_URL"
    printf 'BRANCH=%q\n' "$BRANCH"
    printf 'APP_NAME=%q\n' "$APP_NAME"
    printf 'APP_PORT=%q\n' "$APP_PORT"
    printf 'DOMAIN=%q\n' "${DOMAIN:-}"
    printf 'EMAIL=%q\n' "${EMAIL:-}"
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

load_state() {
  [[ -f "$STATE_FILE" ]] || return 1
  set +u
  source "$STATE_FILE"
  set -u
  [[ -n "${PROJECT_DIR:-}" && -n "${REPO_URL:-}" && -n "${BRANCH:-}" && -n "${APP_NAME:-}" && -n "${APP_PORT:-}" ]]
}

assert_project_layout() {
  [[ -f "${PROJECT_DIR}/package.json" ]] || { error "项目目录缺少 package.json: ${PROJECT_DIR}"; return 1; }
  [[ -f "${PROJECT_DIR}/server.js" ]] || { error "项目目录缺少 server.js: ${PROJECT_DIR}"; return 1; }
}

install_git_if_needed() {
  if command_exists git; then
    return 0
  fi

  ensure_root_capability
  info "检测到未安装 Git，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq git
  elif command_exists dnf; then
    run_root dnf install -y -q git
  elif command_exists yum; then
    run_root yum install -y -q git
  else
    error "不支持的系统包管理器，请手动安装 Git"
    return 1
  fi

  ok "Git 安装完成"
}

install_node_if_needed() {
  if command_exists node && command_exists npm; then
    return 0
  fi

  ensure_root_capability
  info "检测到未安装 Node.js，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash -
    run_root apt-get install -y -qq nodejs
  elif command_exists dnf; then
    run_root dnf module reset -y nodejs >/dev/null 2>&1 || true
    run_root dnf install -y -q nodejs npm
  elif command_exists yum; then
    run_root yum install -y -q nodejs npm
  else
    error "不支持的系统包管理器，请手动安装 Node.js"
    return 1
  fi

  ok "Node.js 安装完成"
}

install_pm2_if_needed() {
  if command_exists pm2; then
    return 0
  fi

  info "检测到未安装 PM2，开始自动安装"
  npm install -g pm2
  ok "PM2 安装完成"
}

install_nginx_if_needed() {
  if command_exists nginx; then
    return 0
  fi

  ensure_root_capability
  info "检测到未安装 Nginx，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq nginx
  elif command_exists dnf; then
    run_root dnf install -y -q nginx
  elif command_exists yum; then
    run_root yum install -y -q nginx
  else
    error "不支持的系统包管理器，请手动安装 Nginx"
    return 1
  fi

  run_root systemctl enable nginx
  run_root systemctl start nginx
  ok "Nginx 安装完成"
}

install_certbot_if_needed() {
  if command_exists certbot; then
    return 0
  fi

  ensure_root_capability
  info "检测到未安装 certbot，开始自动安装"
  if command_exists apt-get; then
    run_root apt-get update -y -qq
    run_root apt-get install -y -qq certbot python3-certbot-nginx
  elif command_exists dnf; then
    run_root dnf install -y -q certbot python3-certbot-nginx || run_root dnf install -y -q certbot-nginx
  elif command_exists yum; then
    run_root yum install -y -q certbot python3-certbot-nginx || run_root yum install -y -q certbot-nginx
  else
    error "不支持的系统包管理器，请手动安装 certbot"
    return 1
  fi

  ok "certbot 安装完成"
}

allow_firewall_port() {
  local port="$1"
  if command_exists ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
    run_root ufw allow "${port}/tcp" >/dev/null 2>&1 || true
  fi
  if command_exists firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_root firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    run_root firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

port_owner() {
  local port="$1"

  if command_exists lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1; exit}'
    return 0
  fi

  if command_exists ss; then
    ss -ltnp 2>/dev/null | awk -v target=":$port" '$4 ~ target {print $NF; exit}' | sed -E 's/.*"([^"]+)".*/\1/'
    return 0
  fi

  return 0
}

sync_project_code() {
  local install_dir="$1" repo_url="$2" branch="$3"

  if [[ -d "${install_dir}/.git" ]]; then
    info "检测到已有代码，开始拉取最新版本"
    git -C "$install_dir" fetch origin "$branch"
    git -C "$install_dir" checkout "$branch"
    git -C "$install_dir" pull --ff-only origin "$branch"
  else
    if [[ -d "$install_dir" ]] && [[ -n "$(ls -A "$install_dir" 2>/dev/null)" ]]; then
      error "安装目录已存在且不是 Git 仓库：${install_dir}"
      error "请换一个空目录，或先清理该目录后重试"
      return 1
    fi

    ensure_root_capability
    run_root mkdir -p "$(dirname "$install_dir")"
    run_root mkdir -p "$install_dir"
    if [[ "$(id -u)" -ne 0 ]]; then
      run_root chown -R "$(id -u):$(id -g)" "$install_dir"
    fi
    info "开始克隆项目代码到 ${install_dir}"
    git clone --branch "$branch" "$repo_url" "$install_dir"
  fi

  PROJECT_DIR="$install_dir"
}

install_app_dependencies() {
  (
    cd "$PROJECT_DIR"
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  )
}

start_or_restart_app() {
  (
    cd "$PROJECT_DIR"
    if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
      PORT="$APP_PORT" NODE_ENV=production pm2 restart "$APP_NAME" --update-env
    else
      PORT="$APP_PORT" NODE_ENV=production pm2 start server.js --name "$APP_NAME"
    fi
    pm2 save >/dev/null 2>&1 || true
  )
}

nginx_conf_dir() {
  if [[ -d /etc/nginx/conf.d ]]; then
    printf '/etc/nginx/conf.d'
  else
    printf '/etc/nginx/sites-available'
  fi
}

enable_nginx_conf_if_needed() {
  local conf_file="$1"
  if [[ "$conf_file" == /etc/nginx/conf.d/* ]]; then
    run_root rm -f "/etc/nginx/sites-enabled/$(basename "$conf_file")" 2>/dev/null || true
    return 0
  fi
  if [[ -d /etc/nginx/sites-enabled ]]; then
    run_root ln -sf "$conf_file" "/etc/nginx/sites-enabled/$(basename "$conf_file")"
  fi
}

write_nginx_http_conf() {
  local conf_file="$1" domain="$2" app_port="$3"
  local tmp_file
  tmp_file="$(mktemp)"

  cat > "$tmp_file" <<EOF
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:${app_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF

  run_root install -m 0644 "$tmp_file" "$conf_file"
  rm -f "$tmp_file"
}

deploy_app() {
  local install_dir

  install_git_if_needed
  install_node_if_needed
  install_pm2_if_needed

  if load_state; then
    install_dir="${PROJECT_DIR:-$DEFAULT_INSTALL_DIR}"
    REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
    BRANCH="${BRANCH:-$DEFAULT_BRANCH}"
    APP_NAME="${APP_NAME:-$DEFAULT_APP_NAME}"
    APP_PORT="${APP_PORT:-$DEFAULT_PORT}"
  else
    install_dir="$DEFAULT_INSTALL_DIR"
    REPO_URL="$DEFAULT_REPO_URL"
    BRANCH="$DEFAULT_BRANCH"
    APP_NAME="$DEFAULT_APP_NAME"
    APP_PORT="$DEFAULT_PORT"
  fi

  install_dir="$(prompt_default "项目安装目录" "${install_dir}")"
  REPO_URL="$(prompt_default "Git 仓库地址" "${REPO_URL}")"
  BRANCH="$(prompt_default "分支名" "${BRANCH}")"
  APP_NAME="$(prompt_default "PM2 应用名称" "${APP_NAME}")"
  APP_PORT="$(prompt_default "应用监听端口" "${APP_PORT}")"

  [[ -z "$install_dir" ]] && { error "安装目录不能为空"; return 1; }
  [[ -z "$REPO_URL" ]] && { error "Git 仓库地址不能为空"; return 1; }
  [[ -z "$BRANCH" ]] && { error "分支名不能为空"; return 1; }
  [[ -z "$APP_NAME" ]] && { error "PM2 应用名称不能为空"; return 1; }
  validate_port "$APP_PORT" || { error "端口无效：$APP_PORT"; return 1; }

  if [[ -n "$(port_owner "$APP_PORT")" ]] && ! pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    error "端口 ${APP_PORT} 已被其他进程占用"
    return 1
  fi

  sync_project_code "$install_dir" "$REPO_URL" "$BRANCH"
  assert_project_layout

  info "开始安装依赖"
  install_app_dependencies

  info "开始启动 PM2 服务"
  start_or_restart_app
  save_state

  ok "应用部署完成"
  echo "项目目录：${PROJECT_DIR}"
  echo "Git 仓库：${REPO_URL}"
  echo "分支：${BRANCH}"
  echo "访问端口：http://127.0.0.1:${APP_PORT}"
  echo "如需域名 HTTPS，请继续执行脚本菜单中的“接入域名 HTTPS”。"
}

setup_https() {
  load_state || { error "请先执行应用部署"; return 1; }

  install_nginx_if_needed
  install_certbot_if_needed

  DOMAIN="$(prompt_default "绑定域名（如 op.example.com）" "${DOMAIN:-}")"
  [[ -z "$DOMAIN" ]] && { error "域名不能为空"; return 1; }
  EMAIL="$(prompt_default "证书邮箱" "${EMAIL:-admin@${DOMAIN}}")"

  local conf_dir conf_file
  conf_dir="$(nginx_conf_dir)"
  conf_file="${conf_dir}/${DOMAIN}.conf"

  run_root mkdir -p "$conf_dir"
  write_nginx_http_conf "$conf_file" "$DOMAIN" "$APP_PORT"
  enable_nginx_conf_if_needed "$conf_file"

  allow_firewall_port 80
  allow_firewall_port 443
  run_root nginx -t
  run_root systemctl reload nginx 2>/dev/null || run_root nginx -s reload
  run_root certbot --nginx -d "$DOMAIN" --redirect -m "$EMAIL" --agree-tos --non-interactive
  save_state

  ok "HTTPS 已接入"
  echo "访问地址：https://${DOMAIN}"
}

status_app() {
  load_state || { error "请先执行应用部署"; return 1; }
  echo "项目目录：${PROJECT_DIR}"
  echo "Git 仓库：${REPO_URL}"
  echo "分支：${BRANCH}"
  echo "PM2 应用：${APP_NAME}"
  echo "监听端口：${APP_PORT}"
  echo "域名：${DOMAIN:-未配置}"
  echo
  pm2 status "$APP_NAME"
}

logs_app() {
  load_state || { error "请先执行应用部署"; return 1; }
  pm2 logs "$APP_NAME" --lines 100
}

restart_app() {
  load_state || { error "请先执行应用部署"; return 1; }
  PORT="$APP_PORT" NODE_ENV=production pm2 restart "$APP_NAME" --update-env
  ok "服务已重启"
}

rebuild_app() {
  load_state || { error "请先执行应用部署"; return 1; }
  install_git_if_needed
  install_node_if_needed
  install_pm2_if_needed
  sync_project_code "$PROJECT_DIR" "$REPO_URL" "$BRANCH"
  assert_project_layout
  install_app_dependencies
  start_or_restart_app
  save_state
  ok "代码已更新并重新部署"
}

uninstall_app() {
  load_state || { error "请先执行应用部署"; return 1; }
  warn "将删除 PM2 进程，代码目录和 Nginx 配置不会自动删除。"
  if ask_yes_no "确认继续卸载" "n"; then
    pm2 delete "$APP_NAME" || true
    pm2 save >/dev/null 2>&1 || true
    ok "PM2 应用已删除"
  fi
}

print_menu() {
  echo
  echo "=============== oplogin 部署脚本 ==============="
  echo "1) 拉代码 + 安装依赖 + PM2 部署"
  echo "2) 接入域名 HTTPS"
  echo "3) 查看服务状态"
  echo "4) 查看日志"
  echo "5) 重启服务"
  echo "6) 拉取最新代码并重建"
  echo "7) 卸载 PM2 应用"
  echo "0) 退出"
  echo "==============================================="
}

interactive_main() {
  while true; do
    print_menu
    printf '请选择 [0-7]: ' >&2
    local choice
    read -r choice
    choice="$(trim "$choice")"
    case "$choice" in
      1) deploy_app ;;
      2) setup_https ;;
      3) status_app ;;
      4) logs_app ;;
      5) restart_app ;;
      6) rebuild_app ;;
      7) uninstall_app ;;
      0) exit 0 ;;
      *) warn "无效选项" ;;
    esac
  done
}

main() {
  case "${1:-}" in
    deploy) deploy_app ;;
    https) setup_https ;;
    status) status_app ;;
    logs) logs_app ;;
    restart) restart_app ;;
    rebuild) rebuild_app ;;
    uninstall) uninstall_app ;;
    "") interactive_main ;;
    *)
      error "不支持的命令: $1"
      echo "可用命令: deploy | https | status | logs | restart | rebuild | uninstall"
      exit 1
      ;;
  esac
}

main "$@"
