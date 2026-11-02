import gzip
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("site_deploy", ROOT / "deploy/site.py")
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)
SHA = "a" * 40
OLD = "b" * 40


class Docker:
    """Fake git and Docker: containers by name, with their revision, state and image."""

    def __init__(self):
        self.containers = {"planifikateur-site": self.container(OLD, running=True)}
        self.containers["planifikateur-site-proxy"] = {"running": True, "labels": {site.DOMAIN_LABEL: "exemple.fr"},
                                                       "image": site.PROXY_IMAGE}
        self.networks = {"planifikateur"}
        self.calls = []
        self.serving = {}
        self.build_fails = False
        self.boot_failure = False
        self.volume_has_base = False

    @staticmethod
    def container(revision, running=False):
        return {"running": running, "labels": {site.REVISION_LABEL: revision}, "image": "image-" + revision}

    def __call__(self, args, cwd=None, timeout=1800, optional=False):
        self.calls.append(args)
        if args[0] == "git":
            return 0, SHA if args[1] == "rev-parse" else ""
        if args[0] == "tar":
            return 0, ""
        action = args[1]
        if action == "inspect":
            name = args[-1]
            if name in self.networks:
                return 0, json.dumps("net-id")
            if name not in self.containers:
                return 1, ""
            c = self.containers[name]
            values = {".State": {"Running": c["running"]}, ".Image": c["image"], ".Config.Labels": c["labels"],
                      ".RestartCount": 0}
            return 0, json.dumps(values[args[3][7:-2]])
        if action == "build":
            if self.build_fails:
                raise site.UpdateError("Échec simulé : build")
            return 0, ""
        if action == "create":
            name = args[args.index("--name") + 1]
            label = args[args.index("--label") + 1]
            key, _, value = label.partition("=")
            self.containers[name] = {"running": False, "labels": {key: value}, "image": "image-" + value, "args": args}
            return 0, name
        if action == "start":
            c = self.containers[args[-1]]
            c["running"] = not (self.boot_failure and c["labels"].get(site.REVISION_LABEL) == SHA)
            return 0, ""
        if action == "stop":
            self.containers[args[-1]]["running"] = False
            return 0, ""
        if action == "rename":
            self.containers[args[-1]] = self.containers.pop(args[-2])
            return 0, ""
        if action == "rm":
            assert "-v" not in args and "--volumes" not in args
            self.containers.pop(args[-1])
            return 0, ""
        if action == "exec":
            c = self.containers[args[2]]
            return 0, c["labels"].get(site.REVISION_LABEL, "") if c["running"] else ""
        if action == "run":
            return (1 if self.volume_has_base else 0), ""
        if action in ("info", "image", "network"):
            if action == "network":
                self.networks.add(args[-1])
            return 0, "/var/lib/docker" if action == "info" else ""
        raise AssertionError(args)


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.env = self.dir / "site.env"
        self.env.write_text("PLANIFIKATEUR_DOMAIN=exemple.fr\nPLANIFIKATEUR_OWNER_TOKEN=secret-owner\n")
        self.docker = Docker()
        self.tested = True
        site.tested = lambda request, sha, repository: self.tested
        self.logs = []
        self.clock = 0

    def make(self, **extra):
        options = SimpleNamespace(repo_dir=str(self.dir), env_file=str(self.env), state_dir=str(self.dir),
                                  repository="flo91360/PlaniFiKateur", container="planifikateur-site",
                                  volume="planifikateur-site-data", network="planifikateur",
                                  backups=str(self.dir / "backups"), startup_timeout=10, min_free_gb=2.0,
                                  retry=False, **extra)

        def tick(seconds):
            self.clock += seconds
        return site.Site(options, None, run=self.docker, log=self.logs.append, sleep=tick,
                         clock=lambda: self.clock, disk_free=lambda path: 50e9)

    def actions(self):
        return [call[1] for call in self.docker.calls if call[0] == "docker" and call[1] != "inspect"]

    def test_tested_commit_replaces_the_site_after_building_and_keeps_data_and_previous_version(self):
        self.make().update()
        current = self.docker.containers["planifikateur-site"]
        self.assertEqual(current["labels"][site.REVISION_LABEL], SHA)
        self.assertTrue(current["running"])
        self.assertEqual(self.docker.containers["planifikateur-site-previous"]["labels"][site.REVISION_LABEL], OLD)
        actions = self.actions()
        # The new image is built while the old site runs; the old one stops before the new one starts.
        self.assertLess(actions.index("build"), actions.index("stop"))
        self.assertLess(actions.index("stop"), actions.index("start"))
        build = next(c for c in self.docker.calls if c[:2] == ["docker", "build"])
        self.assertIn("PLANIFIKATEUR_COMMIT_SHA=" + SHA, build)
        self.assertEqual(build[3], "deploy/site.Dockerfile")
        create = current["args"]
        self.assertIn("source=planifikateur-site-data,target=/data", create)
        self.assertIn("PLANIFIKATEUR_PUBLIC_ORIGIN=https://exemple.fr", create)
        self.assertNotIn("-p", create)  # Only the proxy is reachable from outside.
        self.assertIn(str(self.env), create)
        self.assertFalse(any("secret-owner" in " ".join(c) for c in self.docker.calls))
        self.assertEqual(json.loads((self.dir / "site.json").read_text())["deployed_sha"], SHA)

    def test_untested_or_current_commits_change_nothing(self):
        self.tested = False
        self.make().update()
        self.assertNotIn("build", self.actions())
        self.tested = True
        self.docker.containers["planifikateur-site"]["labels"][site.REVISION_LABEL] = SHA
        self.make().update()
        self.assertNotIn("build", self.actions())
        self.assertIn("Site déjà à jour.", self.logs)

    def test_a_site_that_does_not_serve_the_new_commit_is_rolled_back_and_not_retried(self):
        self.docker.boot_failure = True
        with self.assertRaises(site.UpdateError):
            self.make().update()
        current = self.docker.containers["planifikateur-site"]
        self.assertEqual(current["labels"][site.REVISION_LABEL], OLD)
        self.assertTrue(current["running"])
        self.assertNotIn("planifikateur-site-next", self.docker.containers)
        self.docker.calls.clear()
        self.make().update()
        self.assertNotIn("build", self.actions())

    def test_a_failed_build_keeps_the_running_site(self):
        self.docker.build_fails = True
        with self.assertRaises(site.UpdateError):
            self.make().update()
        self.assertTrue(self.docker.containers["planifikateur-site"]["running"])
        self.assertNotIn("stop", self.actions())

    def test_proxy_is_recreated_for_a_new_domain_and_rejects_invalid_ones(self):
        self.docker.containers["planifikateur-site"]["labels"][site.REVISION_LABEL] = SHA
        self.env.write_text("PLANIFIKATEUR_DOMAIN=203-0-113-7.sslip.io\n")
        self.make().update()
        proxy = self.docker.containers["planifikateur-site-proxy"]["args"]
        self.assertEqual(proxy[-6:], ["caddy", "reverse-proxy", "--from", "203-0-113-7.sslip.io", "--to", "site:3000"])
        self.assertIn("443:443", proxy)
        self.env.write_text('PLANIFIKATEUR_DOMAIN=exemple.fr\nPLANIFIKATEUR_OWNER_TOKEN="secret"\n')
        with self.assertRaisesRegex(site.UpdateError, "ligne 2 .* guillemets .* PLANIFIKATEUR_OWNER_TOKEN"):
            self.make().update()
        for domain in ("https://exemple.fr", "exemple", "a.b/c", "x.fr;rm"):
            self.env.write_text(f"PLANIFIKATEUR_DOMAIN={domain}\n")
            with self.assertRaises(site.UpdateError):
                self.make().update()

    def database(self, path, revision=3):
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE workspace (id INTEGER PRIMARY KEY, revision INTEGER)")
        db.execute("INSERT INTO workspace VALUES (1, ?)", (revision,))
        db.commit()
        db.close()

    def test_install_restores_the_newest_daily_copy_then_starts_site_and_proxy(self):
        del self.docker.containers["planifikateur-site"], self.docker.containers["planifikateur-site-proxy"]
        backups = self.dir / "backups"
        backups.mkdir()
        raw = self.dir / "raw.sqlite"
        self.database(raw)
        for name in ("planifikateur-2026-11-01T06-00-00-000Z-x.sqlite.gz", "planifikateur-2026-11-02T06-00-00-000Z-x.sqlite.gz"):
            with gzip.open(backups / name, "wb") as output:
                output.write(raw.read_bytes())
        self.make().install("latest")
        self.assertTrue(self.docker.containers["planifikateur-site"]["running"])
        self.assertTrue(self.docker.containers["planifikateur-site-proxy"]["running"])
        restore = next(c for c in self.docker.calls if c[:2] == ["docker", "run"])
        self.assertEqual(restore[-1], site.RESTORE)
        self.assertIn("test ! -e /data/planifikateur.sqlite", site.RESTORE)  # Never replaces a base.
        self.assertTrue(any("2026-11-02" in line for line in self.logs))
        # The restore happens before the site first starts.
        actions = self.actions()
        self.assertLess(actions.index("run"), actions.index("start"))

    def test_install_refuses_a_damaged_copy_or_an_existing_base(self):
        del self.docker.containers["planifikateur-site"], self.docker.containers["planifikateur-site-proxy"]
        bad = self.dir / "bad.sqlite"
        bad.write_bytes(b"pas une base")
        with self.assertRaises(site.UpdateError):
            self.make().install(str(bad))
        good = self.dir / "good.sqlite"
        self.database(good)
        self.docker.volume_has_base = True
        with self.assertRaises(site.UpdateError):
            self.make().install(str(good))
        self.assertNotIn("planifikateur-site", self.docker.containers)


if __name__ == "__main__":
    unittest.main()
