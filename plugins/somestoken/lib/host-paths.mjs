import fs from 'node:fs';
import path from 'node:path';

/**
 * Accept only an explicit, host-provided absolute filesystem location.
 *
 * This is deliberately a syntactic boundary: host-owned roots may themselves
 * be managed links, so callers still perform their own lstat checks before
 * reading or writing SomesToken-owned children. Rejecting relative and dot
 * segments prevents a malformed hook environment or manual invocation from
 * redirecting state into the current working directory.
 */
export function isHostOwnedAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('${') || value.includes('\0')) return false;
  if (!path.isAbsolute(value) || path.parse(value).root === value) return false;
  return !value.split(path.sep).some((segment) => segment === '.' || segment === '..');
}

/** A generated name is reusable; cleanup owns only the file it created. */
export function unlinkOwnedFile(file,owned) {
  if(!owned)return;
  const current=fs.lstatSync(file,{throwIfNoEntry:false});
  if(current?.isFile()&&current.dev===owned.dev&&current.ino===owned.ino)fs.unlinkSync(file);
}
