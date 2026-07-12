import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("cli", () => {
  test("--version matches the package manifest", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
    };

    await expect(runCli(["--version"])).resolves.toMatchObject({
      stdout: `${packageJson.version}\n`,
    });
  });

  test("-f enables override mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-cli-"));
    const templatePath = join(directory, "config.toml.template");
    const targetPath = join(directory, "config.toml");

    await writeFile(templatePath, 'model = "gpt-5.6-sol"\n', "utf8");
    await writeFile(targetPath, 'model = "gpt-5.6-terra"\n', "utf8");

    const { stdout } = await runCli([
      "diff",
      "--template",
      templatePath,
      "--target",
      targetPath,
      "-f",
      "--json",
    ]);

    const result = JSON.parse(stdout) as { changed: boolean; mode: string };
    expect(result.changed).toBe(true);
    expect(result.mode).toBe("override");
  });

  test("--override-all is not accepted", async () => {
    await expect(runCli(["diff", "--override-all"])).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown option '--override-all'"),
    });
  });

  test("--profile targets the current CODEX_HOME profile-v2 file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-home-"));
    const templatePath = join(directory, "template.toml");
    await writeFile(templatePath, 'model = "gpt-5.6-sol"\n', "utf8");

    const result = JSON.parse(
      (
        await runCli(
          ["apply", "--profile", "work", "--template", templatePath, "--json"],
          { CODEX_HOME: directory },
        )
      ).stdout,
    ) as { target: string };

    expect(result.target).toBe(join(directory, "work.config.toml"));
    await expect(readFile(result.target, "utf8")).resolves.toBe('model = "gpt-5.6-sol"\n');
  });

  test("rejects unsafe profile names and profile/target ambiguity", async () => {
    await expect(runCli(["diff", "--profile", "../work"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid profile name"),
    });
    await expect(
      runCli(["diff", "--profile", "work", "--target", "/tmp/config.toml"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--target and --profile cannot be used together"),
    });
  });

  test("apply migrates an old config and doctor accepts the result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-cli-"));
    const templatePath = join(directory, "config.toml.template");
    const targetPath = join(directory, "config.toml");

    await writeFile(
      templatePath,
      `model = "gpt-5.6-sol"
default_permissions = ":danger-full-access"

[features]
memories = true
`,
      "utf8",
    );
    await writeFile(
      targetPath,
      `model = "gpt-5.5"
sandbox_mode = "danger-full-access"
personality = "friendly"

[features]
image_detail_original = true
view_image_tool = true
`,
      "utf8",
    );

    const diff = JSON.parse(
      (
        await runCli([
          "diff",
          "--template",
          templatePath,
          "--target",
          targetPath,
          "--json",
        ])
      ).stdout,
    ) as { operations: Array<{ action: string; path: string }> };
    expect(diff.operations).toEqual(
      expect.arrayContaining([
        { action: "update", path: "model" },
        { action: "remove", path: "personality" },
        { action: "remove", path: "features.image_detail_original" },
        { action: "remove", path: "features.view_image_tool" },
      ]),
    );

    await runCli(["apply", "--template", templatePath, "--target", targetPath, "--json"]);
    const applied = parse(await readFile(targetPath, "utf8")) as Record<string, unknown>;
    expect(applied).toMatchObject({
      model: "gpt-5.6-sol",
      default_permissions: ":danger-full-access",
      features: { memories: true },
    });
    expect(applied).not.toHaveProperty("personality");
    expect(applied).not.toHaveProperty("sandbox_mode");

    const doctor = JSON.parse(
      (
        await runCli([
          "doctor",
          "--template",
          templatePath,
          "--target",
          targetPath,
          "--json",
        ])
      ).stdout,
    ) as { ok: boolean; target: { clean: boolean } };
    expect(doctor.ok).toBe(true);
    expect(doctor.target.clean).toBe(true);
  });

  test("default output focuses on the config and groups understandable changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-output-"));
    const templatePath = join(directory, "config.toml.template");
    const targetPath = join(directory, "config.toml");

    await writeFile(
      templatePath,
      `model = "gpt-5.6-sol"
default_permissions = ":danger-full-access"

[features]
memories = true
`,
      "utf8",
    );
    await writeFile(
      targetPath,
      `model = "gpt-5.5"
personality = "friendly"
`,
      "utf8",
    );

    const { stdout } = await runCli([
      "apply",
      "--dry-run",
      "--template",
      templatePath,
      "--target",
      targetPath,
    ]);

    expect(stdout).toContain(`Codex config would be updated.\n  ${targetPath}`);
    expect(stdout).toContain("Added settings:\n  - default_permissions\n  - features.memories");
    expect(stdout).toContain("Updated settings:\n  - model");
    expect(stdout).toContain("Removed obsolete settings:\n  - personality");
    expect(stdout).not.toContain(templatePath);
    expect(stdout).not.toContain("mode:");
  });

  test("already-current output is concise", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-output-"));
    const templatePath = join(directory, "config.toml.template");
    const targetPath = join(directory, "config.toml");
    await writeFile(templatePath, 'model = "gpt-5.6-sol"\n', "utf8");
    await writeFile(targetPath, 'model = "gpt-5.6-sol"\n', "utf8");

    const { stdout } = await runCli([
      "apply",
      "--template",
      templatePath,
      "--target",
      targetPath,
    ]);

    expect(stdout).toBe(`Codex config is already up to date.\n  ${targetPath}\n`);
  });

  test("doctor explains a missing config and exits nonzero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-doctor-"));
    const templatePath = join(directory, "config.toml.template");
    const targetPath = join(directory, "missing.toml");
    await writeFile(templatePath, 'model = "gpt-5.6-sol"\n', "utf8");

    await expect(
      runCli(["doctor", "--template", templatePath, "--target", targetPath]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        `Codex config needs attention.\n  ${targetPath}\n\nConfig file not found.`,
      ),
    });
  });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, NO_COLOR: "1" },
  });
}
