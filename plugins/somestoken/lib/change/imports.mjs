// Project-local import graphs for architecture checks. Only statically written
// imports are followed; dynamic ones are counted, never guessed. Links are not
// followed and nothing outside the project root is read.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'vendor', 'build', 'dist', 'target', 'out', 'Pods', 'DerivedData', '__pycache__', 'venv']);
const EXTENSIONS = {
  javascript: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'],
  python: ['.py'],
  go: ['.go'],
  java: ['.java'],
};

function sourceFiles(root, extensions) {
  const files = [];
  let skippedLarge = 0, truncated = false;
  const visit = relative => {
    let entries;
    try {
      if (relative && !fs.lstatSync(path.join(root, relative)).isDirectory()) return;
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) { truncated = true; return; }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) visit(child);
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        const stat = fs.lstatSync(path.join(root, child));
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) skippedLarge++;
        else files.push(child);
      }
    }
  };
  visit('');
  return { files, skippedLarge, truncated };
}

function read(root, file) {
  let parent = root;
  for (const part of path.dirname(file).split(path.sep).filter(part => part !== '.')) {
    parent = path.join(parent, part);
    if (!fs.lstatSync(parent).isDirectory()) throw Error('source_file_changed');
  }
  const target = path.join(root, file);
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || fs.realpathSync(target) !== path.join(fs.realpathSync(root), file)) throw Error('source_file_changed');
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0, count;
    while (used < buffer.length && (count = fs.readSync(fd, buffer, used, buffer.length - used, null))) used += count;
    if (used > stat.size) throw Error('source_file_changed');
    return buffer.subarray(0, used).toString('utf8');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Resolves a relative path against a file's directory; null when it leaves the root.
function inside(root, from, target) {
  const relative = path.relative(root, path.resolve(root, path.dirname(from), target));
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : relative.split(path.sep).join('/');
}

function javascriptEdges(root, file, known) {
  const text = read(root, file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const targets = [], typescript = ['.js', '.mjs', '.cjs', '.jsx'];
  for (const [, , specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g)) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
    const base = inside(root, file, specifier);
    if (base === null) continue;
    const swapped = typescript.includes(path.extname(base)) ? ['.ts', '.mts', '.cts', '.tsx'].map(ext => base.slice(0, -path.extname(base).length) + ext) : [];
    const candidates = [base, ...swapped, ...EXTENSIONS.javascript.map(ext => base + ext), ...EXTENSIONS.javascript.map(ext => `${base}/index${ext}`)];
    const target = candidates.find(candidate => known.has(candidate));
    if (target) targets.push(target);
  }
  return { targets, dynamic: [...text.matchAll(/\b(?:import|require)\s*\(\s*(?!['"])[^)\s]/g)].length };
}

function pythonEdges(root, file, known) {
  const text = read(root, file).replace(/#.*$/gm, '').replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/\s*\n\s*/g, ' ')})`);
  const roots = [...known].some(file => file.startsWith('src/')) ? ['', 'src'] : [''];
  const moduleFile = dotted => {
    for (const sourceRoot of roots) {
      const base = (sourceRoot ? `${sourceRoot}/` : '') + dotted.replaceAll('.', '/');
      if (known.has(`${base}.py`)) return `${base}.py`;
      if (known.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    }
    return null;
  };
  const pathFile = base => known.has(`${base}.py`) ? `${base}.py` : known.has(`${base}/__init__.py`) ? `${base}/__init__.py` : null;
  const targets = [];
  for (const [, names] of text.matchAll(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
    for (const name of names.split(',')) {
      const target = moduleFile(name.trim().split(/\s+/)[0]);
      if (target) targets.push(target);
    }
  }
  for (const [, dots, module, names] of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([^\n]+)/gm)) {
    let base;
    if (dots) {
      const levels = path.dirname(file).split('/').filter(part => part && part !== '.');
      const up = levels.slice(0, Math.max(0, levels.length - (dots.length - 1)));
      if (dots.length - 1 > levels.length) continue;
      base = [...up, ...(module ? module.split('.') : [])].join('/');
    } else {
      const found = moduleFile(module);
      base = found ? found.replace(/(\/__init__)?\.py$/, '') : null;
    }
    if (base === null) continue;
    let linked = false;
    for (const name of names.replace(/[()]/g, '').split(',').map(part => part.trim().split(/\s+/)[0]).filter(name => /^\w+$/.test(name))) {
      const submodule = pathFile(base ? `${base}/${name}` : name);
      if (submodule) { targets.push(submodule); linked = true; }
    }
    if (!linked) { const target = pathFile(base); if (target) targets.push(target); }
  }
  return { targets, dynamic: [...text.matchAll(/\b(?:importlib\.import_module|__import__)\s*\(/g)].length };
}

function goGraph(root) {
  let module;
  try { module = read(root, 'go.mod').match(/^module\s+(\S+)/m)?.[1]; } catch { return { status: 'unavailable', reason: 'go_module_missing' }; }
  if (!module) return { status: 'unavailable', reason: 'go_module_missing' };
  const scan = sourceFiles(root, EXTENSIONS.go);
  const files = scan.files.filter(file => !file.endsWith('_test.go'));
  const node = file => path.dirname(file) === '.' ? '.' : path.dirname(file);
  const packages = new Set(files.map(node)), edges = [];
  for (const file of files) {
    const text = read(root, file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const imports = [...text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)].map(match => match[1]);
    for (const [, block] of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) imports.push(...[...block.matchAll(/"([^"]+)"/g)].map(match => match[1]));
    for (const imported of imports) {
      const target = imported === module ? '.' : imported.startsWith(`${module}/`) ? imported.slice(module.length + 1) : null;
      if (target && packages.has(target) && target !== node(file)) edges.push([node(file), target]);
    }
  }
  return { ...scan, files, nodes: [...packages], edges, dynamic: 0 };
}

function javaGraph(root) {
  const scan = sourceFiles(root, EXTENSIONS.java);
  const declared = new Map(scan.files.map(file => [file, read(root, file).match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? '(default)']));
  const packages = new Set(declared.values()), edges = [];
  for (const [file, from] of declared) {
    for (const [, isStatic, name] of read(root, file).matchAll(/^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm)) {
      const parts = name.replace(/\.\*$/, '').split('.');
      // import a.b.C / import static a.b.C.member / import static a.b.C.* → package a.b; import a.b.* → a.b
      const drop = name.endsWith('.*') ? (isStatic ? 1 : 0) : isStatic ? 2 : 1;
      const target = parts.slice(0, parts.length - drop).join('.');
      if (packages.has(target) && target !== from) edges.push([from, target]);
    }
  }
  return { ...scan, nodes: [...packages], edges, dynamic: 0 };
}

function swiftGraph(root) {
  if (!fs.existsSync(path.join(root, 'Package.swift'))) return { status: 'unavailable', reason: 'swiftpm_manifest_missing' };
  const dump = spawnSync('swift', ['package', 'dump-package'], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (dump.error) return { status: 'unavailable', reason: dump.error.code === 'ENOENT' ? 'swift_toolchain_missing' : 'swift_manifest_unreadable' };
  if (dump.status !== 0) return { status: 'unavailable', reason: 'swift_manifest_unreadable' };
  let manifest;
  try { manifest = JSON.parse(dump.stdout); } catch { return { status: 'unavailable', reason: 'swift_manifest_unreadable' }; }
  const targets = new Set((manifest.targets ?? []).map(target => target.name)), edges = [];
  for (const target of manifest.targets ?? []) {
    for (const dependency of target.dependencies ?? []) {
      const name = (dependency.byName ?? dependency.target)?.[0];
      if (targets.has(name) && name !== target.name) edges.push([target.name, name]);
    }
  }
  return { files: [], skippedLarge: 0, truncated: false, nodes: [...targets], edges, dynamic: 0 };
}

/** Module/file dependency graph for one language, or an explicit unavailable status. */
export function importGraph(root, language) {
  let graph;
  if (language === 'go') graph = goGraph(root);
  else if (language === 'java') graph = javaGraph(root);
  else if (language === 'swift') graph = swiftGraph(root);
  else if (language === 'javascript' || language === 'python') {
    const scan = sourceFiles(root, EXTENSIONS[language]), known = new Set(scan.files), edges = [];
    let dynamic = 0;
    for (const file of scan.files) {
      const result = (language === 'python' ? pythonEdges : javascriptEdges)(root, file, known);
      dynamic += result.dynamic;
      for (const target of result.targets) if (target !== file) edges.push([file, target]);
    }
    graph = { ...scan, nodes: scan.files, edges, dynamic };
  } else return { language, status: 'unavailable', reason: 'unsupported_language' };
  if (graph.status === 'unavailable') return { language, ...graph };
  const unique = [...new Map(graph.edges.map(edge => [edge.join('\0'), edge])).values()].sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
  return { language, status: graph.truncated ? 'partial' : 'available', nodes: [...graph.nodes].sort(), edges: unique,
    unresolved_dynamic: graph.dynamic, skipped_large_files: graph.skippedLarge, truncated: graph.truncated };
}

/** Strongly connected components with more than one node (Tarjan), sorted. */
export function findCycles(graph) {
  const adjacency = new Map((graph.nodes ?? []).map(node => [node, []]));
  for (const [from, to] of graph.edges ?? []) adjacency.get(from)?.push(to);
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), cycles = [];
  let next = 0;
  const frames = [];
  const enter = node => {
    index.set(node, next); low.set(node, next++); stack.push(node); onStack.add(node);
    frames.push({ node, target: 0 });
  };
  for (const node of adjacency.keys()) {
    if (index.has(node)) continue;
    enter(node);
    while (frames.length) {
      const frame = frames.at(-1), targets = adjacency.get(frame.node) ?? [];
      if (frame.target < targets.length) {
        const target = targets[frame.target++];
        if (!index.has(target)) enter(target);
        else if (onStack.has(target)) low.set(frame.node, Math.min(low.get(frame.node), index.get(target)));
        continue;
      }
      frames.pop();
      if (frames.length) low.set(frames.at(-1).node, Math.min(low.get(frames.at(-1).node), low.get(frame.node)));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== frame.node);
      if (component.length > 1) cycles.push(component.sort());
    }
  }
  return cycles.sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
}

/** Cycles present after a change that did not exist, with the same members, before it. */
export function newCycles(before, after) {
  const known = new Set(findCycles(before).map(cycle => cycle.join('\0')));
  return findCycles(after).filter(cycle => !known.has(cycle.join('\0')));
}
