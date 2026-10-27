// Language detection and the project's own checks. A capability is "available"
// only when a real command and its tool exist here; nothing here claims that a
// check passed, which only a run in the change workflow can establish.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importGraph } from './imports.mjs';

export const LANGUAGES = ['swift', 'python', 'go', 'java', 'javascript'];
const MANIFESTS = {
  swift: ['Package.swift'],
  python: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
  go: ['go.mod'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  javascript: ['package.json', 'tsconfig.json'],
};
const SOURCE_EXTENSIONS = {
  swift: ['.swift'], python: ['.py'], go: ['.go'], java: ['.java'],
  javascript: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'],
};

/** Language for a source path by extension; used for scoped checks, not as a support claim. */
export function languageOf(file) {
  const extension = path.extname(file);
  return LANGUAGES.find(language => SOURCE_EXTENSIONS[language].includes(extension)) ?? null;
}

function hasSources(root, language, depth = 0) {
  if (depth > 4) return false;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  return entries.some(entry => entry.isFile() ? SOURCE_EXTENSIONS[language].includes(path.extname(entry.name))
    : entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && hasSources(path.join(root, entry.name), language, depth + 1));
}

export function detectLanguages(root) {
  const detected = [];
  for (const language of LANGUAGES) {
    const manifest = MANIFESTS[language].find(file => fs.existsSync(path.join(root, file)))
      ?? (language === 'swift' && fs.readdirSync(root).find(name => name.endsWith('.xcodeproj')));
    if (manifest) detected.push({ language, detected_by: manifest });
    else if (hasSources(root, language)) detected.push({ language, detected_by: 'source_files_only' });
  }
  return detected;
}

/** True when the executable exists; project-relative wrappers are checked as files. */
export function toolAvailable(tool, root = process.cwd()) {
  if (tool.startsWith('./')) {
    try { return fs.statSync(path.join(root, tool)).isFile(); } catch { return false; }
  }
  const probe = spawnSync(tool, tool === 'go' ? ['version'] : ['--version'], { encoding: 'utf8', timeout: 20000 });
  return !probe.error;
}

function packageScripts(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {}; } catch { return {}; }
}

/** The project's own build/typecheck/lint/test commands, as argv without a shell. */
export function projectChecks(root, language) {
  const exists = file => fs.existsSync(path.join(root, file));
  if (language === 'javascript') {
    const scripts = packageScripts(root);
    return [
      ...['typecheck', 'lint'].filter(name => scripts[name]).map(name => ({ name, tool: 'npm', argv: ['npm', 'run', name] })),
      ...(scripts.test ? [{ name: 'test', tool: 'npm', argv: ['npm', 'test'] }] : []),
    ];
  }
  if (language === 'go') return exists('go.mod') ? [{ name: 'vet', tool: 'go', argv: ['go', 'vet', './...'] }, { name: 'test', tool: 'go', argv: ['go', 'test', './...'] }] : [];
  if (language === 'python') {
    const python = pythonInterpreter(root), pytest = pytestAvailable(root, python);
    return [{ name: 'test', tool: python, argv: [python, '-m', ...(pytest ? ['pytest', '-q'] : ['unittest', 'discover'])] }];
  }
  if (language === 'java') {
    if (exists('pom.xml')) return [{ name: 'test', ...(exists('mvnw') ? { tool: './mvnw', argv: ['./mvnw', '-q', 'test'] } : { tool: 'mvn', argv: ['mvn', '-q', 'test'] }) }];
    if (['build.gradle', 'build.gradle.kts'].some(exists)) return [{ name: 'test', ...(exists('gradlew') ? { tool: './gradlew', argv: ['./gradlew', 'test'] } : { tool: 'gradle', argv: ['gradle', 'test'] }) }];
    return [];
  }
  // Xcode projects need an explicit scheme and destination: supply them with --check.
  if (language === 'swift') return exists('Package.swift') ? [{ name: 'test', tool: 'swift', argv: ['swift', 'test'] }] : [];
  return [];
}

// The project's own virtual environment holds its libraries; the system interpreter may not.
function pythonInterpreter(root) {
  for (const environment of ['.venv', 'venv']) {
    const interpreter = `${environment}/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`;
    if (fs.existsSync(path.join(root, interpreter))) return `./${interpreter}`;
  }
  return 'python3';
}
const pytestFound = new Map();
function pytestAvailable(root, python) {
  const key = `${root}\0${python}`;
  if (!pytestFound.has(key)) pytestFound.set(key, spawnSync(python, ['-c', 'import pytest'], { cwd: root, encoding: 'utf8', timeout: 20000 }).status === 0);
  return pytestFound.get(key);
}

/** Dependency paths in root manifests that point outside the repository ('../lib'). */
export function externalPaths(root) {
  const found = new Set();
  const scan = (file, pattern) => {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { return; }
    for (const match of text.matchAll(pattern)) found.add(path.posix.normalize(match[1]));
  };
  scan('package.json', /"(?:file|link|portal):(\.\.\/[^"]+)"/g);
  scan('go.mod', /=>\s*(\.\.\/\S+)/g);
  scan('Package.swift', /path:\s*"(\.\.\/[^"]+)"/g);
  for (const file of ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'setup.cfg']) scan(file, /(?:^-e\s+|file:|path\s*=\s*")(\.\.\/[^"\s]+)/gm);
  for (const file of ['settings.gradle', 'settings.gradle.kts']) scan(file, /includeBuild\(\s*["'](\.\.\/[^"']+)["']/g);
  scan('pom.xml', /<(?:relativePath|module)>(\.\.\/[^<]+)<\//g);
  return [...found].filter(entry => entry.startsWith('../'));
}

/** Per-language matrix: what can be checked here, never what has been checked. */
export function capabilities(root) {
  return {
    schema_version: 1,
    languages: detectLanguages(root).map(({ language, detected_by }) => {
      const checks = projectChecks(root, language);
      const missing = checks.find(check => !toolAvailable(check.tool, root));
      const graph = importGraph(root, language);
      return {
        language, detected_by,
        // Reading and judging source is the host model's work; it is never a verification.
        source_review: 'model_only',
        architecture: graph.status === 'unavailable' ? { status: 'unavailable', reason: graph.reason }
          : { status: graph.status, method: language === 'swift' ? 'swiftpm_target_graph' : 'static_import_graph', unresolved_dynamic: graph.unresolved_dynamic },
        behavior: !checks.length ? { status: 'unavailable', reason: 'no_project_check' }
          : missing ? { status: 'unavailable', reason: `tool_missing:${missing.tool}` }
          : { status: 'available', checks: checks.map(check => check.argv.join(' ')) },
        performance: language === 'go' && toolAvailable('go', root) ? { status: 'available', default_bench: 'go test -run ^$ -bench . ./...' }
          : { status: 'requires_bench_command' },
      };
    }),
  };
}
