# Swift

- **Detection:** `Package.swift` (SwiftPM) or an `.xcodeproj`.
- **Architecture:** the SwiftPM target graph from `swift package dump-package`
  (target-to-target dependencies). Needs the Swift toolchain; without it, or for
  Xcode-only projects, the check is unavailable. File-level `import` is per module,
  so there is no file graph.
- **Behaviour:** `swift test` for SwiftPM packages. For Xcode projects pass the
  command explicitly, e.g. `--check "xcodebuild test -scheme App -destination
  'platform=macOS'"`; the scheme and destination come from the project, not from
  guesses.
- **Performance:** give `--bench` a release-mode run, e.g. `swift run -c release
  Bench`, or an XCTest `measure` target. Debug builds are not representative.
- **Contract notes:** value versus reference semantics, `throws` versus optionals
  versus `Result`, actor isolation and `Sendable`, `@MainActor` requirements,
  integer overflow traps, and `Decimal` versus `Double`.
