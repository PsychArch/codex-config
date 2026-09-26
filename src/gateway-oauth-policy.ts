import type { ConfigIssue } from "./codex-policy.js";

// Mirrors model-provider-info/src/gateway_oauth.rs in the pinned Codex source.
const RESERVED_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "host", "content-length",
  "transfer-encoding", "connection", "upgrade", "chatgpt-account-id",
]);
const RESERVED_PREFIXES = ["x-codex-", "x-openai-", "sec-websocket-"];
const INVALID_HTTP_TOKEN = /[^!#$%&'*+.^_`|~0-9A-Za-z-]/;

export function gatewayOAuthIssues(
  provider: Record<string, unknown>,
  basePath: string,
  isBedrock: boolean,
): ConfigIssue[] {
  const gateway = provider.gateway_oauth;
  if (!isRecord(gateway)) {
    return [];
  }
  const issues: ConfigIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ severity: "error", code: "invalid_gateway_oauth", path: `${basePath}.${path}`, message });
  };
  if (provider.aws !== undefined || isBedrock) {
    issue("gateway_oauth", "Gateway OAuth cannot be combined with AWS authentication.");
  }
  for (const [path, value] of [
    ["base_url", provider.base_url],
    ["gateway_oauth.authorization_url", gateway.authorization_url],
    ["gateway_oauth.token_url", gateway.token_url],
  ] as const) {
    if (!validGatewayUrl(value)) {
      issue(path, "Gateway OAuth requires HTTPS (or loopback HTTP), without URL credentials or fragments.");
    }
  }
  if (typeof gateway.client_id !== "string" || gateway.client_id.trim() === "") {
    issue("gateway_oauth.client_id", "Gateway OAuth requires a nonempty client ID.");
  }
  if (gateway.redirect_port === 0 || gateway.redirect_port === 0n) {
    issue("gateway_oauth.redirect_port", "Gateway OAuth redirect port must be nonzero.");
  }
  const delivery = gateway.delivery;
  if (!isRecord(delivery)) {
    return issues; // The schema reports a missing or malformed delivery object.
  }
  const name = typeof delivery.name === "string" ? delivery.name : "";
  let header: string | undefined;
  if (delivery.kind === "header") {
    const headerName = name.toLowerCase();
    header = headerName;
    const scheme = delivery.scheme ?? "Bearer";
    if (!isHttpToken(name) || !isHttpToken(scheme) ||
      RESERVED_HEADERS.has(headerName) || RESERVED_PREFIXES.some((prefix) => headerName.startsWith(prefix))) {
      issue("gateway_oauth.delivery", "Invalid or reserved gateway OAuth delivery header or scheme.");
    }
  } else if (delivery.kind === "cookie") {
    header = "cookie";
    if (!isHttpToken(name)) {
      issue("gateway_oauth.delivery.name", "Invalid gateway OAuth cookie name.");
    }
  }
  if (header && [provider.http_headers, provider.env_http_headers].some((headers) =>
    isRecord(headers) && Object.keys(headers).some((key) => key.toLowerCase() === header))) {
    issue("gateway_oauth.delivery", "Gateway OAuth delivery conflicts with a configured provider header.");
  }
  return issues;
}

function isHttpToken(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !INVALID_HTTP_TOKEN.test(value);
}

function validGatewayUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    return Boolean(url.hostname) && !url.username && !url.password && !value.includes("#") &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
