import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageArchive } from '../stage-sub-app-archive.mjs';

test('stages a regular archive outside the source without executing or extracting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sub-app-stage-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(join(source, 'storage/exports'), { recursive: true });
    writeFileSync(join(source, 'storage/exports/dist.tar.gz'), 'fake archive bytes');
    const destination = join(dir, 'trusted/dist.tar.gz');
    stageArchive(source, destination);
    assert.equal(readFileSync(destination, 'utf8'), 'fake archive bytes');
    assert.throws(() => stageArchive(source, join(source, 'output.tar.gz')), /outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses top-level links and parent-directory links that escape to a host credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sub-app-stage-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(join(source, 'storage/exports'), { recursive: true });
    const secret = join(dir, 'host-secret');
    writeFileSync(secret, 'must not upload');
    const archive = join(source, 'storage/exports/dist.tar.gz');
    symlinkSync(secret, archive);
    assert.throws(() => stageArchive(source, join(dir, 'staged.tar.gz')), /regular file/);
    rmSync(join(source, 'storage'), { recursive: true });
    const outside = join(dir, 'outside');
    mkdirSync(join(outside, 'exports'), { recursive: true });
    writeFileSync(join(outside, 'exports/dist.tar.gz'), 'must not upload');
    symlinkSync(outside, join(source, 'storage'));
    assert.throws(() => stageArchive(source, join(dir, 'staged.tar.gz')), /must not contain a symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
