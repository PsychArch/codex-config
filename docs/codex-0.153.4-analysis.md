# Codex 0.153.4 analysis and codex-config update

Reviewed on 2026-09-05. The project now targets Codex 0.153.4 and uses GPT-6 Astra as its bundled default, as requested. Sol, Terra, and Luna remain supported. The package version is 0.153.4. The validation below was completed before publication.

GitHub identifies [0.153.4 as the latest stable release](https://github.com/openai/codex/releases/tag/rust-v0.153.4). Analysis and generation used its exact commit, `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, in a clean detached worktree derived from the supplied research checkout. The original research checkout was left on its existing main revision. The project started at package 0.152.2 with generated compatibility metadata targeting the 0.152.1 source revision.

The main release changes relevant to daily use are Vim undo/redo, automatic recap controls, remote marketplace plugin commands, richer terminal history, and improved reconnection behavior. Approval handling also improves: remembered MCP approvals are scoped to app accounts, and Guardian history survives more session lifecycle transitions. These are upstream runtime improvements; updating this configuration package does not install the Codex binary. See the [0.153.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.153.0).

Astra arrived in the bundled catalog during the patch releases. Version 0.153.3 added Astra to the Bedrock picker and corrected asynchronous-question instructions; 0.153.4 makes Astra visible and the bundled default, and qualifies its question guidance by tool availability. See [0.153.3](https://github.com/openai/codex/releases/tag/rust-v0.153.3) and [0.153.4](https://github.com/openai/codex/releases/tag/rust-v0.153.4).

The configuration comparison found 17 added schema subtrees, zero removals, and one changed description documenting the legacy paste-burst fallback. These counts treat each newly added object as one subtree rather than counting every nested property. The [exact release schema](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/config.schema.json) is now copied byte for byte into the project.

| Surface | Project behavior |
| --- | --- |
| GPT-6 Astra | Generator includes Astra alongside the three GPT-5.6 models; template and fallback migration default use Astra. |
| Model capabilities | Validates Astra reasoning levels and priority/fast service; rejects Astra Ultrafast, which its bundled catalog does not advertise. Sol retains Ultrafast support. |
| App account settings | Accepts per-account approval modes and reviewers under `apps.<app>.links.<account>`. |
| TUI settings | Accepts `auto_recap`, `disable_paste_burst`, and Vim undo/redo bindings. |
| Paste-burst fallback | Doctor warns about the old root key; apply moves it under `tui`, preserving an existing canonical value, including false. |
| Shared compression flag | Removes `features.local_thread_store_shared_compression`, now a compatibility no-op, at the root and in retained profiles. |
| Experimental controls | Recognizes context-management configuration and the MCP OAuth refresh-coordination flag. The curated template does not enable them. |

The [release model catalog](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/models.json) declares Astra's minimum client version as 0.153.0, reasoning levels from low through ultra, code mode, and multi-agent v2. It advertises priority service, so the existing `service_tier = "fast"` alias remains compatible. Our high reasoning setting remains a deliberate curated choice; Astra's upstream default reasoning is low.

The template retains requests for a 1,000,000-token context window and compaction at 900,000 tokens. These are requested limits. Astra's bundled catalog has a 272,000-token default and 872,000-token maximum, matching Sol. With that bundled maximum, runtime clamping yields 872,000 total tokens, 828,400 usable tokens at 95% headroom, and compaction at 784,800 tokens. Live model metadata can change the effective limits. This follows [model override handling](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/src/model_info.rs) and [context calculations](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/openai_models.rs).

Normal apply preserves an existing supported model and explicit context limits. Fresh configurations use Astra; unsupported managed OpenAI model selections migrate to Astra. Force apply adopts the bundled Astra profile. Expanded context defaults follow Astra across built-in and compatible provider routes. Other model IDs keep their existing context behavior, and custom providers and MCP settings remain preserved.

Validation completed successfully: all 138 tests, TypeScript checking, build, and whitespace checks. Regression coverage includes Astra capabilities, supported-model preservation, fresh/default/force behavior, provider routes, canonical paste-burst precedence, obsolete-flag removal, and repeated-apply idempotency. Repeating the exact-source generator produced identical output. The packed artifact contains 29 entries with no local source paths or development test/script files. A fresh consumer installed that tarball and passed version, Astra apply, repeated apply, doctor, and check smoke tests.

Validation exercised the configuration package and its installed CLI. It did not make model API calls or verify account-specific Astra availability. The user's live Codex configuration was not modified.
