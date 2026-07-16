import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("sync-codex", () => {
  test("parses alias values without treating the Rust struct declaration as one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-sync-"));
    const projectRoot = join(directory, "project");
    const sourceRoot = join(directory, "codex-source");
    const scriptPath = join(projectRoot, "scripts", "sync-codex.mjs");

    await Promise.all([
      mkdir(join(projectRoot, "scripts"), { recursive: true }),
      mkdir(join(projectRoot, "src"), { recursive: true }),
    ]);
    await copyFile(join(process.cwd(), "scripts", "sync-codex.mjs"), scriptPath);
    await writeCodexFixture(sourceRoot);
    await initializeGitRepository(sourceRoot);

    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--source", sourceRoot],
      { cwd: projectRoot },
    );

    expect(stdout).toMatch(/^Synced Codex [0-9a-f]{12} with 3 GPT-5\.6 models\.\n$/);
    const generated = await readFile(
      join(projectRoot, "src", "codex-target.generated.ts"),
      "utf8",
    );
    const target = JSON.parse(
      generated.slice(generated.indexOf("=") + 1, generated.lastIndexOf(" as const;")),
    ) as {
      sourceRevision: string;
      models: Array<{ id: string }>;
      tuiKeys: string[];
      configKeyAliases: Array<{
        tablePath: string[];
        legacyKey: string;
        canonicalKey: string;
      }>;
    };
    const { stdout: fixtureRevision } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: sourceRoot },
    );
    expect(target.sourceRevision).toBe(fixtureRevision.trim());
    expect(target.models.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(target.tuiKeys).toEqual(["notifications"]);
    expect(target.configKeyAliases).toEqual([
      {
        tablePath: ["memories"],
        legacyKey: "no_memories_if_mcp_or_web_search",
        canonicalKey: "disable_on_external_context",
      },
    ]);
    await expect(readFile(join(projectRoot, "config.schema.json"), "utf8")).resolves.toBe(
      await readFile(join(sourceRoot, "codex-rs", "core", "config.schema.json"), "utf8"),
    );
  });
});

async function writeCodexFixture(sourceRoot: string): Promise<void> {
  const files = new Map<string, string>([
    [
      "codex-rs/core/config.schema.json",
      `${JSON.stringify({ definitions: { Tui: { properties: { notifications: { type: "boolean" } } } } }, null, 2)}\n`,
    ],
    [
      "codex-rs/models-manager/models.json",
      `${JSON.stringify({ models: [model("gpt-5.6-sol"), model("gpt-5.6-terra"), model("gpt-5.6-luna")] }, null, 2)}\n`,
    ],
    [
      "codex-rs/features/src/lib.rs",
      `const FEATURES: &[FeatureSpec] = &[
    FeatureSpec {
        id: Feature::Memories,
        key: "memories",
        stage: Stage::Stable,
    },
];
`,
    ],
    ["codex-rs/features/src/legacy.rs", "const ALIASES: &[Alias] = &[];\n"],
    [
      "codex-rs/config/src/key_aliases.rs",
      `struct ConfigKeyAlias {
    table_path: &'static [&'static str],
    legacy_key: &'static str,
    canonical_key: &'static str,
}

const CONFIG_KEY_ALIASES: &[ConfigKeyAlias] = &[ConfigKeyAlias {
    table_path: &["memories"],
    legacy_key: "no_memories_if_mcp_or_web_search",
    canonical_key: "disable_on_external_context",
}];
`,
    ],
  ]);

  await Promise.all(
    [...files].map(async ([path, contents]) => {
      const destination = join(sourceRoot, path);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, contents, "utf8");
    }),
  );
}

function model(slug: string): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    context_window: 128_000,
    supported_reasoning_levels: [{ effort: "high" }],
    default_reasoning_level: "high",
    default_reasoning_summary: "concise",
    support_verbosity: true,
    service_tiers: [{ id: "priority" }],
    minimal_client_version: "0.144.3",
    tool_mode: "default",
    multi_agent_version: null,
    model_messages: {},
  };
}

async function initializeGitRepository(sourceRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", sourceRoot]);
  await execFileAsync("git", ["config", "user.name", "Codex Config Test"], {
    cwd: sourceRoot,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: sourceRoot,
  });
  await execFileAsync("git", ["config", "commit.gpgSign", "false"], {
    cwd: sourceRoot,
  });
  await execFileAsync("git", ["add", "."], { cwd: sourceRoot });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: sourceRoot,
  });
}
