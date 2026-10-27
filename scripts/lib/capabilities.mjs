import { spawnSync } from 'node:child_process';

export const CAPABILITY_SCHEMA_VERSION = 1;
export const SUPPORTED_REASONING_PROFILES = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const SAFE_VERSION_TEXT = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,80}$/;
const SAFE_SOURCE = new Set(['cli', 'hook', 'turn_context']);
const SAFE_SECRET = /(?:^|[-_])(sk|rk|ghp|github_pat|xox[baprs]|AIza)[-_]/i;
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 1024;

function safeSource(value) {
  return SAFE_SOURCE.has(value) ? value : 'cli';
}

function safeModel(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return SAFE_MODEL.test(normalized) && !SAFE_SECRET.test(normalized) ? normalized : undefined;
}

function safeReasoningProfile(value) {
  return typeof value === 'string' && SUPPORTED_REASONING_PROFILES.includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase()
    : undefined;
}

function capabilityBase(source) {
  return { schema_version: CAPABILITY_SCHEMA_VERSION, status: 'unavailable', source: safeSource(source) };
}

export function parseCodexVersion(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.length > 64 || /[\u0000-\u001f\u007f/\\]/.test(normalized)) return null;
  const match = normalized.match(/(?:^|\s)codex-cli\s+([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(?:\s|$)/);
  const raw = match?.[1];
  if (!raw || !SAFE_VERSION_TEXT.test(raw)) return null;
  const [major, minor, patch] = raw.split('.').map(Number);
  return { major, minor, patch, raw };
}

export function normalizeCapability({ version, model, reasoningEffort, source = 'cli' } = {}) {
  const result = capabilityBase(source);
  const versionText = typeof version === 'object' ? version?.raw : version;
  const parsedVersion = typeof versionText === 'string' ? parseCodexVersion(`codex-cli ${versionText}`) : null;
  if (parsedVersion?.raw) result.codex_version = parsedVersion.raw;
  const safeModelValue = safeModel(model);
  const safeReasoning = safeReasoningProfile(reasoningEffort);
  if (safeModelValue) result.model = safeModelValue;
  if (safeReasoning) result.reasoning_profile = safeReasoning;
  if (result.codex_version && result.model && result.reasoning_profile) result.status = 'observed';
  else if (result.codex_version) result.status = 'partial';
  return result;
}

function observedVersionOnly(version) {
  const result = capabilityBase('cli');
  if (version?.raw) {
    result.codex_version = version.raw;
    result.status = 'partial';
  }
  return result;
}

export function probeCodexCapabilities(command = 'codex', root = process.cwd(), env = process.env) {
  const result = spawnSync(command, ['--version'], {
    cwd: root,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
  });
  if (result.error?.code === 'ENOENT') return capabilityBase('cli');
  if (result.status !== 0) return { ...capabilityBase('cli'), status: 'partial' };
  const version = parseCodexVersion(String(result.stdout ?? '').slice(0, OUTPUT_LIMIT));
  return observedVersionOnly(version);
}
