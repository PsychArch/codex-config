import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { describe, expect, test } from "vitest";
import { applyConfig, doctor } from "../src/commands.js";
import { planCodexMigrations } from "../src/codex-migrations.js";
import { inspectCodexConfig } from "../src/codex-policy.js";
import { CODEX_TARGET } from "../src/codex-target.generated.js";

const inspect = (text: string) => inspectCodexConfig(text, "target", { requireModel: true });

describe("Codex 0.162.1 compatibility", () => {
  test("pins the stable release and retains the default and model capabilities", () => {
    expect(CODEX_TARGET.sourceRevision).toBe("092d3acd6bec3e3a14bdc7e7a2810ab628ab759d");
    expect(CODEX_TARGET.defaultModel).toBe("gpt-6.1-sol");
    expect(CODEX_TARGET.minimumClientVersion).toBe("0.155.0");
    expect(CODEX_TARGET.removedFeatureKeys).toContain("apply_patch_preserve_line_endings");
  });

  test.each([false, true])("removes the redundant patch flag (%s) from root and legacy profiles", async (enabled) => {
    const config = `model = "gpt-6.1-sol"
[features]
apply_patch_preserve_line_endings = ${enabled}
instant_interrupt = false
[profiles.work.features]
apply_patch_preserve_line_endings = ${enabled}
incremental_tools = true
`;
    expect((await inspect(config)).issues).toContainEqual(expect.objectContaining({
      code: "removed_feature", path: "features.apply_patch_preserve_line_endings",
    }));
    const plan = planCodexMigrations(config);
    expect(parse(plan.outputText)).toEqual({
      model: "gpt-6.1-sol", features: { instant_interrupt: false },
      profiles: { work: { features: { incremental_tools: true } } },
    });
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
    expect((await inspect(plan.outputText)).valid).toBe(true);
  });

  test("apply preserves the new explicit settings and remains clean and idempotent", async () => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-162-")), "config.toml");
    const settings = {
      model: "custom-model", model_provider: "custom", daybreak: true,
      model_providers: { custom: {
        name: "Custom",
        base_url: "https://example.test/v1",
        capabilities: { external_web_access: false, remote_compaction: "unsupported" },
      } },
      auto_review: {
        experimental_conversation_history_prompt: "Retrieve relevant history.",
        conversation_history_max_output_tokens: 4000,
      },
      features: {
        instant_interrupt: false, cli_daybreak: true, ultrafast_mode: true,
        api_key_cyber_access_programs: true, browser_annotation_api: false,
        code_mode_only_strict_3p_tools: true, code_mode_tool_search: true,
        guardian_conversation_history_tools: true, guardian_root_handoff_context: true,
        guardianv2_decisions_comparison: true, in_app_voice: false,
        incremental_tools: true, login_shell_package_path: true,
        model_catalog_in_context: true, multi_agent_v2_dynamic_tools: true,
        stable_environment_tools: true,
        guardianv2: {
          enabled: true, transcript_mode: "json", async_classifier_mode: "conversation",
          async_classifier_conversation_token_limit: 100000,
        },
        multi_agent_v2: { enabled: true, message_board_remote: {
          url: "https://example.test/board", bearer_token_env_var: "BOARD_TOKEN",
        } },
      },
      audio: { microphone_channel: [1, 2] },
      tui: {
        mouse_scroll_speed: 0.5, agents_overview_grouping: "model",
        keymap: { agents: { fork: "ctrl+f", toggle_pin: "ctrl+p" } },
      },
      mcp_servers: { docs: { url: "https://example.test/mcp" } },
    };
    await writeFile(target, stringify(settings));
    await applyConfig({ target });
    expect(parse(await readFile(target, "utf8"))).toMatchObject(settings);
    expect((await doctor({ target })).ok).toBe(true);
    expect((await applyConfig({ target })).changed).toBe(false);
  });

  test.each([
    '[model_providers.custom.capabilities]\nremote_compaction = "v1"',
    '[model_providers.custom.capabilities]\nexternal_web_access = "yes"',
    '[features.guardianv2]\nasync_classifier_mode = "stream"',
    '[features.guardianv2]\nasync_classifier_conversation_token_limit = 0',
    '[features.guardianv2]\ntranscript_mode = "xml"',
    '[auto_review]\nconversation_history_max_output_tokens = 0',
    '[audio]\nmicrophone_channel = 0',
    '[audio]\nmicrophone_channel = [1, 65536]',
    '[tui]\nmouse_scroll_speed = 0',
    '[tui]\nmouse_scroll_speed = -0.5',
    '[tui]\nmouse_scroll_speed = inf',
    '[tui]\nmouse_scroll_speed = nan',
    '[tui]\nagents_overview_grouping = "owner"',
    '[features.multi_agent_v2.message_board_remote]\nbearer_token_env_var = "BOARD_TOKEN"',
  ])("rejects invalid new settings before writing: %s", async (extra) => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-162-invalid-")), "config.toml");
    const config = `model = "gpt-6.1-sol"\n${extra}\n`;
    await writeFile(target, config);
    expect((await inspect(config)).valid).toBe(false);
    await expect(applyConfig({ target })).rejects.toThrow("not compatible");
    expect(await readFile(target, "utf8")).toBe(config);
  });

  test.each([{ channels: 1 }, { channels: [1, 2] }, { channels: [] }])("accepts upstream microphone channel selection $channels", async ({ channels }) => {
    expect(await inspect(stringify({ model: "gpt-6.1-sol", audio: { microphone_channel: channels } })))
      .toEqual({ valid: true, clean: true, issues: [] });
  });

  test.each([false, "retired", { client_id: "client", resource: "resource" }])(
    "preserves any retired plugin EMA overlay and reports the disabled server (%j)", async (overlay) => {
      const target = join(await mkdtemp(join(tmpdir(), "codex-162-ema-")), "config.toml");
      const config = stringify({ model: "gpt-6.1-sol", plugins: { "docs@example": {
        enabled: true, mcp_servers: { "docs.v1": { enabled: true, ema_auth: overlay } },
      } } });
      const before = await inspect(config);
      expect(before.valid).toBe(true);
      expect(before.clean).toBe(false);
      expect(before.issues).toEqual([expect.objectContaining({
        severity: "warning", code: "unsupported_plugin_ema_auth",
        path: 'plugins."docs@example".mcp_servers."docs.v1".ema_auth',
      })]);
      expect(planCodexMigrations(config).changed).toBe(false);
      await writeFile(target, config);
      await applyConfig({ target });
      expect(parse(await readFile(target, "utf8")).plugins).toEqual(parse(config).plugins);
      const result = await doctor({ target });
      expect(result.ok).toBe(false);
      expect(result.target.compatible).toBe(true);
      expect(result.target.issues).toEqual(before.issues);
      expect((await applyConfig({ target })).changed).toBe(false);
    },
  );

  test("keeps unrelated plugin schema errors while recognizing the retired EMA overlay", async () => {
    const result = await inspect(`model = "gpt-6.1-sol"
[plugins.docs.mcp_servers.docs]
enabled = "yes"
ema_auth = true
unknown = true
`);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "schema_type", path: "plugins.docs.mcp_servers.docs.enabled" }),
      expect.objectContaining({ code: "schema_additionalProperties", path: "plugins.docs.mcp_servers.docs.unknown" }),
      expect.objectContaining({ code: "unsupported_plugin_ema_auth" }),
    ]));
    expect((await inspect('model = "gpt-6.1-sol"\n[model_providers.custom]\nema_auth = true\n')).valid).toBe(false);
  });

  test("does not request experimental defaults or the removed patch flag in the template", async () => {
    const template = parse(await readFile("config.toml.template", "utf8"));
    expect(template).not.toHaveProperty("daybreak");
    expect(template).not.toHaveProperty("auto_review");
    expect(template.features).toEqual({
      default_mode_request_user_input: true, memories: true, multi_agent_v2: true,
    });
  });
});
