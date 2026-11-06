#!/usr/bin/env bash
set -euo pipefail

# Interactive setup plus a checksummed binary. See docs/installation.md for unattended use.
# All prompts use the controlling terminal; stdin may contain this script.
confirm() {
  local answer
  while true; do
    prompt answer "$1 [Y/n] "
    case "$answer" in
      ''|[yY]|[yY][eE][sS]) return 0 ;;
      [nN]|[nN][oO]) return 1 ;;
      *) printf 'Please enter y or n.\n' >&2 ;;
    esac
  done
}

prompt() {
  printf '%s' "$2" > /dev/tty
  if ! read -r "$1" < /dev/tty; then
    printf '\nTerminal input ended. Rerun setup to continue.\n' >&2
    exit 1
  fi
}

# Each operation explicitly propagates errors: Bash disables errexit inside
# functions used as conditions (including the commands invoked by this loop).
retry_step() {
  local label="$1"
  shift
  until "$@"; do
    printf '%s failed.\n' "$label" >&2
    [[ "$noninteractive" != 1 ]] || return 1
    confirm "Retry ${label}?" || return 1
  done
}

download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"
}

download_script() {
  local url="$1" file="$2" shell="$3" first_line
  download "$url" "$file" || return 1
  IFS= read -r first_line < "$file" || true
  if [[ ! "$first_line" =~ ^#!.*sh ]] || ! "$shell" -n "$file" 2>/dev/null; then
    printf 'Invalid installer from %s: expected a shell script, received HTML or other invalid content. Check your network/proxy access.\n' "$url" >&2
    return 1
  fi
}

ensure_brew() {
  if ! command -v brew >/dev/null; then
    confirm 'Install Homebrew to set up missing tools?' || return 1
    retry_step 'Homebrew download' download_script 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh' "${tmp}/homebrew.sh" bash || return 1
    retry_step 'Homebrew installation' bash "${tmp}/homebrew.sh" < /dev/tty || return 1
    export PATH="/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:${PATH}"
  fi
  command -v brew >/dev/null
}

install_github_tools() {
  HOMEBREW_NO_AUTO_UPDATE=1 brew install "$@" || return 1
  hash -r
  local dependency
  for dependency in "$@"; do
    "$dependency" --version >/dev/null 2>&1 || { printf '%s is still unavailable after installation. Check PATH and retry.\n' "$dependency" >&2; return 1; }
  done
}

setup_github() {
  local dependency missing_tools=()
  for dependency in gh git; do
    if ! command -v "$dependency" >/dev/null || ! "$dependency" --version >/dev/null 2>&1; then
      missing_tools+=("$dependency")
    fi
  done
  if [[ "${#missing_tools[@]}" != 0 ]]; then
    [[ "$noninteractive" != 1 ]] || { printf 'Missing or broken tools: %s. Rerun interactively to install them.\n' "${missing_tools[*]}" >&2; return 1; }
    confirm "Install missing GitHub tools (${missing_tools[*]})?" || return 0
    ensure_brew || return 1
    retry_step 'GitHub dependencies' install_github_tools "${missing_tools[@]}" || return 1
  fi
  command -v gh >/dev/null || { printf 'GitHub CLI is missing. Rerun interactively to install it.\n' >&2; return 1; }
  command -v git >/dev/null || { printf 'Git is missing. Rerun interactively to install it.\n' >&2; return 1; }
  if ! gh auth status --active --hostname "$github_host" >/dev/null 2>&1; then
    [[ "$noninteractive" != 1 ]] || { printf 'Run gh auth login --hostname %s --scopes repo,read:org,workflow,read:project first.\n' "$github_host" >&2; return 1; }
    if ! confirm "Authenticate GitHub CLI with ${github_host} now?"; then
      printf 'Skipping GitHub authentication. Run gh auth login --hostname %s when ready.\n' "$github_host"
      return 0
    fi
    printf 'Opus Desk needs repository and organization access; workflow allows agent fixes to CI files.\n'
    retry_step 'GitHub sign-in' gh auth login --hostname "$github_host" --web --git-protocol https --scopes repo,read:org,workflow,read:project < /dev/tty || return 1
  fi
  if confirm 'Check GitHub OAuth scopes and offer refresh?'; then
  local headers scopes missing scope refreshed=0
  while true; do
    retry_step 'GitHub access check' github_headers || return 1
    scopes="$(printf '%s\n' "$headers" | awk 'tolower($0) ~ /^x-oauth-scopes:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]\r]/, ""); print}')"
    missing=''
    for scope in repo read:org workflow read:project; do
      case ",$scopes," in
        *",$scope,"*) ;;
        *) if [[ "$scope" == read:org && ( ",$scopes," == *",admin:org,"* || ",$scopes," == *",write:org,"* ) ]]; then continue; fi
           if [[ "$scope" == read:project && ",$scopes," == *",project,"* ]]; then continue; fi
           missing="${missing}${scope}," ;;
      esac
    done
    [[ -n "$missing" ]] || break
    if [[ -z "$scopes" ]]; then
      printf 'Cannot verify OAuth scopes. Use GitHub CLI browser login (repo, read:org, workflow, read:project). Fine-grained/environment tokens need per-repository checks.\n' >&2
    else
      printf 'GitHub access is missing: %s\n' "${missing%,}" >&2
    fi
    if [[ "$noninteractive" == 1 || -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}${GH_ENTERPRISE_TOKEN:-}${GITHUB_ENTERPRISE_TOKEN:-}" ]]; then
      printf 'Run gh auth refresh --hostname %s --scopes repo,read:org,workflow,read:project (unset environment tokens first).\n' "$github_host" >&2
      return 1
    fi
    if [[ "$refreshed" == 1 ]]; then
      confirm 'GitHub access is still incomplete. Check authorization and retry?' || return 1
    fi
    confirm 'Refresh GitHub OAuth scopes now?' || return 0
    retry_step 'GitHub scope refresh' gh auth refresh --hostname "$github_host" --scopes repo,read:org,workflow,read:project < /dev/tty || return 1
    refreshed=1
  done
  printf 'GitHub authentication and OAuth scopes verified. Organization SSO and repository roles still apply.\n'
  fi
  if confirm 'Configure Git to use GitHub CLI credentials?'; then
    retry_step 'Git credential configuration' gh auth setup-git --hostname "$github_host" || return 1
  fi
}

github_headers() {
  headers="$(gh api --hostname "$github_host" --include user)"
}

agent_authenticated() {
  if [[ "$agent" == codex ]]; then codex login status >/dev/null 2>&1
  else claude auth status >/dev/null 2>&1
  fi
}

agent_login() {
  if [[ "$agent" == codex ]]; then codex login < /dev/tty || return 1
  else claude auth login < /dev/tty || return 1
  fi
  agent_authenticated || { printf '%s sign-in is still incomplete.\n' "$agent" >&2; return 1; }
}

install_agent() {
  # A user may fix their installation separately before answering the retry.
  if [[ "${OPUSDESK_UPDATE_AGENT:-0}" != 1 ]] && command -v "$agent" >/dev/null && "$agent" --version >/dev/null 2>&1; then
    "$agent" --version
    return $?
  fi
  printf 'Installing %s using its official installer…\n' "$agent"
  if [[ "$agent" == codex ]]; then
    download_script 'https://chatgpt.com/codex/install.sh' "${tmp}/codex.sh" sh || return 1
    CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR="${HOME}/.local/bin" sh "${tmp}/codex.sh" < /dev/tty || return 1
  elif ! { download_script 'https://claude.ai/install.sh' "${tmp}/claude.sh" bash && bash "${tmp}/claude.sh" latest < /dev/tty; }; then
    if [[ "$os" == darwin ]] && command -v brew >/dev/null; then
      printf 'Claude native installation failed; trying the official Homebrew alternative.\n'
      HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask claude-code || return 1
    else
      printf 'Claude installation failed. Check access to https://claude.ai/install.sh or install Claude separately and retry this step.\n' >&2
      return 1
    fi
  fi
  hash -r
  "$agent" --version
}

setup_agent() {
  agent="${OPUSDESK_AGENT:-}"
  if [[ -z "$agent" ]]; then
    if command -v codex >/dev/null && ! command -v claude >/dev/null; then agent=codex
    elif command -v claude >/dev/null && ! command -v codex >/dev/null; then agent=claude
    elif [[ "$noninteractive" == 1 ]]; then
      return 0
    fi
  fi
  while [[ "$agent" != codex && "$agent" != claude ]]; do
    if [[ -n "$agent" || "$noninteractive" == 1 ]]; then
      printf 'OPUSDESK_AGENT must be codex or claude.\n' >&2
      [[ "$noninteractive" != 1 ]] || return 1
    fi
    local choice
    prompt choice $'\nChoose your coding agent:\n  1) Codex (OpenAI)\n  2) Claude Code (Anthropic)\nChoice [1]: '
    case "$choice" in ''|1|codex) agent=codex ;; 2|claude) agent=claude ;; *) printf 'Choose 1 or 2.\n' >&2; agent='' ;; esac
  done
  if [[ "${OPUSDESK_UPDATE_AGENT:-0}" != 1 ]] && command -v "$agent" >/dev/null && "$agent" --version; then
    printf 'Using existing %s installation.\n' "$agent"
  else
    [[ "$noninteractive" != 1 ]] || { printf '%s is missing or broken; rerun interactively to install it.\n' "$agent" >&2; return 1; }
    if confirm "Install ${agent} using its official installer?"; then
      retry_step "$agent installation" install_agent || return 1
    else
      printf 'Skipping agent installation; configure it separately when ready.\n'
      return 0
    fi
  fi
  printf 'Existing enterprise provider configuration is managed by the agent CLI.\n'
  if confirm "Check ${agent} login and offer its standard sign-in?"; then
    if ! agent_authenticated; then
      if confirm "Run ${agent} standard sign-in now?"; then
        retry_step "${agent} sign-in" agent_login || return 1
      else
        printf 'Skipping sign-in; configure authentication with your provider when ready.\n'
      fi
    fi
  fi
}

select_github_host() {
  local host_answer label
  while true; do
    if [[ "$noninteractive" != 1 ]]; then
      prompt host_answer "GitHub hostname [${github_host}]: "
      github_host="${host_answer:-$github_host}"
    fi
    # Accept a pasted HTTPS URL as well as a bare host; never accept ports,
    # credentials, paths, or query strings as part of a hostname.
    github_host="${github_host#https://}"
    github_host="${github_host%/}"
    if [[ ${#github_host} -le 253 && "$github_host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$github_host" != *..* ]]; then
      local labels valid=1
      IFS=. read -r -a labels <<< "$github_host"
      for label in "${labels[@]}"; do
        if [[ ${#label} -gt 63 || "$label" == -* || "$label" == *- ]]; then valid=0; break; fi
      done
      [[ "$valid" != 1 ]] || return 0
    fi
    printf 'Invalid GitHub hostname. Enter a hostname such as github.com or ghe.example.com, without a port or path.\n' >&2
    [[ "$noninteractive" != 1 ]] || return 1
    github_host='github.com'
  done
}

select_projects_dir() {
  local default_root="${HOME}/Projects"
  [[ -d "$default_root" ]] || default_root="$HOME"
  while true; do
    if [[ -z "$projects_dir" && "$noninteractive" != 1 ]]; then
      prompt projects_dir "Parent folder containing your Git repositories [${default_root}]: "
      projects_dir="${projects_dir:-$default_root}"
    fi
    # Match literal tildes entered at the prompt, then expand without eval.
    # shellcheck disable=SC2088
    case "$projects_dir" in '~') projects_dir="$HOME" ;; '~/'*) projects_dir="${HOME}/${projects_dir:2}" ;; esac
    [[ -n "$projects_dir" ]] || return 0
    if [[ -d "$projects_dir" && -r "$projects_dir" && -x "$projects_dir" ]]; then
      projects_dir="$(cd -- "$projects_dir" && pwd -P)" || return 1
      return 0
    fi
    printf 'Projects folder does not exist or is not accessible: %s\n' "$projects_dir" >&2
    [[ "$noninteractive" != 1 ]] || return 1
    projects_dir=''
  done
}

resolve_latest() {
  local resolved
  resolved="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 15 --max-time 300 --output /dev/null --write-out '%{url_effective}' "https://github.com/${repo}/releases/latest")" || return 1
  version="${resolved##*/}"
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'No stable release found.\n' >&2; return 1; }
}

install_release() {
  tar -xzf "${tmp}/${asset}" -C "$tmp" opus-desk || return 1
  if [[ -x "${install_dir}/opus-desk" ]] && cmp -s "${tmp}/opus-desk" "${install_dir}/opus-desk"; then
    printf 'Opus Desk %s is already installed at %s/opus-desk.\n' "$version" "$install_dir"
    return 0
  fi
  mkdir -p "$install_dir" || return 1
  # Rename atomically, including when replacing an executable currently in use.
  local staged
  staged="$(mktemp "${install_dir}/.opus-desk.XXXXXX")" || return 1
  if ! install -m 755 "${tmp}/opus-desk" "$staged" || ! mv -f "$staged" "${install_dir}/opus-desk"; then
    rm -f "$staged"; return 1
  fi
  printf 'Installed %s/opus-desk\n' "$install_dir"
}


main() (
  local repo='jakecyr/opus-desk'
  local version="${OPUSDESK_VERSION:-latest}"
  local install_dir="${OPUSDESK_INSTALL_DIR:-${HOME}/.local/bin}"
  local initial_path="$PATH"
  local os arch base asset tmp expected actual
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) printf 'Supported systems: macOS and Linux.\n' >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) printf 'Supported architectures: arm64 and x64.\n' >&2; return 1 ;;
  esac
  command -v curl >/dev/null || { printf 'curl is required.\n' >&2; return 1; }
  command -v tar >/dev/null || { printf 'tar is required.\n' >&2; return 1; }
  local noninteractive="${OPUSDESK_NONINTERACTIVE:-0}" agent
  local github_host="${OPUSDESK_GITHUB_HOST:-github.com}"
  local projects_dir="${OPUSDESK_PROJECTS_DIR:-}"
  local flag
  for flag in "$noninteractive" "${OPUSDESK_START:-0}" "${OPUSDESK_UPDATE_AGENT:-0}"; do
    [[ "$flag" == 0 || "$flag" == 1 ]] || { printf 'OPUSDESK_NONINTERACTIVE, OPUSDESK_START, and OPUSDESK_UPDATE_AGENT must be 0 or 1.\n' >&2; return 1; }
  done
  if [[ "$noninteractive" == 1 && "${OPUSDESK_UPDATE_AGENT:-0}" == 1 ]]; then
    printf 'Agent updates require interactive setup.\n' >&2; return 1
  fi
  export PATH="${HOME}/.local/bin:${PATH}:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin"
  if [[ "$noninteractive" != 1 ]]; then
    if ! ( : < /dev/tty ) 2>/dev/null; then
      printf 'Interactive setup needs a terminal. For unattended installation set OPUSDESK_NONINTERACTIVE=1.\n' >&2; return 1
    fi
    confirm 'Install Opus Desk?' || return 1
  fi
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if [[ "$version" == latest ]]; then
    # Resolve latest once so the archive and checksums always come from one tag.
    retry_step 'Release lookup' resolve_latest
  fi
  if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'No stable release found, or invalid OPUSDESK_VERSION: %s\n' "$version" >&2
    return 1
  fi
  base="https://github.com/${repo}/releases/download/${version}"
  asset="opus-desk-${os}-${arch}.tar.gz"
  printf 'Downloading Opus Desk %s (%s/%s)…\n' "$version" "$os" "$arch"
  retry_step 'Release download' download "${base}/${asset}" "${tmp}/${asset}"
  retry_step 'Checksum download' download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS"
  expected="$(awk -v asset="$asset" '$2 == asset {print $1}' "${tmp}/SHA256SUMS")"
  if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'Missing or invalid checksum for %s.\n' "$asset" >&2; return 1
  fi
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "${tmp}/${asset}")"
  elif command -v shasum >/dev/null; then
    actual="$(shasum -a 256 "${tmp}/${asset}")"
  else
    printf 'sha256sum or shasum is required.\n' >&2; return 1
  fi
  if [[ "${actual%% *}" != "$expected" ]]; then
    printf 'Checksum mismatch; refusing to install.\n' >&2; return 1
  fi
  retry_step 'Opus Desk installation' install_release
  # Optional integrations must never prevent the binary from being installed.
  if [[ "$noninteractive" != 1 ]]; then
    if confirm 'Configure GitHub hostname?'; then
      select_github_host
    else
      github_host=''
    fi
    if confirm 'Configure your projects folder?'; then
      select_projects_dir
    else
      projects_dir=''
    fi
    if confirm 'Set up GitHub tools and authentication?'; then
      if [[ -z "$github_host" ]]; then
        (github_host=github.com; setup_github) || printf 'GitHub setup incomplete; continue configuring it later.\n' >&2
      else
        setup_github || printf 'GitHub setup incomplete; continue configuring it later.\n' >&2
      fi
    fi
    if confirm 'Choose and set up a coding agent?'; then
      setup_agent || printf 'Agent setup incomplete; configure it later.\n' >&2
    fi
  else
    [[ -z "${OPUSDESK_GITHUB_HOST:-}" ]] || select_github_host
    [[ -z "$projects_dir" ]] || select_projects_dir
    agent="${OPUSDESK_AGENT:-}"
    if [[ -n "$agent" && "$agent" != codex && "$agent" != claude ]]; then
      printf 'OPUSDESK_AGENT must be codex or claude.\n' >&2; return 1
    fi
    [[ -n "${OPUSDESK_GITHUB_HOST:-}" ]] || github_host=''
  fi
  case ":${initial_path}:" in
    *":${install_dir}:"*) ;;
    *)
      local profile='' path_line
      # Keep $PATH literal so the user's shell expands it when loading the profile.
      # shellcheck disable=SC2016
      printf -v path_line 'export PATH=%q:"$PATH"' "$install_dir"
      case "${SHELL:-}" in
        */zsh) profile="${HOME}/.zshrc" ;;
        */bash) if [[ "$os" == darwin ]]; then profile="${HOME}/.bash_profile"; else profile="${HOME}/.bashrc"; fi ;;
      esac
      if [[ "$noninteractive" != 1 && -n "$profile" ]] && confirm "Add Opus Desk to PATH in ${profile}?"; then
        if [[ ! -f "$profile" ]] || ! grep -Fqx "$path_line" "$profile"; then
          printf '\n# Opus Desk\n%s\n' "$path_line" >> "$profile"
        fi
        printf 'PATH configured. Open a new terminal to use opus-desk by name.\n'
      else
        printf 'Add this to your shell profile: %s\n' "$path_line"
      fi
      ;;
  esac
  local config_args=()
  [[ -z "${agent:-}" ]] || config_args+=(--agent "$agent")
  [[ -z "$github_host" ]] || config_args+=(--github-host "$github_host")
  [[ -z "$projects_dir" ]] || config_args+=(--projects "$projects_dir")
  if [[ ${#config_args[@]} -gt 0 ]]; then
    retry_step 'Opus Desk configuration' "${install_dir}/opus-desk" configure "${config_args[@]}" || printf 'Configuration incomplete; use opus-desk configure later.\n' >&2
  fi
  if [[ "${OPUSDESK_START:-0}" == 1 ]] || { [[ "$noninteractive" != 1 ]] && confirm 'Start or restart Opus Desk now?'; }; then
    retry_step 'Opus Desk startup' "${install_dir}/opus-desk" restart
  fi
  printf 'Ready. Run: opus-desk start\nCheck: opus-desk status\nOpen: http://127.0.0.1:4317\n'
)

main "$@"
