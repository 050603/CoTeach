"""Exercise deployment failure boundaries without touching services or a remote host."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/deploy-systemd.sh'
SHA = 'a' * 40


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'commands.log'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        fake = '''#!/usr/bin/env bash
set -eu
name=${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$TEST_LOG"
case "$name:$1" in
  git:rev-parse)
    case "$2" in
      --show-toplevel) pwd ;;
      --git-path) printf '%s/lock\\n' "$PWD" ;;
      HEAD) printf '%040d\\n' 0 ;;
    esac ;;
  git:status) printf '%s' "${TEST_DIRTY:-}" ;;
  systemctl:--user)
    if [ "$2" = show ]; then pwd; fi ;;
  pnpm:build) exit "${TEST_BUILD_EXIT:-0}" ;;
  curl:*) exit "${TEST_HEALTH_EXIT:-0}" ;;
  flock:*) exit "${TEST_LOCK_EXIT:-0}" ;;
esac
'''
        for command in ['git', 'pnpm', 'node', 'systemctl', 'curl', 'sleep', 'flock']:
            p = bin_dir / command
            p.write_text(fake)
            p.chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                    'TEST_LOG': str(self.log)}

    def run_deploy(self, sha=SHA, **env):
        result = subprocess.run(['bash', str(SCRIPT), sha, str(self.root)],
                                env={**self.env, **env}, text=True, capture_output=True)
        calls = self.log.read_text() if self.log.exists() else ''
        return result, calls

    def test_verified_revision_becomes_healthy(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'git checkout --detach {SHA}', calls)
        self.assertIn('Healthy deployment:', result.stdout)
        self.assertLess(calls.index('pnpm build'), calls.index('systemctl --user restart'))

    def test_dirty_checkout_is_preserved(self):
        result, calls = self.run_deploy(TEST_DIRTY=' M user-work.ts')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('git checkout', calls)
        self.assertNotIn('pnpm install', calls)

    def test_failed_build_does_not_restart_live_services(self):
        result, calls = self.run_deploy(TEST_BUILD_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('systemctl --user restart', calls)

    def test_failed_health_is_not_reported_as_success(self):
        result, calls = self.run_deploy(TEST_HEALTH_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Healthy deployment:', result.stdout)
        self.assertEqual(calls.count('curl --fail'), 60)

    def test_busy_checkout_is_not_updated(self):
        result, calls = self.run_deploy(TEST_LOCK_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('git fetch', calls)

    def test_invalid_revision_does_not_execute_commands(self):
        result, calls = self.run_deploy(sha='main; echo unexpected')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, '')


if __name__ == '__main__':
    unittest.main()
