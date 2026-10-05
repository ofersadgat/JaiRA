#!/usr/bin/env bash
# Runs a job's commands (given on stdin) in the node:22 image, wherever the job landed
# (.gitlab/ci/pipeline.yml). On GitLab's hosted runners the job is already in that image and they run
# as they are. On the group's own Linux machine, a shell runner, they run in a container of it: the
# checkout and what is cloned beside it mounted at the same paths, the job's variables passed in.
#
# That machine keeps what a job leaves until the project's next job, on a disk every project shares,
# so as the container ends it removes the bulk — every node_modules, and the clones beside the
# checkout the project names in CI_CLONES_BESIDE (JaiRA's declarative-ai; only those: every project's
# checkout is beside them, and another's job may be using its own) — and gives what is left back to
# the runner's user: the container runs as root (apt-get), and the runner's next `git clean` could not
# remove it otherwise. npm's cache goes with the container.
#
# The whole script is read before it runs (`main`): a job may check out an older commit, which
# rewrites this file under it. JaiRA and Tag & Restart have the same script; a change to one belongs
# in the other.
set -euo pipefail

# What the container runs: the job's commands, and the clearing up however they end.
# shellcheck disable=SC2016 # expanded in the container
readonly IN_CONTAINER='
clear_up() {
  for clone in ${CI_CLONES_BESIDE:-}; do rm -rf "${CI_MOUNT:?}/$clone"; done
  find "$CI_PROJECT_DIR" -name node_modules -type d -prune -exec rm -rf {} +
  chown -R "$CI_HOST_OWNER" "$CI_PROJECT_DIR"
}
trap "clear_up 2> /dev/null || true" EXIT
git config --global --add safe.directory "*"
bash -eo pipefail -c "$CI_JOB_COMMANDS"
'

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

  local image="${CI_NODE_IMAGE:-node:22}"
  docker pull --quiet "$image" > /dev/null
  exec docker run --rm -v "$root:$root" -w "$CI_PROJECT_DIR" \
    "${env[@]}" -e CI_JOB_COMMANDS="$job" -e CI_HOST_OWNER="$(id -u):$(id -g)" -e CI_MOUNT="$root" \
    "$image" bash -c "$IN_CONTAINER"
}

main "$@"
exit
