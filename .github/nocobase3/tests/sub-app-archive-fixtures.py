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
        self.portal_name = "@customer/meeting-room"
        self.portal_prefix = self.add_portal(self.portal_name)

    def add_portal(self, name, installed=False):
        prefix = f"dist/{'node_modules' if installed else 'vendor'}/{name}"
        self.meta.setdefault("dependencies", {})[name] = "1.0.0" if installed else f"file:./vendor/{name}"
        manifest = {"name": name, "version": "1.0.0", "nocobase": {
            "portal": {"schemaVersion": 1, "locales": {"en-US": {"title": "Meeting"}}}},
            "exports": {entry: {"types": f"./lib/{file}.d.ts", "import": f"./lib/{file}.js"}
                        for entry, file in [("./server", "backend"), ("./client", "frontend"), ("./portal", "portal")]}}
        self.files[f"{prefix}/package.json"] = json.dumps(manifest).encode()
        for file in ["backend", "frontend", "portal"]:
            self.files[f"{prefix}/lib/{file}.js"] = b"throw new Error('must not execute');"
        return prefix

    def update_portal(self, transform):
        key = f"{self.portal_prefix}/package.json"
        manifest = json.loads(self.files[key])
        transform(manifest)
        self.files[key] = json.dumps(manifest).encode()

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
        self.assertEqual(result["portals"], 1)
        self.assertEqual(result["version"], "0.2.3")
        self.assertEqual(len(result["sha256"]), 64)

    def test_accepts_zero_portals_and_ignores_unreferenced_packages(self):
        self.meta["dependencies"] = {}
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 0)
        self.files = {name: body for name, body in self.files.items() if not name.startswith("dist/vendor/")}
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 0)

    def test_counts_declared_packages_not_names_or_legacy_ids(self):
        self.add_portal("@nocobase/app-portal-equipment")
        self.add_portal("custom-dashboard", installed=True)
        self.meta["nocobase"]["portals"] = [{"key": "not-a-package"}]
        self.meta["dependencies"]["@nocobase/app-portal-kit"] = "1.0.0"
        self.files["dist/node_modules/@nocobase/app-portal-kit/package.json"] = b'{"name":"@nocobase/app-portal-kit"}'
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 3)

    def test_accepts_equipment_as_only_portal(self):
        self.meta["dependencies"] = {}
        self.files = {name: body for name, body in self.files.items() if not name.startswith("dist/vendor/")}
        self.add_portal("@nocobase/app-portal-equipment")
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 1)

    def test_validates_portal_hardlinks(self):
        key = f"{self.portal_prefix}/lib/backend.js"
        del self.files[key]
        link = tarfile.TarInfo(key)
        link.type = tarfile.LNKTYPE
        link.linkname = f"{self.portal_prefix}/lib/frontend.js"
        self.pack(link)
        self.assertEqual(validator.validate_archive(self.root)["portals"], 1)
        installed = f"dist/node_modules/{self.portal_name}/package.json"
        link.name = installed
        link.linkname = f"{self.portal_prefix}/package.json"
        self.files[key] = b"fixture"
        for file in ["backend", "frontend", "portal"]:
            self.files[f"dist/node_modules/{self.portal_name}/lib/{file}.js"] = b"fixture"
        self.pack(link)
        self.assertEqual(validator.validate_archive(self.root)["portals"], 1)

    def test_rejects_missing_empty_and_oversized_manifests(self):
        key = f"{self.portal_prefix}/package.json"
        for body in [None, b"", b" " * (1024 * 1024 + 1), b"[]", b"invalid"]:
            with self.subTest(body_size=len(body) if body is not None else None):
                self.files.pop(key, None)
                if body is not None:
                    self.files[key] = body
                self.pack()
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)

    def test_rejects_malformed_portal_declarations(self):
        for portal in [None, [], {}, {"schemaVersion": 2, "locales": {}},
                       {"schemaVersion": True, "locales": {}},
                       {"schemaVersion": 1, "locales": []},
                       {"schemaVersion": 1, "locales": {"en-US": {"title": " "}}}]:
            with self.subTest(portal=portal):
                self.update_portal(lambda manifest: manifest.update(nocobase={"portal": portal}))
                self.pack()
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)

    def test_rejects_conflicting_installed_and_vendor_declarations(self):
        key = f"dist/node_modules/{self.portal_name}/package.json"
        self.files[key] = json.dumps({"name": self.portal_name}).encode()
        self.pack()
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            validator.validate_archive(self.root)

    def test_rejects_bad_dependency_paths_and_types(self):
        for name, spec in [("../escape", "1.0.0"), (self.portal_name, None),
                           (self.portal_name, "file:/host"), (self.portal_name, "file:../host"),
                           (self.portal_name, "file:vendor/../../host")]:
            with self.subTest(name=name, spec=spec):
                self.meta["dependencies"] = {name: spec}
                self.pack()
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)

    def test_validates_optional_dependencies_when_present(self):
        self.meta["optionalDependencies"] = {"optional-native-addon": "1.0.0"}
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 1)
        prefix = self.add_portal("@customer/optional", installed=True)
        self.meta["optionalDependencies"]["@customer/optional"] = self.meta["dependencies"].pop("@customer/optional")
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 2)
        del self.files[f"{prefix}/lib/portal.js"]
        self.pack()
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)

    def test_uses_production_exports_without_requiring_development_or_types(self):
        self.update_portal(lambda manifest: manifest["exports"].update({
            "./server": {"types": "./src/server.d.ts", "development": "./src/server.ts",
                         "node": {"import": "./lib/backend.js"}},
            "./client": {"browser": "./lib/frontend.js", "default": "./not-used.js"},
            "./portal": {"import": "./lib/portal.js", "require": "./not-used.cjs"}}))
        self.pack()
        self.assertEqual(validator.validate_archive(self.root)["portals"], 1)

    def test_rejects_directory_in_place_of_portal_entry(self):
        key = f"{self.portal_prefix}/lib/portal.js"
        del self.files[key]
        directory = tarfile.TarInfo(key)
        directory.type = tarfile.DIRTYPE
        self.pack(directory)
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)

    def test_rejects_missing_empty_or_unsafe_exports(self):
        for target in [None, {}, {"types": "./lib/portal.d.ts"}, "./missing.js", "./../escape", "/absolute", "./lib//portal.js", "./lib\\portal.js"]:
            with self.subTest(target=target):
                self.update_portal(lambda manifest: manifest["exports"].update({"./portal": target}))
                self.pack()
                with self.assertRaises(ValueError):
                    validator.validate_archive(self.root)
        self.update_portal(lambda manifest: manifest["exports"].update({"./portal": "./lib/portal.js"}))
        self.files[f"{self.portal_prefix}/lib/portal.js"] = b""
        self.pack()
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)

    def test_accepts_only_safe_prior_regular_hardlinks(self):
        self.files["dist/shared"] = b"shared inode fixture"
        link = tarfile.TarInfo("dist/link")
        link.type = tarfile.LNKTYPE
        link.linkname = "dist/shared"
        self.pack(link)
        self.assertEqual(validator.validate_archive(self.root)["portals"], 1)
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
        key = f"{self.portal_prefix}/lib/backend.js"
        del self.files[key]
        self.pack()
        with self.assertRaises(ValueError):
            validator.validate_archive(self.root)
        self.files[key] = b"fixture"
        self.update_portal(lambda manifest: manifest.update(name="wrong"))
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
