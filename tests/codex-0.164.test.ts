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

function mitm(version?: number): Record<string, unknown> {
  return {
    ...(version === undefined ? {} : { version }),
    actions: { substitute: { inject_request_headers: [{
      name: "x-api-key", secret_env_var: "TEST_KEY", placeholder: "dummy-key",
    }] } },
    hooks: { bucket: {
      host: "bucket.example.test", schemes: ["https"], ports: [443],
      methods: ["PUT"], path_prefixes: ["/workspace/"], action: ["substitute"],
    } },
  };
}

const withMitm = (value: Record<string, unknown>) => ({ permissions: { trusted: { network: { mitm: value } } } });
const ema = (oauth: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  mcp_servers: { corp: { url: "https://resource.example.test/mcp", auth: "ema_auth", oauth, ...extra } },
});
const confidential = {
  client_id: "client", client_secret: "test-placeholder", authorization_server_issuer: "https://as.example.test",
};
const idp = (extra: Record<string, unknown>) => ({
  mcp_enterprise_managed_auth: { idp: { issuer: "https://idp.example.test", client_id: "client", ...extra } },
});

describe("Codex 0.164.0 compatibility", () => {
  test("pins the stable source without changing the curated model catalog or template", async () => {
    expect(CODEX_TARGET.sourceRevision).toBe("6aaac694803004a63c6f393d153c96d22521a6b9");
    expect(CODEX_TARGET.defaultModel).toBe("gpt-6.1-sol");
    expect(CODEX_TARGET.models).toHaveLength(7);
    expect(CODEX_TARGET.minimumClientVersion).toBe("0.155.0");
    const template = parse(await readFile("config.toml.template", "utf8"));
    expect(template.features).toEqual({ default_mode_request_user_input: true, memories: true, multi_agent_v2: true });
  });

  test("preserves explicit new settings and unrelated provider/MCP values idempotently", async () => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-164-")), "config.toml");
    const settings = {
      model: "custom-model", model_provider: "custom", include_environment_context_time: false,
      model_providers: { custom: { name: "Custom", base_url: "https://example.test/v1" } },
      mcp_servers: { docs: { url: "https://example.test/mcp" } },
      plugins: { _default: { enabled: false }, "demo@example": {
        enabled: true, remote_plugin_id: "demo", release_id: "release-1", auto_provision: false,
      } },
      hooks: { PreModelRequest: [], PostModelRequest: [] },
      features: {
        async_compaction: { enabled: false, model_async_compact_threshold_percent: 65 },
        multi_agent_v2: { enabled: true, preserve_fork_prefix: false, disable_native_tools: true },
        runtime_agent_instances: { enabled: false, mode: "assertion_only" },
        mcp_tool_list_changed: false, credential_masking: false,
      },
      tui: { copy_on_select_clear_selection: true, presets: { "0": { input: "/status", label: "Status" } },
        keymap: { chat: { open_presets: "ctrl+p" }, global: { leader: "ctrl+g" } } },
      windows: { allow_mxc: false },
      ...withMitm(mitm(2)),
    };
    await writeFile(target, stringify(settings));
    await applyConfig({ target });
    expect(parse(await readFile(target, "utf8"))).toMatchObject(settings);
    expect((await doctor({ target })).ok).toBe(true);
    expect((await applyConfig({ target })).changed).toBe(false);
  });

  test.each([false, true])("cleans retired flags (%s) and retains transcript migration at root/profile scope", async (enabled) => {
    const retired = ["worktrees", "realtime_conversation", "shell_zsh_fork", "stable_environment_tools"];
    const flags = Object.fromEntries(retired.map((name) => [name, enabled]));
    const input = stringify({ model: "gpt-6.1-sol", features: { ...flags, transcript_v2: enabled },
      profiles: { old: { features: { ...flags, transcript_v2: enabled } } } });
    expect((await inspect(input)).issues).toEqual(expect.arrayContaining(retired.map((name) =>
      expect.objectContaining({ code: "removed_feature", path: `features.${name}` }))));
    const plan = planCodexMigrations(input);
    expect(parse(plan.outputText)).toEqual({ model: "gpt-6.1-sol", features: {}, tui: { fullscreen_transcript: enabled },
      profiles: { old: { features: {}, tui: { fullscreen_transcript: enabled } } } });
    expect(planCodexMigrations(plan.outputText).changed).toBe(false);
    const canonical = planCodexMigrations('model="gpt-6.1-sol"\n[features]\ntranscript_v2=true\n[tui]\nfullscreen_transcript=false\n');
    expect(parse(canonical.outputText).tui).toEqual({ fullscreen_transcript: false });
  });

  test.each(["client_secret_basic", "client_secret_post"])("accepts confidential EMA and IdP authentication with %s", async (method) => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-164-ema-")), "config.toml");
    const text = stringify({ model: "gpt-6.1-sol",
      ...ema({ ...confidential, token_endpoint_auth_method: method }, { http_headers: {}, env_http_headers: {} }),
      ...idp({ client_secret: "test-idp-placeholder", token_endpoint_auth_method: method }) });
    expect(await inspect(text)).toEqual({ valid: true, clean: true, issues: [] });
    await writeFile(target, text);
    await applyConfig({ target });
    expect(parse(await readFile(target, "utf8"))).toMatchObject(parse(text));
    expect((await doctor({ target })).ok).toBe(true);
    expect((await applyConfig({ target })).changed).toBe(false);
  });

  test.each([
    ema(confidential), ema({ client_id: "public-client" }),
    { tui: { presets: { "9": { input: "x".repeat(8_000) } } } },
    { tui: { presets: { "1": { input: "中".repeat(2_666) } } } },
    { windows: { sandbox: "mxc", allow_mxc: true } },
    withMitm({ hooks: { legacy: { host: "example.test", methods: ["GET"], path_prefixes: ["/"], action: ["strip"] } },
      actions: { strip: { strip_request_headers: ["x-test"] } } }),
    withMitm({ version: 2 }),
    { features: { async_compaction: { enabled: false, model_async_compact_threshold_percent: 100 } } },
  ])("accepts valid boundary/default settings %#", async (settings) => {
    expect(await inspect(stringify({ model: "gpt-6.1-sol", ...settings })))
      .toEqual({ valid: true, clean: true, issues: [] });
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["EMA missing issuer", ema({ client_id: "c", client_secret: "dummy" }), "mcp_invalid_oauth_client_secret"],
    ["EMA blank issuer", ema({ ...confidential, authorization_server_issuer: " " }), "mcp_invalid_oauth_client_secret"],
    ["EMA blank secret", ema({ ...confidential, client_secret: " " }), "mcp_invalid_oauth_client_secret"],
    ["EMA missing client", ema({ client_secret: "dummy", authorization_server_issuer: "https://as.example" }), "mcp_invalid_oauth_client_secret"],
    ["non-EMA method", { mcp_servers: { corp: { url: "https://example.test", oauth: { token_endpoint_auth_method: "client_secret_post" } } } }, "mcp_invalid_oauth_auth_method"],
    ["EMA method without secret", ema({ token_endpoint_auth_method: "client_secret_basic" }), "mcp_invalid_oauth_auth_method"],
    ["remote EMA", ema(confidential, { environment_id: "remote" }), "mcp_invalid_ema_transport"],
    ["EMA bearer", ema(confidential, { bearer_token_env_var: "TEST_TOKEN" }), "mcp_invalid_ema_transport"],
    ["EMA headers", ema(confidential, { http_headers: { Authorization: "dummy" } }), "mcp_invalid_ema_transport"],
    ["EMA env headers", ema(confidential, { env_http_headers: { Authorization: "TEST_TOKEN" } }), "mcp_invalid_ema_transport"],
    ["EMA header helper", ema(confidential, { http_headers_helper: "headers" }), "mcp_invalid_ema_transport"],
    ["IdP method without secret", idp({ token_endpoint_auth_method: "client_secret_post" }), "mcp_invalid_idp_auth_method"],
    ["IdP blank secret", idp({ client_secret: " " }), "mcp_invalid_idp_client_secret"],
    ["preset slot", { tui: { presets: { "10": { input: "/status" } } } }, "invalid_tui_preset"],
    ["preset non-ASCII digit", { tui: { presets: { "１": { input: "/status" } } } }, "invalid_tui_preset"],
    ["preset blank", { tui: { presets: { "1": { input: " \n" } } } }, "invalid_tui_preset"],
    ["preset shell", { tui: { presets: { "1": { input: "  !ls" } } } }, "invalid_tui_preset"],
    ["preset bytes", { tui: { presets: { "1": { input: "中".repeat(2_667) } } } }, "invalid_tui_preset"],
    ["MXC blocked", { windows: { sandbox: "mxc", allow_mxc: false } }, "windows_mxc_disabled"],
    ["MITM missing version", withMitm(mitm()), "network_mitm_version_required"],
    ["MITM scoped hook", withMitm({ hooks: mitm().hooks }), "network_mitm_version_required"],
    ["MITM placeholder", withMitm({ actions: mitm().actions }), "network_mitm_version_required"],
    ["MITM version", withMitm(mitm(1)), "schema_minimum"],
    ["MITM typo", withMitm({ ...mitm(2), scheme: "https" }), "schema_additionalProperties"],
    ["MITM hook typo", withMitm({ hooks: { h: { host: "example.test", methods: [], path_prefixes: [], action: ["x"], port: [443] } } }), "schema_additionalProperties"],
    ["MITM header typo", withMitm({ actions: { a: { inject_request_headers: [{ name: "x", unknown_placeholder: "dummy" }] } } }), "schema_additionalProperties"],
    ["MITM empty action", withMitm({ actions: { empty: {} } }), "network_mitm_empty_action"],
    ["MITM empty hook", withMitm({ hooks: { h: { host: "example.test", methods: [], path_prefixes: [], action: [] } } }), "network_mitm_empty_hook"],
    ["disabled compaction threshold", { features: { async_compaction: { enabled: false, model_async_compact_threshold_percent: 0 } } }, "schema_minimum"],
  ];
  test.each(invalid)("rejects %s before writing and reports it in doctor", async (_name, settings, code) => {
    const target = join(await mkdtemp(join(tmpdir(), "codex-164-invalid-")), "config.toml");
    const text = stringify({ model: "gpt-6.1-sol", ...settings });
    await writeFile(target, text);
    const result = await inspect(text);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code }));
    const diagnosis = await doctor({ target });
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.target.compatible).toBe(false);
    await expect(applyConfig({ target })).rejects.toThrow("not compatible");
    expect(await readFile(target, "utf8")).toBe(text);
  });
});
