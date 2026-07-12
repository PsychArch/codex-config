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
    parsed = parse(text);
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
  if (!validator(parsed)) {
    issues.push(...(validator.errors ?? []).map(schemaIssue));
  }
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
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    return ajv.compile(schema);
  });
  return validatorPromise;
}

function policyIssues(parsed: unknown, options: { requireModel: boolean }): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const modelValue = getPath(parsed, ["model"]);
  const model =
    typeof modelValue === "string"
      ? CODEX_TARGET.models.find((candidate) => candidate.id === modelValue)
      : undefined;

  if (modelValue === undefined && options.requireModel) {
    issues.push({
      severity: "error",
      code: "model_required",
      path: "model",
      message: `A GPT-5.6 model is required; use ${CODEX_TARGET.defaultModel}.`,
    });
  } else if (modelValue !== undefined && !model) {
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

  if (hasPath(parsed, ["personality"]) && !model?.supportsPersonality) {
    issues.push({
      severity: "warning",
      code: "unsupported_personality",
      path: "personality",
      message: "GPT-5.6 models use model-owned personality instructions and ignore this selector.",
    });
  }

  if (hasPath(parsed, ["sandbox_mode"])) {
    issues.push({
      severity: "warning",
      code: "legacy_sandbox_mode",
      path: "sandbox_mode",
      message: "Use the built-in default_permissions profile instead.",
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
  return issues;
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

function schemaIssue(error: ErrorObject): ConfigIssue {
  const path = jsonPointerToPath(error.instancePath);
  const unknownProperty =
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
      ? error.params.additionalProperty
      : undefined;
  return {
    severity: "error",
    code: `schema_${error.keyword}`,
    path: [path, unknownProperty].filter(Boolean).join("."),
    message: error.message ?? "Does not match the Codex configuration schema.",
  };
}

function jsonPointerToPath(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
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
