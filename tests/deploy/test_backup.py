import contextlib
import datetime
import fcntl
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

MODULE = Path(__file__).resolve().parents[2] / "worker/deploy/backup.py"
spec = importlib.util.spec_from_file_location("backup", MODULE)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
TOKEN = "k" * 64
UUID = "0123abcd-0123-4abc-8def-0123456789ab"


def name_at(date, hour=6):
    return f"planifikateur-{date.isoformat()}T{hour:02d}-00-00-000Z-{UUID}.sqlite"


def database(revision=3):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "site.sqlite"
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE workspace (id INTEGER PRIMARY KEY, revision INTEGER, projects TEXT)")
        db.execute("INSERT INTO workspace VALUES (1, ?, '[]')", (revision,))
        db.commit()
        db.close()
        return path.read_bytes()


class Site:
    """Fake site: backup listing, file downloads and confirmations."""

    def __init__(self, name, content, size=None, error=""):
        self.name, self.content, self.error = name, content, error
        self.size = len(content) if size is None else size
        self.requests, self.confirmed = [], []

    def __call__(self, path, data=None):
        self.requests.append(path)
        if path == "backups":
            files = [{"name": self.name, "size": self.size, "kind": "regular"},
                     {"name": self.name.replace(".sqlite", "-suppression.sqlite"), "size": 1, "kind": "deletion"}]
            body = json.dumps({"files": files, "error": self.error, "intervalHours": 6, "keep": 5}).encode()
        elif path == "backups/offsite":
            self.confirmed.append(data["name"])
            body = b'{"data":{}}'
        elif path == "backups/" + self.name:
            body = self.content
        else:
            raise AssertionError(path)
        return contextlib.nullcontext(io.BytesIO(body))


class CopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.logs = []
        self.free = 100e9
        self.name = name_at(datetime.date(2026, 11, 2))
        self.content = database()

    def run_copy(self, site):
        backup.Backup(self.root, site, log=self.logs.append, disk_free=lambda path: self.free).run()

    def kept(self):
        return sorted(path.name for path in self.root.iterdir())

    def test_newest_copy_is_downloaded_checked_compressed_kept_private_and_confirmed(self):
        site = Site(self.name, self.content)
        self.run_copy(site)
        target = self.root / (self.name + ".gz")
        self.assertEqual(self.kept(), [target.name])
        self.assertEqual(gzip.decompress(target.read_bytes()), self.content)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(site.confirmed, [self.name])
        self.assertTrue(any("récupérée et vérifiée" in line for line in self.logs))
        # Next day without any new copy on the site: nothing is downloaded, the copy is confirmed again.
        site.requests.clear()
        self.run_copy(site)
        self.assertNotIn("backups/" + self.name, site.requests)
        self.assertEqual(site.confirmed, [self.name, self.name])

    def test_damaged_incomplete_or_foreign_files_are_never_kept_or_confirmed(self):
        cases = {
            "incomplète": Site(self.name, self.content[:-10], size=len(self.content)),
            "plus grande": Site(self.name, self.content + b"x", size=len(self.content)),
            "illisible": Site(self.name, b"x" * 4096),
            "incompatible": Site(self.name, database(revision=0)),
        }
        for message, site in cases.items():
            with self.subTest(message=message):
                with self.assertRaisesRegex(backup.BackupError, message):
                    self.run_copy(site)
                self.assertEqual(self.kept(), [])
                self.assertEqual(site.confirmed, [])

    def test_full_disk_stops_before_download_and_interrupted_copies_are_cleaned(self):
        (self.root / (self.name + ".partial")).write_bytes(b"partial")
        self.free = 0.5e9
        site = Site(self.name, self.content)
        with self.assertRaisesRegex(backup.BackupError, "Espace disque insuffisant"):
            self.run_copy(site)
        self.assertNotIn("backups/" + self.name, site.requests)
        self.assertEqual(self.kept(), [])

    def test_failed_site_backup_is_reported_and_the_latest_copy_still_kept(self):
        self.run_copy(Site(self.name, self.content, error="La sauvegarde a échoué."))
        self.assertTrue(any("échec de sa dernière sauvegarde" in line for line in self.logs))
        self.assertEqual(self.kept(), [self.name + ".gz"])

    def test_retention_keeps_the_newest_copy_of_7_days_4_weeks_and_6_months(self):
        first, last = datetime.date(2026, 3, 1), datetime.date(2026, 11, 2)
        days = [first + datetime.timedelta(days=n) for n in range((last - first).days + 1)]
        for day in days[:-1]:
            (self.root / (name_at(day) + ".gz")).write_bytes(b"old")
            # A second copy the same day: only the newest of the day can be kept.
            (self.root / (name_at(day, hour=1) + ".gz")).write_bytes(b"old")
        (self.root / "notes.txt").write_text("autre fichier")
        self.run_copy(Site(name_at(last), self.content))
        expected = [datetime.date(2026, 11, d) for d in (2, 1)] + [datetime.date(2026, 10, d) for d in (31, 30, 29, 28, 27)]
        expected += [datetime.date(2026, 10, 25), datetime.date(2026, 10, 18)]  # Sundays of the previous weeks.
        expected += [datetime.date(2026, 9, 30), datetime.date(2026, 8, 31), datetime.date(2026, 7, 31),
                     datetime.date(2026, 6, 30)]  # Ends of the previous months.
        self.assertEqual(self.kept(), sorted([name_at(day) + ".gz" for day in expected] + ["notes.txt"]))
        self.assertTrue(any("13 copie(s) conservée(s)" in line for line in self.logs))


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = Path(self.temp.name) / "backup.env"

    def write(self, content, mode=0o600):
        self.env.write_text(content)
        self.env.chmod(mode)

    def test_settings_need_a_private_file_an_https_site_and_a_long_key(self):
        self.write(f"# copie\nPLANIFIKATEUR_URL=https://site.example.com/\nPLANIFIKATEUR_BACKUP_TOKEN={TOKEN}\n")
        self.assertEqual(backup.read_settings(self.env), ("https://site.example.com", TOKEN))
        self.write(f"PLANIFIKATEUR_URL=http://localhost:3000\nPLANIFIKATEUR_BACKUP_TOKEN={TOKEN}\n")
        self.assertEqual(backup.read_settings(self.env)[0], "http://localhost:3000")
        for content, mode, message in [
            (f"PLANIFIKATEUR_URL=https://site.example.com\nPLANIFIKATEUR_BACKUP_TOKEN={TOKEN}\n", 0o644, "chmod 600"),
            (f"PLANIFIKATEUR_URL=http://site.example.com\nPLANIFIKATEUR_BACKUP_TOKEN={TOKEN}\n", 0o600, "HTTPS"),
            (f"PLANIFIKATEUR_URL=https://u:p@site.example.com\nPLANIFIKATEUR_BACKUP_TOKEN={TOKEN}\n", 0o600, "HTTPS"),
            (f"PLANIFIKATEUR_URL=https://site.example.com/api\nPLANIFIKATEUR_BACKUP_TOKEN={TOKEN}\n", 0o600, "HTTPS"),
            ("PLANIFIKATEUR_URL=https://site.example.com\nPLANIFIKATEUR_BACKUP_TOKEN=court\n", 0o600, "trop court"),
        ]:
            with self.subTest(content=content, mode=mode):
                self.write(content, mode)
                with self.assertRaisesRegex(backup.BackupError, message) as error:
                    backup.read_settings(self.env)
                self.assertNotIn(TOKEN, str(error.exception))

    def test_site_requests_carry_the_key_without_following_redirects_or_leaking_it(self):
        class Opener:
            def __init__(self, error=None):
                self.requests, self.error = [], error

            def open(self, request, timeout):
                self.requests.append(request)
                if self.error:
                    raise self.error
                return contextlib.nullcontext(io.BytesIO(b"{}"))

        opener = Opener()
        request = backup.site_client("https://site.example.com", TOKEN, opener)
        with request("backups/offsite", {"name": "x"}):
            pass
        sent = opener.requests[0]
        self.assertEqual((sent.full_url, sent.get_method()), ("https://site.example.com/api/v1/backups/offsite", "POST"))
        self.assertEqual(sent.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(json.loads(sent.data), {"name": "x"})
        for error, message in [(urllib.error.HTTPError("https://site.example.com", 401, "", {}, None), "HTTP 401"),
                               (OSError("refused"), "injoignable")]:
            with self.assertRaisesRegex(backup.BackupError, message) as raised:
                backup.site_client("https://site.example.com", TOKEN, Opener(error))("backups")
            self.assertNotIn(TOKEN, str(raised.exception))
            self.assertNotIn("site.example.com", str(raised.exception))
        self.assertTrue(issubclass(backup.NoRedirect, urllib.request.HTTPRedirectHandler))

    def test_overlapping_copies_do_not_read_the_key(self):
        directory = Path(self.temp.name) / "copies"
        directory.mkdir()
        with (directory / ".lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            argv = ["backup.py", "--directory", str(directory), "--env-file", str(self.env)]
            with patch("sys.argv", argv), contextlib.redirect_stdout(io.StringIO()) as output:
                backup.main()
            self.assertIn("déjà en cours", output.getvalue())
        self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
