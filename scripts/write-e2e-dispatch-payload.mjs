#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/write-e2e-dispatch-payload.mjs \\
    [--summary <file> | --resolver-error-log <file>] \\
    --payload-output <file> \\
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

function env(name) {
  return process.env[name] || '';
}

function basePayload(eventType) {
  return {
    event_type: eventType,
    dispatch_id: env('DISPATCH_ID'),
    caller: {
      repo: env('CALLER_REPO'),
      run_id: env('CALLER_RUN_ID'),
      sha: env('CALLER_SHA'),
    },
  };
}

function payloadFromSummary(summaryFile) {
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const eventType = summary.shouldRun ? 'test' : 'skipped';

  return {
    ...basePayload(eventType),
    resolver: {
      mode: summary.mode,
      target_input: summary.targetInput,
      skipped_reason: summary.skippedReason,
      reason_text: summary.skipReasonText,
      rule_scope: summary.skipRuleScope,
      changed_file_count: summary.changedFileCount,
      sources: summary.sources,
    },
  };
}

function payloadFromResolverError(logFile) {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim() : '';
  return {
    ...basePayload('resolver_failed'),
    resolver: {
      error: log || 'E2E target resolver failed without output.',
    },
  };
}

function writeGithubOutput(file, outputs) {
  if (!file) {
    return;
  }

  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    if (String(value).includes('\n')) {
      lines.push(`${key}<<EOF`);
      lines.push(value);
      lines.push('EOF');
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

try {
  const args = parseArgs(process.argv);
  const payloadOutput = args['payload-output'] ? path.resolve(args['payload-output']) : '';
  if (!payloadOutput) {
    throw new Error('--payload-output is required');
  }

  const payload = args.summary
    ? payloadFromSummary(path.resolve(args.summary))
    : payloadFromResolverError(path.resolve(args['resolver-error-log'] || ''));

  const payloadJson = JSON.stringify(payload);
  fs.writeFileSync(payloadOutput, `${payloadJson}\n`);

  const outputs = {
    dispatch_payload: payloadJson,
  };
  if (payload.event_type === 'resolver_failed') {
    outputs.should_run = 'false';
    outputs.skipped_reason = 'resolver-failed';
    outputs.e2e_ref = env('E2E_REF');
  }
  writeGithubOutput(args['github-output'] ? path.resolve(args['github-output']) : '', outputs);

  console.log(`Dispatch payload event type: ${payload.event_type}`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
