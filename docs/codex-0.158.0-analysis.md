# Codex 0.158.0 compatibility update

This package targets the exact [Codex 0.158.0 release](https://github.com/openai/codex/releases/tag/rust-v0.158.0), commit `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`. The bundled schema and generated metadata were refreshed with `pnpm sync:codex` from a full checkout of that tag. Codex 0.157.1 changed none of the synced inputs.

## Changes

- `features.guardianv2.thread_context` is now a removed compatibility no-op (thread-owned Guardian context is always on). The former `guardian_thread_context` → `guardianv2.thread_context` migration is dropped: both keys are now removed by the generic removed/retired-feature cleanup. Keeping the migration made apply non-idempotent, because the key it wrote was deleted on the next run.
- `tui.whimsy` is now an alias of `tui.effects.starfield`; the refreshed generated metadata migrates it.
- New TUI keys `copy_on_select` and `right_click_paste`, MCP `startup_readiness` / `tool_input_schema_max_bytes` / OAuth `client_secret`, code-mode `tool_input_schema_max_bytes`, multi-agent v2 `disable_direct_message` / `message_board_in_memory`, and `otel.log_agent_responses` / `otel.log_guardian_assessments` are accepted through the refreshed schema. None are added to the template.
- Doctor mirrors the new MCP runtime rules for `oauth.client_secret`: it must not be empty, requires a nonempty `oauth.client_id`, and cannot be combined with `auth = "ema_auth"`.

## Unchanged

The model catalog for the supported GPT-6 and GPT-5.6 models is identical to 0.157.0, so model metadata, the Astra default, and `config.toml.template` are unchanged.

## Known cosmetic behavior

Removing `thread_context` from `[features.guardianv2]` or a profile's `guardianv2` table can leave an empty table behind. It is valid and idempotent.

## Not adopted

Unreleased main-branch additions (for example `instant_interrupt`, `guardian_root_handoff_context`, `guardian_conversation_history_tools`, `auto_review.circuit_break_action`) are intentionally not targeted until they ship in a release.
