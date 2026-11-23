#!/bin/sh
# Runs deploy.sh detached from this session, follows its log, and exits with
# its status. CI's deploy job runs this over ssh, and so should a manual
# deploy (#205): if the connection drops, only the following stops. The
# deploy itself finishes, or fails, on the server, and its lock (see
# deploy.sh) keeps the next deploy's rsync out of the tree until it has.
# Each run's log stays for 30 days in $DEPLOY_LOG_DIR, or, for a deploying
# user who can't write there (only root can create the default), in
# ~/.local/state/vaalikone-deploy.
#
# Assumes logind doesn't kill a session's processes when it ends
# (KillUserProcesses=no, the Debian and Ubuntu default): setsid leaves the
# deploy in the ssh login's systemd scope.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
logs=${DEPLOY_LOG_DIR:-/var/log/vaalikone-deploy}
if ! mkdir -p "$logs" 2>/dev/null || [ ! -w "$logs" ]; then
  logs=${XDG_STATE_HOME:-${HOME:?no HOME for the fallback log directory}/.local/state}/vaalikone-deploy
  mkdir -p "$logs"
fi
# Old logs are only housekeeping: never a reason not to deploy.
find "$logs" -name 'deploy-*.log' -mtime +30 -delete 2>/dev/null || true
log="$logs/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
# Before tail opens it: tail -f gives up on a file that doesn't exist yet.
: >"$log"
echo "Deploy log on the server: $log"

# Its output goes only to the log, never to this session's pipes: they close
# with the connection, and the next write would kill it with SIGPIPE
# mid-`up`. setsid gives it a session of its own, so a hangup aimed at this
# one doesn't reach it, and nohup ignores one that does. -w: setsid forks
# when it leads a process group, and then still ends with deploy.sh's status.
# The log ends with the outcome, for whoever reads it after losing the
# connection.
setsid -w nohup sh -c '
  echo "Deploy started $(date -u)"
  status=0
  sh "$1" || status=$?
  echo "Deploy ended $(date -u) with exit status $status"
  exit "$status"
' sh "$here/deploy.sh" >"$log" 2>&1 </dev/null &
pid=$!

# --pid: stop following once the deploy has ended (after printing the rest).
tail -n +1 -f --pid="$pid" "$log" || true
status=0
wait "$pid" || status=$?
exit "$status"
