import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import { CODEX_TARGET, inspectCodexConfig } from "../src/codex-policy.js";

describe("inspectCodexConfig", () => {
  test("accepts the bundled GPT-5.6 template", async () => {
    const template = await readFile("config.toml.template", "utf8");

    await expect(
      inspectCodexConfig(template, "template", { requireModel: true }),
    ).resolves.toEqual({ valid: true, clean: true, issues: [] });
  });

  test("enables multi-agent v2 in the bundled profile", async () => {
    const template = parse(await readFile("config.toml.template", "utf8")) as {
      features?: Record<string, unknown>;
    };

    expect(template.features?.multi_agent_v2).toBe(true);
    expect(template.features).not.toHaveProperty("multi_agent");
  });

  test("allows structured user input in default mode", async () => {
    const template = parse(await readFile("config.toml.template", "utf8")) as {
      features?: Record<string, unknown>;
    };

    expect(template.features?.default_mode_request_user_input).toBe(true);
  });

  test("does not classify schema-recognized feature keys as retired", async () => {
    const schema = JSON.parse(await readFile("config.schema.json", "utf8")) as {
      properties: { features: { properties: Record<string, unknown> } };
    };
    const schemaFeatureKeys = new Set(Object.keys(schema.properties.features.properties));

    expect(CODEX_TARGET.retiredFeatureKeys.filter((key) => schemaFeatureKeys.has(key))).toEqual(
      [],
    );
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

  test("accepts custom models supplied by a custom model provider", async () => {
    const inspection = await inspectCodexConfig(
      `model = "acme-reasoner-v2"
model_provider = "acme"
personality = "friendly"

[model_providers.acme]
name = "Acme"
base_url = "https://models.example.test/v1"
env_key = "ACME_API_KEY"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.valid).toBe(true);
    expect(inspection.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_model" }),
        expect.objectContaining({ code: "unsupported_personality" }),
      ]),
    );
  });

  test("accepts models supplied by OSS and custom catalog sources", async () => {
    const oss = await inspectCodexConfig(
      'model = "qwen3-coder"\noss_provider = "ollama"\n',
      "target",
      { requireModel: true },
    );
    const catalog = await inspectCodexConfig(
      'model = "company-model"\nmodel_catalog_json = "/tmp/models.json"\n',
      "target",
      { requireModel: true },
    );

    expect(oss).toEqual({ valid: true, clean: true, issues: [] });
    expect(catalog).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("accepts a custom OSS provider when it is defined", async () => {
    const inspection = await inspectCodexConfig(
      `model = "acme-model"
oss_provider = "acme"

[model_providers.acme]
name = "Acme"
base_url = "https://models.example.test/v1"
wire_api = "responses"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
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

  test("accepts personality none for GPT-5.6", async () => {
    const inspection = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\npersonality = "none"\n',
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
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

  test("reports runtime-compatible config aliases as warnings, not schema errors", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
js_repl_node_path = "/opt/node"

[tools]
web_search = true

[memories]
no_memories_if_mcp_or_web_search = true

[ghost_snapshot]
ignore_untracked_files_over_bytes = 1024
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.valid).toBe(true);
    expect(inspection.clean).toBe(false);
    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ignored_web_search_boolean" }),
        expect.objectContaining({ code: "deprecated_js_repl_setting" }),
        expect.objectContaining({ code: "runtime_config_alias" }),
      ]),
    );
    expect(inspection.issues).not.toContainEqual(
      expect.objectContaining({ severity: "error" }),
    );
  });

  test("reports historical feature flags deleted from the Codex catalog", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[features]
view_image_tool = true
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        code: "retired_feature",
        path: "features.view_image_tool",
        severity: "warning",
      }),
    );
  });

  test("treats the runtime-only artifact feature as compatible", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[features]
artifact = true
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("treats the runtime-only in-memory thread store as compatible", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
experimental_thread_store = { type = "in_memory", id = "test-store" }
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("accepts the runtime-only artifact feature inside retained profiles", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[profiles.work.features]
artifact = false
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).not.toContainEqual(
      expect.objectContaining({ code: "schema_additionalProperties" }),
    );
    expect(inspection.valid).toBe(true);
  });

  test("rejects non-boolean artifact values and TOML datetimes in string fields", async () => {
    const artifact = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nfeatures = { artifact = "yes" }\n',
      "target",
      { requireModel: true },
    );
    const datetimeModel = await inspectCodexConfig(
      "model = 1979-05-27T07:32:00Z\n",
      "target",
      { requireModel: true },
    );

    expect(artifact.valid).toBe(false);
    expect(datetimeModel.valid).toBe(false);
    expect(datetimeModel.issues).toContainEqual(
      expect.objectContaining({ code: "schema_type", path: "model" }),
    );
  });

  test("accepts TOML integers across the signed 64-bit range", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
model_context_window = 9223372036854775807
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.valid).toBe(true);
    expect(inspection.issues).not.toContainEqual(
      expect.objectContaining({ code: "invalid_toml" }),
    );
  });

  test("rejects TOML integers outside the signed 64-bit range", async () => {
    for (const value of ["9223372036854775808", "-9223372036854775809"]) {
      const inspection = await inspectCodexConfig(
        `model = "gpt-5.6-sol"\nmodel_context_window = ${value}\n`,
        "target",
        { requireModel: true },
      );

      expect(inspection.valid).toBe(false);
      expect(inspection.issues).toContainEqual(
        expect.objectContaining({
          code: "toml_integer_out_of_range",
          path: "model_context_window",
        }),
      );
    }
  });

  test("enforces the uint16 format for the MCP OAuth callback port", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
mcp_oauth_callback_port = 70000
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.valid).toBe(false);
    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        code: "schema_format",
        path: "mcp_oauth_callback_port",
        severity: "error",
      }),
    );
  });

  test("accepts custom models through an OpenAI-compatible base URL", async () => {
    const inspection = await inspectCodexConfig(
      `model = "company-gateway-model"
openai_base_url = "https://gateway.example.test/v1"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toMatchObject({ valid: true, clean: true, issues: [] });
  });

  test("uses the Codex schema to reject unknown fields", async () => {
    const inspection = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nunknown_codex_setting = true\n',
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        code: "schema_additionalProperties",
        path: "unknown_codex_setting",
        severity: "error",
      }),
    );
    expect(inspection.valid).toBe(false);
  });

  test("enforces runtime-only MCP and provider constraints", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[mcp_servers.docs]
command = "docs-server"
url = "https://docs.example.test/mcp"

[model_providers.company]
name = "Company gateway"
base_url = "https://models.example.test/v1"
wire_api = "responses"
env_key = "COMPANY_API_KEY"

[model_providers.company.auth]
command = "fetch-company-token"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "mcp_unsupported_transport_field",
          path: "mcp_servers.docs.url",
        }),
        expect.objectContaining({
          code: "model_provider_auth_conflict",
          path: "model_providers.company.env_key",
        }),
      ]),
    );
    expect(inspection.valid).toBe(false);
  });

  test("rejects unknown provider selections and unsupported Bedrock overrides", async () => {
    const inspection = await inspectCodexConfig(
      `model = "anything"
model_provider = "missing"
oss_provider = "ollama-chat"

[model_providers.amazon-bedrock]
name = "Not allowed"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown_model_provider", path: "model_provider" }),
        expect.objectContaining({ code: "removed_model_provider", path: "oss_provider" }),
        expect.objectContaining({
          code: "amazon_bedrock_override",
          path: "model_providers.amazon-bedrock.name",
        }),
      ]),
    );
  });

  test("rejects negative bigint MCP durations", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[mcp_servers.docs]
command = "docs-server"
startup_timeout_sec = -9223372036854775808
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        code: "mcp_invalid_timeout",
        path: "mcp_servers.docs.startup_timeout_sec",
      }),
    );
  });
});
