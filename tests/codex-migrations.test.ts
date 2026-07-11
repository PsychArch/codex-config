import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import { planCodexMigrations } from "../src/codex-migrations.js";

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

  test("preserves legacy inline profile data for explicit profile-v2 migration", () => {
    const target = `model = "gpt-5.6-sol"

[profiles.work]
model = "gpt-5.5"
personality = "friendly"

[profiles.work.features]
image_detail_original = true
`;

    const plan = planCodexMigrations(target);
    const parsed = parse(plan.outputText) as Record<string, any>;

    expect(plan.changed).toBe(false);
    expect(parsed.profiles.work).toEqual({
      model: "gpt-5.5",
      personality: "friendly",
      features: { image_detail_original: true },
    });
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
});
