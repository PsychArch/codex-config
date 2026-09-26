import { stringify } from "smol-toml";
import { describe, expect, test } from "vitest";
import { inspectCodexConfig } from "../src/codex-policy.js";

function provider(): Record<string, any> {
  return {
    name: "Gateway", base_url: "https://gateway.example.test/v1",
    model_catalog_url: "https://gateway.example.test/catalog",
    gateway_oauth: {
      authorization_url: "https://idp.example.test/authorize",
      token_url: "https://idp.example.test/token",
      client_id: "codex", redirect_port: 9876,
      delivery: { kind: "header", name: "X-Gateway-Auth" },
    },
  };
}

const inspect = (value: Record<string, unknown>) => inspectCodexConfig(stringify({
  model: "custom-model", model_provider: "gateway", model_providers: { gateway: value },
}), "target", { requireModel: true });

describe("gateway OAuth runtime compatibility", () => {
  test.each(["https://example.test", "http://localhost:8080", "http://127.0.0.2:8080", "http://[::1]:8080"])(
    "accepts supported gateway URL %s", async (baseUrl) => {
      const value = provider();
      value.base_url = baseUrl;
      expect(await inspect(value)).toEqual({ valid: true, clean: true, issues: [] });
    },
  );

  test("accepts cookie delivery and command-backed primary auth", async () => {
    const value = provider();
    value.gateway_oauth.delivery = { kind: "cookie", name: "gateway_session" };
    value.auth = { command: "gateway-token" };
    expect(await inspect(value)).toEqual({ valid: true, clean: true, issues: [] });
  });

  test.each([
    ["base_url", "http://example.test"],
    ["base_url", "https://example.test/#"],
    ["base_url", "https://user:dummy@example.test"],
    ["authorization_url", "https://example.test/#fragment"],
    ["token_url", "http://example.test/token"],
    ["token_url", "not-a-url"],
  ])("rejects invalid %s URL", async (field, url) => {
    const value = provider();
    if (field === "base_url") value.base_url = url;
    else value.gateway_oauth[field] = url;
    const result = await inspect(value);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_gateway_oauth" }));
    expect(JSON.stringify(result)).not.toContain("dummy");
  });

  test.each(["Authorization", "Proxy-Authorization", "Cookie", "Host", "Content-Length", "X-Codex-Test", "X-OpenAI-Test", "Sec-WebSocket-Key", "Bad Header", "Header\n"])(
    "rejects reserved or invalid delivery header %s", async (name) => {
      const value = provider();
      value.gateway_oauth.delivery.name = name;
      expect((await inspect(value)).issues).toContainEqual(expect.objectContaining({ code: "invalid_gateway_oauth" }));
    },
  );

  test.each(["http_headers", "env_http_headers"])("rejects a conflicting %s header regardless of case", async (field) => {
    const value = provider();
    value[field] = { "x-gateway-auth": "placeholder" };
    expect((await inspect(value)).issues).toContainEqual(expect.objectContaining({
      code: "invalid_gateway_oauth", message: expect.stringContaining("conflicts"),
    }));
  });

  test.each(["missing base", "blank client", "zero port", "bad scheme", "newline scheme", "bad cookie", "cookie conflict", "aws"])(
    "rejects %s", async (scenario) => {
      const value = provider();
      switch (scenario) {
        case "missing base": delete value.base_url; break;
        case "blank client": value.gateway_oauth.client_id = " "; break;
        case "zero port": value.gateway_oauth.redirect_port = 0; break;
        case "bad scheme": value.gateway_oauth.delivery.scheme = "Bad Scheme"; break;
        case "newline scheme": value.gateway_oauth.delivery.scheme = "Bearer\n"; break;
        case "bad cookie": value.gateway_oauth.delivery = { kind: "cookie", name: "bad;cookie" }; break;
        case "cookie conflict":
          value.gateway_oauth.delivery = { kind: "cookie", name: "session" };
          value.env_http_headers = { Cookie: "COOKIE" };
          break;
        case "aws": value.aws = { region: "us-east-1" }; break;
      }
      expect((await inspect(value)).issues).toContainEqual(expect.objectContaining({ code: "invalid_gateway_oauth" }));
    },
  );
});
