import crypto from 'node:crypto';
import { publicSnapshotBounds } from './schema.mjs';

export const EVIDENCE_SCHEMA_VERSION = 1;

const FILE_NAMES = Object.freeze([
  'manifest.json', 'capabilities.json', 'acceptance.json', 'public-schema.json',
  'performance.json', 'privacy.json', 'package.json', 'checksums.txt',
]);

function safeHost(value) {
  return value === 'codex' || value === 'claude' ? value : 'unknown';
}

function safeQuality(value) {
  return value === 'exact' || value === 'partial' || value === 'unavailable' ? value : 'unavailable';
}

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function json(value) {
  return `${JSON.stringify(value)}\n`;
}

/** Build fixed, public-only evidence files from a validated snapshot. */
export function buildEvidenceFiles(snapshot, certification = null) {
  const host = safeHost(snapshot?.host);
  const artifact = typeof snapshot?.artifact_sha256 === 'string' ? snapshot.artifact_sha256 : null;
  const identity = {
    plugin_version: typeof snapshot?.plugin_version === 'string' ? snapshot.plugin_version : 'unknown',
    host,
    host_version: typeof snapshot?.host_version === 'string' ? snapshot.host_version : 'unknown',
    artifact_sha256: artifact,
    public_schema_version: Number.isSafeInteger(snapshot?.public_schema_version) ? snapshot.public_schema_version : 1,
    snapshot_sequence: Number.isSafeInteger(snapshot?.snapshot_sequence) ? snapshot.snapshot_sequence : 0,
  };
  const files = {
    'manifest.json': {
      evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
      ...identity,
      file_names: FILE_NAMES,
      certification_status: certification?.status ?? 'unavailable',
    },
    'capabilities.json': { ...identity, capabilities: snapshot?.capabilities ?? {} },
    'acceptance.json': { ...identity, status: 'unavailable', reason_code: 'live_acceptance_not_embedded_in_public_snapshot' },
    'public-schema.json': {
      public_schema_version: identity.public_schema_version,
      bounds: publicSnapshotBounds(),
      quality: safeQuality(snapshot?.usage?.quality),
      snapshot_state: snapshot?.snapshot_state ?? 'unavailable',
    },
    'performance.json': { ...identity, status: 'machine_specific_external_evidence', hook_p95_ms: null, target_hook_p95_ms: 10 },
    'privacy.json': {
      ...identity,
      status: 'public_allowlist_enforced',
      raw_content_persisted: false,
      raw_events_exported: false,
      arbitrary_paths_accepted: false,
      network_used: false,
    },
    'package.json': { ...identity, package_identity: 'somestoken', package_validation: 'external_release_check', reproducibility: 'external_release_check' },
  };
  const checksums = FILE_NAMES.filter((name) => name !== 'checksums.txt')
    .map((name) => `${digest(json(files[name]))}  ${name}`)
    .join('\n') + '\n';
  return { files, checksums, file_names: FILE_NAMES };
}

export function evidenceBundleBounds() {
  return { max_bundle_bytes: 64 * 1024, max_files: FILE_NAMES.length, file_names: FILE_NAMES };
}
