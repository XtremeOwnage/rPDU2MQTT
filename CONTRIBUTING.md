# Contributing

## Pull request titles

Every PR title starts with one of these prefixes, then a space and a short summary in the imperative:

| Prefix | Use for | Label |
|---|---|---|
| `[Feature]` | New functionality or an enhancement | `kind/feature` |
| `[Bug]` | A fix for something not working as intended | `kind/bug` |
| `[Major]` | A breaking change (config, API, MQTT topics, CRD) that needs a major version bump | `kind/major` |
| `[Chore]` | Refactoring, tests, CI, build, release housekeeping | `kind/chore` |
| `[Docs]` | Documentation only | `kind/documentation` |
| `[Dependency]` | Dependency updates | `kind/dependency` |

Examples:

```
[Feature] Add hour windows to the Trends pages
[Bug] Re-subscribe to MQTT topics after a reconnect
[Chore] Scope CI and Docker workflows by path
```

PRs are squash-merged, so the title becomes the commit message on `main`. Generated release notes are grouped by the `kind/*` label ([`.github/release.yml`](.github/release.yml)).

## Labels

- **kind/** (required on PRs): exactly one, matching the title prefix. The PR check adds it from the prefix if none is set.
- **kind/support**: questions and support requests (issues only).
- **priority/high**, **priority/low**: optional. No priority label means normal.
- **needs-triage**, **needs-info**: issue triage state.
- **good first issue**, **help wanted**: for contributors.

Duplicates and won't-fix are recorded by closing the issue with that reason, not with a label.

## Checks

The **PR Standards** workflow fails a PR whose title has no valid prefix, or whose `kind/*` label is missing, duplicated, or does not match the prefix.
