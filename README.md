# codex-config

Keep the active Codex `config.toml` current for the GPT-5.6 model family while preserving unrelated user settings such as MCP servers, projects, providers, and notices. The default target is `$CODEX_HOME/config.toml`, with `~/.codex/config.toml` used when `CODEX_HOME` is unset.

The bundled configuration defaults to `gpt-5.6-sol`. The supported models are:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

GPT-5.6 models carry their own personality instructions and do not expose a selectable personality placeholder. `codex-config` therefore removes the ineffective top-level `personality` setting.

The template explicitly opts into memories. Newly stable Codex capabilities such as multi-agent, goals, image generation, plugins, and tool search behavior are left at their source defaults, so the config does not pin redundant feature flags. Under-development features are not enabled automatically.

Package release versions track the Codex CLI version used for live compatibility testing.

## Apply

```bash
pnpm dlx codex-config apply
```

By default, missing template settings are added and existing values are preserved, except for compatibility migrations required by the GPT-5.6 target:

- unsupported models are changed to `gpt-5.6-sol`;
- `sandbox_mode` is converted to its equivalent `default_permissions` profile;
- `personality`, Codex feature flags marked as removed, and historical flags deleted from the source catalog are deleted;
- legacy feature aliases are renamed, and old web-search toggles become the top-level `web_search` mode;
- legacy status-line and terminal-title identifiers are canonicalized.

Use a dry run to inspect these operations before writing:

```bash
pnpm dlx codex-config apply --dry-run
```

Use `-f` to reset every template-covered setting to the bundled value. Supported model selections such as Terra or Luna are otherwise preserved.

```bash
pnpm dlx codex-config apply -f
```

## Inspect

```bash
pnpm dlx codex-config diff
pnpm dlx codex-config check
pnpm dlx codex-config doctor
```

`doctor` validates TOML against the bundled Codex JSON Schema and reports the exact Codex source revision, supported models, removed, retired, or deprecated features, and non-canonical settings. Add `--json` to any command for machine-readable output.

## Profiles

Current Codex profiles are separate config layers named `$CODEX_HOME/<name>.config.toml`. Apply or inspect one directly with the matching option:

```bash
pnpm dlx codex-config apply --profile work
pnpm dlx codex-config doctor --profile work
codex --profile work
```

The older top-level `profile` selector and `[profiles.<name>]` tables are no longer consumed by current Codex. `doctor` reports them with migration guidance, but does not delete or split that user-owned data automatically.

Options:

- `--target PATH`: explicit target config path
- `-p, --profile NAME`: target `$CODEX_HOME/<name>.config.toml`; cannot be combined with `--target`
- `--template PATH`: template path, default bundled template
- `-f, --force`: overwrite template-covered settings
- `--json`: print JSON output

Optional global installation:

```bash
pnpm add --global codex-config
codex-config apply
```

## Development

```bash
pnpm install
pnpm sync:codex -- --source /path/to/codex
pnpm test
pnpm run check
pnpm run build
```

`sync:codex` snapshots `config.schema.json`, the GPT-5.6 model capabilities (including minimum client version, reasoning efforts, service tiers, and personality support), and feature lifecycle metadata from the selected Codex checkout. It also reads the full first-parent feature history to retain migrations for keys that Codex deleted outright, so the source checkout must not be shallow. Commit the generated changes together so validation and migrations target one source revision.
