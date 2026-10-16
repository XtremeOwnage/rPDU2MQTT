# Contributing

## Pull request titles

Every PR title starts with one of these prefixes, then a space and a short summary in the imperative:

| Prefix | Use for | Label |
|---|---|---|
| `[Feature]` | New functionality or an enhancement | `kind/feature` |
| `[Bug]` | A fix for something not working as intended | `kind/bug` |
| `[Major]` | A breaking change (config, API, MQTT topics, CRD) that needs a major version bump | `kind/major` |
| `[Workflow]` | GitHub Actions workflows and repository automation (`.github/`) | `kind/workflow` |
| `[Chore]` | Refactoring, tests, build, release housekeeping | `kind/chore` |
| `[Docs]` | Documentation only | `kind/documentation` |
| `[Dependency]` | Dependency updates | `kind/dependency` |

Examples:

```
[Feature] Add hour windows to the Trends pages
[Bug] Re-subscribe to MQTT topics after a reconnect
[Workflow] Scope CI and Docker workflows by path
```

PRs are squash-merged, so the title becomes the commit message on `main`. Generated release notes are grouped by the `kind/*` label ([`.github/release.yml`](.github/release.yml)).

## Issue types

Every issue has a GitHub issue type that agrees with its `kind/*` label:

| Issue type | Label |
|---|---|
| Bug | `kind/bug` |
| Feature | `kind/feature` |
| Task | `kind/chore`, `kind/workflow`, `kind/documentation`, `kind/dependency` or `kind/support` |

The **Issue Standards** workflow sets the type from the label, or adds the label from the type when there is none.

## Labels

- **kind/** (required on PRs): exactly one, matching the title prefix. The PR check adds it from the prefix if none is set.
- **kind/support**: questions and support requests (issues only).
- **impact/**: optional, any number. What an upgrade means for users:

  | Label | Use when | Applied |
  |---|---|---|
  | `impact/breaking` | Users must change something to upgrade | Automatically with `[Major]`; only allowed with `[Major]` |
  | `impact/config` | The config schema or CRD changes (keys added, renamed, removed or re-typed) | Automatically from changed paths |
  | `impact/migration` | Existing config, history or state is migrated on upgrade | By hand |
  | `impact/helm` | Chart values or templates change | Automatically from `charts/` |
  | `impact/mqtt` | Published MQTT topics or Home Assistant entities change | By hand |
  | `impact/api` | The REST API contract changes | By hand |

  Release notes list `impact/breaking` PRs under Breaking Changes, then `impact/migration` and `impact/config` under Migrations and Config Changes, ahead of the `kind/*` sections.
- **priority/high**, **priority/low**: optional. No priority label means normal.
- **needs-triage**, **needs-info**: issue triage state.
- **good first issue**, **help wanted**: for contributors.

Duplicates and won't-fix are recorded by closing the issue with that reason, not with a label.

## Checks

The **PR Standards** workflow fails a PR whose title has no valid prefix, whose `kind/*` label is missing, duplicated, or does not match the prefix, or whose `[Major]` prefix and `impact/breaking` label disagree.
