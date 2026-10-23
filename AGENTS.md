# Repository Guidelines

## Project Structure & Module Organization

This package adds companion memory, affect continuity, and QQ output handling to DeepSeek Harness. `src/` contains TypeScript: `domain/` holds deterministic affect logic, `memory/` handles retrieval and consolidation, `storage/` manages SQLite, and `runtime/`, `proactive/`, `adapters/`, and `commands/` coordinate behavior. Runtime resources live in `prompts/` and `migrations/`. Tests are under `tests/unit/` and `tests/integration/`. `scripts/` provides tooling; `docs/` documents installation and acceptance. Generated outputs belong in `lib/`, `dist/`, and `artifacts/`.

## Build, Test, and Development Commands

Use Node.js >=22.13 with built-in `node:sqlite`. TypeScript and Node types are vendored in `_vendor/`.

```sh
node scripts/build.mjs                 # Type-check and compile src/ into lib/
node scripts/build.mjs --check-only    # Check types without emitting files
node --test "tests/**/*.test.mjs"       # Run all tests
node scripts/replay.mjs --turns 10000  # Run deterministic conversation replay
node scripts/doctor.mjs                # Inspect environment and configuration
node scripts/benchmark.mjs --mode local # Measure local performance
node scripts/package.mjs               # Build and stage package plus manifest
```

On the documented Windows setup, use the bundled runtime:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'Z:\dsh\DeepSeek Harness.exe' scripts\build.mjs
```

Substitute other script arguments as needed. For local use, link the package into a DSH profile following `docs/INSTALL.md`, rebuild, and restart DSH Desktop.

## Coding Style & Naming Conventions

Follow existing two-space indentation, single quotes, and omitted statement semicolons. Use kebab-case filenames, camelCase functions and variables, and PascalCase types/classes. Keep TypeScript strict; use `import type` and `.js` extensions for relative ESM imports. Edit `src/` and regenerate `lib/`. No formatter or linter is configured.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, with `*.test.mjs` filenames and descriptive behavior names. Build first: tests import compiled `lib/` modules. Run subsets with `npm run test:unit` or `npm run test:integration` when npm is available. Add regression tests using fixed clocks, temporary databases, and fake hosts. No coverage percentage is enforced.

## Commit & Pull Request Guidelines

This checkout lacks Git metadata, so historical commit conventions cannot be verified. Use concise imperative subjects, for example `fix(memory): preserve conflicting facts`. PRs should explain behavior changes, link relevant issues, list validation commands and results, and describe configuration or migration effects. Update affected documentation.

## Configuration & Data Safety

Keep deployment settings in the profile's `cordis.patch.yml`; see `src/config.ts` for defaults. Never commit live conversation databases or credentials. Append numbered migrations such as `004_description.sql`; applied migrations are checksum-verified and must remain unchanged.
