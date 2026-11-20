import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Stage the completed archive outside the application directory. Never follow an escape link. */
export function stageArchive(sourceRoot, destination) {
  for (const entry of [sourceRoot, resolve(sourceRoot, 'storage'), resolve(sourceRoot, 'storage/exports')]) {
    if (lstatSync(entry).isSymbolicLink()) throw new Error('The archive path must not contain a symlink.');
  }
  const root = realpathSync(sourceRoot);
  const path = resolve(root, 'storage/exports/dist.tar.gz');
  if (!lstatSync(path).isFile()) throw new Error('The deployment archive must be a regular file, not a symlink.');
  const archive = realpathSync(path);
  const within = relative(root, archive);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) {
    throw new Error('The deployment archive escapes the application directory.');
  }
  mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  const target = resolve(realpathSync(dirname(resolve(destination))), basename(destination));
  const targetWithin = relative(root, target);
  if (targetWithin !== '..' && !targetWithin.startsWith(`..${sep}`) && !isAbsolute(targetWithin)) {
    throw new Error('Stage the archive outside the application directory.');
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(archive, target, constants.COPYFILE_EXCL);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    stageArchive(process.env.SUB_APP_SOURCE_ROOT, process.env.SUB_APP_ARCHIVE);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
