import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import { applyConfig, doctor } from "../src/commands.js";
import { planCodexMigrations } from "../src/codex-migrations.js";
import { inspectCodexConfig } from "../src/codex-policy.js";
import { CODEX_TARGET } from "../src/codex-target.generated.js";

const config = (settings: string) => `model = "gpt-6.2-sol"\n${settings}`;
const inspect = (settings: string) => inspectCodexConfig(config(settings), "target", { requireModel: true });
const enabledBudget = "[features.rollout_budget]\nenabled = true\n";

describe("Codex 0.172.0 compatibility", () => {
  test("pins the stable source and recognizes both GPT-6.2 models", async () => {
    expect(CODEX_TARGET.sourceRevision).toBe("3d86e43b075adeba2193ec5c22ac92f55afd82e6");
    expect(CODEX_TARGET.defaultModel).toBe("gpt-6.2-sol");
    expect(CODEX_TARGET.minimumClientVersion).toBe("0.166.0");
    expect(CODEX_TARGET.models).toHaveLength(10);
    expect(CODEX_TARGET.models.slice(0, 2)).toMatchObject([
      { id: "gpt-6.2-sol", contextWindow: 500000, maxContextWindow: 872000, minimumClientVersion: "0.166.0" },
      { id: "gpt-6.2-astra", contextWindow: 272000, maxContextWindow: 872000, minimumClientVersion: "0.166.0" },
    ]);
    expect((await inspectCodexConfig('model = "gpt-6.2-astra"\n', "target", { requireModel: true })).clean).toBe(true);
  });

  test.each([false, true])("removes obsolete gRPC flag %s from root and legacy profiles", async (enabled) => {
    const input = config(`[features]
code_mode_host_grpc = ${enabled}
mcp_lazy_stdio_startup = false
[profiles.work.features]
code_mode_host_grpc = ${enabled}
`);
    expect((await inspectCodexConfig(input, "target", { requireModel: true })).issues).toContainEqual(
      expect.objectContaining({ code: "removed_feature", path: "features.code_mode_host_grpc" }),
    );
    const migrated = planCodexMigrations(input);
    const parsed = parse(migrated.outputText);
    expect(parsed.features).toEqual({ mcp_lazy_stdio_startup: false });
    expect(parsed).not.toHaveProperty("profiles.work.features.code_mode_host_grpc");
    expect(planCodexMigrations(migrated.outputText).changed).toBe(false);
  });

  test("preserves new settings through apply and doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-172-"));
    const target = join(dir, "config.toml");
    const original = config(`[responses]
process_mode = "after_complete_response"
[code_mode]
heartbeat_interval_s = 30
[rollout_trace]
max_bytes = 1024
[apps.demo.tools.search]
approvals_reviewer = "user"
[features.rollout_budget]
enabled = true
limit_budget = 100.5
reminder_at_context_start = false
reminder_at_remaining_tokens = [100]
`);
    try {
      await writeFile(target, original);
      await applyConfig({ target });
      expect(parse(await readFile(target, "utf8"))).toMatchObject(parse(original));
      expect((await doctor({ target })).ok).toBe(true);
      expect((await applyConfig({ target })).changed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["legacy integer allowance above 2^53", enabledBudget +
      "limit_tokens = 9007199254740993\nreminder_at_remaining_tokens = [9007199254740992]\n"],
    ["fractional f64 allowance above 2^53", enabledBudget +
      "limit_budget = 9007199254740996.0\nreminder_at_remaining_tokens = [9007199254740995]\n"],
    ["empty reminder array", enabledBudget +
      "limit_budget = 0.5\nreminder_at_remaining_tokens = []\n"],
    ["inactive table", "[features.rollout_budget]\nlimit_tokens = 10\nreminder_at_remaining_tokens = [10]\n"],
  ])("accepts rollout budget with %s", async (_name, settings) => {
    expect((await inspect(settings)).clean).toBe(true);
  });

  test.each([
    ["[features]\nrollout_budget = true\n", "rollout_budget_limit_required"],
    [enabledBudget, "rollout_budget_limit_required"],
    ["[features.rollout_budget]\nenabled = false\nlimit_tokens = 5\nlimit_budget = 7.5\n",
      "rollout_budget_conflicting_limits"],
    [enabledBudget + "limit_budget = 7.5\nreminder_at_context_start = false\n", "rollout_budget_reminders_required"],
    [enabledBudget + "limit_budget = 7.0\nreminder_at_remaining_tokens = [7]\n", "rollout_budget_invalid_threshold"],
    [enabledBudget + "limit_budget = 7.5\nreminder_at_remaining_tokens = [0]\n", "rollout_budget_invalid_threshold"],
    [enabledBudget + "limit_tokens = 9007199254740993\nreminder_at_remaining_tokens = [9007199254740993]\n",
      "rollout_budget_invalid_threshold"],
  ])("reports invalid rollout budgets with %s", async (settings, code) => {
    expect((await inspect(settings)).issues).toContainEqual(expect.objectContaining({ code }));
  });

  test("applies the Guardian V3 cap independently using trimmed UTF-8 byte counts", async () => {
    const guardian = "[features.guardianv3]\nenabled = false\nmax_instruction_tokens = 1\n";
    const routing = '[features.guardianv3.housekeeper]\nrouting_instructions = "\\u0085éé "\n';
    const reviewer = '[features.guardianv3.reviewer]\nretrieval_instructions = " abcd "\n';
    expect((await inspect(guardian + routing + reviewer)).clean).toBe(true);
    const invalid = await inspect(guardian + routing.replace("éé", "ééx") + reviewer.replace("abcd", "ééx"));
    expect(invalid.issues).toEqual([
      expect.objectContaining({ code: "guardian_instruction_token_limit", path: "features.guardianv3.housekeeper.routing_instructions" }),
      expect.objectContaining({ code: "guardian_instruction_token_limit", path: "features.guardianv3.reviewer.retrieval_instructions" }),
    ]);
  });

  test("validates explicit TCP conflicts and respects feature overrides for a direct profile", async () => {
    const feature = "[features.network_proxy]\nenabled = true\ntransparent_tcp = true\nenable_socks5 = false\n";
    const profile = 'default_permissions = "local"\n[permissions.local.network]\nenabled = true\ntransparent_tcp = true\nenable_socks5 = false\n';
    const enabled = "[features]\nnetwork_proxy = true\n";
    const code = "network_transparent_tcp_requires_socks5";
    expect((await inspect(feature)).issues).toContainEqual(expect.objectContaining({
      code, path: "features.network_proxy.transparent_tcp",
    }));
    expect((await inspect(profile + enabled)).issues).toContainEqual(expect.objectContaining({
      code, path: "permissions.local.network.transparent_tcp",
    }));
    expect((await inspect(profile + "[features.network_proxy]\nenabled = true\nenable_socks5 = true\n")).clean).toBe(true);
    expect((await inspect(feature.replace("enabled = true", "enabled = false"))).clean).toBe(true);
    expect((await inspect(profile)).clean).toBe(true);
  });

  test.each([
    [enabledBudget + "limit_budget = 7.5\n", "rollout_budget_reminders_required"],
    ['[features.guardianv3]\nmax_instruction_tokens = 1\n[features.guardianv3.reviewer]\nretrieval_instructions = "abcde"\n',
      "guardian_instruction_token_limit"],
    ["[features.network_proxy]\nenabled = true\ntransparent_tcp = true\nenable_socks5 = false\n",
      "network_transparent_tcp_requires_socks5"],
  ])("reports invalid config and preserves its bytes after rejected apply", async (settings, code) => {
    const dir = await mkdtemp(join(tmpdir(), "codex-172-invalid-"));
    const target = join(dir, "config.toml");
    const original = config(settings);
    try {
      await writeFile(target, original);
      expect((await doctor({ target })).target.issues).toContainEqual(expect.objectContaining({ code }));
      await expect(applyConfig({ target })).rejects.toThrow("not compatible");
      expect(await readFile(target, "utf8")).toBe(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
