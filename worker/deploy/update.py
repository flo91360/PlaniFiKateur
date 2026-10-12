#!/usr/bin/env python3
"""Update the EC2 worker from tested main commits; never execute task code here."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

REQUIRED_JOBS = ("Tests serveur", "Tests navigateur")
REVISION_LABEL = "io.planifikateur.worker.revision"
READY = "Worker IA démarré : une tâche à la fois."
BUSY_PROBE = """const fs=require('node:fs');
try { const jobs=fs.readdirSync('/data/state').filter(f=>f.endsWith('.json'));
console.log(jobs.some(f=>JSON.parse(fs.readFileSync('/data/state/'+f,'utf8')).phase==='running')?'busy':'idle'); }
catch(e) { if(e.code==='ENOENT') console.log('idle'); else process.exit(2); }"""


class UpdateError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def command(args, cwd=None, timeout=1800, optional=False):
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise UpdateError(f"Commande {args[0]} indisponible ou délai dépassé.") from None
    if result.returncode and not optional:
        # Commands may include private env-file contents in their error output.
        raise UpdateError(f"Commande {args[0]} échouée (code {result.returncode}).")
    output = result.stdout + (result.stderr if args[:2] == ["docker", "logs"] else "")
    return result.returncode, output.strip()


def read_token(env_file):
    for line in env_file.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, separator, value = line.partition("=")
            if separator and key.strip() == "PLANIFIKATEUR_GITHUB_TOKEN" and value.strip():
                return value.strip()
    raise UpdateError("PLANIFIKATEUR_GITHUB_TOKEN absent du fichier de configuration.")


def github_client(repository, token):
    opener = urllib.request.build_opener(NoRedirect())

    def request(path):
        req = urllib.request.Request("https://api.github.com/repos/" + repository + path, headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "PlaniFiKateur-worker-updater",
        })
        try:
            with opener.open(req, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise UpdateError(f"Lecture des contrôles GitHub refusée (HTTP {error.code}).") from None
        except (OSError, ValueError):
            raise UpdateError("Lecture des contrôles GitHub indisponible.") from None
    return request


def tested(request, sha, repository):
    query = urllib.parse.urlencode({"branch": "main", "event": "push", "head_sha": sha, "per_page": 100})
    workflow = request("/actions/workflows/ci.yml")
    runs = request("/actions/workflows/ci.yml/runs?" + query)["workflow_runs"]
    runs = [run for run in runs if run.get("head_sha") == sha and run.get("head_branch") == "main"
            and run.get("event") == "push" and run.get("workflow_id") == workflow["id"]
            and run.get("head_repository", {}).get("full_name", "").lower() == repository.lower()]
    if not runs:
        return False
    latest = max(runs, key=lambda run: run["id"])
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        return False
    jobs = []
    for page in range(1, 101):
        result = request(f"/actions/runs/{latest['id']}/jobs?filter=latest&per_page=100&page={page}")
        jobs.extend(result["jobs"])
        if len(jobs) >= result["total_count"]:
            break
        if not result["jobs"]:
            return False
    else:
        return False
    for name in REQUIRED_JOBS:
        matches = [job for job in jobs if job.get("name") == name]
        if len(matches) != 1 or matches[0].get("status") != "completed" or matches[0].get("conclusion") != "success" or matches[0].get("run_attempt") != latest["run_attempt"]:
            return False
    # A rerun or a newer run must not appear during the preceding checks.
    current = request(f"/actions/runs/{latest['id']}")
    newest = request("/actions/workflows/ci.yml/runs?" + query)["workflow_runs"]
    newer = any(run.get("head_sha") == sha and run.get("workflow_id") == workflow["id"] and run["id"] > latest["id"] for run in newest)
    return not newer and current.get("run_attempt") == latest["run_attempt"] and current.get("status") == "completed" and current.get("conclusion") == "success"


class Updater:
    def __init__(self, options, request, run=command, log=print, sleep=time.sleep, clock=time.monotonic,
                 disk_free=lambda path: shutil.disk_usage(path).free):
        self.options, self.request, self.run, self.disk_free = options, request, run, disk_free
        self.log, self.sleep, self.clock = log, sleep, clock
        self.root, self.env_file = Path(options.repo_dir), Path(options.env_file)
        self.state_path = Path(options.state_dir) / "deployment.json"
        self.name = options.container
        self.next = self.name + "-next"
        self.backup = self.name + "-previous"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def save(self):
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state))
        temporary.chmod(0o600)
        temporary.replace(self.state_path)

    def cmd(self, *args, optional=False, timeout=1800):
        return self.run(list(args), cwd=str(self.root), optional=optional, timeout=timeout)[1]

    def inspect(self, name, field):
        code, text = self.run(["docker", "inspect", "--format", "{{json " + field + "}}", name], optional=True)
        return None if code else json.loads(text)

    def exists(self, name):
        return self.inspect(name, ".State") is not None

    def running(self, name):
        return bool((self.inspect(name, ".State") or {}).get("Running"))

    def remove(self, name):
        if self.exists(name):
            if self.running(name):
                self.cmd("docker", "stop", "--time", "60", name, timeout=90)
            self.cmd("docker", "rm", name)  # Never remove the persistent volume.

    def security(self):
        return ["--security-opt", "seccomp=" + str(self.root / "worker/seccomp.json"),
                "--security-opt", "apparmor=" + self.options.apparmor_profile]

    def busy(self):
        image = self.inspect(self.name, ".Image")
        output = self.cmd("docker", "run", "--rm", "--entrypoint", "node", "--mount",
                          "source=" + self.options.volume + ",target=/data,readonly", image,
                          "-e", BUSY_PROBE, timeout=60)
        if output not in ("busy", "idle"):
            raise UpdateError("Impossible de vérifier les tâches en cours.")
        return output == "busy"

    def recover(self):
        pending = self.state.get("pending")
        if not pending:
            return
        self.log("Remplacement interrompu : restauration du worker précédent.")
        self.remove(self.next)
        if self.exists(self.backup):
            self.remove(self.name)
            self.cmd("docker", "rename", self.backup, self.name)
        if not self.exists(self.name):
            raise UpdateError("Worker précédent absent : intervention nécessaire.")
        if not self.running(self.name):
            self.cmd("docker", "start", self.name)
        self.state.update(pending=None, failed_sha=pending)
        self.save()

    def free_bytes(self):
        code, root = self.run(["docker", "info", "--format", "{{.DockerRootDir}}"], optional=True)
        for path in ([root] if not code and root.startswith("/") else []) + ["/"]:
            try:
                return self.disk_free(path)
            except OSError:
                continue
        return None

    def cleanup(self, sha, record=True):
        """Free disk around a deployment; never blocks or undoes it."""
        # Keep the running image and the previous one, which a rollback restarts.
        keep = {self.inspect(name, ".Image") for name in (self.name, self.backup)} - {None}
        code, listing = self.run(["docker", "image", "ls", "--no-trunc", "--format",
                                  "{{.ID}} {{.Repository}}:{{.Tag}}", "planifikateur-worker"], optional=True)
        removed = 0
        for line in (listing.splitlines() if not code else []):
            image_id, _, reference = line.partition(" ")
            if image_id in keep or not reference.startswith("planifikateur-worker:"):
                continue
            removed += not self.run(["docker", "image", "rm", reference], optional=True)[0]
        # Untagged layers left by a rebuilt revision, then the whole build cache.
        self.run(["docker", "image", "prune", "--force"], optional=True, timeout=600)
        self.run(["docker", "builder", "prune", "--all", "--force"], optional=True, timeout=600)
        if record:
            self.state["cleaned_sha"] = sha
            self.save()
        self.log(f"Nettoyage{'' if record else ' avant construction'} : {removed} ancienne(s) image(s) du worker et le cache de construction supprimés.")

    def ready(self, name):
        deadline = self.clock() + self.options.startup_timeout
        stable = None
        while self.clock() < deadline:
            status = self.inspect(name, ".State") or {}
            restarts = self.inspect(name, ".RestartCount")
            if not status.get("Running") or restarts:
                return False
            output = self.cmd("docker", "logs", "--tail", "100", name, timeout=20)
            if "Connexion du worker refusée ou indisponible" in output:
                return False
            if READY in output:
                stable = self.clock() if stable is None else stable
                if self.clock() - stable >= 5:
                    return True
            self.sleep(1)
        return False

    def update(self):
        self.recover()
        if not self.running(self.name):
            self.log("Worker arrêté : mise à jour différée.")
            return
        mounts = self.inspect(self.name, ".Mounts") or []
        if not any(mount.get("Name") == self.options.volume and mount.get("Destination") == "/data" for mount in mounts):
            raise UpdateError("Le conteneur n’utilise pas le volume configuré à /data.")
        if self.cmd("git", "branch", "--show-current") != "main" or self.cmd("git", "status", "--porcelain"):
            raise UpdateError("Le checkout doit être sur main et sans modifications locales.")
        self.cmd("git", "fetch", "--no-tags", "origin", "main", timeout=90)
        sha = self.cmd("git", "rev-parse", "origin/main")
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise UpdateError("Révision Git invalide.")
        labels = self.inspect(self.name, ".Config.Labels") or {}
        deployed = labels.get(REVISION_LABEL)
        if deployed == sha:
            self.log("Worker déjà à jour.")
            if self.state.get("cleaned_sha") != sha:
                self.cleanup(sha)
            return
        if self.state.get("failed_sha") == sha and not self.options.retry:
            self.log("Cette révision a échoué au déploiement ; nouvelle tentative suspendue.")
            return
        if not tested(self.request, sha, self.options.repository):
            self.log("Mise à jour différée : contrôles GitHub non terminés ou non réussis.")
            return
        if deployed and re.fullmatch(r"[0-9a-f]{40}", deployed):
            changed = self.cmd("git", "diff", "--name-only", deployed, sha, "--", "worker", ".dockerignore")
            if not changed:
                self.cmd("git", "merge", "--ff-only", sha)
                self.log("Changements hors worker : aucune reconstruction nécessaire.")
                return
        if self.busy():
            self.log("Une tâche est en cours : mise à jour différée.")
            return
        self.cmd("git", "merge", "--ff-only", sha)
        image = "planifikateur-worker:" + sha
        # Debian packages need room while unpacking: free old images first, then
        # refuse to build on a full disk (an external cause, retried automatically).
        self.cleanup(sha, record=False)
        free, needed = self.free_bytes(), self.options.min_free_gb * 1e9
        if free is not None and free < needed:
            raise UpdateError(f"Espace disque insuffisant pour construire l’image : {free / 1e9:.1f} Go libres, "
                              f"{self.options.min_free_gb:g} Go nécessaires. Libérez de l’espace ou agrandissez le disque.")
        try:
            self.log("Construction de l’image " + sha[:7] + ". L’ancien worker reste actif.")
            self.cmd("docker", "build", "-f", "worker/Dockerfile", "-t", image, ".")
            self.cmd("docker", "run", "--rm", *self.security(), image, "node", "sandbox-check.mjs", timeout=90)
        except UpdateError:
            self.state["failed_sha"] = sha
            try:
                self.save()
            except OSError:
                pass  # A full disk must not hide the build failure being reported.
            raise
        if self.busy() or not tested(self.request, sha, self.options.repository):
            self.log("Remplacement différé : tâche démarrée ou contrôles GitHub modifiés.")
            return
        if self.exists(self.next) or self.running(self.backup):
            raise UpdateError("Conteneur de remplacement déjà présent : intervention nécessaire.")
        self.remove(self.backup)
        self.cmd("docker", "create", "--name", self.next, "--restart", "unless-stopped",
                 "--label", REVISION_LABEL + "=" + sha, *self.security(), "--env-file", str(self.env_file),
                 "--mount", "source=" + self.options.volume + ",target=/data", image)
        self.state["pending"] = sha
        self.save()
        try:
            self.cmd("docker", "stop", "--time", "60", self.name, timeout=90)
            self.cmd("docker", "rename", self.name, self.backup)
            self.cmd("docker", "start", self.next)
            if not self.ready(self.next):
                raise UpdateError("Le nouveau worker n’a pas confirmé son démarrage.")
            self.cmd("docker", "rename", self.next, self.name)
            self.state.update(pending=None, failed_sha=None, deployed_sha=sha)
            self.save()
            self.log("Worker mis à jour : " + sha[:7] + ". Le volume et le conteneur précédent sont conservés.")
        except UpdateError:
            self.recover()
            raise
        self.cleanup(sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", default="/home/admin/PlaniFiKateur")
    parser.add_argument("--env-file", default="/home/admin/planifikateur-worker.env")
    parser.add_argument("--state-dir", default="/home/admin/.local/state/planifikateur-worker-update")
    parser.add_argument("--repository", default="flo91360/PlaniFiKateur")
    parser.add_argument("--container", default="planifikateur-worker")
    parser.add_argument("--volume", default="planifikateur-worker-data")
    parser.add_argument("--apparmor-profile", default="unconfined")
    parser.add_argument("--startup-timeout", type=int, default=60)
    parser.add_argument("--min-free-gb", type=float, default=2.5, help="Free disk required before building")
    parser.add_argument("--retry", action="store_true", help="Retry a revision previously rejected at deployment")
    options = parser.parse_args()
    directory = Path(options.state_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "update.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Une mise à jour est déjà en cours.")
            return
        request = github_client(options.repository, read_token(Path(options.env_file)))
        Updater(options, request).update()


if __name__ == "__main__":
    try:
        main()
    except UpdateError as error:
        print(str(error), flush=True)
        raise SystemExit(1)
    except Exception as error:
        # Never leak secret file contents or command output through a traceback:
        # report only the error type and, for system errors, the system message.
        detail = type(error).__name__ + (" : " + error.strerror if isinstance(error, OSError) and error.strerror else "")
        print(f"Mise à jour interrompue ({detail}) : consulter la configuration du service.", flush=True)
        raise SystemExit(1)
