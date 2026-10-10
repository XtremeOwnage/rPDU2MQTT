# Copilot instructions

## Pull requests

- Title format: `[Prefix] Summary`, where Prefix is one of `Feature`, `Bug`, `Major`, `Chore`, `Docs`, `Dependency`. No conventional-commit prefixes (`feat:`, `fix(scope):`).
- `[Major]` only for breaking changes to config, API, MQTT topics or the CRD.
- Apply exactly one `kind/*` label matching the prefix: Feature `kind/feature`, Bug `kind/bug`, Major `kind/major`, Chore `kind/chore`, Docs `kind/documentation`, Dependency `kind/dependency`.
- Use only the labels listed in `CONTRIBUTING.md`. Do not create labels.
- PR body: a short list of what changed. No narration, no restating the diff.

## Commits

- Commit subjects follow the same `[Prefix] Summary` format.

## Code comments

- Comment why, not what. No narration of the change history in comments.

See `CONTRIBUTING.md` for the full standard.
