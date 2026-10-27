# Behaviour contracts

Write the contract before the edit, in a few lines per changed unit. It is
what "same behaviour" means for this change, and it decides which checks must run.

## What to record

- **Inputs and outputs** — accepted types and ranges, empty and missing values,
  return shape, and what callers read from it.
- **Errors** — which failures raise, return an error value or are swallowed, the
  error type or code callers match on, and the message only when callers or tests
  read it.
- **Ordering** — whether output order is defined (sorted, insertion, stable) and
  whether callers rely on it.
- **Repeated values** — duplicates kept, merged or rejected; identity versus equality.
- **Side effects** — files, network, globals, caches, logs, metrics; how often and
  in what order they happen.
- **Cancellation and timeouts** — who can cancel, what is left behind, and which
  limits apply.
- **Concurrency** — shared state, locks, reentrancy, thread or task affinity, and
  what may run in parallel.
- **Numeric precision** — integer versus floating point, overflow, rounding,
  units, and exact-versus-approximate results.

Mark each item as observed (a test or caller shows it) or assumed. An assumed item
the change touches needs a test before the change is applied.

## Reject a shorter version when it

- changes an error type, turns an error into a default value, or the reverse;
- drops input validation at a trust boundary, or a security or privacy safeguard;
- loses data-loss protection (atomic writes, rollback of partial work, locking);
- makes the code harder to read or test, or removes an accessibility behaviour;
- relies on behaviour that no test or contract item covers.

Fewer lines are not an improvement on their own.

## Abstractions

Keep an interface, protocol or wrapper that is a seam for tests, platforms,
plugins or a published API, even when only one implementation exists today. Pass it
to `--preserve` so its removal is caught. Remove an abstraction only when it has no
caller that depends on the seam and the user's task asks for that removal.

Do not merge different responsibilities into one function to make the code
shorter. Separate a structure that is genuinely broken from a design decision the
code deliberately keeps; only the first is a defect.

## Architecture changes

Name the concrete problem first: a dependency cycle, a lower layer importing a
higher one, duplicated ownership of state, or a module that mixes unrelated work.
The change must remove that problem without adding a new cycle or layer violation.
Never relax a test, lint rule or architecture rule to make a check pass.

## Algorithm changes

Compare the old and new code on the same inputs, including edge and error cases.
Judge time and memory together, measured on the same machine in the same run
(`--bench` alternates baseline and candidate). Claim only what the checks measured:
a benchmark result covers its inputs, not every workload.
