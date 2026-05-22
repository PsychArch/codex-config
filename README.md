# codex-config

Apply a `config.toml.template` to `~/.codex/config.toml` without taking over the whole file.

By default, `codex-config` only adds template options that are missing. Existing options stay unchanged, and unrelated tables such as `[mcp_servers.*]`, `[model_providers.*]`, `[notice]`, and `[projects.*]` are preserved.

Use `--override-all` to reset template-covered options to the template values.

## Install

```bash
npm install -g codex-config
```

## Usage

```bash
codex-config apply
codex-config apply --dry-run
codex-config apply --override-all
codex-config diff
codex-config check
codex-config doctor
```

Options:

- `--target PATH`: target config path, default `~/.codex/config.toml`
- `--template PATH`: template path, default bundled template
- `--override-all`: overwrite template-covered keys
- `--json`: print JSON output
