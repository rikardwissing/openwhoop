# Project Guidelines

## Testing
- Do not create, update, or expand tests unless the user explicitly asks for tests.
- For normal implementation tasks, prioritize changing production code over adding test coverage.
- Running existing targeted validation, such as focused tests or typecheck, is allowed when needed.

## Migrations
- Expensive local data migrations, aggregate rebuilds, backfills, table rewrites, or derived schema-version bumps must run through an explicit migration/progress screen or maintenance flow. Do not hide long-running SQLite work behind normal app startup or screen reads.
