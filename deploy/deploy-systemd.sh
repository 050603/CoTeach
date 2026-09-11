#!/usr/bin/env bash
# Run on the deployment host, as the owner of the configured user services.
set -euo pipefail

revision=${1:?Usage: deploy-systemd.sh COMMIT_SHA PROJECT_PATH}
project_path=${2:?Missing project path}
app_port=${3:-${OPENPBL_PORT:-3000}}
[[ "$app_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$app_port > 0 && 10#$app_port <= 65535 )) || {
  echo 'Invalid application port' >&2; exit 2;
}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA' >&2; exit 2; }
[[ "$project_path" = /* ]] || { echo 'Expected an absolute project path' >&2; exit 2; }
cd "$project_path"
[[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ]]

# Serialize manual and CI updates on the host as well as in GitHub Actions.
exec 9>"$(git rev-parse --git-path openpbl-deploy.lock)"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Deployment checkout has local changes' >&2; exit 1; }
for executable in pnpm node python3 systemctl curl; do command -v "$executable" >/dev/null; done
for service in openpbl.service openpbl-code-runner.service openpbl-survey-nlp.service; do
  [[ "$(systemctl --user show "$service" --property=WorkingDirectory --value)" = "$(pwd -P)" ]] || {
    echo "$service must be installed for $project_path before deployment" >&2; exit 1;
  }
done

previous_revision=$(git rev-parse HEAD)
git fetch --no-tags origin "$revision"
git checkout --detach "$revision"
printf 'Deploying %s (previous commit %s)\n' "$revision" "$previous_revision"

python3 scripts/setup-survey-nlp.py
pnpm install --frozen-lockfile
pnpm build
# The application service applies committed migrations before it starts.
# Failed builds never restart the currently serving immutable release.
systemctl --user daemon-reload
systemctl --user restart openpbl-code-runner.service openpbl-survey-nlp.service openpbl.service

for attempt in {1..60}; do
  if systemctl --user is-active --quiet openpbl.service openpbl-code-runner.service openpbl-survey-nlp.service &&
    curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:3003/health/live" >/dev/null 2>&1 &&
    curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$app_port/api/health/live" >/dev/null 2>&1; then
    printf 'Healthy deployment: %s\n' "$revision"
    exit 0
  fi
  sleep 3
done
printf 'Deployment health check failed; inspect user services. Previous commit: %s\n' "$previous_revision" >&2
# Schema migrations can make automatic rollback unsafe; leave diagnosis explicit.
exit 1
