#!/usr/bin/env bash
set -euo pipefail

# Interactive setup plus a checksummed binary. See docs/installation.md for unattended use.
# All prompts use the controlling terminal; stdin may contain this script.
confirm() {
  local answer
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r answer < /dev/tty
  [[ "$answer" == '' || "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}

download() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$1" -o "$2"
}

ensure_brew() {
  if ! command -v brew >/dev/null; then
    confirm 'Install Homebrew to set up Git and GitHub CLI?' || { printf 'Setup cancelled.\n' >&2; exit 1; }
    download 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh' "${tmp}/homebrew.sh"
    bash "${tmp}/homebrew.sh" < /dev/tty
    export PATH="/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:${PATH}"
  fi
  if [[ "${brew_updated:-0}" != 1 ]]; then brew update; brew_updated=1; fi
}

setup_github() {
  if [[ "$noninteractive" != 1 ]]; then
    ensure_brew
    brew install gh git
    brew upgrade gh git
  fi
  command -v gh >/dev/null || { printf 'GitHub CLI is missing. Rerun interactively to install it.\n' >&2; exit 1; }
  command -v git >/dev/null || { printf 'Git is missing. Rerun interactively to install it.\n' >&2; exit 1; }
  if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
    [[ "$noninteractive" != 1 ]] || { printf 'Run gh auth login --hostname github.com --scopes repo,read:org,workflow,read:project first.\n' >&2; exit 1; }
    printf 'Sign in to GitHub. Opus Desk needs repository and organization access; workflow allows agent fixes to CI files.\n'
    gh auth login --hostname github.com --web --git-protocol https --scopes repo,read:org,workflow,read:project < /dev/tty
  fi
  local headers scopes missing scope
  headers="$(gh api --hostname github.com --include user)"
  scopes="$(printf '%s\n' "$headers" | awk 'tolower($0) ~ /^x-oauth-scopes:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]\r]/, ""); print}')"
  if [[ -z "$scopes" ]]; then
    printf 'Cannot verify OAuth scopes. Use GitHub CLI browser login (repo, read:org, workflow, read:project). Fine-grained/environment tokens need per-repository checks.\n' >&2
    if [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" || "$noninteractive" == 1 ]]; then
      printf 'Unset GH_TOKEN/GITHUB_TOKEN and rerun interactively, or authenticate gh with the scopes above.\n' >&2
      exit 1
    fi
    gh auth refresh --hostname github.com --scopes repo,read:org,workflow,read:project < /dev/tty
    headers="$(gh api --hostname github.com --include user)"
    scopes="$(printf '%s\n' "$headers" | awk 'tolower($0) ~ /^x-oauth-scopes:/ {sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]\r]/, ""); print}')"
  fi
  missing=''
  for scope in repo read:org workflow read:project; do
    case ",$scopes," in
      *",$scope,"*) ;;
      *) if [[ "$scope" == read:org && ( ",$scopes," == *",admin:org,"* || ",$scopes," == *",write:org,"* ) ]]; then continue; fi
         if [[ "$scope" == read:project && ",$scopes," == *",project,"* ]]; then continue; fi
         missing="${missing}${scope}," ;;
    esac
  done
  if [[ -n "$missing" ]]; then
    printf 'GitHub access is missing: %s\n' "${missing%,}" >&2
    if [[ "$noninteractive" == 1 || -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
      printf 'Run gh auth refresh --hostname github.com --scopes repo,read:org,workflow,read:project (unset environment tokens first).\n' >&2
      exit 1
    fi
    gh auth refresh --hostname github.com --scopes repo,read:org,workflow,read:project < /dev/tty
    # Verify again rather than assuming the browser flow granted access.
    noninteractive=1 setup_github
  fi
  gh auth setup-git --hostname github.com
  gh --version | head -n 1
  printf 'GitHub authentication and OAuth scopes verified. Organization SSO and repository roles still apply.\n'
}

setup_agent() {
  agent="${OPUSDESK_AGENT:-}"
  if [[ -z "$agent" ]]; then
    if command -v codex >/dev/null && ! command -v claude >/dev/null; then agent=codex
    elif command -v claude >/dev/null && ! command -v codex >/dev/null; then agent=claude
    elif [[ "$noninteractive" != 1 ]]; then
      printf '\nChoose your coding agent:\n  1) Codex (OpenAI)\n  2) Claude Code (Anthropic)\nChoice [1]: ' > /dev/tty
      local choice
      read -r choice < /dev/tty
      case "$choice" in ''|1|codex) agent=codex ;; 2|claude) agent=claude ;; *) printf 'Choose 1 or 2.\n' >&2; exit 1 ;; esac
    else
      printf 'Set OPUSDESK_AGENT=codex or OPUSDESK_AGENT=claude for unattended setup.\n' >&2; exit 1
    fi
  fi
  [[ "$agent" == codex || "$agent" == claude ]] || { printf 'OPUSDESK_AGENT must be codex or claude.\n' >&2; exit 1; }
  if [[ "$noninteractive" != 1 ]]; then
    printf 'Installing/updating %s using its official latest-release installer…\n' "$agent"
    if [[ "$agent" == codex ]]; then
      download 'https://chatgpt.com/codex/install.sh' "${tmp}/codex.sh"
      CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR="${HOME}/.local/bin" sh "${tmp}/codex.sh" < /dev/tty
    else
      download 'https://claude.ai/install.sh' "${tmp}/claude.sh"
      bash "${tmp}/claude.sh" latest < /dev/tty
    fi
    export PATH="${HOME}/.local/bin:${PATH}"
    hash -r
  fi
  command -v "$agent" >/dev/null || { printf '%s is missing; rerun interactively to install it.\n' "$agent" >&2; exit 1; }
  "$agent" --version
  local auth_ok=0
  if [[ "$agent" == codex ]]; then
    if codex login status >/dev/null 2>&1; then auth_ok=1; fi
  elif claude auth status >/dev/null 2>&1; then auth_ok=1; fi
  if [[ "$auth_ok" != 1 ]]; then
    [[ "$noninteractive" != 1 ]] || { printf 'Run %s first.\n' "$([[ "$agent" == codex ]] && printf 'codex login' || printf 'claude auth login')" >&2; exit 1; }
    printf 'Complete %s sign-in in your browser. Your plan or API account must permit usage.\n' "$agent"
    if [[ "$agent" == codex ]]; then codex login < /dev/tty; codex login status
    else claude auth login < /dev/tty; claude auth status
    fi
  fi
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
  if [[ "$version" == latest ]]; then
    # Resolve latest once so the archive and checksums always come from one tag.
    base="$(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output /dev/null --write-out '%{url_effective}' "https://github.com/${repo}/releases/latest")"
    version="${base##*/}"
  fi
  if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'No stable release found, or invalid OPUSDESK_VERSION: %s\n' "$version" >&2
    return 1
  fi
  base="https://github.com/${repo}/releases/download/${version}"
  asset="opus-desk-${os}-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf 'Downloading Opus Desk %s (%s/%s)…\n' "$version" "$os" "$arch"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "${base}/${asset}" -o "${tmp}/${asset}"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS"
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
  local noninteractive="${OPUSDESK_NONINTERACTIVE:-0}" agent brew_updated=0
  export PATH="${HOME}/.local/bin:${PATH}:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin"
  if [[ "$noninteractive" != 1 ]]; then
    if ! ( : < /dev/tty ) 2>/dev/null; then
      printf 'Interactive setup needs a terminal. For preconfigured machines set OPUSDESK_NONINTERACTIVE=1 and OPUSDESK_AGENT.\n' >&2; return 1
    fi
    confirm 'Set up GitHub, install/update your agent, and install Opus Desk?' || return 1
  fi
  setup_github
  setup_agent
  tar -xzf "${tmp}/${asset}" -C "$tmp" opus-desk
  mkdir -p "$install_dir"
  # Rename atomically, including when replacing an executable currently in use.
  local staged
  staged="$(mktemp "${install_dir}/.opus-desk.XXXXXX")"
  if ! install -m 755 "${tmp}/opus-desk" "$staged" || ! mv -f "$staged" "${install_dir}/opus-desk"; then
    rm -f "$staged"; return 1
  fi
  printf 'Installed %s/opus-desk\n' "$install_dir"
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
  local projects_dir="${OPUSDESK_PROJECTS_DIR:-}"
  if [[ "$noninteractive" != 1 && -z "$projects_dir" ]]; then
    local default_root="${HOME}/Projects"
    [[ -d "$default_root" ]] || default_root="$HOME"
    printf 'Parent folder containing your Git repositories [%s]: ' "$default_root" > /dev/tty
    read -r projects_dir < /dev/tty
    projects_dir="${projects_dir:-$default_root}"
  fi
  if [[ -n "$projects_dir" ]]; then
    "${install_dir}/opus-desk" configure --agent "$agent" --projects "$projects_dir"
  else
    "${install_dir}/opus-desk" configure --agent "$agent"
  fi
  if [[ "${OPUSDESK_START:-0}" == 1 ]] || { [[ "$noninteractive" != 1 ]] && confirm 'Start or restart Opus Desk now?'; }; then
    "${install_dir}/opus-desk" restart
  fi
  printf 'Ready. Run: opus-desk start\nCheck: opus-desk status\nOpen: http://127.0.0.1:4317\n'
)

main "$@"
