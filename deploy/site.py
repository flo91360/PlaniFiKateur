#!/usr/bin/env python3
"""Run the PlaniFiKateur site on this VPS behind Caddy, updated from tested main commits.

Same rules as the worker updater (worker/deploy/update.py), whose GitHub checks it reuses:
only a main commit whose CI succeeded is deployed, the data volume is never removed, the
previous container is kept and restarted if the new one does not serve the expected commit.
Secrets stay in the private env file passed to Docker; neither they nor command output are logged."""
import argparse
import fcntl
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time

_spec = importlib.util.spec_from_file_location(
    "planifikateur_worker_update", Path(__file__).resolve().parents[1] / "worker/deploy/update.py")
common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(common)
UpdateError, command, failure_message, read_env, tested = (
    common.UpdateError, common.command, common.failure_message, common.read_env, common.tested)

REVISION_LABEL = "io.planifikateur.site.revision"
DOMAIN_LABEL = "io.planifikateur.site.domain"
PROXY_CONFIG_LABEL = "io.planifikateur.site.proxy-config"
# Caddy obtains and renews the Let's Encrypt certificate itself (ports 80 and 443).
PROXY_IMAGE = "caddy:2.10-alpine"
ALIAS = "site"
# While the site restarts (old container stopped, new one starting), Caddy keeps the requests and
# retries the connection instead of answering 502: an update is seen as a short wait, not an outage.
# Only connections refused or unresolved are retried, so a request already received is never replayed.
HOLD_SECONDS = 60
CADDYFILE = """{domain} {{
\treverse_proxy """ + ALIAS + """:3000 {{
\t\tlb_try_duration """ + str(HOLD_SECONDS) + """s
\t\tlb_try_interval 250ms
\t}}
}}
"""
PROXY_START = 'printf "%s" "$PLANIFIKATEUR_CADDYFILE" > /etc/caddy/Caddyfile && exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile'
DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
PROBE = """fetch('http://127.0.0.1:3000/build-info.json',{signal:AbortSignal.timeout(5000)})
.then(r=>r.ok?r.json():{}).then(b=>console.log(b.commit||''),()=>console.log(''))"""
RESTORE = """set -e
test ! -e /data/planifikateur.sqlite
cp /restore.sqlite /data/planifikateur.sqlite.partial
chown node:node /data/planifikateur.sqlite.partial
chmod 600 /data/planifikateur.sqlite.partial
mv /data/planifikateur.sqlite.partial /data/planifikateur.sqlite"""


def read_domain(env_file):
    try:
        lines = env_file.read_text().splitlines()
        domain = (read_env(env_file, "PLANIFIKATEUR_DOMAIN") or "").lower()
    except OSError:
        raise UpdateError(f"Fichier de configuration {env_file} illisible.") from None
    # Docker keeps quotes as part of the value (unlike Railway's raw editor): a quoted key would be refused.
    for number, line in enumerate(lines, 1):
        key, separator, value = line.partition("=")
        if separator and not key.lstrip().startswith("#") and value.strip()[:1] in ("'", '"'):
            raise UpdateError(f"{env_file}, ligne {number} : retirez les guillemets autour de la valeur de {key.strip()}.")
    if not DOMAIN.fullmatch(domain):
        raise UpdateError("PLANIFIKATEUR_DOMAIN : nom de domaine du site attendu (ex. 203-0-113-7.sslip.io).")
    return domain


def check_database(path):
    """A restored file must be an intact PlaniFiKateur database."""
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise UpdateError("Copie à restaurer endommagée (contrôle d’intégrité SQLite).")
            row = db.execute("SELECT revision FROM workspace WHERE id = 1").fetchone()
            if not row or not isinstance(row[0], int) or row[0] < 1:
                raise UpdateError("Copie à restaurer incompatible.")
        finally:
            db.close()
    except sqlite3.Error:
        raise UpdateError("Copie à restaurer illisible par SQLite.") from None


def newest_backup(directory):
    copies = sorted(p for p in Path(directory).glob("planifikateur-*.sqlite.gz") if p.is_file())
    if not copies:
        raise UpdateError(f"Aucune copie dans {directory} : lancez d’abord la copie quotidienne.")
    return copies[-1]


class Site:
    def __init__(self, options, request, run=command, log=print, sleep=time.sleep, clock=time.monotonic,
                 disk_free=lambda path: shutil.disk_usage(path).free):
        self.options, self.request, self.run, self.log = options, request, run, log
        self.sleep, self.clock, self.disk_free = sleep, clock, disk_free
        self.root, self.env_file = Path(options.repo_dir), Path(options.env_file)
        self.name, self.proxy = options.container, options.container + "-proxy"
        self.next, self.backup = self.name + "-next", self.name + "-previous"
        self.state_path = Path(options.state_dir) / "site.json"
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
                self.cmd("docker", "stop", "--time", "30", name, timeout=60)
            self.cmd("docker", "rm", name)  # Never remove the data volume.

    def latest(self):
        self.cmd("git", "fetch", "--no-tags", "origin", "main", timeout=90)
        sha = self.cmd("git", "rev-parse", "origin/main")
        if not SHA.fullmatch(sha):
            raise UpdateError("Révision Git invalide.")
        return sha

    def build(self, sha):
        image = "planifikateur-site:" + sha
        free, needed = self.free_bytes(), self.options.min_free_gb * 1e9
        if free is not None and free < needed:
            raise UpdateError(f"Espace disque insuffisant pour construire le site : {free / 1e9:.1f} Go libres, "
                              f"{self.options.min_free_gb:g} Go nécessaires.")
        self.log("Construction du site " + sha[:7] + ". Le site actuel reste en ligne.")
        with tempfile.TemporaryDirectory(prefix="planifikateur-site-") as directory:
            # Exact content of the tested commit, whatever the state of the checkout.
            archive = str(Path(directory) / "source.tar")
            self.cmd("git", "archive", "--format=tar", "-o", archive, sha)
            context = str(Path(directory) / "context")
            Path(context).mkdir()
            self.cmd("tar", "-xf", archive, "-C", context)
            self.cmd("docker", "build", "-f", "deploy/site.Dockerfile", "--build-arg",
                     "PLANIFIKATEUR_COMMIT_SHA=" + sha, "-t", image, context)
        return image

    def free_bytes(self):
        code, root = self.run(["docker", "info", "--format", "{{.DockerRootDir}}"], optional=True)
        for path in ([root] if not code and root.startswith("/") else []) + ["/"]:
            try:
                return self.disk_free(path)
            except OSError:
                continue
        return None

    def create(self, name, image, sha, domain):
        self.cmd("docker", "create", "--name", name, "--restart", "unless-stopped",
                 "--label", REVISION_LABEL + "=" + sha, "--env-file", str(self.env_file),
                 "--env", "PLANIFIKATEUR_PUBLIC_ORIGIN=https://" + domain,
                 "--network", self.options.network, "--network-alias", ALIAS,
                 "--mount", "source=" + self.options.volume + ",target=/data", image)

    def serves(self, name, sha):
        """The container stays up and its server answers with the expected commit."""
        deadline = self.clock() + self.options.startup_timeout
        while self.clock() < deadline:
            if not self.running(name) or self.inspect(name, ".RestartCount"):
                return False
            code, output = self.run(["docker", "exec", name, "node", "-e", PROBE], optional=True, timeout=30)
            if not code and output == sha:
                return True
            self.sleep(2)
        return False

    def recover(self):
        pending = self.state.get("pending")
        if not pending:
            return
        self.log("Remplacement du site interrompu : restauration de la version précédente.")
        self.remove(self.next)
        if self.exists(self.backup):
            self.remove(self.name)
            self.cmd("docker", "rename", self.backup, self.name)
        if not self.exists(self.name):
            raise UpdateError("Site précédent absent : intervention nécessaire.")
        if not self.running(self.name):
            self.cmd("docker", "start", self.name)
        self.state.update(pending=None, failed_sha=pending)
        self.save()

    def replace(self, image, sha, domain):
        if self.exists(self.next) or self.running(self.backup):
            raise UpdateError("Conteneur de remplacement du site déjà présent : intervention nécessaire.")
        self.remove(self.backup)
        self.create(self.next, image, sha, domain)
        self.state["pending"] = sha
        self.save()
        try:
            # SQLite: a single server writes the base, so the old one stops before the new one starts.
            self.cmd("docker", "stop", "--time", "30", self.name, timeout=60)
            self.cmd("docker", "rename", self.name, self.backup)
            self.cmd("docker", "start", self.next)
            if not self.serves(self.next, sha):
                raise UpdateError("Le nouveau site n’a pas servi la version attendue : version précédente rétablie.")
            self.cmd("docker", "rename", self.next, self.name)
            self.state.update(pending=None, failed_sha=None, deployed_sha=sha)
            self.save()
        except UpdateError:
            self.recover()
            raise
        self.log("Site mis à jour : " + sha[:7] + ". Les données et la version précédente sont conservées.")
        self.cleanup()

    def cleanup(self):
        keep = {self.inspect(name, ".Image") for name in (self.name, self.backup)} - {None}
        code, listing = self.run(["docker", "image", "ls", "--no-trunc", "--format",
                                  "{{.ID}} {{.Repository}}:{{.Tag}}", "planifikateur-site"], optional=True)
        for line in (listing.splitlines() if not code else []):
            image_id, _, reference = line.partition(" ")
            if image_id not in keep and reference.startswith("planifikateur-site:"):
                self.run(["docker", "image", "rm", reference], optional=True)
        self.run(["docker", "image", "prune", "--force"], optional=True, timeout=600)

    def ensure_proxy(self, domain):
        config = CADDYFILE.format(domain=domain)
        digest = hashlib.sha256(config.encode()).hexdigest()[:16]
        labels = self.inspect(self.proxy, ".Config.Labels")
        if labels is not None and labels.get(DOMAIN_LABEL) != domain:
            self.log("Nom de domaine modifié : recréation du mandataire HTTPS.")
            self.remove(self.proxy)
            labels = None
        elif labels is not None and labels.get(PROXY_CONFIG_LABEL) != digest:
            self.log("Configuration du mandataire HTTPS modifiée : recréation (coupure d’une seconde environ).")
            self.remove(self.proxy)
            labels = None
        if labels is None:
            # Certificates live in their own volume, kept across updates (Let's Encrypt limits renewals).
            self.cmd("docker", "create", "--name", self.proxy, "--restart", "unless-stopped",
                     "--label", DOMAIN_LABEL + "=" + domain, "--label", PROXY_CONFIG_LABEL + "=" + digest,
                     "--network", self.options.network, "--env", "PLANIFIKATEUR_CADDYFILE=" + config,
                     "-p", "80:80", "-p", "443:443", "-p", "443:443/udp",
                     "--mount", "source=" + self.options.volume + "-caddy,target=/data",
                     "--entrypoint", "sh", PROXY_IMAGE, "-c", PROXY_START)
        if not self.running(self.proxy):
            self.cmd("docker", "start", self.proxy)

    def install(self, restore):
        """First start on this server: data restored from a copy, site and HTTPS proxy started."""
        domain = read_domain(self.env_file)
        if self.exists(self.name):
            self.log("Site déjà installé : vérification de la mise à jour et du mandataire HTTPS.")
            return self.update()
        if self.inspect(self.options.network, ".Id") is None:
            self.cmd("docker", "network", "create", self.options.network)
        sha = self.latest()
        if not tested(self.request, sha, self.options.repository):
            raise UpdateError("Contrôles GitHub du dernier commit de main non terminés ou non réussis : réessayez plus tard.")
        image = self.build(sha)
        if restore:
            self.restore(image, restore)
        self.create(self.name, image, sha, domain)
        self.cmd("docker", "start", self.name)
        if not self.serves(self.name, sha):
            self.cmd("docker", "stop", "--time", "30", self.name, timeout=60)
            raise UpdateError("Le site n’a pas démarré : consultez « docker logs " + self.name + " ».")
        self.state.update(deployed_sha=sha, failed_sha=None)
        self.save()
        self.ensure_proxy(domain)
        self.log(f"Site installé : https://{domain} sert {sha[:7]}.")

    def restore(self, image, source):
        source = newest_backup(self.options.backups) if source == "latest" else Path(source)
        with tempfile.TemporaryDirectory(prefix="planifikateur-restore-") as directory:
            path = Path(directory) / "restore.sqlite"
            opener = gzip.open if source.name.endswith(".gz") else open
            with opener(source, "rb") as data, path.open("xb") as output:
                shutil.copyfileobj(data, output, 1024 * 1024)
            check_database(path)
            code, _ = self.run(["docker", "run", "--rm", "--user", "root", "--entrypoint", "sh",
                                "--mount", "source=" + self.options.volume + ",target=/data",
                                "--mount", "type=bind,source=" + str(path) + ",target=/restore.sqlite,readonly",
                                image, "-c", RESTORE], optional=True, timeout=600)
        if code:
            raise UpdateError("Restauration refusée : le volume contient déjà une base (elle n’est jamais remplacée).")
        self.log(f"Données restaurées depuis {source.name}.")

    def update(self):
        domain = read_domain(self.env_file)
        self.recover()
        if not self.exists(self.name):
            return self.log("Site non installé sur ce serveur : rien à mettre à jour.")
        self.ensure_proxy(domain)
        if not self.running(self.name):
            self.cmd("docker", "start", self.name)
        sha = self.latest()
        deployed = (self.inspect(self.name, ".Config.Labels") or {}).get(REVISION_LABEL)
        if deployed == sha:
            return self.log("Site déjà à jour.")
        if self.state.get("failed_sha") == sha and not self.options.retry:
            return self.log("Cette révision a échoué au déploiement du site ; nouvelle tentative suspendue.")
        if not tested(self.request, sha, self.options.repository):
            return self.log("Mise à jour du site différée : contrôles GitHub non terminés ou non réussis.")
        try:
            image = self.build(sha)
        except UpdateError:
            self.state["failed_sha"] = sha
            self.save()
            raise
        self.replace(image, sha, domain)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", default="/home/admin/PlaniFiKateur")
    parser.add_argument("--env-file", default="/home/admin/planifikateur-site.env")
    parser.add_argument("--github-env-file", default="/home/admin/planifikateur-worker.env",
                        help="File holding PLANIFIKATEUR_GITHUB_TOKEN, used to read the CI results")
    # Shared with the worker updater: one of them at a time fetches main in the checkout.
    parser.add_argument("--state-dir", default="/home/admin/.local/state/planifikateur-worker-update")
    parser.add_argument("--repository", default="flo91360/PlaniFiKateur")
    parser.add_argument("--container", default="planifikateur-site")
    parser.add_argument("--volume", default="planifikateur-site-data")
    parser.add_argument("--network", default="planifikateur")
    parser.add_argument("--backups", default="/home/admin/planifikateur-backups")
    parser.add_argument("--startup-timeout", type=int, default=120)
    parser.add_argument("--min-free-gb", type=float, default=2.0)
    parser.add_argument("--install", action="store_true", help="First installation of the site on this server")
    parser.add_argument("--restore", help="With --install: database copy to restore (.sqlite, .sqlite.gz or latest)")
    parser.add_argument("--retry", action="store_true", help="Retry a revision previously rejected at deployment")
    options = parser.parse_args()
    if options.restore and not options.install:
        parser.error("--restore s’utilise avec --install.")
    directory = Path(options.state_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "update.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Une mise à jour du worker ou du site est déjà en cours : nouvelle vérification au prochain passage.")
            return
        token = read_env(Path(options.github_env_file), "PLANIFIKATEUR_GITHUB_TOKEN")
        if not token:
            raise UpdateError("PLANIFIKATEUR_GITHUB_TOKEN absent du fichier du worker.")
        site = Site(options, common.github_client(options.repository, token))
        site.install(options.restore) if options.install else site.update()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(failure_message(error), flush=True)
        raise SystemExit(1)
