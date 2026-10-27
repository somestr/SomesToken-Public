#!/usr/bin/env node
import {humanLabel} from '../lib/core.mjs';
import { unlinkOwnedFile } from '../lib/host-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { readPublicSnapshot } from '../lib/public/read.mjs';
import { isPublicRootSafe, resolvePublicRoot } from '../lib/public/write.mjs';
import { certifyPolicy } from '../lib/optimization/certification.mjs';
import { buildEvidenceFiles, evidenceBundleBounds } from '../lib/public/evidence.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('SomesToken evidence · collect a local sanitized evidence bundle; option=--json. No remote publication.\n');
  process.exit(0);
}
if (args.some((value) => value !== '--json')) {
  process.stderr.write('SomesToken evidence · invalid bounded arguments · Next: use --help for supported options.\n');
  process.exit(2);
}
const result = readPublicSnapshot(process.env);
const snapshot = result.status === 'bridge_ready' ? result.snapshot : null;
const certification = certifyPolicy(snapshot);
const evidenceFiles = snapshot ? buildEvidenceFiles(snapshot, certification) : null;
const bundle = {
  evidence_schema_version: 1,
  created_at: Date.now(),
  source: result.source,
  bridge_status: result.status,
  snapshot,
  certification,
  file_names: evidenceFiles?.file_names ?? evidenceBundleBounds().file_names,
  files: evidenceFiles?.files ?? null,
  checksums: evidenceFiles?.checksums ?? null,
};
const root = resolvePublicRoot(process.env);
if (root && isPublicRootSafe(process.env) && snapshot && evidenceFiles) {
  const directory = path.join(root, 'evidence');
  const bundleDirectory = path.join(directory, `evidence-${snapshot.snapshot_sequence}`);
  const file = path.join(directory, `evidence-${snapshot.snapshot_sequence}.json`);
  const safeDirectory = (target) => {
    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(target, 0o700);
      return true;
    } catch {
      return false;
    }
  };
  const atomic = (target, serialized) => {
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    let fd,owned;
    let committed = false;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      owned = fs.fstatSync(fd);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, target);
      committed = true;
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fail open */ }
      if (!committed) try { unlinkOwnedFile(temp,owned); } catch { /* fail open */ }
    }
  };
  try {
    if (!safeDirectory(directory) || !safeDirectory(bundleDirectory)) throw new Error('evidence-directory-invalid');
    const serialized = `${JSON.stringify(bundle)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') <= evidenceBundleBounds().max_bundle_bytes) {
      atomic(file, serialized);
      for (const name of evidenceFiles.file_names) {
        const value = name === 'checksums.txt' ? evidenceFiles.checksums : `${JSON.stringify(evidenceFiles.files[name])}\n`;
        if (Buffer.byteLength(value, 'utf8') <= 16 * 1024) atomic(path.join(bundleDirectory, name), value);
      }
      if (!safeDirectory(directory)) throw new Error('evidence-directory-invalid');
      const directories = fs.readdirSync(directory)
        .filter((name) => /^evidence-\d+$/.test(name))
        .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
      for (const name of directories.slice(0, Math.max(0, directories.length - 5))) {
        try { fs.rmSync(path.join(directory, name), { recursive: true, force: true }); } catch { /* fail open */ }
      }
    }
  } catch {
    // Evidence export is report-only and fail-open.
  }
}
process.stdout.write(`${args.includes('--json') ? JSON.stringify(bundle) : `SomesToken evidence · ${humanLabel(certification.status)} · ${humanLabel(result.status)}${result.status!=='bridge_ready'?' · Next: check SomesToken diagnostics.':''}`}\n`);
