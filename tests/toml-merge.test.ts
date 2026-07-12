import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { atomicWriteFile } from "../src/fs.js";
import { planConfigChange, planConfigRemovals } from "../src/toml-merge.js";

const template = `approval_policy = "never"
default_permissions = ":danger-full-access"
model = "gpt-5.6-sol"
# model_reasoning_summary options: "auto", "concise", "detailed", "none"
model_reasoning_summary = "concise"

[analytics]
enabled = false

[features]
memories = true

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
memories = false

[projects."/workspace/demo"]
trust_level = "trusted"
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "missing" });
    const second = planConfigChange({ targetText: plan.outputText, templateText: template, mode: "missing" });

    expect(plan.changed).toBe(true);
    expect(plan.outputText).toContain('model = "gpt-5.4"');
    expect(plan.outputText).toContain('[mcp_servers.jina]\nurl = "https://example.test/jina"');
    expect(plan.outputText).toContain('[projects."/workspace/demo"]\ntrust_level = "trusted"');
    expect(plan.outputText).toContain('default_permissions = ":danger-full-access"');
    expect(plan.outputText).toContain('[analytics]\nenabled = false');
    expect(plan.outputText).toContain('memories = false');
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("default mode does not overwrite existing template values", () => {
    const target = `approval_policy = "on-request"

[features]
memories = false
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "missing" });

    expect(plan.outputText).toContain('approval_policy = "on-request"');
    expect(plan.outputText).toContain('memories = false');
  });

  test("keeps root settings above newly added tables", () => {
    const plan = planConfigChange({
      targetText: 'model = "gpt-5.6-sol"\n',
      templateText: `model = "gpt-5.6-sol"
default_permissions = ":danger-full-access"

[features]
memories = true
`,
      mode: "missing",
    });

    expect(plan.outputText).toBe(`model = "gpt-5.6-sol"
default_permissions = ":danger-full-access"

[features]
memories = true
`);
  });

  test("override mode updates only template-covered values", () => {
    const target = `approval_policy = "on-request"
chatgpt_base_url = "https://chatgpt.example"

[features]
memories = false

[notice]
fast_default_opt_out = true
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "override" });
    const second = planConfigChange({ targetText: plan.outputText, templateText: template, mode: "override" });

    expect(plan.outputText).toContain('approval_policy = "never"');
    expect(plan.outputText).toContain('chatgpt_base_url = "https://chatgpt.example"');
    expect(plan.outputText).toContain('[notice]\nfast_default_opt_out = true');
    expect(plan.outputText).toContain('memories = true');
    expect(second.changed).toBe(false);
  });

  test("invalid target TOML fails before producing changes", () => {
    expect(() =>
      planConfigChange({
        targetText: 'model = "gpt-5.6-sol"\ninvalid = [',
        templateText: template,
        mode: "missing",
      }),
    ).toThrow(/Invalid target TOML/);
  });
});

describe("planConfigRemovals", () => {
  test("removes standalone root and nested keys while preserving unrelated settings", () => {
    const target = `model = "gpt-5.6-sol"
personality = "friendly"

[features]
memories = true
image_detail_original = true

[mcp_servers.jina]
url = "https://example.test/jina"
`;

    const plan = planConfigRemovals(target, [
      ["personality"],
      ["features", "image_detail_original"],
    ]);
    const second = planConfigRemovals(plan.outputText, [
      ["personality"],
      ["features", "image_detail_original"],
    ]);

    expect(plan.operations).toEqual([
      { action: "remove", path: "personality" },
      { action: "remove", path: "features.image_detail_original" },
    ]);
    expect(plan.outputText).not.toContain("personality");
    expect(plan.outputText).not.toContain("image_detail_original");
    expect(plan.outputText).toContain('url = "https://example.test/jina"');
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("rejects a removal that cannot be represented as a surgical line edit", () => {
    expect(() =>
      planConfigRemovals('features = { image_detail_original = true }\n', [
        ["features", "image_detail_original"],
      ]),
    ).toThrow(/not represented as a standalone TOML key/);
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
