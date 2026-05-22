# codex-config

Apply a `config.toml.template` to `~/.codex/config.toml` without taking over the whole file.

By default, `codex-config` only adds template options that are missing. Existing options stay unchanged, and unrelated tables such as `[mcp_servers.*]`, `[model_providers.*]`, `[notice]`, and `[projects.*]` are preserved.

Use `-f` to reset template-covered options to the template values.

## Run

```bash
npx codex-config apply
```

## Usage

```bash
npx codex-config apply
npx codex-config apply --dry-run
npx codex-config apply -f
npx codex-config diff
npx codex-config check
npx codex-config doctor
```

Optional global install:

```bash
npm install -g codex-config
codex-config apply
```

Options:

- `--target PATH`: target config path, default `~/.codex/config.toml`
- `--template PATH`: template path, default bundled template
- `-f, --force`: overwrite template-covered keys
- `--json`: print JSON output

One-shot vibe coded by Codex.
