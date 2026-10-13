# Codex 0.162.1 drift analysis

Target: [`rust-v0.162.1`](https://github.com/openai/codex/releases/tag/rust-v0.162.1), commit [`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`](https://github.com/openai/codex/commit/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d). GitHub's latest release redirects to this tag, and npm's `@openai/codex` `latest` tag reports **0.162.1**, checked on **2026-10-13 Asia/Shanghai**. GitHub records publication at **2026-10-10 03:44:51 Asia/Shanghai**. The 0.163 alpha tags and unreleased main branch are excluded from this stable compatibility target.

The previous target was 0.159.1 (`8e68a98ef03cdde76d2e6800791ebdf1b3b95b24`). A PR is warranted: the schema has new settings, one feature flag becomes a removed no-op, and legacy plugin EMA overlays need a runtime diagnostic that preserves their authentication policy.

## Evidence and scope

The review uses complete local git history and direct tag-to-tag endpoint comparisons. `rust-v0.159.1..rust-v0.162.1` contains 435 reachable commits; the endpoint diff changes 2,531 paths. The intermediate ranges contain 56 commits (0.159.1 to 0.160.0), 155 (0.160.0 to 0.161.0), 227 (0.161.0 to 0.162.0), and 3 (0.162.0 to 0.162.1). Release branches include overlapping backports, so these counts are not additive, and merge-base comparisons can include changes already present at the previous release endpoint.

Reviewed the serialized schema, config types and strict loading, feature registry and aliases, historical retired features, model metadata and default selection, provider capability resolution and Bedrock catalogs, plugin MCP policy materialization, enterprise authentication, Guardian settings, TUI configuration, and release patch commits. Generated files come from a clean detached worktree at the exact release tag, using `sync:codex`; the upstream main checkout is left intact.

## Adopted changes

| Area | Drift and result |
| --- | --- |
| Release target | Package version becomes 0.162.1. Generated revision/date and schema track the exact release. |
| Models | The same seven curated models and capability values remain supported; GPT-6.1 Sol remains the default. The maximum catalog minimum client version remains 0.155.0, which is separate from the package's release target. |
| Patch flag | `features.apply_patch_preserve_line_endings` moves to `Removed`. Codex always preserves line endings. Existing generated-catalog migration removes the obsolete flag at the root and in legacy inline profiles; doctor reports it as a removed feature. Explicit unrelated flags are preserved. |
| Provider capabilities | Accept and preserve `model_providers.<id>.capabilities.external_web_access` and `remote_compaction` (`unsupported` or `v2`). Omission retains provider defaults; no capability override is injected. |
| Guardian | Support `features.guardianv2.transcript_mode` (`line` or `json`), `async_classifier_mode` (`snapshot` or `conversation`), and positive `async_classifier_conversation_token_limit`; support `auto_review.experimental_conversation_history_prompt` and positive `conversation_history_max_output_tokens`. |
| Audio | Support `[audio].microphone_channel` as one channel or a list of channels, each in 1–65,535. An empty list is accepted upstream and remains accepted here. Device-dependent channel availability is a runtime concern. |
| TUI | Support positive, finite `tui.mouse_scroll_speed`, `tui.agents_overview_grouping` (`project`, `status`, `model`), and `tui.keymap.agents.fork` / `toggle_pin`. Existing unknown-TUI-key rejection remains in place. |
| Multi-agent | Support `features.multi_agent_v2.message_board_remote` with required `url` and optional `bearer_token` / `bearer_token_env_var`. Codex strips this host setting from project configuration; this single-file tool cannot establish host provenance. No remote board is configured by the template. |
| Daybreak and feature additions | Support the release's new keys through the synced schema, preserving explicit choices. The template continues to omit these settings. |
| Plugin EMA overlays | Preserve retired `plugins.<plugin>.mcp_servers.<server>.ema_auth` values and add a targeted doctor warning explaining that Codex disables the affected server. No automatic deletion or relocation of authentication policy is performed. |

The OpenAI bundled model JSON removes unused `model_messages.instructions_variables`; all seven generated model capability records remain identical. Context requests remain 1,000,000 / 900,000 tokens and are subject to Codex's live catalog clamp. Existing supported and unfamiliar model selections remain preserved on ordinary apply.

## Runtime behavior and boundaries

The template is unchanged. `instant_interrupt` now defaults **on** upstream, API-key model discovery becomes stable and defaults **on**, and the new `ultrafast_mode` feature defaults **on** independently of `fast_mode`. These feature defaults do not establish model or account support. The bundled OpenAI catalog still advertises only priority service for the curated models; `service_tier = "fast"` remains the template setting, and unsupported OpenAI Ultrafast selections still receive an error.

New serialized feature keys are `api_key_cyber_access_programs`, `browser_annotation_api`, `cli_daybreak`, `code_mode_only_strict_3p_tools`, `code_mode_tool_search`, `guardian_conversation_history_tools`, `guardian_root_handoff_context`, `guardianv2_decisions_comparison`, `in_app_voice`, `incremental_tools`, `login_shell_package_path`, `model_catalog_in_context`, `multi_agent_v2_dynamic_tools`, `stable_environment_tools`, and `ultrafast_mode`. Browser annotation and in-app Voice are requirements-controlled gates; ordinary user config does not grant those capabilities. Guardian history retrieval, comparison scoring, transcript/classifier experiments, tool discovery, Daybreak controls, and login-shell PATH restoration remain outside the curated defaults.

Bedrock now retains multi-agent v2 and Ultra reasoning, exposes Ultrafast for bundled Astra Mantle and Runtime routes, and supports GovCloud Mantle routing. Custom provider catalogs are authoritative rather than silently borrowing bundled OpenAI entries. This package still verifies model capabilities only for the bundled OpenAI route, preserving custom and Bedrock model selections without applying OpenAI tier assumptions.

Plugin EMA handling follows the release's `PluginMcpServerConfig` deserializer and both policy-application paths in `codex-rs/core-plugins/src/loader.rs`: **any** present `ema_auth` value disables the server. The schema omits this retired field, but the runtime deliberately consumes it. The local schema exception is therefore limited to that exact plugin-server property; unrelated unknown fields and invalid plugin settings remain errors. Doctor marks the config compatible but not clean and exits unsuccessfully until the operator resolves the overlay. Apply preserves it and can make unrelated configuration changes idempotently. A trusted non-project MCP registration must replace the retired authentication setup before the old overlay is removed manually.

Upstream enterprise credential scoping, cloud-policy validity during reloads, managed Windows sandbox requirements, scoped required skills, tool exposure, and terminal-title sanitization require no additional serialized template values. Existing prompt-suggestion cleanup, Guardian thread-context cleanup, cloud-skills and TUI aliases, MCP OAuth restrictions, and gateway/AWS checks remain covered.

The 0.162.1 patch changes multiline asynchronous question rendering and limits background-server feature compatibility checks to explicit CLI overrides. Its schema, feature registry, config types, and model JSON match 0.162.0 byte-for-byte; the patch itself requires no further migration.

## Validation

Passed on Node **24.19.0** with a frozen lockfile:

- `pnpm run check`
- `pnpm test`: **243 tests across 8 files**
- `pnpm run build`
- Built CLI version, dry run, fresh apply, doctor, check, and unchanged second apply against a temporary target.
- Repeated source sync produces byte-identical schema and metadata; the schema matches the 0.162.1 release byte-for-byte.
- `git diff --check`.

The new regressions cover removed patch flags at root/profile scope, preservation of new settings and existing MCP/provider configuration, validation failures before writing, finite/positive scroll speed and channel bounds, and any-valued plugin EMA overlays. They verify that retired auth policy is preserved, doctor reports the disabled server, repeated apply is unchanged, and unrelated plugin validation remains strict. Existing tests continue to cover supported/custom models, aliases, Guardian cleanup, OAuth, provider constraints, and configuration editing.

The repository currently has a release-publishing workflow and no PR-triggered validation workflow. The results above are local validation, not GitHub CI results. The proposed update is ready for review; publishing a package or merging the PR is outside this analysis.
