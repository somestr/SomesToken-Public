# Python

- **Detection:** `pyproject.toml`, `setup.py`, `setup.cfg` or `requirements.txt`;
  bare `.py` files are reported as "source files only".
- **Architecture:** a static module graph from `import` and `from … import`
  statements, including relative imports and a `src/` layout. `importlib` and
  `__import__` calls are counted as unresolved, never guessed.
- **Behaviour:** `python3 -m pytest -q` when pytest is importable, otherwise
  `python3 -m unittest discover`. Use `--check` for tox, nox or a custom runner.
  Type checkers (mypy, pyright) run only when the project already uses them.
- **Performance:** `--bench "python3 -m timeit …"` or a small script run by the
  project's interpreter; peak memory comes from the benchmark process.
- **Contract notes:** which exception class is raised, truthiness of empty values,
  mutable default arguments, generator versus list results, dict ordering reliance,
  integer versus float division, and `Decimal` rounding.
