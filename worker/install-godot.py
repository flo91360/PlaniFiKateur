#!/usr/bin/env python3
"""Install the official Godot build after checking its published SHA-512."""
import argparse
import hashlib
import platform
from pathlib import Path
import tempfile
import urllib.request
import zipfile

# Versions installées dans l'image du worker, chacune avec les sommes publiées par Godot :
# https://github.com/godotengine/godot/releases/download/<version>-stable/SHA512-SUMS.txt
CHECKSUMS = {
    "4.4.1": {
        "x86_64": "ef4e76880a514257175544952c61191106fdef3095b909bafed9fcbeb230c3e5533920a0f3012882dd4bbde83028a67549825794e2d2c3cf76eba7918b71370e",
        "arm64": "8af79fe5fbc4cc42f5a7e4a52bd124973e084218f4d299cb5400595c6083ca800a59770c9c289b622dfc164fc3c6f369b362134ea2ac44223361657ea7941b09",
    },
    "4.7.2": {
        "x86_64": "9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65",
        "arm64": "dd59918da086bd49bde2f5450b5e567ff8650cbde9abbd7b8f4ca1197ff8c609baa38834666d032deafb47099078d7822279e2a0e06e5665745468f26533e7e2",
    },
}

def install(destination, archive=None, version="4.4.1"):
    if version not in CHECKSUMS:
        raise RuntimeError("Unsupported Godot version")
    architecture = {"aarch64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    if architecture not in CHECKSUMS[version]:
        raise RuntimeError("Unsupported Godot architecture")
    name = f"Godot_v{version}-stable_linux.{architecture}"
    with tempfile.TemporaryDirectory(prefix="planifikateur-godot-") as folder:
        source = Path(archive) if archive else Path(folder) / "godot.zip"
        if not archive:
            urllib.request.urlretrieve(f"https://github.com/godotengine/godot/releases/download/{version}-stable/{name}.zip", source)
        digest = hashlib.sha512()
        with source.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != CHECKSUMS[version][architecture]:
            raise RuntimeError("Godot archive checksum mismatch")
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(source) as bundle:
            with bundle.open(name) as source_file, destination.open("wb") as output:
                import shutil
                shutil.copyfileobj(source_file, output)
        destination.chmod(0o755)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", default="/usr/local/bin/godot")
    parser.add_argument("--archive")
    parser.add_argument("--version", default="4.4.1", choices=sorted(CHECKSUMS))
    args = parser.parse_args()
    install(args.destination, args.archive, args.version)
