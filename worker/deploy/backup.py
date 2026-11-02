#!/usr/bin/env python3
"""Keep a daily copy of the site database on this server, outside Railway.

Downloads the newest regular backup made by the site, checks it with SQLite, stores it
compressed and keeps 7 daily, 4 weekly and 6 monthly copies. The site key only goes to
PLANIFIKATEUR_URL over HTTPS; neither the key nor command output is ever logged."""
import argparse
import datetime
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

# Name of a regular copy made by the site (server/backups.js), kept as is, compressed.
NAME = re.compile(r"^planifikateur-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$")
SUFFIX = ".gz"
RETENTION = {"daily": 7, "weekly": 4, "monthly": 6}
MAX_BYTES = 2 * 1024 ** 3


class BackupError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_settings(env_file):
    """Site address and backup key from the private file, read without executing a shell."""
    try:
        if env_file.stat().st_mode & 0o077:
            raise BackupError(f"{env_file} doit être lisible par son seul propriétaire (chmod 600).")
        values = {}
        for line in env_file.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                key, separator, value = line.partition("=")
                if separator and value.strip():
                    values.setdefault(key.strip(), value.strip())
    except OSError:
        raise BackupError(f"Fichier de configuration {env_file} illisible.") from None
    token = values.get("PLANIFIKATEUR_BACKUP_TOKEN", "")
    try:
        url = urllib.parse.urlsplit(values.get("PLANIFIKATEUR_URL", ""))
        local = url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
        valid = (url.scheme == "https" or local) and url.hostname and not (url.username or url.password)
        valid = valid and url.path in ("", "/") and not (url.query or url.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise BackupError("PLANIFIKATEUR_URL : origine HTTPS du site requise (HTTP accepté uniquement en local).")
    if len(token) < 32:
        raise BackupError("PLANIFIKATEUR_BACKUP_TOKEN absent ou trop court dans le fichier de configuration.")
    return url.scheme + "://" + url.netloc, token


def site_client(origin, token, opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())

    def request(path, data=None):
        req = urllib.request.Request(origin + "/api/v1/" + path, method="POST" if data is not None else "GET",
                                     data=None if data is None else json.dumps(data).encode(), headers={
            "Authorization": "Bearer " + token, "User-Agent": "PlaniFiKateur-backup",
            **({"Content-Type": "application/json"} if data is not None else {}),
        })
        try:
            return opener.open(req, timeout=60)
        except urllib.error.HTTPError as error:
            raise BackupError(f"Site : accès refusé ou indisponible (HTTP {error.code}).") from None
        except (OSError, ValueError):
            raise BackupError("Site injoignable.") from None
    return request


def newest(status):
    files = [f for f in status.get("files", []) if isinstance(f, dict) and f.get("kind") == "regular"
             and NAME.fullmatch(str(f.get("name", ""))) and isinstance(f.get("size"), int)
             and 0 < f["size"] <= MAX_BYTES]
    if not files:
        raise BackupError("Aucune sauvegarde régulière disponible sur le site.")
    return max(files, key=lambda f: f["name"])


def taken(name):
    """Date and time of a copy, from its name."""
    match = NAME.fullmatch(name[:-len(SUFFIX)] if name.endswith(SUFFIX) else name)
    if not match:
        return None
    day, hour, minute, second, millis = match.groups()
    return datetime.datetime.fromisoformat(f"{day}T{hour}:{minute}:{second}.{millis}+00:00")


def check_database(path):
    """The downloaded file must be an intact PlaniFiKateur database."""
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise BackupError("Copie téléchargée endommagée (contrôle d’intégrité SQLite).")
            row = db.execute("SELECT revision FROM workspace WHERE id = 1").fetchone()
            if not row or not isinstance(row[0], int) or row[0] < 1:
                raise BackupError("Copie téléchargée incompatible.")
        finally:
            db.close()
    except sqlite3.Error:
        raise BackupError("Copie téléchargée illisible par SQLite.") from None


def retained(names):
    """Copies kept: the newest of each of the last 7 days, 4 ISO weeks and 6 months."""
    dated = sorted(((taken(name), name) for name in names if taken(name)), reverse=True)
    keys = {"daily": lambda d: d.date(), "weekly": lambda d: d.isocalendar()[:2], "monthly": lambda d: (d.year, d.month)}
    keep = set()
    for period, count in RETENTION.items():
        seen = []
        for date, name in dated:
            key = keys[period](date)
            if key in seen:
                continue
            if len(seen) == count:
                break
            seen.append(key)
            keep.add(name)
    return keep


class Backup:
    def __init__(self, directory, request, log=print, disk_free=lambda path: shutil.disk_usage(path).free,
                 min_free_bytes=1e9):
        self.directory, self.request, self.log = Path(directory), request, log
        self.disk_free, self.min_free_bytes = disk_free, min_free_bytes

    def run(self):
        for stale in self.directory.glob("*.partial"):  # Left by an interrupted copy.
            stale.unlink()
        with self.request("backups") as response:
            status = json.load(response)
        if status.get("error"):
            self.log("Le site signale un échec de sa dernière sauvegarde : la copie disponible la plus récente est récupérée.")
        file = newest(status)
        target = self.directory / (file["name"] + SUFFIX)
        if target.exists():
            self.log(f"Copie {file['name']} déjà conservée : aucune nouvelle sauvegarde sur le site.")
        else:
            self.fetch(file, target)
        self.prune()
        self.confirm(file["name"])

    def fetch(self, file, target):
        needed = 2 * file["size"] + self.min_free_bytes
        free = self.disk_free(self.directory)
        if free < needed:
            raise BackupError(f"Espace disque insuffisant pour la copie : {free / 1e9:.1f} Go libres, "
                              f"{needed / 1e9:.1f} Go nécessaires.")
        raw = self.directory / (file["name"] + ".partial")
        compressed = self.directory / (target.name + ".partial")
        try:
            size = 0
            with self.request("backups/" + file["name"]) as response, raw.open("xb") as output:
                os.chmod(raw, 0o600)  # Also outside systemd, whose UMask already ensures it.
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > file["size"]:
                        raise BackupError("Copie téléchargée plus grande qu’annoncé.")
                    output.write(chunk)
            if size != file["size"]:
                raise BackupError("Copie téléchargée incomplète.")
            check_database(raw)
            with raw.open("rb") as source, gzip.open(compressed, "wb", compresslevel=6) as output:
                os.chmod(compressed, 0o600)
                shutil.copyfileobj(source, output, 1024 * 1024)
            os.replace(compressed, target)
        finally:
            for path in (raw, compressed):
                path.unlink(missing_ok=True)
        self.log(f"Copie {file['name']} récupérée et vérifiée ({target.stat().st_size / 1e6:.1f} Mo compressés).")

    def confirm(self, name):
        # The site shows the last confirmed copy and alerts the administrator after two days without one.
        with self.request("backups/offsite", {"name": name}) as response:
            response.read()

    def prune(self):
        names = [path.name for path in self.directory.iterdir() if path.is_file() and taken(path.name)]
        keep = retained(names)
        for name in names:
            if name not in keep:
                (self.directory / name).unlink()
        self.log(f"Rétention : {len(keep)} copie(s) conservée(s), {len(names) - len(keep)} supprimée(s).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default="/home/admin/planifikateur-backup.env")
    parser.add_argument("--directory", default="/home/admin/planifikateur-backups")
    parser.add_argument("--min-free-gb", type=float, default=1.0, help="Free disk kept after a copy")
    options = parser.parse_args()
    directory = Path(options.directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)  # The copies hold accounts, password hashes and sessions.
    with (directory / ".lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Une copie est déjà en cours.")
            return
        origin, token = read_settings(Path(options.env_file))
        Backup(directory, site_client(origin, token), min_free_bytes=options.min_free_gb * 1e9).run()


if __name__ == "__main__":
    try:
        main()
    except BackupError as error:
        print(str(error), flush=True)
        raise SystemExit(1)
    except Exception as error:
        # Never leak the key or file contents through a traceback.
        detail = type(error).__name__ + (" : " + error.strerror if isinstance(error, OSError) and error.strerror else "")
        print(f"Copie interrompue ({detail}) : consulter la configuration du service.", flush=True)
        raise SystemExit(1)
