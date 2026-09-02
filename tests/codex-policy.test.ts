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

  test("requests the expanded GPT-5.6 Sol context window", async () => {
    const template = parse(await readFile("config.toml.template", "utf8")) as {
      model?: unknown;
      model_context_window?: unknown;
      model_auto_compact_token_limit?: unknown;
    };

    expect(template.model).toBe("gpt-5.6-sol");
    expect(template.model_context_window).toBe(1_000_000);
    expect(template.model_auto_compact_token_limit).toBe(900_000);
  });

  test("allows structured user input in default mode", async () => {
    const template = parse(await readFile("config.toml.template", "utf8")) as {
      features?: Record<string, unknown>;
    };

    expect(template.features?.default_mode_request_user_input).toBe(true);
  });

  test("keeps the update_plan tool enabled after Codex 0.152 made it opt-in", async () => {
    const template = parse(await readFile("config.toml.template", "utf8")) as {
      tools?: { update_plan?: { enabled?: unknown } };
    };

    expect(template.tools?.update_plan?.enabled).toBe(true);
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

  test("accepts representative Codex 0.147 configuration surfaces", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[features]
apply_patch_preserve_line_endings = true
background_paginated_rollout_migration = true
code_mode_interrupt = true
executed_tool_call_metadata = true
guardian_reuse_parent_compaction = true
image_resize_notice = true
recommended_plugins = true
unified_image_budget = true
view_image = true

[features.code_mode]
enabled = true
default_exec_yield_time_ms = 10000

[features.tool_registry]
error_on_tool_collisions = true
turn_metadata_includes_tool_info = true

[features.multi_agent_v2]
enabled = true
subagent_developer_instructions = "Use the bounded task instructions."

[mcp_servers.docs]
url = "https://docs.example.test/mcp"
omit_tools_from = ["code_mode", "deferred"]
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("accepts representative Codex 0.148 configuration surfaces", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
responses_api_metadata = { product_surface = "codex-config-test" }

[goals]
max_goal_token_budget = 20000

[features]
guardian_enhanced_node_repl_transcripts = true
guardian_node_repl_transcript_images = true
psp = true
retain_client_developer_messages = true
unbounded_connection_retries = true

[features.guardianv2]
enabled = true
max_action_tokens = 2000
max_classifier_instruction_tokens = 2000
reasoning_effort = "high"
review_threshold = 0.7

[features.guardianv2.transcript]
max_message_entry_tokens = 1000
max_message_transcript_tokens = 5000
max_recent_non_user_entries = 5
max_tool_entry_tokens = 1000
max_tool_transcript_tokens = 5000
sources = ["tool_calls", "tool_outputs", "reasoning"]

[mcp_servers.local]
url = "http://127.0.0.1:8765/mcp"
http_headers_helper = "auth-cli headers"

[mcp_servers.local.oauth]
callback_port = 8766
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("accepts representative Codex 0.149 configuration surfaces", async () => {
    const inspection = await inspectCodexConfig(
      `model = "anything"
model_provider = "amazon-bedrock-runtime"

[skills]
max_context_tokens = 8000

[features]
cwd_relative_turn_diffs = true
in_app_chat = true
in_app_dictation = true

[features.guardianv2]
enabled = true
max_parent_compaction_tokens = 4000
max_tool_call_lag = 2
review_scope = { sandboxed_exec_commands = false }

[features.guardianv2.transcript]
include_images = true

[model_providers.amazon-bedrock]
base_url = "https://bedrock.example.test/v1"
http_headers = { x-example = "mantle" }
supports_standalone_web_search = false

[model_providers.amazon-bedrock.auth]
command = "fetch-bedrock-token"

[model_providers.amazon-bedrock-runtime]
base_url = "https://bedrock-runtime.example.test/v1"
http_headers = { x-example = "runtime" }

[model_providers.amazon-bedrock-runtime.aws]
profile = "example"
region = "us-west-2"

[model_providers.amazon-bedrock-runtime.aws.auth_refresh]
command = "aws"
args = ["sso", "login", "--profile", "example"]
timeout_ms = 300000

[tui.keymap.global]
open_agents = "f12"

[tui.keymap.agents]
search = "f6"
new_task = "f7"
toggle_grouping = "f8"
rename = "f9"
stop = "f10"

[tui.keymap.vim_normal]
replace_char = "r"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("accepts representative Codex 0.151 configuration surfaces", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"
mcp_optional_startup_grace_ms = 250
hooks = { Interrupt = [] }
browser_use = { allow_history_access = false, default_origin_policy = { access = "deny", downloads = "deny", full_cdp_access = "deny", uploads = "deny" }, origins = { "https://example.test" = { access = "allow", downloads = "allow" } } }
computer_use = { default_app_access = "deny", macos = { bundle_ids = { "com.apple.Safari" = "allow" } }, windows = { aumids = { "Example.App" = "allow" }, exes = [{ publisher_name = "Example", product_name = "Browser", binary_name = "browser.exe", access = "allow" }] } }

[features]
bedrock_setup_wizard = true
code_mode_prewarm = true
compaction_image_budget = true
content_item_kinds = true
guardian_ext = true
in_app_local_automation = true
shell_snapshot_v2 = true
skip_host_skill_discovery = true
step_model_switching = true
transcript_v2 = true
write_stdin_approval = true

[features.guardianv2]
enabled = true
free_guardian = true
persist_scores = true
reuse_parent_compaction = true
review_scope = { computer_use_only = true }

[features.network_proxy]
credential_broker = true

[features.token_budget]
enabled = true
use_history_notes_extension = true

[otel.tool_result]
max_bytes = 4096

[mcp_servers.docs]
url = "https://example.test/mcp"

[mcp_servers.docs.oauth]
callback_url = "http://127.0.0.1:1455/callback"

[tui.keymap.chat]
next_permission_mode = "ctrl-right"
previous_permission_mode = "ctrl-left"
toggle_voice_mute = "ctrl-m"

[tui.keymap.vim_normal]
find_forward = "f"
jump_top = "g g"
repeat_last_change = "."

[tui.keymap.vim_operator]
motion_find_forward = "f"
motion_jump_top = "g g"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
  });

  test("accepts representative Codex 0.152 configuration surfaces", async () => {
    const inspection = await inspectCodexConfig(
      `model = "gpt-5.6-sol"

[tools.update_plan]
enabled = true

[features]
local_thread_store_shared_compression = false
omit_app_server_notification_media = true
powershell_shell_version = true

[features.sleep_tool]
enabled = true
mode = "always_on"

[mcp_servers.docs]
url = "https://example.test/mcp"

[mcp_servers.docs.tools.search]
output_token_limit = 30000

[tui.keymap.vim_search]
backward = "?"
forward = "/"
next = "n"
previous = "shift-n"
`,
      "target",
      { requireModel: true },
    );

    expect(inspection).toEqual({ valid: true, clean: true, issues: [] });
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

  test("enforces model service tiers while accepting aliases and model-specific tiers", async () => {
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
    const ultrafastSol = await inspectCodexConfig(
      'model = "gpt-5.6-sol"\nservice_tier = "ultrafast"\n',
      "target",
      { requireModel: true },
    );
    const ultrafastTerra = await inspectCodexConfig(
      'model = "gpt-5.6-terra"\nservice_tier = "ultrafast"\n',
      "target",
      { requireModel: true },
    );

    expect(unsupported.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_service_tier", path: "service_tier" }),
    );
    expect(fast.valid).toBe(true);
    expect(ultrafastSol.valid).toBe(true);
    expect(ultrafastTerra.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_service_tier", path: "service_tier" }),
    );
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

  test("enforces Bedrock authentication constraints from Codex runtime", async () => {
    const inspection = await inspectCodexConfig(
      `model = "anything"
model_provider = "amazon-bedrock-runtime"

[model_providers.amazon-bedrock-runtime]
env_key = "BEDROCK_TOKEN"

[model_providers.amazon-bedrock-runtime.aws]
region = "us-west-2"

[model_providers.amazon-bedrock-runtime.aws.auth_refresh]
command = "custom-refresh"

[model_providers.amazon-bedrock.auth]
command = "   "
`,
      "target",
      { requireModel: true },
    );

    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "amazon_bedrock_override",
          path: "model_providers.amazon-bedrock-runtime.env_key",
        }),
        expect.objectContaining({
          code: "model_provider_aws_refresh_command",
          path: "model_providers.amazon-bedrock-runtime.aws.auth_refresh.command",
        }),
        expect.objectContaining({
          code: "model_provider_auth_command_required",
          path: "model_providers.amazon-bedrock.auth.command",
        }),
      ]),
    );
    expect(inspection.valid).toBe(false);
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
