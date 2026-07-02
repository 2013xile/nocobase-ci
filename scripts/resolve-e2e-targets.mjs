#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_E2E_REFS = new Set(['main', 'next', 'develop']);

function usage() {
  console.error(`Usage:
  node scripts/resolve-e2e-targets.mjs \\
    --branch <branch> \\
    --repository <repository> \\
    [--nocobase-pr-number <number>] \\
    [--pro-plugin <name>] \\
    [--pro-pr-number <number>] \\
    [--github-token <token>] \\
    [--output <file>] \\
    [--github-output <file>]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--')) {
      usage();
      process.exit(2);
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeRepoName(repo) {
  return clean(repo).replace(/^nocobase\//, '');
}

function deriveRepository(args) {
  const repository = normalizeRepoName(args.repository);
  if (repository) {
    return repository;
  }

  const proPlugin = clean(args['pro-plugin']);
  if (!proPlugin) {
    return 'nocobase';
  }

  if (proPlugin === 'pro-plugins') {
    return 'pro-plugins';
  }

  return proPlugin.startsWith('plugin-') ? proPlugin : `plugin-${proPlugin}`;
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nocobase-e2e-target-resolver',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function githubJson(url, token) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API failed: ${response.status} ${response.statusText} ${url}\n${body}`);
  }
  return response.json();
}

function repoApiPath(fullName) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

async function listPullRequestFiles(fullName, prNumber, token) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const url = `https://api.github.com/repos/${repoApiPath(fullName)}/pulls/${encodeURIComponent(prNumber)}/files?per_page=100&page=${page}`;
    const batch = await githubJson(url, token);
    files.push(...batch.map((file) => file.filename));
    if (batch.length < 100) {
      return files;
    }
  }
}

async function listLatestCommitFiles(fullName, branch, token) {
  const url = `https://api.github.com/repos/${repoApiPath(fullName)}/commits/${encodeURIComponent(branch)}`;
  const commit = await githubJson(url, token);
  return (commit.files || []).map((file) => file.filename);
}

function deriveSources(args) {
  const branch = clean(args.branch);
  const repository = deriveRepository(args);
  const nocobasePrNumber = clean(args['nocobase-pr-number']);
  const proPrNumber = clean(args['pro-pr-number']);

  if (!branch) {
    throw new Error('branch is required');
  }

  const sources = [];

  if (repository === 'nocobase') {
    sources.push({
      sourceRepo: 'nocobase',
      sourceFullName: 'nocobase/nocobase',
      triggerType: nocobasePrNumber ? 'main-repo-pr' : 'main-repo-branch',
      prNumber: nocobasePrNumber,
      branch,
    });
    return sources;
  }

  sources.push({
    sourceRepo: repository,
    sourceFullName: `nocobase/${repository}`,
    triggerType: proPrNumber ? 'plugin-repo-pr' : 'plugin-repo-branch',
    prNumber: proPrNumber,
    branch,
  });

  if (nocobasePrNumber) {
    sources.push({
      sourceRepo: 'nocobase',
      sourceFullName: 'nocobase/nocobase',
      triggerType: 'main-repo-pr',
      prNumber: nocobasePrNumber,
      branch,
    });
  }

  return sources;
}

async function collectChangedFiles(source, token) {
  const files = source.prNumber
    ? await listPullRequestFiles(source.sourceFullName, source.prNumber, token)
    : await listLatestCommitFiles(source.sourceFullName, source.branch, token);

  return {
    ...source,
    files,
  };
}

function isIgnoredFile(file) {
  return (
    file === '.gitignore' ||
    file === '.ignore' ||
    file === '.node-version' ||
    file === 'README.md' ||
    file.startsWith('.github/') ||
    file.startsWith('docs/') ||
    file.endsWith('.md')
  );
}

function createResolution() {
  return {
    all: false,
    targets: new Set(),
    matched: [],
    ignored: [],
  };
}

function addTarget(result, source, file, target, rule) {
  result.targets.add(target);
  result.matched.push({
    sourceRepo: source.sourceRepo,
    triggerType: source.triggerType,
    file,
    target,
    rule,
  });
}

function addAll(result, source, file, rule) {
  result.all = true;
  result.matched.push({
    sourceRepo: source.sourceRepo,
    triggerType: source.triggerType,
    file,
    target: '*',
    rule,
  });
}

function ignoreFile(result, source, file, reason) {
  result.ignored.push({
    sourceRepo: source.sourceRepo,
    triggerType: source.triggerType,
    file,
    reason,
  });
}

function resolveNocobaseFile(result, source, file) {
  if (isIgnoredFile(file)) {
    ignoreFile(result, source, file, 'ignored-doc-or-config');
    return;
  }

  const pluginMatch = file.match(/^packages\/plugins\/@nocobase\/([^/]+)\//);
  if (pluginMatch) {
    addTarget(result, source, file, pluginMatch[1], 'main-repo-plugin-path');
    return;
  }

  addAll(result, source, file, 'main-repo-runtime-or-shared-change');
}

function resolveProPluginsFile(result, source, file) {
  if (isIgnoredFile(file)) {
    ignoreFile(result, source, file, 'ignored-doc-or-config');
    return;
  }

  const scopedPluginMatch = file.match(/^@nocobase\/([^/]+)\//);
  if (scopedPluginMatch) {
    addTarget(result, source, file, scopedPluginMatch[1], 'pro-plugins-scoped-plugin-path');
    return;
  }

  const packageMatch = file.match(/^([^/.][^/]+)\//);
  if (packageMatch) {
    addTarget(result, source, file, packageMatch[1], 'pro-plugins-package-path');
    return;
  }

  addAll(result, source, file, 'pro-plugins-root-or-shared-change');
}

function resolveStandalonePluginFile(result, source, file) {
  if (isIgnoredFile(file)) {
    ignoreFile(result, source, file, 'ignored-doc-or-config');
    return;
  }

  addTarget(result, source, file, source.sourceRepo, 'standalone-plugin-repo-change');
}

function resolveSourceFiles(result, source) {
  for (const file of source.files) {
    if (source.sourceRepo === 'nocobase') {
      resolveNocobaseFile(result, source, file);
    } else if (source.sourceRepo === 'pro-plugins') {
      resolveProPluginsFile(result, source, file);
    } else {
      resolveStandalonePluginFile(result, source, file);
    }
  }
}

function writeGithubOutput(file, outputs) {
  if (!file) {
    return;
  }

  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    if (Array.isArray(value)) {
      lines.push(`${key}<<EOF`);
      lines.push(...value);
      lines.push('EOF');
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

try {
  const args = parseArgs(process.argv);
  const branch = clean(args.branch);
  const token = clean(args['github-token']) || clean(process.env.GITHUB_TOKEN);
  const outputFile = args.output ? path.resolve(args.output) : '';
  const githubOutputFile = args['github-output'] ? path.resolve(args['github-output']) : '';
  const e2eRefSupported = SUPPORTED_E2E_REFS.has(branch);
  const sources = deriveSources(args);
  const sourcesWithFiles = [];
  const resolution = createResolution();

  for (const source of sources) {
    const sourceWithFiles = await collectChangedFiles(source, token);
    sourcesWithFiles.push(sourceWithFiles);
    resolveSourceFiles(resolution, sourceWithFiles);
  }

  const targets = [...resolution.targets].sort();
  const mode = resolution.all ? 'all' : targets.length > 0 ? 'packages' : 'none';
  const targetInput = resolution.all ? '*' : targets.join(',');
  const shouldRun = e2eRefSupported && Boolean(targetInput);
  const skippedReason = !e2eRefSupported
    ? 'unsupported-e2e-ref'
    : targetInput
      ? ''
      : 'no-e2e-targets';
  const changedFileCount = sourcesWithFiles.reduce((count, source) => count + source.files.length, 0);
  const summary = {
    branch,
    e2eRef: branch,
    e2eRefSupported,
    mode,
    shouldRun,
    skippedReason,
    targetInput,
    targets,
    changedFileCount,
    sources: sourcesWithFiles.map((source) => ({
      sourceRepo: source.sourceRepo,
      sourceFullName: source.sourceFullName,
      triggerType: source.triggerType,
      prNumber: source.prNumber,
      changedFileCount: source.files.length,
    })),
    matched: resolution.matched,
    ignored: resolution.ignored,
  };

  if (outputFile) {
    fs.writeFileSync(outputFile, `${JSON.stringify(summary, null, 2)}\n`);
  }

  writeGithubOutput(githubOutputFile, {
    mode,
    should_run: String(shouldRun),
    skipped_reason: skippedReason,
    target_input: targetInput,
    e2e_ref: branch,
    e2e_ref_supported: String(e2eRefSupported),
    targets,
    changed_file_count: String(changedFileCount),
  });

  console.log(`E2E ref: ${branch}`);
  console.log(`E2E ref supported: ${e2eRefSupported}`);
  console.log(`Changed files: ${changedFileCount}`);
  console.log(`Mode: ${mode}`);
  console.log(`Target input: ${targetInput || '<none>'}`);
  if (skippedReason) {
    console.log(`Skipped reason: ${skippedReason}`);
  }
  for (const source of summary.sources) {
    console.log(`Source: ${source.sourceFullName} (${source.triggerType}), changed files: ${source.changedFileCount}`);
  }
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
