import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { inspectCodexConfig } from "../src/codex-policy.js";

describe("inspectCodexConfig", () => {
  test("accepts the bundled GPT-5.6 template", async () => {
    const template = await readFile("config.toml.template", "utf8");

    await expect(
      inspectCodexConfig(template, "template", { requireModel: true }),
    ).resolves.toEqual({ valid: true, clean: true, issues: [] });
  });

  test("rejects models outside the GPT-5.6 family", async () => {
    const inspection = await inspectCodexConfig('model = "gpt-5.5"\n', "target", {
      requireModel: true,
    });

    expect(inspection.valid).toBe(false);
    expect(inspection.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_model", path: "model" }),
    );
  });

  test("reports personality as ineffective for GPT-5.6", async () => {
    const inspection = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\npersonality = "friendly"\n',
      "target",
      { requireModel: true },
    );

    expect(inspection.valid).toBe(true);
    expect(inspection.clean).toBe(false);
    expect(inspection.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_personality", path: "personality" }),
    );
  });

  test("enforces model-specific reasoning efforts", async () => {
    const luna = await inspectCodexConfig(
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "ultra"\n',
      "target",
      { requireModel: true },
    );
    const sol = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n',
      "target",
      { requireModel: true },
    );

    expect(luna.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_reasoning_effort" }),
    );
    expect(sol.valid).toBe(true);
  });

  test("enforces model service tiers while accepting the fast alias", async () => {
    const unsupported = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nservice_tier = "flex"\n',
      "target",
      { requireModel: true },
    );
    const fast = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nservice_tier = "fast"\n',
      "target",
      { requireModel: true },
    );

    expect(unsupported.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_service_tier", path: "service_tier" }),
    );
    expect(fast.valid).toBe(true);
  });

  test("reports legacy inline profiles without rewriting their contents", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
profile = "work"

[profiles.work]
model = "gpt-5.5"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "legacy_profile_selector", severity: "error" }),
        expect.objectContaining({ code: "legacy_profiles", severity: "warning" }),
      ]),
    );
  });

  test("reports legacy feature aliases", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
experimental_use_unified_exec_tool = true

[features]
collab = true
enable_experimental_windows_sandbox = true
web_search = true
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy_feature_alias",
          path: "experimental_use_unified_exec_tool",
        }),
        expect.objectContaining({ code: "legacy_feature_alias", path: "features.collab" }),
        expect.objectContaining({
          code: "legacy_feature_alias",
          path: "features.enable_experimental_windows_sandbox",
        }),
        expect.objectContaining({ code: "legacy_feature_alias", path: "features.web_search" }),
      ]),
    );
  });

  test("uses the Codex schema to reject unknown fields", async () => {
    const inspection = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nunknown_codex_setting = true\n',
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toContainEqual(
      expect.objectContaining({ code: "schema_additionalProperties" }),
    );
  });
});
