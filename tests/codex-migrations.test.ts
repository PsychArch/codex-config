import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import { planCodexMigrations } from "../src/codex-migrations.js";
import { CODEX_TARGET } from "../src/codex-target.generated.js";

describe("planCodexMigrations", () => {
  test("migrates the v0.2 defaults to the GPT-5.6 configuration", () => {
    const target = `approval_policy = "never"
sandbox_mode = "danger-full-access"
model = "gpt-5.5"
personality = "friendly"

[features]
memories = true
image_detail_original = true
terminal_resize_reflow = true
tool_search = true
view_image_tool = true

[tui]
status_line = ["model-name", "project", "status", "session-id"]
terminal_title = ["spinner", "project", "status", "thread"]

[mcp_servers.jina]
url = "https://example.test/jina"
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;
    const second = planCodexMigrations(plan.outputText);

    expect(parsed.model).toBe("gpt-5.6-sol");
    expect(parsed.default_permissions).toBe(":danger-full-access");
    expect(parsed).not.toHaveProperty("sandbox_mode");
    expect(parsed).not.toHaveProperty("personality");
    expect(parsed.features).toEqual({ memories: true });
    expect(parsed.tui.status_line).toEqual([
      "model",
      "project-name",
      "run-state",
      "thread-id",
    ]);
    expect(parsed.tui.terminal_title).toEqual([
      "activity",
      "project-name",
      "run-state",
      "thread-title",
    ]);
    expect(parsed.mcp_servers.jina.url).toBe("https://example.test/jina");
    expect(plan.operations).toEqual([
      { action: "update", path: "model" },
      { action: "add", path: "default_permissions" },
      { action: "update", path: "tui.status_line" },
      { action: "update", path: "tui.terminal_title" },
      { action: "remove", path: "personality" },
      { action: "remove", path: "sandbox_mode" },
      { action: "remove", path: "features.image_detail_original" },
      { action: "remove", path: "features.terminal_resize_reflow" },
      { action: "remove", path: "features.tool_search" },
      { action: "remove", path: "features.view_image_tool" },
    ]);
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("preserves a supported GPT-5.6 model and explicit permission profile", () => {
    const target = `model = "gpt-5.6-terra"
default_permissions = ":read-only"
`;

    const plan = planCodexMigrations(target);

    expect(plan.changed).toBe(false);
    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-terra",
      default_permissions: ":read-only",
    });
  });

  test("preserves custom provider model and personality settings", () => {
    const target = `model = "company-coder"
model_provider = "company"
personality = "friendly"

[model_providers.company]
name = "Company gateway"
base_url = "https://models.example.test/v1"
wire_api = "responses"
`;

    const plan = planCodexMigrations(target);

    expect(plan.changed).toBe(false);
    expect(plan.outputText).toBe(target);
    expect(parse(plan.outputText)).toEqual({
      model: "company-coder",
      model_provider: "company",
      personality: "friendly",
      model_providers: {
        company: {
          name: "Company gateway",
          base_url: "https://models.example.test/v1",
          wire_api: "responses",
        },
      },
    });
  });

  test("preserves models selected through OSS and custom catalog sources", () => {
    const oss = `model = "qwen3-coder"
oss_provider = "ollama"
personality = "friendly"
`;
    const catalog = `model = "company-catalog-model"
model_catalog_json = "/tmp/company-models.json"
personality = "pragmatic"
`;

    expect(planCodexMigrations(oss)).toMatchObject({ changed: false, outputText: oss });
    expect(planCodexMigrations(catalog)).toMatchObject({
      changed: false,
      outputText: catalog,
    });
  });

  test("preserves models selected through an OpenAI-compatible base URL", () => {
    const target = `model = "company-gateway-model"
openai_base_url = "https://gateway.example.test/v1"
personality = "friendly"
`;

    expect(planCodexMigrations(target)).toMatchObject({
      changed: false,
      outputText: target,
    });
  });

  test("removes every feature key retired from Codex source history", () => {
    expect(CODEX_TARGET.retiredFeatureKeys).toEqual(
      expect.arrayContaining([
        "parallel",
        "realtime_conversation_v2",
        "skills",
        "spawn_csv",
        "view_image_tool",
        "warnings",
      ]),
    );
    const target = `model = "gpt-5.6-sol"

[features]
${CODEX_TARGET.retiredFeatureKeys.map((key) => `${key} = true`).join("\n")}
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;
    const second = planCodexMigrations(plan.outputText);

    expect(parsed.features).toEqual({});
    expect(plan.operations).toEqual(
      CODEX_TARGET.retiredFeatureKeys.map((key) => ({
        action: "remove",
        path: `features.${key}`,
      })),
    );
    expect(second.changed).toBe(false);
  });

  test("maps each legacy sandbox mode without broadening permissions", () => {
    for (const [sandboxMode, permissionProfile] of [
      ["danger-full-access", ":danger-full-access"],
      ["workspace-write", ":workspace"],
      ["read-only", ":read-only"],
    ]) {
      const plan = planCodexMigrations(
        `model = "gpt-5.6-sol"\nsandbox_mode = "${sandboxMode}"\n`,
      );
      expect(parse(plan.outputText)).toEqual({
        model: "gpt-5.6-sol",
        default_permissions: permissionProfile,
      });
    }
  });

  test("preserves customized workspace-write sandbox semantics", () => {
    const target = `model = "gpt-5.6-sol"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = ["/tmp/project-cache"]
network_access = true
exclude_tmpdir_env_var = false
exclude_slash_tmp = false
`;

    const plan = planCodexMigrations(target);

    expect(plan.changed).toBe(false);
    expect(plan.outputText).toBe(target);
    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-sol",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: ["/tmp/project-cache"],
        network_access: true,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
    });

  });

  test("canonicalizes feature aliases and removals inside legacy profiles", () => {
    const target = `model = "gpt-5.6-sol"

[profiles.work]
model = "gpt-5.5"
personality = "friendly"

[profiles.work.features]
collab = true
memory_tool = true
multi_agent = false
image_detail_original = true

[profiles.personal.features]
imagegenext = true
terminal_resize_reflow = true
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;
    const second = planCodexMigrations(plan.outputText);

    expect(parsed.profiles.work).toEqual({
      model: "gpt-5.5",
      personality: "friendly",
      features: { memories: true, multi_agent: false },
    });
    expect(parsed.profiles.personal).toEqual({
      features: { image_generation: true },
    });
    expect(plan.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  test("migrates quoted prototype-like profile names without mutating prototypes", () => {
    const plan = planCodexMigrations(`[profiles."__proto__".features]
collab = true
`);
    const parsed = parse(plan.outputText) as Record<string, any>;

    expect(Object.prototype.hasOwnProperty.call(parsed.profiles, "__proto__")).toBe(true);
    expect(parsed.profiles["__proto__"]).toEqual({ features: { multi_agent: true } });
    expect(Object.prototype).not.toHaveProperty("multi_agent");
  });

  test("canonicalizes legacy feature aliases and web-search toggles", () => {
    const target = `model = "gpt-5.6-sol"
experimental_use_unified_exec_tool = false

[features]
collab = false
enable_experimental_windows_sandbox = true
imagegenext = true
memory_tool = true
web_search_cached = true
web_search_request = false
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;
    const second = planCodexMigrations(plan.outputText);

    expect(parsed.web_search).toBe("cached");
    expect(parsed).not.toHaveProperty("experimental_use_unified_exec_tool");
    expect(parsed.features).toEqual({
      image_generation: true,
      memories: true,
      multi_agent: false,
      unified_exec: false,
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        { action: "add", path: "web_search" },
        { action: "add", path: "features.image_generation" },
        { action: "add", path: "features.memories" },
        { action: "add", path: "features.multi_agent" },
        { action: "add", path: "features.unified_exec" },
        { action: "remove", path: "experimental_use_unified_exec_tool" },
        { action: "remove", path: "features.collab" },
        { action: "remove", path: "features.enable_experimental_windows_sandbox" },
        { action: "remove", path: "features.imagegenext" },
        { action: "remove", path: "features.memory_tool" },
        { action: "remove", path: "features.web_search_cached" },
        { action: "remove", path: "features.web_search_request" },
      ]),
    );
    expect(second.changed).toBe(false);
  });

  test("does not turn false feature search flags into an explicit disabled mode", () => {
    const plan = planCodexMigrations(`[features]
web_search = false
web_search_cached = false
web_search_request = false
`);

    expect(parse(plan.outputText)).toEqual({ features: {} });
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
  });

  test("keeps a canonical feature value when its legacy alias is also present", () => {
    const plan = planCodexMigrations(`model = "gpt-5.6-sol"

[features]
collab = true
multi_agent = false
`);

    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-sol",
      features: { multi_agent: false },
    });
  });

  test("preserves Codex runtime precedence when selected aliases conflict", () => {
    const plan = planCodexMigrations(`[features]
apps = false
connectors = true
exec_permission_approvals = false
request_permissions = true
memories = false
memory_tool = true
chronicle = false
telepathy = true
`);

    expect(parse(plan.outputText)).toEqual({
      features: {
        apps: true,
        exec_permission_approvals: true,
        memories: true,
        chronicle: true,
      },
    });
  });

  test("canonicalizes every historical memories key and is idempotent", () => {
    const cases = [
      {
        legacy: "max_raw_memories_for_global",
        canonical: "max_raw_memories_for_consolidation",
        literal: "17",
        expected: 17,
      },
      {
        legacy: "phase_1_model",
        canonical: "extract_model",
        literal: '"extractor-v1"',
        expected: "extractor-v1",
      },
      {
        legacy: "phase_2_model",
        canonical: "consolidation_model",
        literal: '"consolidator-v1"',
        expected: "consolidator-v1",
      },
      {
        legacy: "no_memories_if_mcp_or_web_search",
        canonical: "disable_on_external_context",
        literal: "true",
        expected: true,
      },
    ] as const;

    for (const { legacy, canonical, literal, expected } of cases) {
      const plan = planCodexMigrations(`[memories]\n${legacy} = ${literal}\n`);
      const parsed = parse(plan.outputText) as Record<string, any>;

      expect(parsed.memories[canonical]).toBe(expected);
      expect(parsed.memories).not.toHaveProperty(legacy);
      expect(planCodexMigrations(plan.outputText).changed).toBe(false);
    }
  });

  test("canonical memories keys win over all historical aliases", () => {
    const plan = planCodexMigrations(`[memories]
max_raw_memories_for_global = 17
max_raw_memories_for_consolidation = 23
phase_1_model = "legacy-extractor"
extract_model = "canonical-extractor"
phase_2_model = "legacy-consolidator"
consolidation_model = "canonical-consolidator"
no_memories_if_mcp_or_web_search = true
disable_on_external_context = false
`);

    expect(parse(plan.outputText)).toEqual({
      memories: {
        max_raw_memories_for_consolidation: 23,
        extract_model: "canonical-extractor",
        consolidation_model: "canonical-consolidator",
        disable_on_external_context: false,
      },
    });
  });

  test("migrates historical approval policies without reversing their behavior", () => {
    const plan = planCodexMigrations(`approval_policy = { reject = { sandbox_approval = true, rules = false, skill_approval = true, request_permissions = false, mcp_elicitations = true } }

[profiles.work]
approval_policy = "unless-trusted"

[profiles.personal]
approval_policy = "on-failure"
`);

    expect(parse(plan.outputText)).toEqual({
      approval_policy: {
        granular: {
          sandbox_approval: false,
          rules: true,
          skill_approval: false,
          request_permissions: true,
          mcp_elicitations: false,
        },
      },
      profiles: {
        work: { approval_policy: "untrusted" },
        personal: { approval_policy: "on-request" },
      },
    });
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
  });

  test("canonical granular approval fields win over historical reject fields", () => {
    const plan = planCodexMigrations(`
[approval_policy.granular]
sandbox_approval = true
rules = false
skill_approval = true
request_permissions = false
mcp_elicitations = true

[approval_policy.reject]
sandbox_approval = true
rules = true
skill_approval = true
request_permissions = true
mcp_elicitations = true
`);

    expect(parse(plan.outputText)).toEqual({
      approval_policy: {
        granular: {
          sandbox_approval: true,
          rules: false,
          skill_approval: true,
          request_permissions: false,
          mcp_elicitations: true,
        },
      },
    });
  });

  test("canonicalizes ghost snapshot aliases and preserves canonical values", () => {
    const migrated = planCodexMigrations(`[ghost_snapshot]
ignore_untracked_files_over_bytes = 1048576
large_untracked_dir_warning_threshold = 80
`);
    expect(parse(migrated.outputText)).toEqual({
      ghost_snapshot: {
        ignore_large_untracked_files: 1048576,
        ignore_large_untracked_dirs: 80,
      },
    });
    expect(planCodexMigrations(migrated.outputText).changed).toBe(false);

    const canonicalWins = planCodexMigrations(`[ghost_snapshot]
ignore_untracked_files_over_bytes = 1048576
ignore_large_untracked_files = 2097152
large_untracked_dir_warning_threshold = 80
ignore_large_untracked_dirs = 120
`);
    expect(parse(canonicalWins.outputText)).toEqual({
      ghost_snapshot: {
        ignore_large_untracked_files: 2097152,
        ignore_large_untracked_dirs: 120,
      },
    });
  });

  test("migrates MCP environment aliases under dynamic server names", () => {
    const plan = planCodexMigrations(`[mcp_servers."__proto__"]
url = "https://proto.example.test/mcp"
experimental_environment = "remote"

[mcp_servers.docs]
url = "https://docs.example.test/mcp"
experimental_environment = "legacy"
environment_id = "canonical"
`);
    const parsed = parse(plan.outputText) as Record<string, any>;

    expect(Object.prototype.hasOwnProperty.call(parsed.mcp_servers, "__proto__")).toBe(true);
    expect(parsed.mcp_servers["__proto__"]).toEqual({
      url: "https://proto.example.test/mcp",
      environment_id: "remote",
    });
    expect(parsed.mcp_servers.docs).toEqual({
      url: "https://docs.example.test/mcp",
      environment_id: "canonical",
    });
  });

  test("migrates retired root settings, misplaced web search, and the ui table", () => {
    const target = `model = "gpt-5.6-sol"
disable_response_storage = true
preferred_auth_method = "apikey"
web_search_request = true

[ui]
notifications = true
theme = "legacy-theme"

[tui]
notifications = false
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;
    const second = planCodexMigrations(plan.outputText);

    expect(parsed).toEqual({
      model: "gpt-5.6-sol",
      web_search: "live",
      tui: {
        notifications: false,
        theme: "legacy-theme",
      },
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        { action: "add", path: "web_search" },
        { action: "add", path: "tui.theme" },
        { action: "remove", path: "disable_response_storage" },
        { action: "remove", path: "preferred_auth_method" },
        { action: "remove", path: "web_search_request" },
        { action: "remove", path: "ui" },
      ]),
    );
    expect(second.changed).toBe(false);
  });

  test("preserves prototype-like TUI item identifiers as ordinary strings", () => {
    const plan = planCodexMigrations(`[tui]
status_line = ["__proto__", "constructor", "model-name"]
terminal_title = ["toString", "__proto__", "model-name"]
`);

    expect(parse(plan.outputText)).toEqual({
      tui: {
        status_line: ["__proto__", "constructor", "model"],
        terminal_title: ["toString", "__proto__", "model"],
      },
    });
  });

  test("migrates only recognized ui keys and leaves unknown ui state visible", () => {
    const target = `model = "gpt-5.6-sol"

[ui]
notifications = true
theme = "legacy-theme"
custom_client_state = "must-not-discard"

[tui]
notifications = false
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;

    expect(parsed.tui).toEqual({
      notifications: false,
      theme: "legacy-theme",
    });
    expect(parsed.ui).toEqual({ custom_client_state: "must-not-discard" });
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
  });

  test("handles the four reported incompatible keys and is idempotent", () => {
    const target = `model = "gpt-5.6-sol"
disable_response_storage = true
preferred_auth_method = "apikey"
web_search_request = false

[ui]
notifications = true
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;
    const second = planCodexMigrations(plan.outputText);

    expect(parsed).toEqual({
      model: "gpt-5.6-sol",
      web_search: "disabled",
      tui: { notifications: true },
    });
    expect(plan.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.outputText).toBe(plan.outputText);
  });

  test("migrates the historical tools web_search_request alias", () => {
    const plan = planCodexMigrations(`model = "gpt-5.6-sol"

[tools]
web_search_request = true
`);

    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-sol",
      web_search: "live",
      tools: {},
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        { action: "add", path: "web_search" },
        { action: "remove", path: "tools.web_search_request" },
      ]),
    );
  });

  test.each([true, false] as const)(
    "removes ignored boolean tools.web_search=%s without inferring a mode",
    (enabled) => {
    const plan = planCodexMigrations(`model = "gpt-5.6-sol"

[tools]
web_search = ${enabled}
`);

    expect(parse(plan.outputText)).toEqual({
      model: "gpt-5.6-sol",
      tools: {},
    });
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
    },
  );

  test("preserves the structured tools.web_search configuration", () => {
    const target = `model = "gpt-5.6-sol"

[tools.web_search]
allowed_domains = ["docs.example.test"]
context_size = "high"
`;

    const plan = planCodexMigrations(target);

    expect(plan.changed).toBe(false);
    expect(plan.outputText).toBe(target);
  });

  test("removes deprecated JS REPL paths at the root and in every profile", () => {
    const target = `model = "gpt-5.6-sol"
js_repl_node_path = "/opt/node/bin/node"
js_repl_node_module_dirs = ["/opt/node/lib/node_modules"]

[profiles.work]
model = "gpt-5.5"
js_repl_node_path = "/work/node"
js_repl_node_module_dirs = ["/work/modules"]

[profiles.personal]
js_repl_node_path = "/personal/node"
js_repl_node_module_dirs = ["/personal/modules"]
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;

    expect(parsed).not.toHaveProperty("js_repl_node_path");
    expect(parsed).not.toHaveProperty("js_repl_node_module_dirs");
    expect(parsed.profiles.work).toEqual({ model: "gpt-5.5" });
    expect(parsed.profiles.personal).toEqual({});
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
  });

  test("does not silently discard a non-table ui value", () => {
    const target = `model = "gpt-5.6-sol"
ui = "custom-client-state"
`;

    const plan = planCodexMigrations(target);

    expect(plan.changed).toBe(false);
    expect(plan.outputText).toBe(target);
  });
});
