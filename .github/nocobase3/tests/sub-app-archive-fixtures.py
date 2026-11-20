import gzip
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("validator", Path(__file__).parents[1] / "validate-sub-app-archive.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "app"
        (self.root / "storage/exports").mkdir(parents=True)
        self.archive = self.root / "storage/exports/dist.tar.gz"
        self.meta = {"name": validator.NAME, "version": "0.2.3", "nocobase": {
            "finderTenantProtocol": 1, "relocatable": True,
            "buildTarget": {"platform": "linux", "arch": "x64", "libc": "glibc", "nodeMajor": 24}}}
        (self.root / "package.json").write_text(json.dumps(self.meta))
        self.files = {path: b"fixture" for path in ["dist/server/standalone.js", "dist/cli/index.js",
                      "dist/client/index.html", "dist/variables.json", "config.example.yml",
                      "Dockerfile", "Dockerfile.dockerignore"]}
        for portal in validator.PORTALS:
            prefix = f"dist/vendor/@nocobase/app-portal-{portal}"
            self.files[f"{prefix}/package.json"] = json.dumps({"name": f"@nocobase/app-portal-{portal}"}).encode()
            for rel in ["dist/server/index.js", "dist/client/index.js", "dist/portal.js"]:
                self.files[f"{prefix}/{rel}"] = b"fixture"

    def pack(self, extra=None):
        files = {**self.files, "dist/package.json": json.dumps(self.meta).encode()}
        with tarfile.open(self.archive, "w:gz") as bundle:
            for path, body in files.items():
                entry = tarfile.TarInfo(path)
                entry.size = len(body)
                bundle.addfile(entry, io.BytesIO(body))
            if extra is not None:
                bundle.addfile(extra)

    def test_complete(self):
        self.pack()
        result = validator.validate_archive(self.root)
        self.assertEqual(result["portals"], 3)
        self.assertEqual(result["version"], "0.2.3")
        self.assertEqual(len(result["sha256"]), 64)

    def test_accepts_only_safe_prior_regular_hardlinks(self):
        self.files["dist/shared"] = b"shared inode fixture"
        link = tarfile.TarInfo("dist/link")
        link.type = tarfile.LNKTYPE
        link.linkname = "dist/shared"
        self.pack(link)
        self.assertEqual(validator.validate_archive(self.root)["portals"], 3)
        for target in ["dist/link", "Dockerfile", "dist/missing", "../escape", "/host-secret", "dist/./shared"]:
            with self.subTest(target=target):
                link.linkname = target
                self.pack(link)
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)

    def test_rejects_bad_metadata(self):
        for key, value in [("name", "@nocobase/multi-tenant-platform-app"), ("version", "9.0.0")]:
            with self.subTest(key=key):
                old = self.meta[key]
                self.meta[key] = value
                self.pack()
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)
                self.meta[key] = old
        for key, value in [("platform", "darwin"), ("arch", "arm64"), ("libc", "musl"), ("nodeMajor", 22)]:
            with self.subTest(key=key):
                target = self.meta["nocobase"]["buildTarget"]
                old = target[key]
                target[key] = value
                self.pack()
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)
                target[key] = old

    def test_rejects_missing_portal_and_wrong_portal_identity(self):
        key = "dist/vendor/@nocobase/app-portal-devices/dist/server/index.js"
        del self.files[key]
        self.pack()
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)
        self.files[key] = b"fixture"
        self.files["dist/vendor/@nocobase/app-portal-devices/package.json"] = b'{"name":"wrong"}'
        self.pack()
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)

    def test_paths_links_specials_duplicates_and_runtime_state(self):
        for name in ["dist/./client/index.html", "dist//client/index.html", "../escape", "/absolute", "dist/../../escape", "dist\\escape", "dist/.env", "dist/config.yml", "dist/storage/db"]:
            with self.subTest(path=name):
                self.pack(tarfile.TarInfo(name))
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind):
                link = tarfile.TarInfo("dist/link")
                link.type = kind
                link.linkname = "/host-secret"
                self.pack(link)
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)
        self.pack(tarfile.TarInfo("dist/client/index.html"))
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)

    def test_rejects_path_symlinks_and_truncation(self):
        self.pack()
        raw = self.archive.read_bytes()
        self.archive.unlink()
        outside = Path(self.temp.name) / "outside"
        outside.write_bytes(raw)
        self.archive.symlink_to(outside)
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)
        self.archive.unlink()
        self.archive.write_bytes(raw[:-12])
        with self.assertRaises((ValueError, EOFError, gzip.BadGzipFile, tarfile.TarError)):
            validator.validate_archive(self.root)

if __name__ == "__main__":
    unittest.main()
