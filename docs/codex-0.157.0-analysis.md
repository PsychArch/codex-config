# Codex 0.157.0 compatibility update

Reviewed on 2026-09-26. This package targets the exact [Codex 0.157.0 release](https://github.com/openai/codex/releases/tag/rust-v0.157.0), commit `00c972ed5d6ff6499317fd41b7f23605b8e6850d`. The release source was checked out separately from the original research checkout. The bundled schema is copied byte for byte from this commit.

## Changes

- Add GPT-6 Sol and Luna to the curated model catalog, alongside Astra and the GPT-5.6 models. Sol and Luna require Codex 0.155.0. Luna supports reasoning through `max`; Sol also supports `ultra`. Refresh service-tier metadata: GPT-5.6 Sol no longer advertises `ultrafast`.
- Keep Astra as the default. Normal apply preserves supported model selections and unfamiliar model IDs. Doctor warns about unfamiliar model capabilities. The established migration from the former bundled GPT-5.5 default remains; force apply still selects Astra.
- Store full source and destination paths for generated config aliases. The generator understands both the 0.157.0 alias format and the newer path-array format, including destinations with a different depth.
- Migrate `orchestrator.skills.enabled` to `cloud.skills.enabled`, retaining explicit false values and giving the canonical setting precedence.
- Migrate `features.transcript_v2` to `tui.fullscreen_transcript`. Remove retired Windows desktop settings and removed feature flags, including `personality`, `guardian_ext`, and `remote_compaction_v2`.
- Migrate the historical `features.guardian_thread_context` flag to `features.guardianv2.thread_context`, preserving the Guardian enablement switch and canonical values, including in retained legacy profile tables.
- Validate gateway OAuth URLs, delivery headers/cookies, reserved names, header conflicts, client IDs, redirect ports, and AWS conflicts. Validate AWS credential-export commands and profile conflicts, plus MCP authorization-server issuer requirements.
- Accept the release's new memory, cloud, TUI, provider, and post-turn compaction configuration through the refreshed schema. Register the new unsigned 8-bit numeric format.
- Give subprocess-heavy CLI tests a 30-second per-test timeout after reproducing failures at the former five-second limit.

## Release boundary and defaults

The initial comparison used the September 26 development checkout. Several changes there are newer than 0.157.0. In this release, `features.guardianv2.thread_context` is still active and must not be removed. MCP startup-readiness settings, MCP OAuth client secrets, TUI copy-on-select/right-click-paste/prompt-suggestion controls, and the `tui.whimsy` alias are not part of the pinned schema or migrations.

The template retains Astra, high reasoning, existing context requests, and native terminal scrollback (`alternate_screen = "never"`). Fullscreen transcript mode requires alternate-screen permission. Memory v2, dual writes, and post-turn compaction are supported as user choices, without adding them to the curated template.

## Validation scope

All 190 tests passed, along with TypeScript checking, build, and whitespace checks. Repeating source sync produced identical metadata and schema. The packed artifact contained 32 entries; a fresh consumer installation passed version, dry-run, apply, doctor/check, profile, migration, model-preservation, force, idempotency, and invalid-config write-prevention checks.

Regression coverage exercises model preservation, force apply, canonical false precedence, Guardian migration, obsolete-setting cleanup, provider validation, both source-alias formats, and repeated-apply idempotency. Release validation also includes the complete test suite, TypeScript checks, build, reproducible metadata generation, and installation of the packed artifact in an isolated consumer directory.

These checks validate the configuration package. They do not make model API requests, exercise account-specific model availability, execute authentication helper commands, or modify the user's live Codex configuration.
