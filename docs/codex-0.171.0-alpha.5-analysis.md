# Codex 0.171.0-alpha.5 drift analysis

Target: [`rust-v0.171.0-alpha.5`](https://github.com/openai/codex/releases/tag/rust-v0.171.0-alpha.5), commit [`466da69cf6b72983f0d28c498c7cdb8d9bf2d114`](https://github.com/openai/codex/commit/466da69cf6b72983f0d28c498c7cdb8d9bf2d114). Checked 2026-11-15 UTC: npm's `@openai/codex` alpha tag is 0.171.0-alpha.5; latest remains 0.169.0. This package follows the alpha target and publishes only to `codex-config@alpha`. Stable users retain `codex-config@latest` 0.169.0.

## Scope and source evidence

The previous target is 0.169.0 (`d32063f96c2dff1dc96af839b3952abb6acfeda4`). Its direct endpoint comparison with the selected alpha changes 1,038 paths; the reachable commit range contains 126 commits. Review covers schema, feature registry and full first-parent feature history, aliases, model catalog, config loading/merging, Guardian limits, telemetry, provider authentication, MCP, permissions, and TUI settings. GitHub API access from this environment returned Forbidden, so release-channel evidence comes from npm and exact Git tags rather than a claimed GitHub release API check.

Latest main was also compared at `b7056f3408522716b6643c8b3e23ce7c9b53b041` (2026-11-15). Its additional schema changes are documented below, not bundled into this release. The release source is an isolated, unmodified worktree at the exact alpha tag.

## Adopted changes

| Area | Result |
| --- | --- |
| Schema and metadata | Schema copied byte-for-byte from the selected tag. Generated revision and TUI keys refreshed; all eight model capability records, feature retirement/deprecation sets, and aliases remain unchanged. |
| Asynchronous Guardian budgets | Validates `async_elastic_budgeting` and `async_elastic_sections` independently of synchronous activation. Enabled budgets require nonempty maps, known section names, no duplicate aliases, valid limits, and effective minimums totaling 128,000 tokens. Inactive maps retain upstream schema-only checks. |
| Selected exec reservations | Supports `transcript_selected_exec_results` in synchronous budgets, requiring nonempty `nested_tool_names` without blank entries. Rejects that section in asynchronous budgets and rejects nonempty nested tool lists on other sections. Its omitted default reservation is zero. |
| Status line | Accepts `tui.status_line_provider = "default"` or `{ server = "...", tool = "..." }`. Existing built-in status-line recommendations remain unchanged. |
| Marketplace | Accepts per-marketplace `auto_update`; upstream defaults it to false. No auto-update preference is injected. |
| Telemetry | Accepts `otel.headers_helper` and positive `headers_helper_refresh_interval_ms`. Commands are never executed by this tool. |
| Feature registry | Adds opt-in `catalog_apps_instructions`, `multi_environment_mcp`, and `safe_image_decoder`. `tui_workspace` becomes stable and defaults on upstream; explicit false remains preserved. |
| Template and models | GPT-6.1 Sol remains default, all model metadata is unchanged, and the curated template remains byte-identical. No new migrations or feature toggles are needed. |
| Release routing | Main version bumps can now create alpha GitHub prereleases and publish to npm's alpha tag. Stable versions continue to publish to latest. Alpha releases explicitly avoid GitHub's latest designation. |

## Runtime review

- [`core/src/config/mod.rs`](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.5/codex-rs/core/src/config/mod.rs) resolves sync and async elastic policies independently, with the same aliases and limits. Selected nested exec results are sync-only; explicit section minimums and entry caps must be positive, entry caps cannot exceed the minimum or 9,000 tokens, and explicit maxima cannot fall below minima. [`guardian-context/src/budget.rs`](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.5/codex-rs/guardian-context/src/budget.rs) retains default minima of 5,000 transcript-message tokens, 1,000 transcript-tool tokens, and 900 for the other existing sections; selected exec results default to zero. Actual request admission and context fit remain runtime responsibilities.
- [`config/src/types.rs`](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.5/codex-rs/config/src/types.rs) defines the status provider, marketplace flag, and nonzero telemetry refresh interval. The header helper defaults to a 29-minute refresh upstream and applies to explicit OTLP HTTP exporters. Repository-local configuration cannot set OTel options. This tool validates one local file and does not evaluate layer trust or execute helpers.
- [`config/src/merge.rs`](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.5/codex-rs/config/src/merge.rs) treats a status provider as a complete identity: partial higher-layer overrides cannot inherit half an identity. Runtime handling of ignored untrusted/malformed provider values does not require discarding user configuration here; doctor retains strict local schema validation.
- Model-provider source and bundled model JSON are unchanged at the alpha target. Existing gateway OAuth/export, AWS, MCP transport, retired policy, and legacy permissions validation remain applicable. Internal permission accessors, persistence changes, remote config filtering, and environment-qualified MCP exposure require no additional serialized migrations.

## Main-branch drift excluded from this alpha

Main additionally introduces `code_mode.heartbeat_interval_s`, `responses.process_mode`, fractional rollout `limit_budget` and context reminders, token-budget tool-output hints, the transcript `mark_markdown` binding, and `per_environment_context`, `mcp_shared_repl_cwd`, and `file_backed_tool_audio`. Main also enables legacy incremental tool declarations by default. These changes are later than the selected published alpha. The package rejects unknown main-only keys rather than claiming compatibility with an unshipped schema. Managed-network requirement changes are runtime policy handling, outside this single-file updater.

## Validation

Node 24.19.0, frozen lockfile: type check, 395 tests across 12 files, and build pass. Regression cases cover independent sync/async activation, default minima, aliases, duplicate aliases, total/entry bounds, selected-tool requirements, preservation of opt-in settings and explicit workspace disablement, schema bounds, main-only key rejection, second-apply idempotence, and byte-identical input after rejected apply. Existing stable regression coverage remains passing.

Repeat sync and byte equality against the exact upstream schema pass. Built CLI and npm package smoke verification cover version, dry-run, fresh apply, doctor, check, repeat apply, and shipped file inventory. Publication uses the existing GitHub Actions trusted-publishing path; registry and tag verification are performed after pushing the release commit.
