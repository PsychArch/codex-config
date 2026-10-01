import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("sync-codex", () => {
  test.each([
    ["legacy", false], ["paths", false], ["legacy", true], ["paths", true],
  ] as const)("parses %s aliases and discovers the catalog (minor release: %s)", async (format, minorRelease) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-sync-"));
    const projectRoot = join(directory, "project");
    const sourceRoot = join(directory, "codex-source");
    const scriptPath = join(projectRoot, "scripts", "sync-codex.mjs");

    await Promise.all([
      mkdir(join(projectRoot, "scripts"), { recursive: true }),
      mkdir(join(projectRoot, "src"), { recursive: true }),
    ]);
    await copyFile(join(process.cwd(), "scripts", "sync-codex.mjs"), scriptPath);
    await writeCodexFixture(sourceRoot, format, minorRelease);
    await initializeGitRepository(sourceRoot);

    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--source", sourceRoot],
      { cwd: projectRoot },
    );

    expect(stdout).toMatch(new RegExp(`^Synced Codex [0-9a-f]{12} with ${minorRelease ? 7 : 6} supported models\\.\\n$`));
    const generated = await readFile(
      join(projectRoot, "src", "codex-target.generated.ts"),
      "utf8",
    );
    const target = JSON.parse(
      generated.slice(generated.indexOf("=") + 1, generated.lastIndexOf(" as const;")),
    ) as {
      sourceRevision: string;
      defaultModel: string;
      minimumClientVersion: string;
      models: Array<{ id: string }>;
      tuiKeys: string[];
      configKeyAliases: Array<{
        legacyPath: string[];
        canonicalPath: string[];
      }>;
    };
    const { stdout: fixtureRevision } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: sourceRoot },
    );
    expect(target.sourceRevision).toBe(fixtureRevision.trim());
    expect(target.defaultModel).toBe(minorRelease ? "gpt-6.1-sol" : "gpt-6-astra");
    expect(target.minimumClientVersion).toBe("0.155.0");
    expect(target.models.map((entry) => entry.id)).toEqual([
      ...(minorRelease ? ["gpt-6.1-sol"] : []),
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(target.tuiKeys).toEqual(["notifications"]);
    expect(target.configKeyAliases).toEqual([
      {
        legacyPath: ["agents", "max_threads"],
        canonicalPath: ["agents", "max_concurrent_threads_per_session"],
      },
      {
        legacyPath: ["memories", "no_memories_if_mcp_or_web_search"],
        canonicalPath: ["memories", "disable_on_external_context"],
      },
      ...(format === "paths" ? [{ legacyPath: ["tui", "whimsy"], canonicalPath: ["tui", "effects", "starfield"] }] : []),
    ]);
    await expect(readFile(join(projectRoot, "config.schema.json"), "utf8")).resolves.toBe(
      await readFile(join(sourceRoot, "codex-rs", "core", "config.schema.json"), "utf8"),
    );
  });

  test("refuses an upstream default outside the curated catalog before writing outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-sync-"));
    const projectRoot = join(directory, "project");
    const sourceRoot = join(directory, "codex-source");
    const scriptPath = join(projectRoot, "scripts", "sync-codex.mjs");
    await mkdir(join(projectRoot, "scripts"), { recursive: true });
    await copyFile(join(process.cwd(), "scripts", "sync-codex.mjs"), scriptPath);
    await writeCodexFixture(sourceRoot, "paths", true);
    const modelsPath = join(sourceRoot, "codex-rs", "models-manager", "models.json");
    const catalog = JSON.parse(await readFile(modelsPath, "utf8"));
    catalog.models.unshift({ ...model("gpt-5.5"), priority: -3 });
    await writeFile(modelsPath, JSON.stringify(catalog));
    await initializeGitRepository(sourceRoot);
    await expect(execFileAsync(process.execPath, [scriptPath, "--source", sourceRoot], { cwd: projectRoot }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("upstream default model is outside the supported catalog") });
    await expect(readFile(join(projectRoot, "config.schema.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeCodexFixture(sourceRoot: string, format: string, minorRelease = false): Promise<void> {
  const files = new Map<string, string>([
    [
      "codex-rs/core/config.schema.json",
      `${JSON.stringify({ definitions: { Tui: { properties: { notifications: { type: "boolean" } } } } }, null, 2)}\n`,
    ],
    [
      "codex-rs/models-manager/models.json",
      `${JSON.stringify({ models: [
        model("gpt-5.6-luna"), model("gpt-6-astra"), model("gpt-6-sol"),
        model("gpt-6-luna"), model("gpt-5.6-sol"), model("gpt-5.6-terra"),
        ...(minorRelease ? [model("gpt-6.1-sol")] : []),
        { ...model("gpt-6.2-sol"), visibility: "hide", priority: -1 },
        { ...model("gpt-6.3-sol"), supported_in_api: false, priority: -2 },
        { ...model("gpt-5.5"), priority: 20 },
      ] }, null, 2)}\n`,
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

const CONFIG_KEY_ALIASES: &[ConfigKeyAlias] = &[
    ConfigKeyAlias {
        table_path: &["agents"],
        legacy_key: "max_threads",
        canonical_key: "max_concurrent_threads_per_session",
    },
    ConfigKeyAlias {
        table_path: &["memories"],
        legacy_key: "no_memories_if_mcp_or_web_search",
        canonical_key: "disable_on_external_context",
    },
];
`,
    ],
  ]);

  if (format === "paths") {
    files.set("codex-rs/config/src/key_aliases.rs", `
struct ConfigKeyAlias { legacy: &'static [&'static str], canonical: &'static [&'static str] }
const CONFIG_KEY_ALIASES: &[ConfigKeyAlias] = &[
    ConfigKeyAlias {
        legacy: &["agents", "max_threads"],
        canonical: &["agents", "max_concurrent_threads_per_session"],
    },
    ConfigKeyAlias {
        legacy: &["memories", "no_memories_if_mcp_or_web_search"],
        canonical: &["memories", "disable_on_external_context"],
    },
    ConfigKeyAlias {
        legacy: &["tui", "whimsy"],
        canonical: &["tui", "effects", "starfield"],
    },
];
`);
  }
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
    visibility: "list",
    supported_in_api: true,
    priority: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].indexOf(slug),
    display_name: slug,
    context_window: 128_000,
    supported_reasoning_levels: [{ effort: "high" }],
    default_reasoning_level: "high",
    default_reasoning_summary: "concise",
    support_verbosity: true,
    service_tiers: [{ id: "priority" }],
    minimal_client_version: slug === "gpt-6-astra" ? "0.153.0" : slug.startsWith("gpt-6-") ? "0.155.0" : "0.144.3",
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
