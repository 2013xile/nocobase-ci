import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [image, edition] = process.argv.slice(2);
assert.ok(image && ['studio', 'studio-ee'].includes(edition));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim();
const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-image-smoke-'));
const name = `studio-edition-smoke-${randomBytes(6).toString('hex')}`;
const email = 'image-smoke@example.invalid';
const password = randomBytes(24).toString('hex');
try {
  await chmod(directory, 0o755);
  await writeFile(path.join(directory, 'config.yml'), JSON.stringify({
    secrets: { keys: [{ version: 1, key: randomBytes(32).toString('hex') }] },
    users: { initialAdmin: { username: 'image-smoke', email, password } },
    app: { sampleData: false, publicOrigin: 'http://localhost' },
    agents: { enabled: false },
    releases: { host: { enabled: false }, docker: { enabled: false } },
    jobs: { default: 'memory' }, queue: { default: 'memory' },
    logging: { level: 'error' },
  }), { mode: 0o644 });
  docker('run', '-d', '--name', name, '--init', '-e', 'NB_STUDIO_E2E=1', '-p', '127.0.0.1::13000',
    '--mount', `type=bind,source=${directory}/config.yml,target=/app/config.yml,readonly`, image);
  const port = docker('port', name, '13000/tcp').split(':').at(-1);
  const base = `http://127.0.0.1:${port}/main/api`;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      ready = response.ok && (await response.json()).ok === true;
      if (ready) break;
    } catch {}
    if (docker('inspect', name, '--format', '{{.State.Running}}') !== 'true') break;
    await setTimeout(2000);
  }
  assert.ok(ready, 'The built image must become healthy.');
  const login = await fetch(`${base}/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(login.status, 200, 'Administrator sign-in');
  const cookie = login.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
  for (const [endpoint, status] of [['projects', 200], ['quality/projects', edition === 'studio' ? 404 : 200], ['swagger', 200]]) {
    const response = await fetch(`${base}/${endpoint}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, status, endpoint);
    if (endpoint === 'swagger') {
      const document = await response.json();
      assert.equal(Object.keys(document.paths).some((key) => /\/quality(?:\/|$)/.test(key)), edition === 'studio-ee');
    }
  }
  const identity = JSON.parse(docker('exec', name, 'node', '--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { readFileSync } from 'node:fs';
    import Provider from '/app/dist/server/providers/edition.js';
    import { studioEditionToken } from '/app/dist/server/edition-service.js';
    const require = createRequire('/app/dist/package.json');
    const { ServiceContainer } = await import(require.resolve('@nocobase/service-provider'));
    const container = new ServiceContainer();
    new Provider({ container, paths: { root: (file) => '/app/dist/' + file } }).register();
    const info = container.resolve(studioEditionToken);
    const manifest = JSON.parse(readFileSync('/app/dist/package.json', 'utf8'));
    if (info.version !== manifest.version) throw new Error('Wrong artifact version');
    console.log(JSON.stringify(info));
  `));
  assert.equal(identity.image, edition);
  assert.equal(identity.edition, edition === 'studio' ? 'pro' : 'enterprise');
  console.log(JSON.stringify({ image, ...identity, health: true, login: true, projects: true, qualityIsolation: true }));
} catch (error) {
  try {
    const logs = docker('logs', '--tail', '80', name);
    for (const line of logs.split('\n')) {
      try { const record = JSON.parse(line); if (record.level === 'error' || record.level === 50) console.error(record.msg ?? record.message); } catch {}
    }
  } catch {}
  throw error;
} finally {
  try { docker('rm', '-f', name); } catch {}
  await rm(directory, { recursive: true, force: true });
}
