import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("cli", () => {
  test("-f enables override mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-cli-"));
    const templatePath = join(directory, "config.toml.template");
    const targetPath = join(directory, "config.toml");

    await writeFile(templatePath, 'model = "gpt-5.5"\n', "utf8");
    await writeFile(targetPath, 'model = "gpt-5.4"\n', "utf8");

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
});

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
  });
}
