import { parse, stringify } from "smol-toml";
import { CODEX_TARGET } from "./codex-target.generated.js";
import {
  planConfigChange,
  planConfigRemovals,
  type ChangeOperation,
  type ConfigChangePlan,
} from "./toml-merge.js";

const SANDBOX_PERMISSION_PROFILES: Readonly<Record<string, string>> = {
  "danger-full-access": ":danger-full-access",
  "workspace-write": ":workspace",
  "read-only": ":read-only",
};

const STATUS_LINE_ALIASES: Readonly<Record<string, string>> = {
  "model-name": "model",
  project: "project-name",
  "project-root": "project-name",
  status: "run-state",
  approval: "approval-mode",
  "context-usage": "context-used",
  "session-id": "thread-id",
};

const TERMINAL_TITLE_ALIASES: Readonly<Record<string, string>> = {
  project: "project-name",
  spinner: "activity",
  status: "run-state",
  thread: "thread-title",
  "context-usage": "context-used",
  "session-id": "thread-id",
  "model-name": "model",
};

export function planCodexMigrations(targetText: string): ConfigChangePlan {
  const parsed = parseTarget(targetText);
  const migrationValues: Record<string, unknown> = {};
  const featureUpdates: Record<string, unknown> = {};
  const supportedModels = new Set<string>(CODEX_TARGET.models.map((model) => model.id));

  if (hasPath(parsed, ["model"])) {
    const model = getPath(parsed, ["model"]);
    if (typeof model !== "string" || !supportedModels.has(model)) {
      migrationValues.model = CODEX_TARGET.defaultModel;
    }
  }

  const sandboxMode = getPath(parsed, ["sandbox_mode"]);
  const defaultPermissions = getPath(parsed, ["default_permissions"]);
  const migratedPermissionProfile =
    typeof sandboxMode === "string" ? SANDBOX_PERMISSION_PROFILES[sandboxMode] : undefined;
  if (defaultPermissions === undefined && migratedPermissionProfile) {
    migrationValues.default_permissions = migratedPermissionProfile;
  }

  for (const [alias, canonical] of Object.entries(CODEX_TARGET.legacyFeatureAliases)) {
    if (alias === "web_search" || !hasPath(parsed, ["features", alias])) {
      continue;
    }
    if (
      !CODEX_TARGET.removedFeatureKeys.includes(canonical as never) &&
      !hasPath(parsed, ["features", canonical])
    ) {
      featureUpdates[canonical] = getPath(parsed, ["features", alias]);
    }
  }

  const legacyUnifiedExec = getPath(parsed, ["experimental_use_unified_exec_tool"]);
  if (
    legacyUnifiedExec !== undefined &&
    !hasPath(parsed, ["features", "unified_exec"]) &&
    !Object.prototype.hasOwnProperty.call(featureUpdates, "unified_exec")
  ) {
    featureUpdates.unified_exec = legacyUnifiedExec;
  }

  const legacyWebSearchPaths = [
    ["features", "web_search"],
    ["features", "web_search_cached"],
    ["features", "web_search_request"],
  ];
  if (
    getPath(parsed, ["web_search"]) === undefined &&
    legacyWebSearchPaths.some((path) => hasPath(parsed, path))
  ) {
    migrationValues.web_search = legacyWebSearchMode(parsed);
  }
  if (Object.keys(featureUpdates).length > 0) {
    migrationValues.features = featureUpdates;
  }

  const tuiUpdates: Record<string, unknown> = {};
  const statusLine = getPath(parsed, ["tui", "status_line"]);
  const migratedStatusLine = migrateAliases(statusLine, STATUS_LINE_ALIASES);
  if (migratedStatusLine) {
    tuiUpdates.status_line = migratedStatusLine;
  }
  const terminalTitle = getPath(parsed, ["tui", "terminal_title"]);
  const migratedTerminalTitle = migrateAliases(terminalTitle, TERMINAL_TITLE_ALIASES);
  if (migratedTerminalTitle) {
    tuiUpdates.terminal_title = migratedTerminalTitle;
  }
  if (Object.keys(tuiUpdates).length > 0) {
    migrationValues.tui = tuiUpdates;
  }

  const updatePlan = planConfigChange({
    targetText,
    templateText: stringify(migrationValues),
    mode: "override",
  });

  const removalPaths: string[][] = [];
  if (hasPath(parsed, ["personality"])) {
    removalPaths.push(["personality"]);
  }
  if (hasPath(parsed, ["experimental_use_unified_exec_tool"])) {
    removalPaths.push(["experimental_use_unified_exec_tool"]);
  }
  if (
    hasPath(parsed, ["sandbox_mode"]) &&
    (defaultPermissions !== undefined || migratedPermissionProfile !== undefined)
  ) {
    removalPaths.push(["sandbox_mode"]);
  }
  for (const key of [
    ...CODEX_TARGET.removedFeatureKeys,
    ...CODEX_TARGET.retiredFeatureKeys,
  ]) {
    if (hasPath(parsed, ["features", key])) {
      removalPaths.push(["features", key]);
    }
  }
  for (const alias of Object.keys(CODEX_TARGET.legacyFeatureAliases)) {
    if (hasPath(parsed, ["features", alias])) {
      removalPaths.push(["features", alias]);
    }
  }
  for (const key of ["web_search_cached", "web_search_request"]) {
    if (hasPath(parsed, ["features", key])) {
      removalPaths.push(["features", key]);
    }
  }

  const removalPlan = planConfigRemovals(updatePlan.outputText, removalPaths);
  return combinePlans(updatePlan, removalPlan);
}

export const STATUS_LINE_LEGACY_IDS = Object.freeze(Object.keys(STATUS_LINE_ALIASES));
export const TERMINAL_TITLE_LEGACY_IDS = Object.freeze(Object.keys(TERMINAL_TITLE_ALIASES));

function parseTarget(text: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid target TOML: ${message}`);
  }
}

function migrateAliases(
  value: unknown,
  aliases: Readonly<Record<string, string>>,
): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  const migrated = [...new Set(value.map((item) => aliases[item] ?? item))];
  return JSON.stringify(migrated) === JSON.stringify(value) ? undefined : migrated;
}

function legacyWebSearchMode(parsed: unknown): "cached" | "live" | "disabled" {
  if (getPath(parsed, ["features", "web_search_cached"]) === true) {
    return "cached";
  }
  if (
    getPath(parsed, ["features", "web_search_request"]) === true ||
    getPath(parsed, ["features", "web_search"]) === true
  ) {
    return "live";
  }
  return "disabled";
}

function combinePlans(first: ConfigChangePlan, second: ConfigChangePlan): ConfigChangePlan {
  const operations: ChangeOperation[] = [...first.operations, ...second.operations];
  return {
    changed: first.changed || second.changed,
    outputText: second.outputText,
    operations,
  };
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
