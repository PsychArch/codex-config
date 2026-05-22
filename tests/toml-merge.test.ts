import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { atomicWriteFile } from "../src/fs.js";
import { planConfigChange } from "../src/toml-merge.js";

const template = `approval_policy = "never"
sandbox_mode = "danger-full-access"
model = "gpt-5.5"
# model_reasoning_summary options: "auto", "concise", "detailed", "none"
model_reasoning_summary = "concise"

[analytics]
enabled = false

[features]
multi_agent = true
goals = true

[tui]
alternate_screen = "never"
status_line = ["model-with-reasoning", "project-name"]
`;

describe("planConfigChange", () => {
  test("writes the full template when the target is missing", () => {
    const plan = planConfigChange({ targetText: undefined, templateText: template, mode: "missing" });

    expect(plan.changed).toBe(true);
    expect(plan.outputText).toBe(template);
    expect(plan.operations).toEqual([{ action: "create", path: "~/.codex/config.toml" }]);
  });

  test("adds missing template keys and preserves unrelated tables", () => {
    const target = `model = "gpt-5.4"

[mcp_servers.jina]
url = "https://example.test/jina"

[features]
goals = false

[projects."/home/li/projects/demo"]
trust_level = "trusted"
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "missing" });
    const second = planConfigChange({ targetText: plan.outputText, templateText: template, mode: "missing" });

    expect(plan.changed).toBe(true);
    expect(plan.outputText).toContain('model = "gpt-5.4"');
    expect(plan.outputText).toContain('[mcp_servers.jina]\nurl = "https://example.test/jina"');
    expect(plan.outputText).toContain('[projects."/home/li/projects/demo"]\ntrust_level = "trusted"');
    expect(plan.outputText).toContain('approval_policy = "never"');
    expect(plan.outputText).toContain('[analytics]\nenabled = false');
    expect(plan.outputText).toContain('multi_agent = true');
    expect(plan.outputText).toContain('goals = false');
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("default mode does not overwrite existing template values", () => {
    const target = `approval_policy = "on-request"

[features]
multi_agent = false
goals = false
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "missing" });

    expect(plan.outputText).toContain('approval_policy = "on-request"');
    expect(plan.outputText).toContain('multi_agent = false');
    expect(plan.outputText).toContain('goals = false');
  });

  test("override mode updates only template-covered values", () => {
    const target = `approval_policy = "on-request"
chatgpt_base_url = "https://chatgpt.example"

[features]
multi_agent = false
goals = false

[notice]
fast_default_opt_out = true
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "override" });
    const second = planConfigChange({ targetText: plan.outputText, templateText: template, mode: "override" });

    expect(plan.outputText).toContain('approval_policy = "never"');
    expect(plan.outputText).toContain('chatgpt_base_url = "https://chatgpt.example"');
    expect(plan.outputText).toContain('[notice]\nfast_default_opt_out = true');
    expect(plan.outputText).toContain('multi_agent = true');
    expect(plan.outputText).toContain('goals = true');
    expect(second.changed).toBe(false);
  });

  test("invalid target TOML fails before producing changes", () => {
    expect(() =>
      planConfigChange({
        targetText: 'model = "gpt-5.5"\ninvalid = [',
        templateText: template,
        mode: "missing",
      }),
    ).toThrow(/Invalid target TOML/);
  });
});

describe("atomicWriteFile", () => {
  test("uses mode 0600 for new files and preserves existing mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-config-test-"));
    const path = join(directory, ".codex/config.toml");
    await atomicWriteFile(path, "one\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await chmodLike(path, 0o640);
    await atomicWriteFile(path, "two\n");
    expect(await readFile(path, "utf8")).toBe("two\n");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });
});

async function chmodLike(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}
