import { readFile } from "node:fs/promises";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse } from "smol-toml";
import { STATUS_LINE_LEGACY_IDS, TERMINAL_TITLE_LEGACY_IDS } from "./codex-migrations.js";
import { CODEX_TARGET } from "./codex-target.generated.js";
import { defaultSchemaPath } from "./paths.js";

export interface ConfigIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface ConfigInspection {
  valid: boolean;
  clean: boolean;
  issues: ConfigIssue[];
}

let validatorPromise: Promise<ValidateFunction> | undefined;

export async function inspectCodexConfig(
  text: string,
  label: string,
  options: { requireModel: boolean },
): Promise<ConfigInspection> {
  let parsed: unknown;
  try {
    parsed = parse(text, { integersAsBigInt: "asNeeded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return inspectionFromIssues([
      {
        severity: "error",
        code: "invalid_toml",
        path: "",
        message: `Invalid ${label} TOML: ${message}`,
      },
    ]);
  }

  const issues: ConfigIssue[] = [];
  const validator = await configValidator();
  if (!validator(schemaValue(parsed))) {
    issues.push(
      ...(validator.errors ?? []).flatMap((error) => {
        const disposition = runtimeCompatibilityDisposition(parsed, error);
        return disposition === "ignore" ? [] : [schemaIssue(error, disposition)];
      }),
    );
  }
  issues.push(...runtimeSemanticIssues(parsed));
  issues.push(...policyIssues(parsed, options));
  return inspectionFromIssues(deduplicateIssues(issues));
}

export function formatConfigIssues(label: string, inspection: ConfigInspection): string {
  return inspection.issues
    .map((issue) => {
      const location = issue.path ? ` at ${issue.path}` : "";
      return `${label}${location}: ${issue.message}`;
    })
    .join("\n");
}

export { CODEX_TARGET };

async function configValidator(): Promise<ValidateFunction> {
  validatorPromise ??= readFile(defaultSchemaPath(), "utf8").then((text) => {
    const schema = JSON.parse(text) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addNumericFormats(ajv);
    return ajv.compile(schema);
  });
  return validatorPromise;
}

function policyIssues(parsed: unknown, options: { requireModel: boolean }): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const modelValue = getPath(parsed, ["model"]);
  const modelProvider = getPath(parsed, ["model_provider"]);
  const usesOpenAIModelCatalog =
    (modelProvider === undefined || modelProvider === "openai") &&
    getPath(parsed, ["openai_base_url"]) === undefined &&
    getPath(parsed, ["oss_provider"]) === undefined &&
    getPath(parsed, ["model_catalog_json"]) === undefined;
  const model =
    usesOpenAIModelCatalog && typeof modelValue === "string"
      ? CODEX_TARGET.models.find((candidate) => candidate.id === modelValue)
      : undefined;

  if (modelValue === undefined && options.requireModel) {
    issues.push({
      severity: "error",
      code: "model_required",
      path: "model",
      message: `A GPT-5.6 model is required; use ${CODEX_TARGET.defaultModel}.`,
    });
  } else if (
    usesOpenAIModelCatalog &&
    typeof modelValue === "string" &&
    !model
  ) {
    issues.push({
      severity: "error",
      code: "unsupported_model",
      path: "model",
      message: `Only ${CODEX_TARGET.models.map((candidate) => candidate.id).join(", ")} are supported.`,
    });
  }

  if (model) {
    for (const path of [["model_reasoning_effort"], ["plan_mode_reasoning_effort"]]) {
      const effort = getPath(parsed, path);
      if (typeof effort === "string" && !model.reasoningEfforts.includes(effort as never)) {
        issues.push({
          severity: "error",
          code: "unsupported_reasoning_effort",
          path: path.join("."),
          message: `${model.id} supports reasoning efforts: ${model.reasoningEfforts.join(", ")}.`,
        });
      }
    }

    const serviceTier = getPath(parsed, ["service_tier"]);
    if (typeof serviceTier === "string") {
      const canonicalTier = serviceTier === "fast" ? "priority" : serviceTier;
      if (canonicalTier !== "default" && !model.serviceTiers.includes(canonicalTier as never)) {
        issues.push({
          severity: "error",
          code: "unsupported_service_tier",
          path: "service_tier",
          message: `${model.id} supports service tiers: default, ${model.serviceTiers.join(", ")} (fast is an alias for priority).`,
        });
      }
    }
  }

  if (
    usesOpenAIModelCatalog &&
    hasPath(parsed, ["personality"]) &&
    !model?.supportsPersonality
  ) {
    issues.push({
      severity: "warning",
      code: "unsupported_personality",
      path: "personality",
      message: "GPT-5.6 models use model-owned personality instructions and ignore this selector.",
    });
  }

  if (hasPath(parsed, ["experimental_use_unified_exec_tool"])) {
    issues.push({
      severity: "warning",
      code: "legacy_feature_alias",
      path: "experimental_use_unified_exec_tool",
      message: "Use features.unified_exec instead of this legacy top-level toggle.",
    });
  }

  if (hasPath(parsed, ["profile"])) {
    issues.push({
      severity: "error",
      code: "legacy_profile_selector",
      path: "profile",
      message:
        "Inline profile selection is no longer supported; use `codex --profile <name>` with `$CODEX_HOME/<name>.config.toml`.",
    });
  }

  const legacyProfiles = getPath(parsed, ["profiles"]);
  if (isRecord(legacyProfiles) && Object.keys(legacyProfiles).length > 0) {
    issues.push({
      severity: "warning",
      code: "legacy_profiles",
      path: "profiles",
      message:
        "Inline profile tables are no longer consumed; move each profile to `$CODEX_HOME/<name>.config.toml`.",
    });
  }

  for (const [alias, canonical] of Object.entries(CODEX_TARGET.legacyFeatureAliases)) {
    if (!hasPath(parsed, ["features", alias])) {
      continue;
    }
    const message = CODEX_TARGET.removedFeatureKeys.includes(canonical as never)
      ? "This legacy alias maps to a removed feature and should be deleted."
      : alias === "web_search"
        ? "Use the top-level web_search mode instead of this legacy feature alias."
        : `Use features.${canonical} instead of this legacy feature alias.`;
    issues.push({
      severity: "warning",
      code: "legacy_feature_alias",
      path: `features.${alias}`,
      message,
    });
  }

  for (const key of CODEX_TARGET.removedFeatureKeys) {
    if (hasPath(parsed, ["features", key])) {
      issues.push({
        severity: "warning",
        code: "removed_feature",
        path: `features.${key}`,
        message: "This feature flag is a removed compatibility no-op.",
      });
    }
  }
  for (const key of CODEX_TARGET.retiredFeatureKeys) {
    if (hasPath(parsed, ["features", key])) {
      issues.push({
        severity: "warning",
        code: "retired_feature",
        path: `features.${key}`,
        message: "This historical feature flag is no longer recognized by the targeted Codex source.",
      });
    }
  }
  for (const key of CODEX_TARGET.deprecatedFeatureKeys) {
    if (hasPath(parsed, ["features", key])) {
      issues.push({
        severity: "warning",
        code: "deprecated_feature",
        path: `features.${key}`,
        message: "This feature flag is deprecated in the targeted Codex source.",
      });
    }
  }

  appendLegacyIdIssues(issues, parsed, ["tui", "status_line"], STATUS_LINE_LEGACY_IDS);
  appendLegacyIdIssues(
    issues,
    parsed,
    ["tui", "terminal_title"],
    TERMINAL_TITLE_LEGACY_IDS,
  );
  appendRuntimeCompatibilityIssues(issues, parsed);
  return issues;
}

function appendRuntimeCompatibilityIssues(issues: ConfigIssue[], parsed: unknown): void {
  const scopes: string[][] = [[]];
  const profiles = getPath(parsed, ["profiles"]);
  if (isRecord(profiles)) {
    scopes.push(...Object.keys(profiles).map((name) => ["profiles", name]));
  }
  for (const scope of scopes) {
    const toolsWebSearchPath = [...scope, "tools", "web_search"];
    if (typeof getPath(parsed, toolsWebSearchPath) === "boolean") {
      issues.push({
        severity: "warning",
        code: "ignored_web_search_boolean",
        path: toolsWebSearchPath.join("."),
        message: "Codex accepts but ignores this boolean; remove it or set top-level web_search.",
      });
    }
    for (const key of ["js_repl_node_path", "js_repl_node_module_dirs"] as const) {
      const path = [...scope, key];
      if (hasPath(parsed, path)) {
        issues.push({
          severity: "warning",
          code: "deprecated_js_repl_setting",
          path: path.join("."),
          message: "This deprecated JavaScript REPL setting is ignored.",
        });
      }
    }
  }
  for (const [table, legacyKey, canonicalKey] of [
    [
      "memories",
      "no_memories_if_mcp_or_web_search",
      "disable_on_external_context",
    ],
    [
      "ghost_snapshot",
      "ignore_untracked_files_over_bytes",
      "ignore_large_untracked_files",
    ],
    [
      "ghost_snapshot",
      "large_untracked_dir_warning_threshold",
      "ignore_large_untracked_dirs",
    ],
  ] as const) {
    if (hasPath(parsed, [table, legacyKey])) {
      issues.push({
        severity: "warning",
        code: "runtime_config_alias",
        path: `${table}.${legacyKey}`,
        message: `Use ${table}.${canonicalKey} instead.`,
      });
    }
  }
}

function appendLegacyIdIssues(
  issues: ConfigIssue[],
  parsed: unknown,
  path: string[],
  legacyIds: readonly string[],
): void {
  const value = getPath(parsed, path);
  if (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && legacyIds.includes(item))
  ) {
    issues.push({
      severity: "warning",
      code: "legacy_tui_id",
      path: path.join("."),
      message: "Use the current canonical TUI item identifiers.",
    });
  }
}

function schemaIssue(
  error: ErrorObject,
  severity: ConfigIssue["severity"] = "error",
): ConfigIssue {
  const path = jsonPointerToPath(error.instancePath);
  const unknownProperty =
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
      ? error.params.additionalProperty
      : undefined;
  return {
    severity,
    code: `schema_${error.keyword}`,
    path: [path, unknownProperty].filter(Boolean).join("."),
    message: error.message ?? "Does not match the Codex configuration schema.",
  };
}

function runtimeCompatibilityDisposition(
  parsed: unknown,
  error: ErrorObject,
): ConfigIssue["severity"] | "ignore" {
  const unknownProperty =
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
      ? error.params.additionalProperty
      : undefined;
  const instancePath = jsonPointerSegments(error.instancePath);
  if (
    instancePath.at(-1) === "features" &&
    unknownProperty === "artifact" &&
    typeof getPath(parsed, [...instancePath, "artifact"]) === "boolean"
  ) {
    return "ignore";
  }
  if (
    instancePath.at(-1) === "web_search" &&
    instancePath.at(-2) === "tools" &&
    typeof getPath(parsed, instancePath) === "boolean"
  ) {
    return "ignore";
  }
  if (
    error.keyword === "additionalProperties" &&
    unknownProperty !== undefined &&
    isRuntimeCompatibilityProperty(parsed, instancePath, unknownProperty)
  ) {
    return "ignore";
  }
  if (
    (error.instancePath === "/experimental_thread_store" ||
      error.instancePath.startsWith("/experimental_thread_store/")) &&
    isInMemoryThreadStore(getPath(parsed, ["experimental_thread_store"]))
  ) {
    return "ignore";
  }
  return "error";
}

function isRuntimeCompatibilityProperty(
  parsed: unknown,
  tablePath: string[],
  property: string,
): boolean {
  const value = getPath(parsed, [...tablePath, property]);
  if (
    property === "no_memories_if_mcp_or_web_search" &&
    tablePath.at(-1) === "memories"
  ) {
    return typeof value === "boolean";
  }
  if (
    tablePath.at(-1) === "ghost_snapshot" &&
    (property === "ignore_untracked_files_over_bytes" ||
      property === "large_untracked_dir_warning_threshold")
  ) {
    return typeof value === "number" || typeof value === "bigint";
  }
  const isConfigOrProfile =
    tablePath.length === 0 ||
    (tablePath.length === 2 && tablePath[0] === "profiles");
  if (!isConfigOrProfile) {
    return false;
  }
  if (property === "js_repl_node_path") {
    return typeof value === "string";
  }
  if (property === "js_repl_node_module_dirs") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  return false;
}

function isInMemoryThreadStore(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "in_memory" &&
    typeof value.id === "string" &&
    Object.keys(value).every((key) => key === "type" || key === "id")
  );
}

function schemaValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(schemaValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, schemaValue(child)]),
    );
  }
  return value;
}

function addNumericFormats(ajv: Ajv): void {
  const minimumTomlInteger = Number(-9_223_372_036_854_775_808n);
  const maximumTomlInteger = Number(9_223_372_036_854_775_807n);
  const integer = (minimum: number, maximum: number) => ({
    type: "number" as const,
    validate: (value: number) =>
      Number.isInteger(value) && value >= minimum && value <= maximum,
  });
  ajv.addFormat("uint16", integer(0, 65_535));
  ajv.addFormat("uint32", integer(0, 4_294_967_295));
  ajv.addFormat("uint", integer(0, maximumTomlInteger));
  ajv.addFormat("uint64", integer(0, maximumTomlInteger));
  ajv.addFormat("int32", integer(-2_147_483_648, 2_147_483_647));
  ajv.addFormat("int64", integer(minimumTomlInteger, maximumTomlInteger));
  ajv.addFormat("double", {
    type: "number",
    validate: (value: number) => Number.isFinite(value),
  });
}

function runtimeSemanticIssues(parsed: unknown): ConfigIssue[] {
  return [
    ...tomlIntegerRangeIssues(parsed),
    ...mcpServerIssues(parsed),
    ...modelProviderIssues(parsed),
    ...providerSelectionIssues(parsed),
  ];
}

function tomlIntegerRangeIssues(parsed: unknown): ConfigIssue[] {
  const minimum = -9_223_372_036_854_775_808n;
  const maximum = 9_223_372_036_854_775_807n;
  const issues: ConfigIssue[] = [];

  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === "bigint") {
      if (value < minimum || value > maximum) {
        issues.push(
          runtimeIssue(
            "toml_integer_out_of_range",
            path.map(formatPathSegment).join("."),
            "TOML integers must fit in the signed 64-bit range.",
          ),
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, [...path, key]);
      }
    }
  };

  visit(parsed, []);
  return issues;
}

function mcpServerIssues(parsed: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const servers = getPath(parsed, ["mcp_servers"]);
  if (!isRecord(servers)) {
    return issues;
  }

  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) {
      continue;
    }
    const basePath = `mcp_servers.${formatPathSegment(name)}`;
    const hasCommand = typeof value.command === "string";
    const hasUrl = typeof value.url === "string";
    if (!hasCommand && !hasUrl) {
      issues.push(runtimeIssue("mcp_invalid_transport", basePath, "Set exactly one of command or url."));
      continue;
    }

    const unsupportedFields = hasCommand
      ? [
          "url",
          "bearer_token_env_var",
          "bearer_token",
          "http_headers",
          "env_http_headers",
          "oauth",
          "oauth_resource",
          "auth",
        ]
      : ["args", "env", "env_vars", "cwd", "bearer_token"];
    for (const field of unsupportedFields) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        issues.push(
          runtimeIssue(
            "mcp_unsupported_transport_field",
            `${basePath}.${field}`,
            `${field} is not supported for ${hasCommand ? "stdio" : "streamable_http"} transport.`,
          ),
        );
      }
    }

    if (hasCommand && Array.isArray(value.env_vars)) {
      for (const [index, envVar] of value.env_vars.entries()) {
        if (
          isRecord(envVar) &&
          typeof envVar.source === "string" &&
          envVar.source !== "local" &&
          envVar.source !== "remote"
        ) {
          issues.push(
            runtimeIssue(
              "mcp_invalid_env_source",
              `${basePath}.env_vars.${index}.source`,
              "Expected local or remote.",
            ),
          );
        }
      }
    }

    for (const field of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
      const timeout = value[field];
      if (
        (typeof timeout === "number" && (!Number.isFinite(timeout) || timeout < 0)) ||
        (typeof timeout === "bigint" && timeout < 0n)
      ) {
        issues.push(
          runtimeIssue(
            "mcp_invalid_timeout",
            `${basePath}.${field}`,
            "Expected a finite, non-negative duration.",
          ),
        );
      }
    }
  }
  return issues;
}

function modelProviderIssues(parsed: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const providers = getPath(parsed, ["model_providers"]);
  if (!isRecord(providers)) {
    return issues;
  }

  const reserved = new Set(["openai", "ollama", "lmstudio"]);
  for (const [name, value] of Object.entries(providers)) {
    const basePath = `model_providers.${formatPathSegment(name)}`;
    if (reserved.has(name)) {
      issues.push(
        runtimeIssue(
          "reserved_model_provider",
          basePath,
          "Built-in provider IDs cannot be overridden; use a custom provider name.",
        ),
      );
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    if (name === "amazon-bedrock") {
      for (const [field, fieldValue] of Object.entries(value)) {
        const isDefaultField =
          (field === "name" && fieldValue === "") ||
          (field === "wire_api" && fieldValue === "responses") ||
          (field === "requires_openai_auth" && fieldValue === false) ||
          (field === "supports_websockets" && fieldValue === false);
        if (field !== "aws" && !isDefaultField) {
          issues.push(
            runtimeIssue(
              "amazon_bedrock_override",
              `${basePath}.${field}`,
              "amazon-bedrock only supports overriding aws.profile and aws.region.",
            ),
          );
        }
      }
      continue;
    }
    if (typeof value.name !== "string" || value.name.trim() === "") {
      issues.push(
        runtimeIssue(
          "model_provider_name_required",
          `${basePath}.name`,
          "Provider name must not be empty.",
        ),
      );
    }
    if (Object.prototype.hasOwnProperty.call(value, "aws")) {
      issues.push(
        runtimeIssue(
          "model_provider_aws_reserved",
          `${basePath}.aws`,
          "AWS authentication is only supported for amazon-bedrock.",
        ),
      );
    }

    const auth = value.auth;
    if (isRecord(auth)) {
      if (typeof auth.command !== "string" || auth.command.trim() === "") {
        issues.push(
          runtimeIssue(
            "model_provider_auth_command_required",
            `${basePath}.auth.command`,
            "Provider auth command must not be empty.",
          ),
        );
      }
      for (const field of [
        "env_key",
        "experimental_bearer_token",
        "requires_openai_auth",
      ] as const) {
        if (
          Object.prototype.hasOwnProperty.call(value, field) &&
          (field !== "requires_openai_auth" || value[field] === true)
        ) {
          issues.push(
            runtimeIssue(
              "model_provider_auth_conflict",
              `${basePath}.${field}`,
              `${field} cannot be combined with command-backed auth.`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function providerSelectionIssues(parsed: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const providers = getPath(parsed, ["model_providers"]);
  const builtInProviders = new Set(["openai", "ollama", "lmstudio", "amazon-bedrock"]);
  for (const field of ["model_provider", "oss_provider"] as const) {
    const provider = getPath(parsed, [field]);
    if (typeof provider !== "string") {
      continue;
    }
    if (provider === "ollama-chat") {
      issues.push(
        runtimeIssue(
          "removed_model_provider",
          field,
          "ollama-chat was removed; use ollama.",
        ),
      );
      continue;
    }
    if (
      !builtInProviders.has(provider) &&
      (!isRecord(providers) || !Object.prototype.hasOwnProperty.call(providers, provider))
    ) {
      issues.push(
        runtimeIssue(
          "unknown_model_provider",
          field,
          `Model provider ${JSON.stringify(provider)} is not defined.`,
        ),
      );
    }
  }
  return issues;
}

function runtimeIssue(code: string, path: string, message: string): ConfigIssue {
  return { severity: "error", code, path, message };
}

function formatPathSegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function jsonPointerToPath(pointer: string): string {
  return jsonPointerSegments(pointer).join(".");
}

function jsonPointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function inspectionFromIssues(issues: ConfigIssue[]): ConfigInspection {
  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    clean: issues.length === 0,
    issues,
  };
}

function deduplicateIssues(issues: ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function hasPath(value: unknown, path: string[]): boolean {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
