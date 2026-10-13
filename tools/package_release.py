"""Build a portable runtime ZIP from tracked runtime files and the production UI."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = {
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "README.zh-CN.md",
    ".env.example",
    "run.py",
    "preview_server.py",
    "backend/.python-version",
    "backend/alembic.ini",
    "backend/pyproject.toml",
    "backend/uv.lock",
    "frontend/package.json",
    "docs/usage.md",
    "docs/configuration.md",
    "docs/troubleshooting.md",
    "docs/en/usage.md",
    "docs/en/configuration.md",
    "docs/en/troubleshooting.md",
}
RUNTIME_PREFIXES = ("backend/app/", "backend/migrations/")


def runtime_file(name: str) -> bool:
    return name in RUNTIME_FILES or name.startswith(RUNTIME_PREFIXES)


def build(root: Path, destination: Path, tracked: list[str] | None = None) -> Path:
    metadata = tomllib.loads(
        (root / "backend/pyproject.toml").read_text(encoding="utf-8")
    )
    version = metadata["project"]["version"]
    frontend = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))
    if frontend["version"] != version:
        raise ValueError("Frontend and backend versions do not match")
    if not (root / "frontend/out/index.html").is_file():
        raise ValueError("Build the production frontend before packaging")
    if tracked is None:
        tracked = (
            subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
            .decode("utf-8")
            .split("\0")
        )
    names = sorted(name for name in tracked if runtime_file(name))
    missing = RUNTIME_FILES - set(names)
    if missing:
        raise ValueError(f"Missing tracked runtime files: {', '.join(sorted(missing))}")
    files = [root / name for name in names]
    files += sorted(
        path for path in (root / "frontend/out").rglob("*") if path.is_file()
    )
    if any(path.is_symlink() for path in files):
        raise ValueError("Runtime packages cannot contain symbolic links")
    for path in files:
        if path.suffix in {".js", ".html"} and path.is_relative_to(
            root / "frontend/out"
        ):
            content = path.read_bytes()
            if any(
                endpoint in content
                for endpoint in (b"127.0.0.1:8009", b"127.0.0.1:8011")
            ):
                raise ValueError("Frontend build contains a test API endpoint")
    destination.mkdir(parents=True, exist_ok=True)
    package = destination / f"MemoCosmos-{version}.zip"
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            # Equal timestamps prevent ZIP extraction from marking sources newer
            # than the built interface in the launcher's freshness check.
            info = zipfile.ZipInfo(
                f"MemoCosmos-{version}/{path.relative_to(root).as_posix()}"
            )
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    checksum = hashlib.sha256(package.read_bytes()).hexdigest()
    (destination / "SHA256SUMS").write_text(
        f"{checksum}  {package.name}\n", encoding="utf-8"
    )
    return package


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/releases")
    args = parser.parse_args()
    print(build(ROOT, args.output.resolve()))


if __name__ == "__main__":
    main()
