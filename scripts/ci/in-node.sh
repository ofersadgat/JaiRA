#!/usr/bin/env bash
# Runs a job's commands (given on stdin) in the node:22 image, wherever the job landed
# (.gitlab/ci/pipeline.yml). On GitLab's hosted runners the job is already in that image and they run
# as they are. On the group's own Linux machine, a shell runner, they run in a container of it: the
# checkout and the declarative-ai clone beside it mounted at the same paths, the job's variables passed
# in, npm's cache kept in a volume between jobs. The container runs as root (apt-get), so what it wrote
# is given back to the runner's user as it ends; the runner's next `git clean` could not remove it
# otherwise.
#
# The whole script is read before it runs (`main`): a job may check out an older commit, which
# rewrites this file under it.
set -euo pipefail

main() {
  local job
  job="$(cat)"
  if [ -f /.dockerenv ] || ! command -v docker > /dev/null 2>&1; then
    exec bash -eo pipefail -c "$job"
  fi

  local root env=() name
  root="$(dirname "$CI_PROJECT_DIR")"
  while IFS= read -r name; do
    case "$name" in
      PATH | HOME | HOSTNAME | PWD | OLDPWD | SHELL | USER | LOGNAME | SHLVL | TERM | TMPDIR | LANG | LANGUAGE | MAIL | _ | LC_* | XDG_* | DBUS_* | SSH_*) ;;
      *) env+=(-e "$name") ;;
    esac
  done < <(compgen -e)

  # shellcheck disable=SC2016 # expanded in the container
  exec docker run --rm --pull always \
    -v "$root:$root" -w "$CI_PROJECT_DIR" -v ci-npm-cache:/root/.npm \
    "${env[@]}" -e CI_JOB_COMMANDS="$job" -e CI_HOST_OWNER="$(id -u):$(id -g)" -e CI_MOUNT="$root" \
    "${CI_NODE_IMAGE:-node:22}" \
    bash -c '
      trap '\''chown -R "$CI_HOST_OWNER" "$CI_PROJECT_DIR" "$CI_MOUNT/declarative-ai" 2> /dev/null || true'\'' EXIT
      git config --global --add safe.directory "*"
      bash -eo pipefail -c "$CI_JOB_COMMANDS"
    '
}

main "$@"
exit
