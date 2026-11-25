"""Validate the child archive without extracting or executing application code."""
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile

PACKAGE_NAME = r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*"
PACKAGE_PATH = re.compile(rf"dist/(?:vendor/|node_modules/){PACKAGE_NAME}/package\.json")
NAME = "@nocobase/multi-tenant-sub-app"

def read_manifest(files, name):
    size, body = files.get(name, (0, None))
    if not size or body is None:
        raise ValueError(f"Missing, empty or oversized package manifest: {name}")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError(f"Package manifest must be an object: {name}")
    return value


def export_targets(value, conditions):
    """Inspect runtime export declarations, never import application code."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        for condition, branch in value.items():
            if condition in conditions:
                return export_targets(branch, conditions)
        return []
    if isinstance(value, list):
        return [target for branch in value for target in export_targets(branch, conditions)]
    if value is None:
        return []
    raise ValueError("Invalid Portal export declaration")


def validate_portal_files(files, manifest_path, manifest):
    exports = manifest.get("exports")
    if not isinstance(exports, dict):
        raise ValueError(f"Missing Portal exports: {manifest_path}")
    for entry in ("./server", "./client", "./portal"):
        conditions = {"import", "default", "browser" if entry == "./client" else "node"}
        targets = export_targets(exports.get(entry), conditions)
        if not targets:
            raise ValueError(f"Missing Portal runtime export {entry}: {manifest_path}")
        for target in targets:
            relative = target.removeprefix("./")
            if (not target.startswith("./") or not relative or "\\" in relative
                    or ".." in PurePosixPath(relative).parts
                    or PurePosixPath(relative).as_posix() != relative
                    or relative.startswith("/")):
                raise ValueError(f"Unsafe Portal export: {target}")
            name = f"{PurePosixPath(manifest_path).parent}/{relative}"
            if files.get(name, (0, None))[0] == 0:
                raise ValueError(f"Missing or empty Portal runtime entry: {name}")


def validate_portals(metadata, files):
    # Match the deployment scanner: root dependencies plus file: vendor copies,
    # identified by nocobase.portal metadata, not package names or legacy portal ids.
    required = metadata.get("dependencies", {})
    optional = metadata.get("optionalDependencies", {})
    if not isinstance(required, dict) or not isinstance(optional, dict):
        raise ValueError("Invalid application dependencies")
    portals = 0
    for name, spec in {**required, **optional}.items():
        if not re.fullmatch(PACKAGE_NAME, name) or not isinstance(spec, str):
            raise ValueError("Invalid application dependency")
        candidates = [f"dist/node_modules/{name}/package.json"]
        if spec.startswith("file:"):
            location = spec[5:].removeprefix("./")
            candidate = f"dist/{location}/package.json"
            if not location.startswith("vendor/") or not PACKAGE_PATH.fullmatch(candidate):
                raise ValueError(f"Unsafe vendored dependency path: {spec}")
            candidates.append(candidate)
        present = [candidate for candidate in candidates if candidate in files]
        if not present:
            if name in optional:
                continue
            raise ValueError(f"Missing dependency manifest: {name}")
        declarations = []
        for candidate in present:
            manifest = read_manifest(files, candidate)
            nocobase = manifest.get("nocobase", {})
            if not isinstance(nocobase, dict):
                raise ValueError(f"Invalid nocobase metadata: {candidate}")
            if "portal" not in nocobase:
                declarations.append(None)
                continue
            portal = nocobase["portal"]
            if (not isinstance(portal, dict) or set(portal) != {"schemaVersion", "locales"}
                    or type(portal["schemaVersion"]) is not int or portal["schemaVersion"] != 1
                    or not isinstance(portal["locales"], dict)):
                raise ValueError(f"Invalid Portal declaration: {candidate}")
            for locale, content in portal["locales"].items():
                if (not re.fullmatch(r"[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*", locale)
                        or not isinstance(content, dict) or set(content) - {"title", "description"}
                        or any(not isinstance(text, str) for text in content.values())
                        or ("title" in content and (not content["title"].strip()
                            or "\n" in content["title"] or "\r" in content["title"]))):
                    raise ValueError(f"Invalid Portal locales: {candidate}")
            if manifest.get("name") != name:
                raise ValueError(f"Wrong Portal identity: {candidate}")
            validate_portal_files(files, candidate, manifest)
            declarations.append({"portal": portal, **{key: manifest.get(key) for key in
                                 ("name", "version", "displayName", "description")}})
        if any(declaration != declarations[0] for declaration in declarations):
            raise ValueError(f"Conflicting installed and vendored Portal declarations: {name}")
        if declarations[0] is not None:
            portals += 1
    return portals


def validate_archive(source_root):
    if Path(source_root).is_symlink():
        raise ValueError("Source root must not be a symlink")
    root = Path(source_root).resolve(strict=True)
    archive = root / "storage/exports/dist.tar.gz"
    for entry in (root / "storage", root / "storage/exports", archive):
        if entry.is_symlink():
            raise ValueError("Archive path must not contain symlinks")
    if not stat.S_ISREG(archive.lstat().st_mode):
        raise ValueError("Archive must be a regular file")
    if not archive.resolve(strict=True).is_relative_to(root):
        raise ValueError("Archive escapes the application directory")
    source = json.loads((root / "package.json").read_text())
    required = {"dist/package.json", "dist/server/standalone.js", "dist/cli/index.js",
                "dist/client/index.html", "dist/variables.json", "config.example.yml",
                "Dockerfile", "Dockerfile.dockerignore"}
    seen = set()
    regular = {}
    files = {}
    with gzip.open(archive, "rb") as stream:
        with tarfile.open(fileobj=stream, mode="r|") as bundle:
            for member in bundle:
                name = member.name.removeprefix("./").rstrip("/")
                parts = PurePosixPath(name).parts
                if not name or name.startswith("/") or "\\" in name or ".." in parts or PurePosixPath(name).as_posix() != name:
                    raise ValueError("Unsafe or noncanonical archive path")
                if name in seen or not (member.isfile() or member.isdir() or member.islnk()):
                    raise ValueError("Duplicate entry, symlink or special file in archive")
                if (member.isdir() or member.islnk()) and member.size != 0:
                    raise ValueError("Unexpected directory or hardlink payload")
                seen.add(name)
                if name not in {"Dockerfile", "Dockerfile.dockerignore", "config.example.yml", "dist"} and not name.startswith("dist/"):
                    raise ValueError("Unexpected archive root")
                if len(parts) > 1 and parts[0] == "dist" and (parts[1].startswith(".env") or parts[1] in {"config.yml", "config.yaml", "storage"}):
                    raise ValueError("Runtime state in archive")
                size = member.size
                manifest = None
                if member.islnk():
                    # pnpm's hoisted production install can share inodes. Permit only a
                    # direct link to an earlier regular dist file, never a link chain.
                    target = member.linkname
                    if not target.startswith("dist/") or PurePosixPath(target).as_posix() != target or ".." in PurePosixPath(target).parts or "\\" in target or target not in regular:
                        raise ValueError("Unsafe, unresolved or chained hardlink")
                    size, manifest = regular[target]
                elif member.isfile():
                    if name.endswith("/package.json") and member.size <= 1024 * 1024:
                        manifest = bundle.extractfile(member).read()
                    regular[name] = (size, manifest)
                if name in required:
                    if not (member.isfile() or member.islnk()) or size == 0:
                        raise ValueError("Required archive entry must be a nonempty file")
                    required.remove(name)
                if member.isfile() or member.islnk():
                    files[name] = (size, manifest)
        # Read through gzip's trailer, detecting truncation and CRC failures too.
        while stream.read(1024 * 1024):
            pass
    if required:
        raise ValueError("Required application files are missing")
    metadata = read_manifest(files, "dist/package.json")
    target = metadata.get("nocobase", {}).get("buildTarget", {})
    if source.get("name") != NAME or metadata.get("name") != NAME or metadata.get("version") != source.get("version"):
        raise ValueError("Wrong child archive name or version")
    if metadata.get("nocobase", {}).get("finderTenantProtocol") != 1:
        raise ValueError("Wrong tenant protocol")
    if any(target.get(key) != value for key, value in {"platform": "linux", "arch": "x64", "libc": "glibc", "nodeMajor": 24}.items()):
        raise ValueError("Wrong Linux x64 / glibc / Node 24 target")
    if metadata.get("nocobase", {}).get("relocatable") is not True:
        raise ValueError("Archive must be relocatable")
    portals = validate_portals(metadata, files)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"name": NAME, "version": metadata["version"], "target": {key: target[key] for key in ("platform", "arch", "libc", "nodeMajor")},
            "entries": len(seen), "bytes": archive.stat().st_size, "sha256": digest, "portals": portals}

if __name__ == "__main__":
    try:
        print(json.dumps(validate_archive(sys.argv[1]), sort_keys=True))
    except Exception as error:
        print(f"::error::Child archive validation failed: {error}", file=sys.stderr)
        sys.exit(1)
