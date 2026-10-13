"""Release bundles include the usable UI and exclude private local files."""

import tempfile
import unittest
import zipfile
from pathlib import Path

from tools.package_release import RUNTIME_FILES, build


class PackageTests(unittest.TestCase):
    def fixture(self, root):
        for name in RUNTIME_FILES:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("runtime", encoding="utf-8")
        (root / "backend/pyproject.toml").write_text(
            '[project]\nversion = "1.0.0"\n', encoding="utf-8"
        )
        (root / "frontend/package.json").write_text(
            '{"version":"1.0.0"}', encoding="utf-8"
        )
        (root / "frontend/out").mkdir()
        (root / "frontend/out/index.html").write_text("MemoCosmos", encoding="utf-8")
        return list(RUNTIME_FILES)

    def test_bundle_contains_built_ui_and_excludes_private_files_and_development_notes(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracked = self.fixture(root)
            for name in ("backend/model.json", "docs/architecture.md", ".env"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("private-must-not-be-published", encoding="utf-8")
                tracked.append(name)
            package = build(root, root / "releases", tracked)
            with zipfile.ZipFile(package) as archive:
                self.assertIn(
                    "MemoCosmos-1.0.0/frontend/out/index.html", archive.namelist()
                )
                self.assertIn("MemoCosmos-1.0.0/LICENSE", archive.namelist())
                self.assertTrue(
                    all(
                        b"private-must-not-be-published" not in archive.read(name)
                        for name in archive.namelist()
                    )
                )
            self.assertTrue((root / "releases/SHA256SUMS").is_file())

    def test_rejects_mismatched_versions_and_test_endpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracked = self.fixture(root)
            (root / "frontend/package.json").write_text(
                '{"version":"0.1.0"}', encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "versions do not match"):
                build(root, root / "releases", tracked)
            (root / "frontend/package.json").write_text(
                '{"version":"1.0.0"}', encoding="utf-8"
            )
            (root / "frontend/out/index.html").write_text(
                "http://127.0.0.1:8009", encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "test API endpoint"):
                build(root, root / "releases", tracked)


if __name__ == "__main__":
    unittest.main()
