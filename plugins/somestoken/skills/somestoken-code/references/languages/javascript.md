# JavaScript and TypeScript (Node.js)

- **Detection:** `package.json` or `tsconfig.json`.
- **Architecture:** a file graph of relative `import`, `export … from`,
  `require()` and literal `import()` specifiers, resolving extensions, `index`
  files and TypeScript's `.js`-for-`.ts` convention. Package imports are external;
  non-literal `import()`/`require()` calls are counted as unresolved. Path aliases
  from `tsconfig` are not resolved.
- **Behaviour:** the project's `typecheck`, `lint` and `test` npm scripts, in that
  order, when they exist. Node's own test runner works with `--check "node --test"`.
- **Performance:** `--bench "node bench.mjs"` or the project's benchmark script;
  compare equal Node versions.
- **Contract notes:** thrown error classes and rejected promises, `undefined`
  versus `null`, sync versus async return, event-loop ordering, array sort
  stability and comparator results, and floating-point versus `BigInt`.
