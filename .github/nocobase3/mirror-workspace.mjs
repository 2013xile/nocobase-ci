// Mirrors a framework's pnpm-workspace.yaml into the application workspace that vendors it: the application keeps its
// own top of the file through its `packages:` list, and everything after that list is the framework's, because pnpm
// reads the catalog, overrides and build settings only from the workspace root. Studio keeps the two in step by hand
// (its AGENTS.md); a Studio preview of a nocobase3 pull request has to do it for the pull request's framework.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

function split(text, name) {
  const lines = text.split('\n');
  const start = lines.indexOf('packages:');
  if (start === -1) throw new Error(`${name} has no top-level packages: list.`);
  let end = start + 1;
  while (end < lines.length && /^\s+- /u.test(lines[end])) end += 1;
  return { head: lines.slice(0, end), rest: lines.slice(end) };
}

export function mirrorWorkspace(application, framework) {
  return [
    ...split(application, 'The application workspace').head,
    ...split(framework, 'The framework workspace').rest,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [applicationPath, frameworkPath] = process.argv.slice(2);
  writeFileSync(
    applicationPath,
    mirrorWorkspace(readFileSync(applicationPath, 'utf8'), readFileSync(frameworkPath, 'utf8')),
  );
}
