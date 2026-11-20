"""Validate the child archive without extracting or executing application code."""
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile

PORTALS = ("devices", "inspections", "reagents")
NAME = "@nocobase/multi-tenant-sub-app"

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
    portal_manifests = {}
    for portal in PORTALS:
        prefix = f"dist/vendor/@nocobase/app-portal-{portal}"
        required.update({f"{prefix}/package.json", f"{prefix}/dist/server/index.js",
                         f"{prefix}/dist/client/index.js", f"{prefix}/dist/portal.js"})
        portal_manifests[f"{prefix}/package.json"] = f"@nocobase/app-portal-{portal}"
    seen = set()
    regular = {}
    metadata = {}
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
                if name == "dist/package.json" or name in portal_manifests:
                    if manifest is None:
                        raise ValueError("Oversized or unavailable manifest")
                    value = json.loads(manifest)
                    if name == "dist/package.json":
                        metadata = value
                    elif value.get("name") != portal_manifests[name]:
                        raise ValueError("Wrong Portal identity")
        # Read through gzip's trailer, detecting truncation and CRC failures too.
        while stream.read(1024 * 1024):
            pass
    if required:
        raise ValueError("Required application or Portal files are missing")
    target = metadata.get("nocobase", {}).get("buildTarget", {})
    if source.get("name") != NAME or metadata.get("name") != NAME or metadata.get("version") != source.get("version"):
        raise ValueError("Wrong child archive name or version")
    if metadata.get("nocobase", {}).get("finderTenantProtocol") != 1:
        raise ValueError("Wrong tenant protocol")
    if any(target.get(key) != value for key, value in {"platform": "linux", "arch": "x64", "libc": "glibc", "nodeMajor": 24}.items()):
        raise ValueError("Wrong Linux x64 / glibc / Node 24 target")
    if metadata.get("nocobase", {}).get("relocatable") is not True:
        raise ValueError("Archive must be relocatable")
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"name": NAME, "version": metadata["version"], "target": {key: target[key] for key in ("platform", "arch", "libc", "nodeMajor")},
            "entries": len(seen), "bytes": archive.stat().st_size, "sha256": digest, "portals": 3}

if __name__ == "__main__":
    try:
        print(json.dumps(validate_archive(sys.argv[1]), sort_keys=True))
    except Exception as error:
        print(f"::error::Child archive validation failed: {error}", file=sys.stderr)
        sys.exit(1)
