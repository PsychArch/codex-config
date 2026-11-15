import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { describe, expect, test } from "vitest";
import { applyConfig, doctor } from "../src/commands.js";
import { inspectCodexConfig } from "../src/codex-policy.js";
import { CODEX_TARGET } from "../src/codex-target.generated.js";

const limits = (minimum = 117100) => ({ min_total_section_tokens: minimum, max_section_entry_tokens: 900 });
const inspect = (settings: Record<string, unknown>) => inspectCodexConfig(
  stringify({ model: "gpt-6.1-sol", ...settings }), "target", { requireModel: true },
);
const elastic = (mode: string, sections?: Record<string, unknown>, enabled = true) => ({ features: { guardianv2: {
  [`${mode}_elastic_budgeting`]: enabled,
  ...(sections === undefined ? {} : { [`${mode}_elastic_sections`]: sections }),
} } });

describe("Codex 0.171.0-alpha.5 compatibility", () => {
  test("pins the published alpha source", () => {
    expect(CODEX_TARGET.sourceRevision).toBe("466da69cf6b72983f0d28c498c7cdb8d9bf2d114");
    expect(CODEX_TARGET.models).toHaveLength(8);
  });

  test.each(["sync", "async"])("validates %s budgets with defaults and aliases", async (mode) => {
    expect((await inspect(elastic(mode, { transcript_messages: limits(), root_messages: limits(900) }))).clean).toBe(true);
    expect((await inspect(elastic(mode, { future: limits(0) }, false))).clean).toBe(true);
  });

  test("accepts selected exec reservations only with named nested tools", async () => {
    expect((await inspect(elastic("sync", {
      transcript_messages: limits(116100),
      transcript_selected_exec_results: { ...limits(1000), nested_tool_names: ["functions.exec_command"] },
    }))).clean).toBe(true);
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["missing async sections", elastic("async"), "guardian_elastic_sections_required"],
    ["empty async sections", elastic("async", {}), "guardian_elastic_sections_required"],
    ["unknown async section", elastic("async", { future: limits() }), "guardian_elastic_unknown_section"],
    ["duplicate async alias", elastic("async", { root_messages: limits(900), root_conversation_messages: limits(900) }), "guardian_elastic_duplicate_section"],
    ["async total", elastic("async", { transcript_messages: limits(117101) }), "guardian_elastic_minimum_total"],
    ["async limits", elastic("async", { transcript_messages: { ...limits(), max_section_entry_tokens: 9001 } }), "guardian_elastic_section_limits"],
    ["selected exec in async", elastic("async", { transcript_selected_exec_results: { ...limits(1000), nested_tool_names: ["tool"] } }), "guardian_elastic_selected_exec_sync_only"],
    ...[undefined, [], [""], [" "]].map((names): [string, Record<string, unknown>, string] => [
      "missing or blank selected tools", elastic("sync", { transcript_selected_exec_results: {
        ...limits(1000), ...(names === undefined ? {} : { nested_tool_names: names }),
      } }), "guardian_elastic_nested_tool_names",
    ]),
    ["nested tools on other section", elastic("sync", { transcript_messages: { ...limits(), nested_tool_names: ["tool"] } }), "guardian_elastic_nested_tool_names"],
    ["status line provider missing tool", { tui: { status_line_provider: { server: "local" } } }, "schema_required"],
    ["OTel refresh zero", { otel: { headers_helper_refresh_interval_ms: 0 } }, "schema_minimum"],
    ["unreleased heartbeat", { code_mode: { heartbeat_interval_s: 30 } }, "schema_additionalProperties"],
  ];
  test.each(invalid)("rejects %s before writing %#", async (_name, settings, code) => {
    expect((await inspect(settings)).issues).toContainEqual(expect.objectContaining({ code }));
    const target = join(await mkdtemp(join(tmpdir(), "codex-171-invalid-")), "config.toml");
    const text = stringify({ model: "gpt-6.1-sol", ...settings });
    await writeFile(target, text);
    await expect(applyConfig({ target })).rejects.toThrow("not compatible");
    expect(await readFile(target, "utf8")).toBe(text);
  });

  test.each(["default", { server: "local", tool: "status" }])("preserves new explicit settings with provider %#", async (provider) => {
    const settings = { model: "gpt-6.1-terra", ...elastic("async", { transcript_messages: limits() }),
      tui: { status_line_provider: provider }, marketplaces: { local: { auto_update: true } },
      otel: { headers_helper: "never-executed-test-command", headers_helper_refresh_interval_ms: 1000 },
      features: { ...elastic("async", { transcript_messages: limits() }).features,
        catalog_apps_instructions: true, multi_environment_mcp: true, safe_image_decoder: false, tui_workspace: false },
    };
    const target = join(await mkdtemp(join(tmpdir(), "codex-171-")), "config.toml");
    await writeFile(target, stringify(settings));
    await applyConfig({ target });
    expect(parse(await readFile(target, "utf8"))).toMatchObject(settings);
    expect((await doctor({ target })).ok).toBe(true);
    expect((await applyConfig({ target })).changed).toBe(false);
  });
});
