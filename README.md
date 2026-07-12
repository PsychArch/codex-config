# codex-config

Keep your Codex configuration up to date as Codex evolves.

`codex-config` updates the active `config.toml` to the supported Codex configuration shape and applies a curated set of recommended settings. It is safe to run after every Codex upgrade: repeated runs produce the same result.

It:

- adds recommended settings that are missing;
- migrates obsolete settings to their current equivalents;
- preserves your existing choices and unrelated configuration, including MCP servers, projects, providers, and notices;
- validates the result against the bundled Codex schema before writing it.

## Quick start

Requires Node.js 22 or later.

Package versions follow the Codex CLI version used for compatibility testing.

```bash
pnpm --silent dlx codex-config@latest apply
```

This updates `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is not set. Run the same command again whenever you upgrade Codex.

To review the changes first:

```bash
pnpm --silent dlx codex-config@latest apply --dry-run
```

## Recommended configuration

The bundled recommendations currently select `gpt-5.6-sol`, high reasoning effort, live web search, the fast service tier, memories, disabled analytics, and a useful terminal status display. They also configure Codex for unrestricted local access without approval prompts. Review the exact values in [`config.toml.template`](config.toml.template) before applying them if that permission level is not appropriate for your environment.

By default, existing values are kept. Compatibility migrations are still applied when an old setting is no longer valid—for example, legacy sandbox permissions, feature aliases, retired feature flags, web-search flags, and terminal display identifiers. Unsupported model selections move to the current default, while supported GPT-5.6 selections are preserved.

Use `--force` only when you want every setting managed by `codex-config` reset to its recommended value:

```bash
pnpm --silent dlx codex-config@latest apply --force
```

## Check your configuration

```bash
# Show pending changes without writing
pnpm --silent dlx codex-config@latest diff

# Exit with status 1 when an update is needed
pnpm --silent dlx codex-config@latest check

# Validate the current config and report compatibility issues
pnpm --silent dlx codex-config@latest doctor
```

All commands support `--json` for machine-readable output.

## Profiles and custom paths

Codex profiles use separate files under `$CODEX_HOME`:

```bash
pnpm --silent dlx codex-config@latest apply --profile work
codex --profile work
```

Use `--target /path/to/config.toml` to manage another file. Use `--template /path/to/template.toml` to supply your own recommendations.

## Install globally

```bash
pnpm add --global codex-config
codex-config apply
```

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

The source checkout must include full first-parent history so retired configuration keys can be detected.
