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
const provider = (name: string, value: Record<string, unknown>) => ({ model_providers: { [name]: value } });
const signing = { aws_sigv4: { placeholder_access_key_id: "PLACEHOLDER_KEY", region: "us-east-1", service: "s3",
  access_key_id: { env_var: "TEST_AWS_KEY" }, secret_access_key: { env_var: "TEST_AWS_SECRET" } } };
const substitution = { body_secret_substitution: { replacements: [
  { placeholder: "OPAQUE_TEST_PLACEHOLDER", secret: { env_var: "TEST_SECRET" } },
] } };
const mitm = (value: Record<string, unknown>) => ({ permissions: { trusted: { network: { mitm: value } } } });

describe("Codex 0.167.1 compatibility", () => {
  test("retains Terra capabilities", () => {
    expect(CODEX_TARGET.models).toHaveLength(8);
    expect(CODEX_TARGET.defaultModel).toBe("gpt-6.1-sol");
    expect(CODEX_TARGET.models.find(({ id }) => id === "gpt-6.1-terra")).toMatchObject({
      contextWindow: 500000, maxContextWindow: 872000, minimumClientVersion: "0.153.0",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      serviceTiers: ["priority"], toolMode: "code_mode_only", multiAgentVersion: "v2",
    });
  });

  test("preserves new settings and Terra selection through apply, doctor, and a second apply", async () => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-167-")), "config.toml");
    const settings = { model: "gpt-6.1-terra", model_reasoning_effort: "ultra", service_tier: "fast",
      auto_review: { timeout_ms: 0 }, memories: { version: "v2", consolidation_service_tier: "fast" },
      otel: { log_sse_deltas: false }, plugins: { "demo@example": { apps: { docs: { enabled: false } } } },
      features: { guardianv3: { enabled: false }, rollout_budget: { enabled: false, enforce_limit: false, limit_tokens: 1000 },
        incremental_tools_legacy: true, code_mode_host_output_truncation: false },
      tui: { keymap: { global: { select_transcript: "ctrl+t" } } },
      ...mitm({ version: 2, actions: { sign: signing, substitute: substitution }, hooks: {
        request: { host: "bucket.example.test", methods: ["POST"], path_prefixes: ["/"], action: ["substitute", "sign"] },
      } }),
    };
    await writeFile(target, stringify(settings));
    await applyConfig({ target });
    const result = parse(await readFile(target, "utf8"));
    expect(result).toMatchObject(settings);
    expect(result).not.toHaveProperty("model_context_window");
    expect((await doctor({ target })).ok).toBe(true);
    expect((await applyConfig({ target })).changed).toBe(false);
  });

  test("diagnoses the ignored Guardian classifier override without rewriting it", async () => {
    const settings = { features: { guardianv2: { async_classifier_mode: "snapshot" } } };
    expect((await inspect(settings)).issues).toContainEqual(expect.objectContaining({ code: "ignored_guardian_classifier_mode" }));
    const text = stringify({ model: "gpt-6.1-sol", ...settings });
    expect(planCodexMigrations(text).outputText).toBe(text);
  });

  test.each([true, false])("cleans the removed code-mode flag (%s) at root and profile scope", async (enabled) => {
    const features = { code_mode_tool_description_first: enabled, multi_agent_v2: true };
    const text = stringify({ model: "gpt-6.1-sol", features, profiles: { old: { features } } });
    expect((await inspect({ features })).issues).toContainEqual(expect.objectContaining({ code: "removed_feature" }));
    const plan = planCodexMigrations(text);
    expect(parse(plan.outputText)).toMatchObject({ features: { multi_agent_v2: true },
      profiles: { old: { features: { multi_agent_v2: true } } } });
    expect(plan.outputText).not.toContain("code_mode_tool_description_first");
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
  });

  test.each([{}, { base_url: "https://vertex.example.test/v1", project_id: "project", location: "global",
    credential_file: join(tmpdir(), "adc.json"), auth: { command: "print-token" }, http_headers: { "x-test": "value" } }])(
    "accepts GCP selection and supported partial overrides %#", async (overrides) => {
      expect(await inspect({ model: "openai.gpt-6.1-terra", model_provider: "gcp", ...provider("gcp", overrides) }))
        .toEqual({ valid: true, clean: true, issues: [] });
    },
  );

  test.each(["chatgpt.com", "gov.chatgpt.com", "chat.openai.com", "chatgpt-staging.com", "api.chatgpt-staging.com"])(
    "accepts OpenAI catalog host %s", async (host) => {
      expect(await inspect(provider("openai", { model_catalog_url: `https://${host}/models` })))
        .toEqual({ valid: true, clean: true, issues: [] });
    },
  );

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ...["", "adc.json", "../adc.json"].map((path): [string, Record<string, unknown>, string] =>
      [`GCP relative path ${path}`, provider("gcp", { credential_file: path }), "gcp_invalid_credential_file"]),
    ["GCP unsupported override", provider("gcp", { env_key: "KEY" }), "gcp_provider_override"],
    ["GCP blank auth", provider("gcp", { auth: { command: " " } }), "model_provider_auth_command_required"],
    ["OpenAI inference override", provider("openai", { base_url: "https://example.test" }), "reserved_model_provider"],
    ...["http://chatgpt.com/models", "https://api.openai.com/models", "https://evilchatgpt.com/models",
      "https://chatgpt.com.evil.test/models", "https://user:placeholder@chatgpt.com/models",
      "https://@chatgpt.com/models", "https://%63hatgpt.com/models", "https://ｃhatgpt.com/models"].map(
      (url): [string, Record<string, unknown>, string] =>
        ["OpenAI catalog URL", provider("openai", { model_catalog_url: url }), "invalid_openai_catalog_url"]),
    ["signing version", mitm({ actions: { sign: signing } }), "network_mitm_version_required"],
    ["substitution version", mitm({ actions: { substitute: substitution } }), "network_mitm_version_required"],
    ...[signing, substitution].map((action): [string, Record<string, unknown>, string] =>
      ["duplicate proxy actions", mitm({ version: 2, actions: { a: action, b: action }, hooks: {
        request: { host: "example.test", methods: ["POST"], path_prefixes: ["/"], action: ["a", "b"] },
      } }), "network_mitm_duplicate_action"]),
    ["Guardian timeout bound", { auto_review: { timeout_ms: 4294967296 } }, "schema_format"],
  ];
  test.each(invalid)("rejects %s before writing and reports it in doctor", async (_name, settings, code) => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-167-invalid-")), "config.toml");
    const text = stringify({ model: "gpt-6.1-sol", ...settings });
    await writeFile(target, text);
    expect((await inspect(settings)).issues).toContainEqual(expect.objectContaining({ code }));
    expect((await doctor({ target })).target.compatible).toBe(false);
    await expect(applyConfig({ target })).rejects.toThrow("not compatible");
    expect(await readFile(target, "utf8")).toBe(text);
  });
});
