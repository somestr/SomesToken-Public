import fs from 'node:fs';
import path from 'node:path';
import { publicSnapshotPath } from './write.mjs';
import { validatePublicSnapshot } from './validate.mjs';

const MAX_READ_BYTES = 64 * 1024;

export function readPublicSnapshot(env = {}, now = Date.now()) {
  const target = publicSnapshotPath(env);
  if (!target) return { snapshot: null, source: 'unavailable', status: 'bridge_unavailable', path: null };
  let fd;
  let authorityObserved = false;
  try {
    // Inspect only our two direct directories. The host-owned data root may
    // be a platform link; SomesToken's children must not redirect the read.
    // Unlike the writer's directory helper, a read never changes permissions.
    for (const directory of [path.dirname(path.dirname(target)), path.dirname(target)]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { snapshot: null, source: 'plugin_data', status: 'bridge_read_failed', path: target };
    }
    const link = fs.lstatSync(target);
    authorityObserved = true;
    if (!link.isFile() || link.isSymbolicLink()) return { snapshot: null, source: 'plugin_data', status: 'bridge_read_failed', path: target };
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
    const stat = fs.fstatSync(fd);
    const size = stat.isFile() ? stat.size : null;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_READ_BYTES) return { snapshot: null, source: 'plugin_data', status: 'bridge_read_failed', path: target };
    const buffer = Buffer.alloc(size);
    if (size) fs.readSync(fd, buffer, 0, size, 0);
    const parsed = JSON.parse(buffer.toString('utf8'));
    const result = validatePublicSnapshot(parsed, now);
    if (!result.valid) return { snapshot: null, source: 'plugin_data', status: 'bridge_schema_mismatch', path: target };
    const status = result.status === 'stale' || result.status === 'expired'
      ? 'bridge_stale'
      : result.status === 'unavailable'
        ? 'bridge_unavailable'
        : 'bridge_ready';
    return { snapshot: result.snapshot, source: 'plugin_data', status, path: target };
  } catch (error) {
    // Once an authority was seen, disappearance during open/read is not
    // permission to resurrect older private state or another public mirror.
    if (!authorityObserved && error?.code === 'ENOENT') {
      return { snapshot: null, source: 'plugin_data', status: 'bridge_read_failed', path: target, missing: true };
    }
    return { snapshot: null, source: 'plugin_data', status: 'bridge_read_failed', path: target };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fail open */ }
  }
}
