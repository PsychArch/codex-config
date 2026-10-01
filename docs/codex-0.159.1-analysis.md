# Codex 0.159.1 compatibility review

Target: [`rust-v0.159.1`](https://github.com/openai/codex/releases/tag/rust-v0.159.1), commit `8e68a98ef03cdde76d2e6800791ebdf1b3b95b24`. GitHub marks this release non-draft and non-prerelease, published at **2026-09-30 04:32:34 Asia/Shanghai**. This supersedes the 0.158.0 target in PR #2.

## Review scope

Reviewed both release ranges using local git history and direct tag comparisons: `rust-v0.158.0..rust-v0.159.0` (89 commits; 605 changed paths in the endpoint diff) and `rust-v0.159.0..rust-v0.159.1` (3 commits; 29 changed paths). GitHub's compare API limits its changed-file list to 300 and compares from the merge base; it is insufficient by itself for this review. The 0.158 and 0.159 release branches contain overlapping backports, so a merge-base diff can show changes already present in the actual 0.158.0 tag.

Configuration-facing changes were checked in the schema, feature registry and history, config types and aliases, core config loading, model picker/default logic, bundled models, Bedrock Mantle/Runtime catalogs, provider metadata, and MCP/Guardian runtime behavior. Other upstream changes concern execution, networking, sandbox enforcement, UI rendering, protocol handling, tests, and packaging; they do not require additional template settings or compatibility migrations here.

## Changes adopted

| Area | Result |
| --- | --- |
| Model catalog | Adds `gpt-6.1-sol` before the previous six supported models; all six retain their capability metadata. |
| Default | Upstream priority makes GPT-6.1 Sol the bundled default. Fresh apply, `--force`, and the existing GPT-5.5 legacy-default migration select it. Existing supported and unfamiliar model selections remain preserved on normal apply. |
| Sync | Discovers visible, API-supported GPT-6 (including minor releases) and GPT-5.6 models; sorts by upstream priority and derives the picker default. Hidden entries, API-ineligible entries, and older families are excluded. An upstream default outside the curated families causes an error before outputs are written. |
| Schema | Copied byte-for-byte from the exact release. Adds `features.instant_interrupt` and `auto_review.circuit_break_action` (`default` / `strict`). |
| Removed TUI key | Reports and removes `tui.prompt_suggestions` at the root and in legacy inline profiles. Cleans its legacy `[ui]` spelling while preserving unrelated UI data. Removal is idempotent. |
| Template | Uses `gpt-6.1-sol`; retains the curated high reasoning, fast tier, and expanded context requests. Expanded context defaults follow the new bundled model; existing context settings remain preserved. |

GPT-6.1 Sol's bundled metadata declares a 272,000-token context window, 872,000-token maximum, reasoning efforts `low` through `ultra`, default effort `low`, default reasoning summary `none`, priority service, code-mode-only tools, multi-agent v2, and no selectable personality. Its declared minimum client version is 0.153.0; the bundled entry first ships in 0.159.1. The maximum minimum version across the seven supported models remains 0.155.0. These catalog compatibility values are not the package's release target.

The template requests 1,000,000 context / 900,000 compaction tokens as before; Codex clamps them to the live model limit. Normal apply preserves Astra and the other existing model choices and does not inject the new default's context settings into those selections.

## Existing PR fixes retained

- Guardian thread context remains always on upstream. Both `guardian_thread_context` and `guardianv2.thread_context` are removed; no migration recreates the removed nested key. Empty Guardian tables remain valid and idempotent.
- `tui.whimsy` still migrates to `tui.effects.starfield`, preserving an existing canonical value.
- MCP OAuth `client_secret` still must be nonempty, requires a nonempty `client_id`, and is incompatible with `auth = "ema_auth"`.
- Existing TUI copy/paste, MCP readiness/schema-size, memory, multi-agent, and telemetry schema settings remain supported.

The actual 0.158.0 tag already contains the removal of prompt suggestions and the updated `copy_on_select = "auto"` documentation, so they produce no new schema diff relative to the old PR head. The missing prompt-suggestion cleanup is added explicitly rather than inferring an alias.

## Defaults and boundaries

`instant_interrupt` is still under development and defaults off. `auto_review.circuit_break_action` defaults to `default`; `strict` adds structured Guardian interruption errors that older clients may not understand in shared history. Neither option is enabled by the template; explicit user choices are preserved and validated.

Bedrock's new `openai.gpt-6.1-sol` catalog entry was reviewed. This package still verifies capabilities only against its bundled OpenAI catalog; provider-specific/custom models remain preserved without borrowing OpenAI capability assumptions. No Bedrock rewrite is needed.

Upstream `include_internal_metadata` is runtime-only (`serde(skip)` / `schemars(skip)`), so no serialized provider key is introduced here. New upstream executor credential isolation, filesystem denial handling, and Guardian history behavior require no local policy changes. No unreleased main-branch feature keys are added.

## Validation

Passed `pnpm run check`, `pnpm test` (**217 tests across 7 files**), and `pnpm run build` on Node 24.19.0 with the frozen lockfile. A second sync produced byte-identical schema and generated metadata; the schema also matches the upstream release byte-for-byte. Built CLI smoke checks passed for version, fresh apply, doctor, check, and an unchanged second apply using a temporary target.

Tests cover the seven supported models, fresh/force/default migrations, existing/custom model preservation, context adaptation, schema bounds, opt-in settings, removed-key diagnostics/cleanup, sync priority selection and exclusions, and the retained Guardian/TUI/MCP OAuth fixes. The type check, test suite, and build were run with the subprocess permissions required by the CLI/git integration tests.

Recommendation: **merge** once the PR head contains this reviewed change and the base/head and GitHub check/review state remain unchanged. No merge is performed by this update. The repository has no PR-triggered validation workflow; its release publishing workflow is not a PR check. Local passing validation is the evidence for this recommendation, not a claim of GitHub CI success.
