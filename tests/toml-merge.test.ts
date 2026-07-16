import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { parse } from "smol-toml";
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

  test("keeps additions scoped to an existing final table when adding later tables", () => {
    const target = `model = "gpt-5.6-sol"

[tui]
notifications = true
`;

    const plan = planConfigChange({ targetText: target, templateText: template, mode: "missing" });

    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-sol",
      approval_policy: "never",
      default_permissions: ":danger-full-access",
      model_reasoning_summary: "concise",
      analytics: { enabled: false },
      features: { memories: true },
      tui: {
        notifications: true,
        alternate_screen: "never",
        status_line: ["model-with-reasoning", "project-name"],
      },
    });
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

  test("override mode can replace a scalar with a template table", () => {
    const templateText = `[tools]
enabled = true
mode = "safe"
`;
    const plan = planConfigChange({
      targetText: "tools = false\nunrelated = true\n",
      templateText,
      mode: "override",
    });

    expect(parse(plan.outputText)).toEqual({
      tools: { enabled: true, mode: "safe" },
      unrelated: true,
    });
    expect(plan.operations).toEqual([
      { action: "update", path: "tools" },
      { action: "reformat", path: "config.toml" },
    ]);
    expect(() =>
      planConfigChange({
        targetText: "tools = false\n",
        templateText,
        mode: "missing",
      }),
    ).toThrow(/tools is not a table/);
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

  test("falls back to a semantic rewrite when extending an inline table", () => {
    const target = "features = { collab = true }\n";
    const templateText = `[features]
memories = true
`;

    const plan = planConfigChange({
      targetText: target,
      templateText,
      mode: "missing",
    });
    const second = planConfigChange({
      targetText: plan.outputText,
      templateText,
      mode: "missing",
    });

    expect(parse(plan.outputText)).toEqual({
      features: { collab: true, memories: true },
    });
    expect(plan.operations).toEqual([
      { action: "add", path: "features.memories" },
      { action: "reformat", path: "config.toml" },
    ]);
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("preserves dotted target keys when a table-based template adds a sibling", () => {
    const target = "features.memories = false\n";
    const templateText = `[features]
collab = true
`;

    const plan = planConfigChange({
      targetText: target,
      templateText,
      mode: "missing",
    });
    const second = planConfigChange({
      targetText: plan.outputText,
      templateText,
      mode: "missing",
    });

    expect(parse(plan.outputText)).toEqual({
      features: { memories: false, collab: true },
    });
    expect(plan.operations).toContainEqual({ action: "reformat", path: "config.toml" });
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("applies dotted template keys without nesting them under the active table", () => {
    const target = "features = { memories = false }\n";
    const templateText = "features.collab = true\n";

    const plan = planConfigChange({
      targetText: target,
      templateText,
      mode: "missing",
    });
    const second = planConfigChange({
      targetText: plan.outputText,
      templateText,
      mode: "missing",
    });

    expect(parse(plan.outputText)).toEqual({
      features: { memories: false, collab: true },
    });
    expect(plan.operations).toEqual([
      { action: "add", path: "features.collab" },
      { action: "reformat", path: "config.toml" },
    ]);
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("replaces arrays of tables semantically in override mode", () => {
    const target = `[[hooks]]
name = "first"
command = "old-one"

[[hooks]]
name = "second"
command = "old-two"
`;
    const templateText = `[[hooks]]
name = "replacement"
command = "new"
`;

    const plan = planConfigChange({
      targetText: target,
      templateText,
      mode: "override",
    });
    const second = planConfigChange({
      targetText: plan.outputText,
      templateText,
      mode: "override",
    });

    expect(parse(plan.outputText)).toEqual({
      hooks: [{ name: "replacement", command: "new" }],
    });
    expect(plan.operations).toEqual([
      { action: "update", path: "hooks" },
      { action: "reformat", path: "config.toml" },
    ]);
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("does not interpret TOML-looking multiline string content as config", () => {
    const target = `instructions = """
[features]
memories = false
model = "fake"
"""
features = { collab = true }
`;
    const templateText = `[features]
memories = true
`;

    const plan = planConfigChange({
      targetText: target,
      templateText,
      mode: "missing",
    });
    const second = planConfigChange({
      targetText: plan.outputText,
      templateText,
      mode: "missing",
    });

    expect(parse(plan.outputText)).toEqual({
      instructions: '[features]\nmemories = false\nmodel = "fake"\n',
      features: { collab: true, memories: true },
    });
    expect(plan.operations).toContainEqual({ action: "reformat", path: "config.toml" });
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("preserves signed 64-bit integers across a semantic rewrite", () => {
    const target = `history_limit = 9223372036854775807
features = { collab = true }
`;
    const templateText = `[features]
memories = true
`;

    const plan = planConfigChange({
      targetText: target,
      templateText,
      mode: "missing",
    });
    const second = planConfigChange({
      targetText: plan.outputText,
      templateText,
      mode: "missing",
    });

    expect(parse(plan.outputText, { integersAsBigInt: "asNeeded" })).toEqual({
      history_limit: 9223372036854775807n,
      features: { collab: true, memories: true },
    });
    expect(plan.operations).toContainEqual({ action: "reformat", path: "config.toml" });
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("preserves integral floats and distinguishes them from integers", () => {
    const fallback = planConfigChange({
      targetText: "ratio = 1.0\nfeatures = { collab = true }\n",
      templateText: "features.memories = true\n",
      mode: "missing",
    });
    const override = planConfigChange({
      targetText: "ratio = 1\n",
      templateText: "ratio = 1.0\n",
      mode: "override",
    });
    const negativeZero = planConfigChange({
      targetText: "timeout = -0.0\nfeatures = { collab = true }\n",
      templateText: "features.memories = true\n",
      mode: "missing",
    });

    expect(fallback.outputText).toContain("ratio = 1.0");
    expect(override.outputText).toBe("ratio = 1.0\n");
    expect(override.operations).toEqual([{ action: "update", path: "ratio" }]);
    expect(negativeZero.outputText).toContain("timeout = 0.0");
  });

  test("adds missing empty tables without clearing existing table contents", () => {
    const added = planConfigChange({
      targetText: "x = 1\n",
      templateText: '["empty.table"]\n',
      mode: "missing",
    });
    const preserved = planConfigChange({
      targetText: '["empty.table"]\nvalue = true\n',
      templateText: '["empty.table"]\n',
      mode: "override",
    });
    const replaced = planConfigChange({
      targetText: '"empty.table" = 1\n',
      templateText: '["empty.table"]\n',
      mode: "override",
    });

    expect(parse(added.outputText)).toEqual({ x: 1, "empty.table": {} });
    expect(added.operations).toEqual([
      { action: "add", path: '"empty.table"' },
      { action: "reformat", path: "config.toml" },
    ]);
    expect(preserved.changed).toBe(false);
    expect(parse(replaced.outputText)).toEqual({ "empty.table": {} });
    expect(replaced.operations).toEqual([
      { action: "update", path: '"empty.table"' },
      { action: "reformat", path: "config.toml" },
    ]);
  });

  test("treats prototype-like quoted keys as ordinary TOML keys", () => {
    const plan = planConfigChange({
      targetText: "x = 1\n",
      templateText: '"__proto__".polluted = true\n',
      mode: "missing",
    });
    const parsed = parse(plan.outputText) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(parsed["__proto__"]).toEqual({ polluted: true });
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(planCodexMergeAgain(plan.outputText)).toBe(false);
  });

  test("preserves every TOML date/time kind during a semantic rewrite", () => {
    const target = `local_date = 1979-05-27
local_time = 07:32:00
local_datetime = 1979-05-27T07:32:00
offset_datetime = 1979-05-27T07:32:00-07:00
features = { collab = true }
`;
    const plan = planConfigChange({
      targetText: target,
      templateText: "features.memories = true\n",
      mode: "missing",
    });
    const before = parse(target) as Record<string, any>;
    const after = parse(plan.outputText) as Record<string, any>;

    for (const key of [
      "local_date",
      "local_time",
      "local_datetime",
      "offset_datetime",
    ]) {
      expect(after[key].constructor.name).toBe("TomlDate");
      expect(after[key].toISOString()).toBe(before[key].toISOString());
    }
    expect(after.features).toEqual({ collab: true, memories: true });
    expect(plan.operations).toContainEqual({ action: "reformat", path: "config.toml" });
  });
});

describe("planConfigRemovals", () => {
  test("rejects an empty removal path", () => {
    expect(() => planConfigRemovals("x = 1\n", [[]])).toThrow(/cannot be empty/);
  });

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

  test("removes a table and all of its nested table blocks", () => {
    const target = `model = "gpt-5.6-sol"

[ui]
notifications = true

[ui.keymap.global]
copy = "ctrl-y"

[tui]
animations = false
`;

    const plan = planConfigRemovals(target, [["ui"]]);

    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-sol",
      tui: { animations: false },
    });
    expect(plan.operations).toEqual([{ action: "remove", path: "ui" }]);
  });

  test("falls back to a semantic rewrite when removing an inline-table key", () => {
    const target =
      "features = { image_detail_original = true, memories = false }\n";
    const paths = [["features", "image_detail_original"]] as const;

    const plan = planConfigRemovals(target, paths);
    const second = planConfigRemovals(plan.outputText, paths);

    expect(parse(plan.outputText)).toEqual({ features: { memories: false } });
    expect(plan.operations).toEqual([
      { action: "remove", path: "features.image_detail_original" },
      { action: "reformat", path: "config.toml" },
    ]);
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("preserves TOML date kinds when a removal requires reformatting", () => {
    const target = `created = 1979-05-27T07:32:00-07:00
features = { image_detail_original = true, memories = true }
`;
    const plan = planConfigRemovals(target, [["features", "image_detail_original"]]);
    const before = parse(target) as Record<string, any>;
    const after = parse(plan.outputText) as Record<string, any>;

    expect(after.created.constructor.name).toBe("TomlDate");
    expect(after.created.toISOString()).toBe(before.created.toISOString());
    expect(after.features).toEqual({ memories: true });
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

function planCodexMergeAgain(targetText: string): boolean {
  return planConfigChange({
    targetText,
    templateText: '"__proto__".polluted = true\n',
    mode: "missing",
  }).changed;
}
