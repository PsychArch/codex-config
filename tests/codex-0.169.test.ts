import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { describe, expect, test } from "vitest";
import { applyConfig, doctor } from "../src/commands.js";
import { planCodexMigrations } from "../src/codex-migrations.js";
import { inspectCodexConfig } from "../src/codex-policy.js";
import { CODEX_TARGET } from "../src/codex-target.generated.js";

const inspect = (settings: Record<string, unknown>) => inspectCodexConfig(
  stringify({ model: "gpt-6.1-sol", ...settings }), "target", { requireModel: true },
);
const exportedGateway = (gateway: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) => ({
  model_providers: { gateway: { name: "Gateway", base_url: "https://gateway.example.test/v1",
    model_catalog_url: "https://gateway.example.test:443/models", ...provider,
    gateway_oauth: { credential_export: { command: "test-export-do-not-execute", args: ["--token"] }, ...gateway },
  } },
});
const oauthGateway = (url: string) => ({ model_providers: { gateway: {
  name: "Gateway", base_url: "https://gateway.example.test/v1", gateway_oauth: {
    authorization_url: "https://idp.example.test/auth", token_url: "https://idp.example.test/token",
    client_id: "codex", device_authorization_url: url,
  },
} } });
const limits = (minimum = 117100, entry = 9000, maximum?: number) => ({
  min_total_section_tokens: minimum, max_section_entry_tokens: entry,
  ...(maximum === undefined ? {} : { max_total_section_tokens: maximum }),
});
const elastic = (sections: Record<string, unknown> = { transcript_messages: limits() }, enabled = true) => ({
  features: { guardianv2: { sync_elastic_budgeting: enabled, sync_elastic_sections: sections } },
});

describe("Codex 0.169.0 compatibility", () => {
  test("pins the stable source and retains all eight model records", () => {
    expect(CODEX_TARGET.sourceRevision).toBe("d32063f96c2dff1dc96af839b3952abb6acfeda4");
    expect(CODEX_TARGET.models).toHaveLength(8);
    expect(CODEX_TARGET.defaultModel).toBe("gpt-6.1-sol");
    expect(CODEX_TARGET.minimumClientVersion).toBe("0.155.0");
  });

  test.each([undefined, { kind: "header", name: "X-Gateway-Token" }, { kind: "cookie", name: "session" }])(
    "preserves gateway export and new settings idempotently with delivery %#", async (delivery) => {
      const target = join(await mkdtemp(join(tmpdir(), "codex-169-")), "config.toml");
      const settings = { model: "gpt-6.1-terra", ...exportedGateway(delivery ? { delivery } : {}),
        ...elastic(), tools: { client_search_provider: "search_mcp" },
        tui: { notification_method: "osc777", sidebar_width_percent: 33, collapse_turn_details: true,
          default_hosts: { "/project": { "local-user": "local" } },
          keymap: { global: { close_sidebar_tab: "ctrl+w", focus_main_composer: "ctrl+g m" } } },
      };
      await writeFile(target, stringify(settings));
      await applyConfig({ target });
      expect(parse(await readFile(target, "utf8"))).toMatchObject(settings);
      expect((await doctor({ target })).ok).toBe(true);
      expect((await applyConfig({ target })).changed).toBe(false);
    },
  );

  test.each(["https://idp.example.test/device", "http://127.0.0.1:8080/device"])(
    "accepts device authorization URL %s", async (url) => {
      expect((await inspect(oauthGateway(url))).clean).toBe(true);
    },
  );

  test("allows exported secondary credentials alongside primary command auth", async () => {
    expect((await inspect(exportedGateway({ delivery: { kind: "header", name: "X-Gateway-Token" } },
      { auth: { command: "primary-token" } }))).clean).toBe(true);
  });

  test.each([true, false])("removes plugin prefetch (%s) at root and profile scope", async (enabled) => {
    const features = { plugin_discovery_prefetch: enabled, daemon_auto_start: false };
    const text = stringify({ model: "gpt-6.1-sol", features, profiles: { old: { features } } });
    expect((await inspect({ features })).issues).toContainEqual(expect.objectContaining({
      code: "removed_feature", path: "features.plugin_discovery_prefetch",
    }));
    const plan = planCodexMigrations(text);
    expect(parse(plan.outputText)).toMatchObject({ features: { daemon_auto_start: false },
      profiles: { old: { features: { daemon_auto_start: false } } } });
    expect(plan.outputText).not.toContain("plugin_discovery_prefetch");
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
  });

  test.each([true, false])("preserves deprecated multi_agent=%s and explains its remaining effect", async (enabled) => {
    const text = stringify({ model: "gpt-6.1-sol", features: { multi_agent: enabled } });
    expect(planCodexMigrations(text).outputText).toBe(text);
    expect((await inspect({ features: { multi_agent: enabled } })).issues).toContainEqual(expect.objectContaining({
      code: "deprecated_feature", path: "features.multi_agent", message: expect.stringContaining("V1 fallback"),
    }));
  });

  test("validates Guardian section aliases and leaves inactive budget constraints to activation", async () => {
    expect((await inspect(elastic({ transcript_messages: limits(), root_messages: limits(900, 900) }))).clean).toBe(true);
    expect((await inspect(elastic({ future_section: limits(0, 0) }, false))).clean).toBe(true);
    expect((await inspect(elastic({ transcript_messages: limits(117100, 9000, 117100) }))).clean).toBe(true);
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ...["", " ", ".", "..", "./export", "bin/export"].map((command): [string, Record<string, unknown>, string] =>
      ["export command", exportedGateway({ credential_export: { command } }), "invalid_gateway_oauth"]),
    ["export timeout", exportedGateway({ credential_export: { command: "export-token", timeout_ms: 0 } }), "schema_minimum"],
    ["mixed credential sources", exportedGateway({ authorization_url: "https://idp.example.test/auth",
      token_url: "https://idp.example.test/token", client_id: "codex" }), "schema_anyOf"],
    ...[{ kind: "header", name: "X-Token" }, { kind: "cookie", name: "session" }].map(
      (delivery): [string, Record<string, unknown>, string] => ["cross-origin export catalog",
        exportedGateway({ delivery }, { model_catalog_url: "https://other.example.test/models" }), "invalid_gateway_oauth"]),
    ["default export credential collision", exportedGateway({}, { env_key: "KEY" }), "invalid_gateway_oauth"],
    ["export header collision", exportedGateway({ delivery: { kind: "header", name: "X-Token" } },
      { env_http_headers: { "x-token": "TOKEN" } }), "invalid_gateway_oauth"],
    ...["http://idp.example.test/device", "https://user:private-placeholder@idp.example.test/device",
      "https://idp.example.test/device#fragment"].map((url): [string, Record<string, unknown>, string] =>
      ["device URL", oauthGateway(url), "invalid_gateway_oauth"]),
    ["missing sections", { features: { guardianv2: { sync_elastic_budgeting: true } } }, "guardian_elastic_sections_required"],
    ["empty sections", elastic({}), "guardian_elastic_sections_required"],
    ["unknown section", elastic({ unknown: limits() }), "guardian_elastic_unknown_section"],
    ["duplicate section alias", elastic({ root_messages: limits(900, 900), root_conversation_messages: limits(900, 900) }),
      "guardian_elastic_duplicate_section"],
    ["zero section minimum", elastic({ transcript_messages: limits(0, 1) }), "guardian_elastic_section_limits"],
    ["zero entry cap", elastic({ transcript_messages: limits(117100, 0) }), "guardian_elastic_section_limits"],
    ["entry above minimum", elastic({ transcript_messages: limits(10, 11) }), "guardian_elastic_section_limits"],
    ["entry above delivery cap", elastic({ transcript_messages: limits(117100, 9001) }), "guardian_elastic_section_limits"],
    ["maximum below minimum", elastic({ transcript_messages: limits(117100, 9000, 117099) }), "guardian_elastic_section_limits"],
    ["minimum total mismatch", elastic({ transcript_messages: limits(117101) }), "guardian_elastic_minimum_total"],
    ...["extra_policy", "experimental_policy_template", "experimental_denial_reconsideration_prompt"].map(
      (key): [string, Record<string, unknown>, string] => ["retired Guardian policy",
        { auto_review: { [key]: "Preserve this policy text for manual review." } }, "removed_guardian_policy"]),
    ["sidebar bound", { tui: { sidebar_width_percent: 100 } }, "schema_maximum"],
  ];
  test.each(invalid)("rejects %s without writing %#", async (_name, settings, code) => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-169-invalid-")), "config.toml");
    const text = stringify({ model: "gpt-6.1-sol", ...settings });
    await writeFile(target, text);
    const result = await inspect(settings);
    expect(result.issues).toContainEqual(expect.objectContaining({ code }));
    expect(JSON.stringify(result)).not.toContain("private-placeholder");
    expect((await doctor({ target })).target.compatible).toBe(false);
    await expect(applyConfig({ target })).rejects.toThrow("not compatible");
    expect(await readFile(target, "utf8")).toBe(text);
  });
});
