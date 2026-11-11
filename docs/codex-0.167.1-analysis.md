# Codex 0.167.1 drift analysis

This release targets [`rust-v0.167.1`](https://github.com/openai/codex/releases/tag/rust-v0.167.1), commit [`0a94398fa60c4fac0e7659e4213a0a36e613dd46`](https://github.com/openai/codex/commit/0a94398fa60c4fac0e7659e4213a0a36e613dd46). GitHub's latest stable release and npm's `@openai/codex` latest tag both report **0.167.1**, checked on **2026-11-11 Asia/Shanghai**. GitHub records publication at **2026-11-11 05:32:01 Asia/Shanghai**. This includes the patch release following 0.167.0.

The previous compatibility target was 0.164.0 (`6aaac694803004a63c6f393d153c96d22521a6b9`). The direct release endpoint comparison changes 2,509 paths; the reachable commit range contains 456 commits. Review uses exact release contents and full first-parent feature history. Configuration review covers the schema, feature registry and aliases, model catalog, provider validation and merging, gateway OAuth, permissions/MITM definitions, memory defaults, Guardian settings, and core config loading. The source worktree is clean and pinned to the release tag; unreleased main-branch settings are excluded.

## Changes

| Area | Result |
| --- | --- |
| Schema and metadata | Synced from the exact stable release. Package version becomes 0.167.1. The schema remains byte-for-byte identical to upstream. |
| Model catalog | Adds GPT-6.1 Terra; the seven previous model records remain unchanged. GPT-6.1 Sol remains the default, and the maximum declared minimum client version remains 0.155.0. |
| Removed flag | Reports and removes `features.code_mode_tool_description_first` at root and legacy inline profile scope. Existing generic removed-feature migration handles both boolean values and remains idempotent. |
| GCP | Recognizes built-in `gcp` selection without requiring a custom definition or provider name. Accepts supported partial endpoint/auth/header/project/location/credential-file overrides. Rejects unsupported overrides, blank auth commands, and relative credential-file paths. |
| OpenAI catalog | Accepts `[model_providers.openai].model_catalog_url` while rejecting other non-default overrides. Requires HTTPS and an allowed ChatGPT host, with no URL user information. Diagnostics do not echo the supplied URL. |
| Gateway OAuth | Accepts omitted delivery as `Authorization: Bearer`, or an explicit case-insensitive equivalent. Rejects primary-credential/header collisions and different-origin catalog URLs for that delivery. Custom header and cookie delivery remain supported. Accepts the upstream `keyring`/`file` credential-store choices without selecting a new default. |
| Network MITM | Accepts signing-only and body-substitution-only actions as nonempty operations. Requires MITM version 2 for either operation and rejects hooks selecting multiple signing or multiple substitution actions. |
| Guardian classifier | Reports `features.guardianv2.async_classifier_mode` as deprecated and ignored, including legacy profile scope. Preserves the setting for review; asynchronous classification always uses conversations upstream. |
| Explicit new settings | Preserves Guardian review timeouts, memory consolidation service tier, rollout budget enforcement, plugin app policy, SSE delta logging, transcript selection keybindings, and new feature flags through the updated schema. |

GPT-6.1 Terra declares a 500,000-token context window, 872,000-token maximum, reasoning efforts `low` through `ultra`, default effort `low`, priority service, code-mode-only tools, multi-agent v2, and minimum client version 0.153.0. Normal apply preserves this model selection and does not inject GPT-6.1 Sol's expanded context defaults. Fresh apply and `--force` continue to select Sol. The curated template is unchanged.

The schema adds 20 feature keys: `apps_early_resource_discovery`, `code_mode_host_output_truncation`, `critical_path_timing`, `gcp_setup_wizard`, `guardian_native_multi_agent_history`, `guardian_recorded_items`, `guardianv3`, `incremental_exec_tools`, `incremental_tools_legacy`, `interrupt_on_cancel`, `mcp_connection_sharing`, `omit_skill_descriptions`, `plugin_discovery_prefetch`, `prediction_preserve_parent_tools`, `simplified_selection_hints`, `skill_catalog_deltas`, `suppress_model_change_announcements`, `tui_extensions_statusline`, `tui_multi_backend`, and `untrusted_as_tool_output`. None is explicitly added to the template. The 0.167.1 patch adds `incremental_tools_legacy` after 0.167.0; it remains off by default.

## Runtime sources and defaults

- [`config_toml.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/config/src/config_toml.rs) and [`model-provider-info`](https://github.com/openai/codex/tree/rust-v0.167.1/codex-rs/model-provider-info/src): built-in provider reservation, override validation, GCP credential paths, and OpenAI catalog routing. GCP allows `base_url`, `auth`, `http_headers`, `project_id`, `location`, and `credential_file`; explicit fields equal to upstream struct defaults are also accepted. Default GCP command authentication uses `gcloud auth application-default print-access-token` (`gcloud.cmd` on Windows).
- [`gateway_oauth.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/model-provider-info/src/gateway_oauth.rs): default Authorization delivery, catalog-origin checks, primary authentication conflicts, and existing reserved-header/URL restrictions. Origin comparison includes scheme, host, and effective port. A custom provider named `Google Cloud Vertex AI` also receives upstream's GCP identity checks.
- [`permissions_toml.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/config/src/permissions_toml.rs): new MITM operations, version requirements, and per-hook operation cardinality. The existing in-memory schema repair still connects permission profiles to upstream definitions without modifying the bundled schema.
- [`core/config/mod.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/core/src/config/mod.rs) and [`types.rs`](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/config/src/types.rs): fresh memory-enabled profiles default to v2 unless dual-write is explicitly disabled; existing v1 profiles retain v1. Consolidation defaults to the standard service tier. The template leaves memory version selection to Codex.

Guardian review defaults to a 90,000 ms overall budget; `auto_review.timeout_ms = 0` removes that review deadline while cancellation and independent transport timeouts still apply. Idle thread unloading changes from 1,800 to 60 seconds. `deferred_tool_world_state` and `reasoning_effort_override` become stable and enabled by default; `prediction_preserve_parent_tools` and `plugin_discovery_prefetch` are also enabled upstream. `respect_system_proxy` becomes experimental and remains off. No explicit overrides are injected for these defaults.

Plugin app settings are ignored when their plugin is disabled; explicit top-level app fields take precedence. SSE delta logging defaults on; `otel.log_sse_deltas = false` retains errors, completion events, and metrics. Existing telemetry exporter choices remain preserved.

## Boundaries

Validation here operates on one local configuration file. GCP authentication, project/location environment fallback, catalog entitlements, layered enterprise requirements, and trusted MCP provenance require the Codex runtime. MITM structural checks do not resolve proxy credentials or reproduce the proxy's full request matcher, secret substitution, and signing validation. Codex enforces those runtime constraints, including placeholder bounds and secret-source availability. No credentials are read or commands executed by doctor.

The OpenAI catalog override changes discovery routing; inference still uses `openai_base_url`. Custom and provider-specific model selections remain preserved without borrowing bundled OpenAI model capabilities. This release retains the existing permission, MCP confidential OAuth, TUI preset, Windows sandbox, and plugin EMA checks.

## Validation and release

Local validation passed on Node 24.19.0 with the frozen lockfile: type checking, **333 tests across 10 files**, and build. Built CLI version, dry run, fresh apply, doctor, check, and unchanged second apply passed against a temporary target. A second source sync produced byte-identical generated files, the schema matched the upstream release byte-for-byte, and the npm package dry run contained the expected CLI/schema/template files. Regression coverage includes valid-setting preservation and second-apply idempotence, Terra capabilities, retired root/profile flags, GCP and OpenAI override boundaries, default and secondary gateway delivery, origin and credential conflicts, MITM version/cardinality rules, and the Guardian timeout bound. Invalid configurations remain unchanged when apply rejects them and are reported incompatible by doctor.

Release uses the existing `main` package-version workflow: install the frozen lockfile, type-check, test, build, create `v0.167.1` with this analysis as notes, and publish through npm trusted publishing. GitHub Actions and npm publication must be checked after the push.
