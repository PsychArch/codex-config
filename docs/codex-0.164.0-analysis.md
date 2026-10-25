# Codex 0.164.0 drift analysis

This release targets [`rust-v0.164.0`](https://github.com/openai/codex/releases/tag/rust-v0.164.0), commit [`6aaac694803004a63c6f393d153c96d22521a6b9`](https://github.com/openai/codex/commit/6aaac694803004a63c6f393d153c96d22521a6b9). GitHub's latest stable release and npm's `@openai/codex` latest tag both report **0.164.0**, checked on **2026-10-25 Asia/Shanghai**. GitHub records publication at **2026-10-23 12:48:10 Asia/Shanghai**.

The previous compatibility target was 0.162.1 (`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`). The direct release endpoint comparison changes 2,652 paths; the reachable commit range contains 557 commits. Release branches overlap, so this review uses exact endpoint contents and full history rather than relying on a merge-base comparison.

## Changes

| Area | Result |
| --- | --- |
| Schema and metadata | Synced from a clean worktree at the exact stable release. Package version becomes 0.164.0. |
| Models and template | The seven curated model records are unchanged. GPT-6.1 Sol remains the default; the maximum declared minimum client version remains 0.155.0. The curated template is unchanged. |
| Retired flags | Remove `realtime_conversation`, `shell_zsh_fork`, `stable_environment_tools`, and `worktrees`. Migrate the now-removed `transcript_v2` to `tui.fullscreen_transcript` at both root and legacy profile scope, preserving an existing canonical setting. |
| MCP confidential OAuth | Accept EMA client secrets with nonempty client ID, secret, and authorization-server issuer. Enforce the new token-endpoint authentication-method dependencies and enterprise IdP secret checks. Retain host-owned transport and alternate-credential restrictions. |
| TUI presets | Accept saved prompts and slash commands. Enforce single ASCII digit slots, nonempty input, no shell-command input, and an 8,000 UTF-8 byte limit. |
| Windows sandbox | Reject explicit MXC selection when `windows.allow_mxc = false`. |
| Network MITM | Enforce version 2 for origin scopes and credential placeholders, reject empty actions/hook action lists, and validate permission-profile structure against the upstream definitions. |
| New explicit settings | Preserve plugin defaults and remote metadata, model-request hooks, environment-context time control, copy-selection clearing, keybindings, multi-agent settings, and new feature settings through the updated schema. |

The serialized schema contains 15 new feature keys: `app_server_websocket_compression`, `async_compaction`, `code_mode_host_grpc`, `code_mode_tool_description_first`, `credential_masking`, `executor_capability_discovery_v2`, `guardian_trust_orchestrator_connectors`, `mcp_tool_list_changed`, `multi_env_copy_file`, `output_token_replay`, `retain_client_tool_outputs`, `runtime_agent_instances`, `subagent_default_context_limits`, `subagent_thread_environments`, and `wake_on_agent_messages`. They remain outside the curated defaults.

## Runtime validation

Refreshing only the generated schema and metadata would still reject valid confidential EMA clients and would allow invalid OAuth, preset, and Windows settings to be written and reported clean. Dedicated semantic validation now follows the stable Rust source:

- [`mcp_types.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/mcp_types.rs): token-endpoint authentication methods require EMA and a client secret; secrets require a nonempty client ID.
- [`mcp_ema.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/mcp_ema.rs): confidential EMA issuer, host ownership, alternate credentials, and enterprise IdP secret rules.
- [`types.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/types.rs) and [`core/config/mod.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/config/mod.rs): preset content, digit slots, and conflicting Windows settings.
- [`permissions_toml.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/permissions_toml.rs): MITM versioning and nonempty operation lists.

The upstream schema omits the flattened `PermissionsToml` map's value type. The validator restores its relationship to `PermissionProfileToml` in memory, using the bundled upstream definitions. The checked-in schema remains byte-for-byte identical to upstream. Validation does not insert a MITM version or rewrite credential policy.

This single-file tool cannot establish configuration-layer provenance, enterprise authorization, or account capability. Trusted non-project MCP registration remains necessary for EMA. Retired plugin EMA overlays remain preserved and diagnosed, as in the previous release. Custom and provider-specific model selections remain preserved without borrowing OpenAI catalog assumptions.

## Defaults and source boundaries

Upstream enables `code_mode_interrupt`, `cli_daybreak`, `api_key_cyber_access_programs`, `mcp_oauth_refresh_coordination`, `incremental_tools`, and `bedrock_setup_wizard` by default. No explicit overrides are injected. Background compaction remains opt-in, with a threshold restricted to 1–100 even when disabled. The default idle thread unload delay becomes 1,800 seconds. An explicit `log_dir` also routes local SQLite logs there unless managed storage requirements override it.

`analytics.enabled = false` disables OpenAI analytics; custom OTLP metrics exporters remain controlled by `otel.metrics_exporter`. Existing exporter choices are preserved.

The separately reviewed main-branch snapshot `970111f6cb62cc02fe36a82ea7d71b37a2889c97` contains unreleased GCP/Vertex provider support, Guardian settings, and MITM AWS signing. Those changes are excluded from this stable target. A future main-based target will need GCP provider-selection and override-policy changes in addition to a schema sync.

## Validation and release

Local validation passed on Node 24.19.0:

- Type check, **286 tests across 9 files**, and build.
- Tests cover valid setting preservation and idempotence, retired root/profile flags, confidential OAuth and IdP dependencies, preset byte boundaries, Windows conflicts, and versioned MITM validation. Invalid input remains unchanged when apply rejects it, and doctor reports it as incompatible.
- Repeated source sync produces identical schema and metadata; the schema matches the stable source byte-for-byte.
- Built CLI fresh apply, doctor, check, dry run, and unchanged second apply against temporary targets.
- Workflow lint and release-plan paths passed, including version bumps, unchanged versions, published-version retries, tag mismatches, prerelease merge rejection, and release creation with notes.

The publishing workflow now also runs after package-version changes are merged into `main`. It installs the frozen lockfile, checks types, runs tests, builds, creates the matching stable GitHub release, and publishes through the existing npm trusted-publishing workflow. Same-version package edits do not release, existing npm versions are skipped, and release events must match the package version. Releases created with `GITHUB_TOKEN` do not trigger another release workflow run; the same job performs publishing. Actual GitHub Actions and npm results must be verified after the merge.
