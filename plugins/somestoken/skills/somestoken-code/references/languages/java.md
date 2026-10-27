# Java

- **Detection:** `pom.xml` or a Gradle build file.
- **Architecture:** the package graph from `import` statements (including static
  and wildcard imports) between packages declared in the project. Reflection,
  service loaders and dependency-injection wiring are not visible to it.
- **Behaviour:** `./mvnw -q test` or `mvn -q test` for Maven, `./gradlew test` or
  `gradle test` for Gradle. Without a JDK and the build tool the check is
  unavailable, and nothing is reported as verified.
- **Performance:** pass a JMH or project benchmark command with `--bench`; JIT
  warm-up makes single short runs unreliable.
- **Contract notes:** checked versus unchecked exceptions, `null` versus
  `Optional`, `equals`/`hashCode` consistency, collection ordering and mutability,
  synchronisation, and `BigDecimal` scale and rounding.
