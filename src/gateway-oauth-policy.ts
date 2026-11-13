import type { ConfigIssue } from "./codex-policy.js";
import { validCredentialExportCommand } from "./credential-export-policy.js";

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
  const usesExport = gateway.credential_export !== undefined;
  const urls: Array<[string, unknown]> = [["base_url", provider.base_url]];
  if (usesExport) {
    if (isRecord(gateway.credential_export) && !validCredentialExportCommand(gateway.credential_export.command)) {
      issue("gateway_oauth.credential_export.command", "Gateway credential export requires an absolute path or a bare executable name.");
    }
  } else {
    urls.push(["gateway_oauth.authorization_url", gateway.authorization_url],
      ["gateway_oauth.token_url", gateway.token_url]);
    if (gateway.device_authorization_url !== undefined) {
      urls.push(["gateway_oauth.device_authorization_url", gateway.device_authorization_url]);
    }
    if (typeof gateway.client_id !== "string" || gateway.client_id.trim() === "") {
      issue("gateway_oauth.client_id", "Gateway OAuth requires a nonempty client ID.");
    }
    if (gateway.redirect_port === 0 || gateway.redirect_port === 0n) {
      issue("gateway_oauth.redirect_port", "Gateway OAuth redirect port must be nonzero.");
    }
  }
  for (const [path, value] of urls) {
    if (!validGatewayUrl(value)) {
      issue(path, "Gateway OAuth requires HTTPS (or loopback HTTP), without URL credentials or fragments.");
    }
  }
  const delivery = gateway.delivery ?? { kind: "header", name: "Authorization", scheme: "Bearer" };
  if (!isRecord(delivery)) {
    return issues; // The schema reports a malformed delivery object.
  }
  const name = typeof delivery.name === "string" ? delivery.name : "";
  const scheme = delivery.scheme ?? "Bearer";
  const authorizationBearer = delivery.kind === "header" && name.toLowerCase() === "authorization" &&
    typeof scheme === "string" && scheme.toLowerCase() === "bearer";
  if ((usesExport || authorizationBearer) && provider.model_catalog_url !== undefined &&
    (!validGatewayUrl(provider.model_catalog_url) || !validGatewayUrl(provider.base_url) ||
      new URL(provider.model_catalog_url as string).origin !== new URL(provider.base_url as string).origin)) {
    issue("model_catalog_url", "Gateway credential export and Authorization delivery require the catalog and base URL to share the same scheme, host, and port.");
  }
  let header: string | undefined;
  if (delivery.kind === "header") {
    const headerName = name.toLowerCase();
    header = headerName;
    if (authorizationBearer) {
      if (provider.name === "Google Cloud Vertex AI" || provider.requires_openai_auth === true ||
        provider.env_key !== undefined || provider.experimental_bearer_token !== undefined ||
        isRecord(provider.auth)) {
        issue("gateway_oauth.delivery", "Gateway Authorization delivery conflicts with the provider credential; choose a custom header or cookie.");
      }
    } else if (!isHttpToken(name) || !isHttpToken(scheme) ||
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
