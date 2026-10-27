# Go

- **Detection:** `go.mod`.
- **Architecture:** the package graph of imports inside the module (test files
  excluded). Go already rejects import cycles at build time; the check also
  reports them before the build and in patches that do not compile yet.
- **Behaviour:** `go vet ./...` and `go test ./...`.
- **Performance:** available by default when Go is installed; pass the benchmark
  explicitly, e.g. `--bench "go test -run ^$ -bench BenchmarkParse ./parser"`.
- **Contract notes:** returned `error` values and wrapping (`errors.Is/As`), nil
  versus empty slices and maps, map iteration order, goroutine and channel
  ownership, context cancellation, and integer overflow.
