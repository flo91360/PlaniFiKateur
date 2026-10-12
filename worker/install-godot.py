#!/usr/bin/env python3
"""Install the official Godot build after checking its published SHA-512."""
import argparse
import hashlib
import platform
from pathlib import Path
import tempfile
import urllib.request
import zipfile

VERSION = "4.4.1"
# https://github.com/godotengine/godot/releases/download/4.4.1-stable/SHA512-SUMS.txt
CHECKSUMS = {
    "x86_64": "ef4e76880a514257175544952c61191106fdef3095b909bafed9fcbeb230c3e5533920a0f3012882dd4bbde83028a67549825794e2d2c3cf76eba7918b71370e",
    "arm64": "8af79fe5fbc4cc42f5a7e4a52bd124973e084218f4d299cb5400595c6083ca800a59770c9c289b622dfc164fc3c6f369b362134ea2ac44223361657ea7941b09",
}

def install(destination, archive=None):
    architecture = {"aarch64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    if architecture not in CHECKSUMS:
        raise RuntimeError("Unsupported Godot architecture")
    name = f"Godot_v{VERSION}-stable_linux.{architecture}"
    with tempfile.TemporaryDirectory(prefix="planifikateur-godot-") as folder:
        source = Path(archive) if archive else Path(folder) / "godot.zip"
        if not archive:
            urllib.request.urlretrieve(f"https://github.com/godotengine/godot/releases/download/{VERSION}-stable/{name}.zip", source)
        digest = hashlib.sha512()
        with source.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != CHECKSUMS[architecture]:
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
    args = parser.parse_args()
    install(args.destination, args.archive)
