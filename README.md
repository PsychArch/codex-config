# codex-config

## Codex shipped again. Your `config.toml` didn't get the memo.

Settings get renamed, feature flags disappear, and yesterday's perfectly good configuration quietly becomes today's archaeological site.

`codex-config` migrates your configuration to the Codex release it targets and fills in a curated daily-driver setup—without bulldozing your MCP servers, providers, projects, notices, or other custom settings.

Use it when:

- **Codex shipped again.** Bring old settings forward, remove retired options, and validate the result against the matching Codex schema and runtime rules.
- **You want a strong setup without spending Sunday reading config docs.** Add a curated profile with high reasoning, live search, fast service, memories, useful terminal status, and analytics disabled.
- **You already customized everything just so.** Existing choices stay in place by default. Your MCP servers survive the procedure.

## Try it safely

Use Node.js 22.12 or later with npm or pnpm, or run it with Bun. Choose whichever package runner already lives in your terminal:

```bash
# npm
npx --yes codex-config@latest apply --dry-run

# pnpm 11 (`pn` is the short form of `pnpm`)
pn --silent dlx codex-config@latest apply --dry-run

# Bun
bunx codex-config@latest apply --dry-run
```

The dry run shows which settings would be added, updated, or removed without changing a file. Happy with the plan? Run the same command without `--dry-run`:

```bash
npx --yes codex-config@latest apply
pn --silent dlx codex-config@latest apply
bunx codex-config@latest apply
```

This updates `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is not set. Run it again after a Codex upgrade. Repeated runs produce the same result.

This version targets Codex **0.158.0**, with **GPT-6 Astra** as the bundled default and support for GPT-6 Sol and Luna plus GPT-5.6 Sol, Terra, and Luna. GPT-6 Sol and Luna require Codex 0.155.0 or later; Astra requires 0.153.0. Normal apply preserves an existing supported model selection; `--force` adopts the bundled Astra profile.

Package versions follow the Codex CLI version used for compatibility testing, so it is easy to see which Codex release a package targets.

## The curated profile

The bundled profile is an opinionated setup for trusted local development:

| Setting | What you get |
| --- | --- |
| `gpt-6-astra` | The default model for the targeted Codex release |
| Expanded Astra context | Requests a 1,000,000-token window and compaction around 900,000 tokens |
| High reasoning effort | More reasoning for coding and planning tasks |
| Live web search | Current information when a task needs it |
| Fast service tier | Priority processing when available |
| Memories enabled | Continuity across Codex sessions |
| Multi-agent v2 | Task-path-based sub-agent delegation |
| Default-mode questions | Structured user-input prompts without switching to Plan mode |
| Analytics disabled | Less telemetry |
| Status line and terminal title | Useful model, project, context, limit, and task state at a glance |

Codex clamps the requested context window to the selected model's live catalog limit and reserves its own operating headroom, so the usable capacity shown in a session can be lower than one million tokens. During a normal apply, the expanded defaults follow the `gpt-6-astra` model across built-in and OpenAI-compatible provider routes; alternate model IDs keep their own context behavior.

> [!WARNING]
> The bundled profile also sets `approval_policy = "never"` and `default_permissions = ":danger-full-access"`. It is designed for a trusted local machine, not an untrusted repository or shared environment. Review [`config.toml.template`](config.toml.template) before applying it if that permission level is not appropriate for you.

By default, recommendations are added only where you have not already made a choice. Use `--force` when you deliberately want every setting managed by `codex-config` reset to the bundled profile:

```bash
pn --silent dlx codex-config@latest apply --force
```

You can also supply your own recommendations with `--template /path/to/template.toml`.

## Your config stays yours

Compatibility migrations are intentionally more selective than replacing the whole file. `codex-config`:

- migrates legacy sandbox permissions, approval policies, feature aliases, config-key aliases, web-search flags, memory settings, and terminal display identifiers;
- moves `orchestrator.skills.enabled` to `cloud.skills.enabled` and `features.transcript_v2` to `tui.fullscreen_transcript`, preserving canonical settings;
- removes settings and feature flags that the targeted Codex release no longer uses;
- migrates the former bundled GPT-5.5 default to Astra, while preserving unfamiliar model IDs and reporting their capabilities as unverified;
- preserves supported model choices, custom provider models, customized workspace sandboxes, MCP servers, projects, providers, notices, and unrelated settings;
- validates the final result before writing it.

Comments and formatting are preserved when a change can be patched safely in place. If unusual TOML syntax makes a surgical edit ambiguous, the tool performs a canonical TOML rewrite and reports a `reformat` operation. No silent configuration archaeology.

## Check and automate

The examples below use `pn`; `npx --yes codex-config@latest` and `bunx codex-config@latest` accept the same commands and options.

```bash
# Show pending changes without writing
pn --silent dlx codex-config@latest diff

# Exit with status 1 when an update is needed
pn --silent dlx codex-config@latest check

# Validate the current config and report compatibility issues
pn --silent dlx codex-config@latest doctor
```

All commands support `--json` for machine-readable output.

Doctor also checks gateway OAuth delivery and URL restrictions, AWS credential-export conflicts, and MCP authorization-server issuer requirements. An unfamiliar model produces a warning and a nonzero doctor exit status; normal apply preserves it. `--force` selects the bundled Astra model.

The template retains `tui.alternate_screen = "never"` for native scrollback. To use Codex 0.158's fullscreen transcript, choose `tui.alternate_screen = "auto"` (or `"always"`) and `tui.fullscreen_transcript = true`. Memory v2 and post-turn compaction settings are supported but are not enabled by the template.

## Profiles and custom paths

Codex profiles use separate files under `$CODEX_HOME`:

```bash
pn --silent dlx codex-config@latest apply --profile work
codex --profile work
```

Use `--target /path/to/config.toml` to manage another file. Use `--template /path/to/template.toml` to supply your own recommendations.

Legacy `profile = "..."` selectors and `[profiles.<name>]` tables are reported but are not split automatically: that migration creates multiple sibling files and may conflict with existing profile files. Move each legacy table to `$CODEX_HOME/<name>.config.toml`, then manage it with `--profile <name>`.

## Development

```bash
pnpm install
pnpm test
pnpm run check
pnpm run build
```

Maintainers can refresh the bundled schema and Codex compatibility metadata from a Codex source checkout with:

```bash
pnpm sync:codex -- --source /path/to/codex
```

The source checkout must include complete, non-partial first-parent history so retired configuration keys can be detected.
