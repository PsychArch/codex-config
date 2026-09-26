import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { describe, expect, test } from "vitest";
import { applyConfig, doctor } from "../src/commands.js";
import { planCodexMigrations } from "../src/codex-migrations.js";
import { inspectCodexConfig } from "../src/codex-policy.js";

const inspect = (text: string) => inspectCodexConfig(text, "target", { requireModel: true });

describe("Codex 0.157 compatibility", () => {
  test.each(["gpt-6-sol", "gpt-6-luna"])("preserves %s through apply and doctor", async (model) => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-157-")), "work.config.toml");
    await writeFile(target, `model = "${model}"
model_context_window = 600000
[mcp_servers.docs]
url = "https://example.test/mcp"
[tui]
alternate_screen = "always"
`);
    await applyConfig({ target });
    expect(parse(await readFile(target, "utf8"))).toMatchObject({
      model, model_context_window: 600000,
      mcp_servers: { docs: { url: "https://example.test/mcp" } },
      tui: { alternate_screen: "always" },
    });
    expect((await doctor({ target })).ok).toBe(true);
    expect((await applyConfig({ target })).changed).toBe(false);
  });

  test("preserves an unfamiliar model and reports unverified capabilities", async () => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-157-")), "config.toml");
    await writeFile(target, 'model = "future-model"\n');
    await applyConfig({ target });
    expect(parse(await readFile(target, "utf8")).model).toBe("future-model");
    expect((await doctor({ target })).target.issues).toContainEqual(expect.objectContaining({
      severity: "warning", code: "unverified_model", path: "model",
    }));
    expect((await applyConfig({ target })).changed).toBe(false);
    await applyConfig({ target, force: true });
    expect(parse(await readFile(target, "utf8")).model).toBe("gpt-6-astra");
  });

  test.each([undefined, false, true])("migrates aliases preserving canonical %s", async (canonical) => {
    const plan = planCodexMigrations(`model = "gpt-6-astra"
[orchestrator.skills]
enabled = false
[orchestrator.mcp]
enabled = false
${canonical === undefined ? "" : `[cloud.skills]\nenabled = ${canonical}`}
[features]
transcript_v2 = false
personality = true
remote_compaction_v2 = false
guardian_ext = true
[features.guardianv2]
enabled = false
thread_context = false
[tui]
${canonical === undefined ? "" : `fullscreen_transcript = ${canonical}`}
[windows]
sandbox = "elevated"
sandbox_private_desktop = false
[profiles.work.features]
personality = true
guardian_ext = false
[profiles.work.features.guardianv2]
thread_context = false
`);
    const result = parse(plan.outputText);
    expect(result).toMatchObject({
      cloud: { skills: { enabled: canonical ?? false } },
      orchestrator: { mcp: { enabled: false } },
      tui: { fullscreen_transcript: canonical ?? false },
      features: { guardianv2: { enabled: false, thread_context: false } },
      windows: { sandbox: "elevated" },
      profiles: { work: { features: { guardianv2: { thread_context: false } } } },
    });
    expect(result.features).not.toHaveProperty("transcript_v2");
    expect(result.features).not.toHaveProperty("personality");
    expect(result.features).not.toHaveProperty("guardian_ext");
    expect(result.features).not.toHaveProperty("remote_compaction_v2");
    expect(result.windows).not.toHaveProperty("sandbox_private_desktop");
    expect(result.orchestrator).not.toHaveProperty("skills.enabled");
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
    expect((await inspect(plan.outputText)).valid).toBe(true);
  });

  test("reports obsolete flags and the cloud-skills alias", async () => {
    const result = await inspect(`model = "gpt-6-astra"
[features]
guardian_ext = false
personality = true
remote_compaction_v2 = true
transcript_v2 = false
[orchestrator.skills]
enabled = false
`);
    expect(result.issues.map(({ path }) => path).sort()).toEqual([
      "features.guardian_ext", "features.personality", "features.remote_compaction_v2",
      "features.transcript_v2", "orchestrator.skills.enabled",
    ]);
  });

  test("moves the old Guardian context flag while preserving boolean and canonical settings", () => {
    const result = planCodexMigrations(`model = "gpt-6-astra"
[features]
guardianv2 = false
guardian_thread_context = false
[profiles.work.features]
guardian_thread_context = true
[profiles.work.features.guardianv2]
thread_context = false
`);
    expect(parse(result.outputText)).toEqual({
      model: "gpt-6-astra",
      features: { guardianv2: { enabled: false, thread_context: false } },
      profiles: { work: { features: { guardianv2: { thread_context: false } } } },
    });
    expect(planCodexMigrations(result.outputText).changed).toBe(false);
  });

  test("accepts new settings without enabling optional memory or compaction modes", async () => {
    expect(await inspect(`model = "gpt-6-sol"
model_post_turn_compact_threshold_percent = 80
thread_unload_delay_secs = 120
[cloud.skills]
enabled = false
[memories]
version = "v2"
dual_write = false
[tui]
fullscreen_transcript = true
question_esc_back = true
[tui.effects]
starfield = false
[tui.rendering]
tables = false
`)).toEqual({ valid: true, clean: true, issues: [] });
    const template = parse(await readFile("config.toml.template", "utf8"));
    expect(template).not.toHaveProperty("memories.version");
    expect(template).not.toHaveProperty("model_post_turn_compact_threshold_percent");
  });

  test("enforces new model reasoning and compaction bounds", async () => {
    expect((await inspect('model = "gpt-6-sol"\nmodel_reasoning_effort = "ultra"\n')).valid).toBe(true);
    expect((await inspect('model = "gpt-6-luna"\nmodel_reasoning_effort = "ultra"\n')).issues)
      .toContainEqual(expect.objectContaining({ code: "unsupported_reasoning_effort" }));
    expect((await inspect('model = "gpt-6-astra"\nmodel_post_turn_compact_threshold_percent = 101\n')).valid).toBe(false);
  });

  test("requires EMA auth for an MCP authorization server issuer", async () => {
    const config = 'model = "gpt-6-astra"\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\n';
    const oauth = '[mcp_servers.docs.oauth]\nauthorization_server_issuer = "https://idp.example.test"\n';
    expect((await inspect(config + oauth)).issues).toContainEqual(expect.objectContaining({ code: "mcp_invalid_oauth_issuer" }));
    expect((await inspect(config + 'auth = "ema_auth"\n' + oauth)).valid).toBe(true);
  });

  test.each(["aws-export", "/usr/local/bin/aws-export"])("accepts AWS credential exporter %s", async (command) => {
    const config = stringify({ model: "gpt-6-astra", model_provider: "amazon-bedrock", model_providers: {
      "amazon-bedrock": { aws: { credential_export: { command, args: ["--json"] } } },
    } });
    expect(await inspect(config)).toEqual({ valid: true, clean: true, issues: [] });
  });

  test.each(["", " ", "./export", "../export", "bin/export", ".", ".."])("rejects invalid AWS credential exporter %s", async (command) => {
    const config = stringify({ model: "gpt-6-astra", model_provider: "amazon-bedrock", model_providers: {
      "amazon-bedrock": { aws: { profile: "work", credential_export: { command } } },
    } });
    const result = await inspect(config);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "model_provider_aws_export_command" }),
      expect.objectContaining({ code: "model_provider_aws_export_conflict" }),
    ]));
  });
});
