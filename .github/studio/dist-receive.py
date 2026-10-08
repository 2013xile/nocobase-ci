#!/usr/bin/env python3
"""Receives Studio's standalone tarballs from the `Dist` job of studio-ci.yml.

Installed on the Studio server as /usr/local/sbin/studio-dist-receive and run as the forced command of one SSH key
(`restrict,command="/usr/local/sbin/studio-dist-receive"` in root's authorized_keys), so that key can do nothing but
this. It reads a gzipped tar of `stable/<product>/...` (the layout `pnpm nocobase cli build --out` writes) from stdin,
accepts only regular files and directories of the two products, and merges it into Studio's runner dist directory the
way `cli build` merges into its own output: each delivered version directory replaces the one of the same version, and
the product's manifest keeps its other versions. Everything ends up owned by 1000:1000, the user Studio runs as.
"""
import fcntl
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile

DIST = os.environ.get('STUDIO_DIST_DIR', '/root/deploy/docker/studio/storage/runners/dist')
# Holds the lock and the incoming archive; on the same filesystem as DIST, outside what Studio serves.
WORK = os.environ.get('STUDIO_DIST_WORK_DIR', '/root/deploy/docker/studio')
OWNER = (1000, 1000)
PRODUCTS = ('nb-studio', 'nocobase-runner')
CHANNEL = 'stable'
MAX_BYTES = 2 * 1024 ** 3
SEGMENT = r'[0-9A-Za-z][0-9A-Za-z._+-]{0,127}'
MEMBER = re.compile(
    rf'^{CHANNEL}(/({"|".join(map(re.escape, PRODUCTS))})(/manifest\.json|/{SEGMENT}(/{SEGMENT}\.tar\.gz)?)?)?/?$'
)


def fail(message):
    print(f'studio-dist-receive: {message}', file=sys.stderr)
    sys.exit(1)


def chown_tree(path):
    os.chown(path, *OWNER)
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            os.chown(os.path.join(root, name), *OWNER, follow_symlinks=False)


def receive(archive, staging):
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = member.name[2:] if member.name.startswith('./') else member.name
            if name in ('', '.'):
                continue
            if not MEMBER.match(name) or '..' in name.split('/'):
                fail(f'unexpected entry {member.name!r}')
            target = os.path.join(staging, name.rstrip('/'))
            if member.isdir():
                os.makedirs(target, exist_ok=True)
            elif member.isfile():
                if not (name.endswith('.tar.gz') or name.endswith('/manifest.json')):
                    fail(f'unexpected file {member.name!r}')
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with tar.extractfile(member) as source, open(target, 'xb') as sink:
                    shutil.copyfileobj(source, sink)
            else:
                fail(f'{member.name!r} is not a regular file or directory')


def merge(staging):
    delivered = []
    for product in PRODUCTS:
        source = os.path.join(staging, CHANNEL, product)
        if not os.path.isdir(source):
            continue
        with open(os.path.join(source, 'manifest.json'), encoding='utf-8') as file:
            manifest = json.load(file)
        if manifest.get('product') != product or not isinstance(manifest.get('versions'), dict):
            fail(f'{product}/manifest.json does not describe {product}')
        for version, entry in manifest['versions'].items():
            if not re.fullmatch(SEGMENT, version):
                fail(f'{product} has an invalid version {version!r}')
            for target in entry.get('targets', {}).values():
                if not os.path.isfile(os.path.join(source, target['file'])) or not target['file'].startswith(f'{version}/'):
                    fail(f'{product} {version} lists {target["file"]!r}, which was not delivered')

        destination = os.path.join(DIST, CHANNEL, product)
        os.makedirs(destination, exist_ok=True)
        stored = {'versions': {}}
        stored_path = os.path.join(destination, 'manifest.json')
        if os.path.isfile(stored_path):
            with open(stored_path, encoding='utf-8') as file:
                previous = json.load(file)
            if previous.get('product') == product and isinstance(previous.get('versions'), dict):
                stored = previous

        for version in manifest['versions']:
            new = os.path.join(source, version)
            old = os.path.join(destination, version)
            retired = None
            if os.path.exists(old):
                retired = tempfile.mkdtemp(prefix=f'.{version}.old-', dir=destination)
                os.rename(old, os.path.join(retired, version))
            os.rename(new, old)
            if retired:
                shutil.rmtree(retired)

        merged = {**stored, **{k: v for k, v in manifest.items() if k != 'versions'}}
        merged['versions'] = {**stored['versions'], **manifest['versions']}
        handle, temporary = tempfile.mkstemp(prefix='.manifest-', dir=destination)
        with os.fdopen(handle, 'w', encoding='utf-8') as file:
            json.dump(merged, file, indent=2)
            file.write('\n')
        os.chmod(temporary, 0o644)
        os.rename(temporary, stored_path)
        delivered.append(f'{product} {", ".join(manifest["versions"])}')
    if not delivered:
        fail('the archive holds no product')
    return delivered


def main():
    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(WORK, '.dist-receive.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        work = tempfile.mkdtemp(prefix='.dist-incoming-', dir=WORK)
        try:
            archive = os.path.join(work, 'dist.tar.gz')
            size = 0
            with open(archive, 'wb') as sink:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        fail('the archive is larger than 2 GiB')
                    sink.write(chunk)
            staging = os.path.join(work, 'staging')
            os.makedirs(staging)
            try:
                receive(archive, staging)
                delivered = merge(staging)
            except (tarfile.TarError, OSError, ValueError, KeyError, TypeError) as error:
                fail(f'the archive was refused: {error}')
            if os.geteuid() == 0:
                chown_tree(DIST)
            for line in delivered:
                print(f'Delivered {line}')
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
