import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import fcntl

MODULE = Path(__file__).resolve().parents[2] / "worker/deploy/update.py"
spec = importlib.util.spec_from_file_location("updater", MODULE)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
SHA = "a" * 40
OLD = "b" * 40
REPO = "flo91360/PlaniFiKateur"


class Checks:
    def __init__(self):
        self.run = dict(id=10, workflow_id=2, head_sha=SHA, head_branch="main", event="push",
                        head_repository={"full_name": REPO}, status="completed", conclusion="success", run_attempt=1)
        self.jobs = [dict(name=name, status="completed", conclusion="success", run_attempt=1) for name in updater.REQUIRED_JOBS]
        self.runs = [self.run]
        self.calls = []
        self.on_jobs = None

    def __call__(self, path):
        self.calls.append(path)
        if path == "/actions/workflows/ci.yml":
            return {"id": 2}
        if path.startswith("/actions/workflows/ci.yml/runs?"):
            return {"workflow_runs": self.runs}
        if path.startswith("/actions/runs/10/jobs?"):
            if self.on_jobs:
                self.on_jobs()
            return {"jobs": self.jobs, "total_count": len(self.jobs)}
        if path == "/actions/runs/10":
            return self.run
        raise AssertionError(path)


class Commands:
    def __init__(self):
        self.containers = {"planifikateur-worker": self.container(OLD, running=True)}
        self.calls = []
        self.dirty = ""
        self.branch = "main"
        self.busy = [False, False]
        self.fail = None
        self.boot_failure = False
        self.connection_failure = False
        self.changed = "worker/index.mjs"

    @staticmethod
    def container(revision, running=False):
        return {"revision": revision, "running": running, "image": "image-" + revision,
                "logs": updater.READY, "mounts": [{"Name": "planifikateur-worker-data", "Destination": "/data"}]}

    def __call__(self, args, cwd=None, timeout=1800, optional=False):
        self.calls.append(args)
        if args[0] == "git":
            if args[1] == "branch": return 0, self.branch
            if args[1] == "status": return 0, self.dirty
            if args[1] == "rev-parse": return 0, SHA
            if args[1] == "diff": return 0, self.changed
            return 0, ""
        assert args[0] == "docker", args
        action = args[1]
        if action == "inspect":
            name = args[-1]
            if name not in self.containers: return 1, ""
            c = self.containers[name]
            values = {".State": {"Running": c["running"]}, ".Image": c["image"],
                      ".Config.Labels": {updater.REVISION_LABEL: c["revision"]}, ".RestartCount": 0,
                      ".Mounts": c["mounts"]}
            return 0, json.dumps(values[args[3][7:-2]])
        if self.fail == action and not (action == "run" and "--entrypoint" in args):
            raise updater.UpdateError("Échec simulé : " + action)
        if action == "run":
            if "--entrypoint" in args:
                return 0, "busy" if self.busy.pop(0) else "idle"
            return 0, "Sandbox Codex OK"
        if action == "build": return 0, ""
        if action == "create":
            name = args[args.index("--name") + 1]
            revision = args[args.index("--label") + 1].split("=", 1)[1]
            self.containers[name] = self.container(revision)
            return 0, name
        if action == "stop":
            self.containers[args[-1]]["running"] = False
        elif action == "rename":
            self.containers[args[-1]] = self.containers.pop(args[-2])
        elif action == "start":
            c = self.containers[args[-1]]
            c["running"] = not (self.boot_failure and c["revision"] == SHA)
            if self.connection_failure and c["revision"] == SHA:
                c["logs"] += "\nConnexion du worker refusée ou indisponible."
        elif action == "rm":
            self.containers.pop(args[-1])
            assert "-v" not in args and "--volumes" not in args
        elif action == "logs": return 0, self.containers[args[-1]]["logs"]
        else: raise AssertionError(args)
        return 0, ""


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.options = SimpleNamespace(repo_dir=str(self.root), env_file=str(self.root / "private.env"),
            state_dir=str(self.root), container="planifikateur-worker", volume="planifikateur-worker-data",
            repository=REPO, apparmor_profile="unconfined", startup_timeout=10, retry=False)
        self.commands = Commands()
        self.checks = Checks()
        self.logs = []
        self.now = 0

    def sleep(self, seconds):
        self.now += seconds

    def make(self):
        return updater.Updater(self.options, self.checks, run=self.commands, log=self.logs.append,
                               clock=lambda: self.now, sleep=self.sleep)

    def assert_old(self):
        c = self.commands.containers["planifikateur-worker"]
        self.assertEqual(c["revision"], OLD)
        self.assertTrue(c["running"])

    def test_success_preflights_before_stop_and_keeps_volume_and_previous_container(self):
        self.make().update()
        c = self.commands.containers["planifikateur-worker"]
        self.assertEqual(c["revision"], SHA)
        self.assertTrue(c["running"])
        self.assertFalse(self.commands.containers["planifikateur-worker-previous"]["running"])
        calls = self.commands.calls
        preflight = next(i for i, args in enumerate(calls) if args[:2] == ["docker", "run"] and "--entrypoint" not in args)
        stop = next(i for i, args in enumerate(calls) if args[:2] == ["docker", "stop"])
        self.assertLess(preflight, stop)
        create = next(args for args in calls if args[:2] == ["docker", "create"])
        self.assertIn("source=planifikateur-worker-data,target=/data", create)
        self.assertIn(str(self.root / "private.env"), create)
        self.assertNotIn("--privileged", create)
        self.assertIsNone(json.loads((self.root / "deployment.json").read_text())["pending"])

    def test_first_unlabelled_worker_can_be_adopted(self):
        self.commands.containers["planifikateur-worker"]["revision"] = None
        self.make().update()
        self.assertEqual(self.commands.containers["planifikateur-worker"]["revision"], SHA)

    def test_pending_or_failed_checks_never_stop_or_build(self):
        for conclusion in [None, "failure", "cancelled", "skipped"]:
            with self.subTest(conclusion=conclusion):
                self.checks.run["conclusion"] = conclusion
                self.make().update()
                self.assert_old()
        self.assertFalse(any(args[:2] == ["docker", "build"] for args in self.commands.calls))

    def test_running_task_defers_update(self):
        self.commands.busy = [True]
        self.make().update()
        self.assert_old()
        self.assertFalse(any(args[:2] == ["docker", "build"] for args in self.commands.calls))

    def test_task_started_during_build_defers_replacement(self):
        self.commands.busy = [False, True]
        self.make().update()
        self.assert_old()
        self.assertTrue(any(args[:2] == ["docker", "build"] for args in self.commands.calls))
        self.assertFalse(any(args[:2] == ["docker", "stop"] for args in self.commands.calls))

    def test_build_and_sandbox_failures_keep_worker_and_suppress_repeated_attempts(self):
        for stage in ["build", "run"]:
            with self.subTest(stage=stage):
                self.commands = Commands()
                self.commands.fail = stage
                deployment = self.make()
                with self.assertRaises(updater.UpdateError): deployment.update()
                self.assert_old()
                self.assertEqual(deployment.state["failed_sha"], SHA)
                self.commands.fail = None
                count = len(self.commands.calls)
                self.make().update()
                self.assertFalse(any(args[:2] == ["docker", "build"] for args in self.commands.calls[count:]))
                (self.root / "deployment.json").unlink()

    def test_failed_start_rolls_back_without_deleting_data(self):
        self.commands.boot_failure = True
        with self.assertRaises(updater.UpdateError): self.make().update()
        self.assert_old()
        self.assertNotIn("planifikateur-worker-next", self.commands.containers)
        self.assertEqual(json.loads((self.root / "deployment.json").read_text())["failed_sha"], SHA)

    def test_connection_failure_also_rolls_back(self):
        self.commands.connection_failure = True
        with self.assertRaises(updater.UpdateError): self.make().update()
        self.assert_old()

    def test_interrupted_cutover_recovers_at_next_invocation(self):
        for stage in ["before_stop", "after_rename", "after_promotion"]:
            with self.subTest(stage=stage):
                self.commands = Commands()
                old = self.commands.containers["planifikateur-worker"]
                if stage == "before_stop":
                    self.commands.containers["planifikateur-worker-next"] = Commands.container(SHA)
                else:
                    old["running"] = False
                    self.commands.containers["planifikateur-worker-previous"] = self.commands.containers.pop("planifikateur-worker")
                    name = "planifikateur-worker" if stage == "after_promotion" else "planifikateur-worker-next"
                    self.commands.containers[name] = Commands.container(SHA, running=True)
                (self.root / "deployment.json").write_text(json.dumps({"pending": SHA}))
                self.make().update()
                self.assert_old()

    def test_stopped_worker_is_not_reactivated_without_pending_deployment(self):
        self.commands.containers["planifikateur-worker"]["running"] = False
        self.make().update()
        self.assertFalse(self.commands.containers["planifikateur-worker"]["running"])

    def test_local_edits_and_wrong_volume_block_update(self):
        self.commands.dirty = " M worker/index.mjs"
        with self.assertRaises(updater.UpdateError): self.make().update()
        self.assert_old()
        self.commands.dirty = ""
        self.commands.containers["planifikateur-worker"]["mounts"] = []
        with self.assertRaises(updater.UpdateError): self.make().update()
        self.assert_old()

    def test_ui_only_changes_do_not_rebuild_worker(self):
        self.commands.changed = ""
        self.make().update()
        self.assert_old()
        self.assertFalse(any(args[:2] == ["docker", "build"] for args in self.commands.calls))

    def test_retry_is_explicit_for_rejected_revision(self):
        (self.root / "deployment.json").write_text(json.dumps({"failed_sha": SHA}))
        self.options.retry = True
        self.make().update()
        self.assertEqual(self.commands.containers["planifikateur-worker"]["revision"], SHA)


class SafetyTests(unittest.TestCase):
    def test_missing_failed_duplicate_or_stale_required_jobs_are_rejected(self):
        for change in ["missing", "failed", "duplicate", "stale"]:
            with self.subTest(change=change):
                checks = Checks()
                if change == "missing": checks.jobs.pop()
                if change == "failed": checks.jobs[0]["conclusion"] = "failure"
                if change == "duplicate": checks.jobs.append(dict(checks.jobs[0]))
                if change == "stale": checks.jobs[0]["run_attempt"] = 2
                self.assertFalse(updater.tested(checks, SHA, REPO))

    def test_newer_failed_run_and_forks_cannot_authorize_deployment(self):
        checks = Checks()
        checks.runs.append({**checks.run, "id": 11, "conclusion": "failure"})
        self.assertFalse(updater.tested(checks, SHA, REPO))
        checks = Checks()
        checks.run["head_repository"] = {"full_name": "other/repo"}
        self.assertFalse(updater.tested(checks, SHA, REPO))

    def test_new_run_started_during_check_blocks_deployment(self):
        checks = Checks()
        checks.on_jobs = lambda: checks.runs.append({**checks.run, "id": 11, "status": "queued", "conclusion": None})
        self.assertFalse(updater.tested(checks, SHA, REPO))

    def test_command_errors_do_not_expose_credentials_and_logs_include_stderr(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "private-token", "private-token")):
            with self.assertRaises(updater.UpdateError) as error: updater.command(["docker", "build"])
            self.assertNotIn("private-token", str(error.exception))
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, updater.READY, "connexion refusée")):
            self.assertIn("connexion refusée", updater.command(["docker", "logs", "worker"])[1])

    def test_env_file_is_read_without_executing_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / "env"
            target = Path(directory) / "unwanted"
            env.write_text(f"X=$(touch {target})\nPLANIFIKATEUR_GITHUB_TOKEN=private-token\n")
            self.assertEqual(updater.read_token(env), "private-token")
            self.assertFalse(target.exists())

    def test_overlapping_invocations_do_not_query_github_or_read_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory) / "update.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch("sys.argv", ["update.py", "--state-dir", directory]), contextlib.redirect_stdout(io.StringIO()) as output:
                    updater.main()
                self.assertIn("déjà en cours", output.getvalue())


if __name__ == "__main__":
    unittest.main()
