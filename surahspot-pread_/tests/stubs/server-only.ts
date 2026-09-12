/**
 * Stand-in for the `server-only` package during tests.
 *
 * The real module throws on import unless a bundler has marked the module
 * graph as server-side, which is exactly the protection we want in `next
 * build` and exactly what makes route handlers unimportable in Vitest.
 * Aliasing it here keeps the guard in the real build while letting the suite
 * exercise the same source files the server runs.
 */
export {};
