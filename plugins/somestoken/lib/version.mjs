// This is the package-local base release identity used when a host does not
// supply a version environment variable. Host manifests may add a Codex-only
// cachebuster, but public state must never advertise a stale base release.
export const SOMESTOKEN_VERSION = "0.6.0-beta.128";
