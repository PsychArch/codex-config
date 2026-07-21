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

const MEMORY_KEY_ALIASES: Readonly<Record<string, string>> = {
  max_raw_memories_for_global: "max_raw_memories_for_consolidation",
  phase_1_model: "extract_model",
  phase_2_model: "consolidation_model",
  no_memories_if_mcp_or_web_search: "disable_on_external_context",
};

const GHOST_SNAPSHOT_KEY_ALIASES: Readonly<Record<string, string>> = {
  ignore_untracked_files_over_bytes: "ignore_large_untracked_files",
  large_untracked_dir_warning_threshold: "ignore_large_untracked_dirs",
};

const RETIRED_ROOT_KEYS = [
  "disable_response_storage",
  "preferred_auth_method",
  "model_max_output_tokens",
  "model_reasoning_summary_format",
  "experimental_resume",
  "internal_originator",
  "responses_originator_header_internal_override",
  "use_experimental_reasoning_summary",
  "experimental_use_exec_command_tool",
  "experimental_use_rmcp_client",
  "experimental_use_freeform_apply_patch",
  "experimental_sandbox_command_assessment",
  "windows_wsl_setup_acknowledged",
  "commit_attribution",
  "zsh_path",
] as const;

const RETIRED_UI_KEYS = new Set(["show_plan"]);

const DEPRECATED_JS_REPL_KEYS = [
  "js_repl_node_path",
  "js_repl_node_module_dirs",
] as const;

const FEATURE_ALIASES_THAT_WIN_CONFLICTS = new Set([
  "connectors",
  "request_permissions",
  "memory_tool",
  "telepathy",
]);

export function planCodexMigrations(
  targetText: string,
  options: { targetPath?: string } = {},
): ConfigChangePlan {
  const parsed = parseTarget(targetText);
  const migrationValues: Record<string, unknown> = {};
  const removalPaths: string[][] = [];
  const supportedModels = new Set<string>(CODEX_TARGET.models.map((model) => model.id));
  const usesOpenAIModelCatalog = usesManagedOpenAIModelCatalog(parsed);

  if (usesOpenAIModelCatalog && hasPath(parsed, ["model"])) {
    const model = getPath(parsed, ["model"]);
    if (typeof model !== "string" || !supportedModels.has(model)) {
      setMigrationValue(migrationValues, ["model"], CODEX_TARGET.defaultModel);
    }
  }

  if (usesOpenAIModelCatalog && hasPath(parsed, ["personality"])) {
    removalPaths.push(["personality"]);
  }

  migrateLegacySandbox(parsed, migrationValues, removalPaths);

  for (const [legacyKey, canonicalKey] of Object.entries(MEMORY_KEY_ALIASES)) {
    migrateKey(
      parsed,
      migrationValues,
      removalPaths,
      ["memories", legacyKey],
      ["memories", canonicalKey],
    );
  }
  for (const alias of CODEX_TARGET.configKeyAliases) {
    migrateKey(
      parsed,
      migrationValues,
      removalPaths,
      [...alias.tablePath, alias.legacyKey],
      [...alias.tablePath, alias.canonicalKey],
    );
  }
  for (const [legacyKey, canonicalKey] of Object.entries(GHOST_SNAPSHOT_KEY_ALIASES)) {
    migrateKey(
      parsed,
      migrationValues,
      removalPaths,
      ["ghost_snapshot", legacyKey],
      ["ghost_snapshot", canonicalKey],
    );
  }

  migrateMcpServerAliases(parsed, migrationValues, removalPaths);

  for (const scope of configScopes(parsed)) {
    migrateScopedConfig(parsed, migrationValues, removalPaths, scope);
  }

  migrateLegacyUi(parsed, migrationValues, removalPaths);
  migrateTuiAliases(parsed, migrationValues);

  for (const key of RETIRED_ROOT_KEYS) {
    if (hasPath(parsed, [key])) {
      removalPaths.push([key]);
    }
  }
  if (hasPath(parsed, ["experimental_thread_store_endpoint"])) {
    removalPaths.push(["experimental_thread_store_endpoint"]);
  }
  const threadStore = getPath(parsed, ["experimental_thread_store"]);
  if (isRecord(threadStore) && threadStore.type === "remote") {
    removalPaths.push(["experimental_thread_store"]);
  }
  if (hasPath(parsed, ["realtime", "architecture"])) {
    removalPaths.push(["realtime", "architecture"]);
  }

  const updatePlan = planConfigChange({
    targetText,
    templateText: stringify(migrationValues),
    mode: "override",
    targetPath: options.targetPath,
  });
  const removalPlan = planConfigRemovals(
    updatePlan.outputText,
    uniquePaths(removalPaths),
    options.targetPath,
  );
  return combinePlans(updatePlan, removalPlan);
}

export function adaptCodexTemplate(targetText: string, templateText: string): string {
  const parsed = parseTarget(targetText);
  const workspaceWrite = getPath(parsed, ["sandbox_workspace_write"]);
  if (
    getPath(parsed, ["default_permissions"]) === undefined &&
    isRecord(workspaceWrite) &&
    Object.keys(workspaceWrite).length > 0
  ) {
    return planConfigRemovals(templateText, [["default_permissions"]]).outputText;
  }
  return templateText;
}

export const STATUS_LINE_LEGACY_IDS = Object.freeze(Object.keys(STATUS_LINE_ALIASES));
export const TERMINAL_TITLE_LEGACY_IDS = Object.freeze(Object.keys(TERMINAL_TITLE_ALIASES));

function migrateLegacySandbox(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
): void {
  const legacySandbox = getPath(parsed, ["sandbox"]);
  const legacySandboxMode = isRecord(legacySandbox) ? legacySandbox.mode : undefined;
  const sandboxMode = getPath(parsed, ["sandbox_mode"]);
  const effectiveSandboxMode =
    typeof sandboxMode === "string"
      ? sandboxMode
      : typeof legacySandboxMode === "string"
        ? legacySandboxMode
        : undefined;
  const defaultPermissions = getPath(parsed, ["default_permissions"]);
  const migratedPermissionProfile =
    effectiveSandboxMode === undefined
      ? undefined
      : Object.prototype.hasOwnProperty.call(
            SANDBOX_PERMISSION_PROFILES,
            effectiveSandboxMode,
          )
        ? SANDBOX_PERMISSION_PROFILES[effectiveSandboxMode]
        : undefined;

  const workspaceWrite = getPath(parsed, ["sandbox_workspace_write"]);
  const legacyWorkspaceValues: Record<string, unknown> = {};
  if (isRecord(legacySandbox)) {
    for (const key of ["writable_roots", "network_access"] as const) {
      if (
        Object.prototype.hasOwnProperty.call(legacySandbox, key) &&
        !hasPath(parsed, ["sandbox_workspace_write", key])
      ) {
        legacyWorkspaceValues[key] = legacySandbox[key];
      }
    }
  }
  if (Object.keys(legacyWorkspaceValues).length > 0) {
    setMigrationValue(migrationValues, ["sandbox_workspace_write"], legacyWorkspaceValues);
  }
  const hasWorkspaceCustomization =
    (isRecord(workspaceWrite) && Object.keys(workspaceWrite).length > 0) ||
    Object.keys(legacyWorkspaceValues).length > 0;

  if (defaultPermissions !== undefined) {
    if (hasPath(parsed, ["sandbox_mode"])) {
      removalPaths.push(["sandbox_mode"]);
    }
  } else if (
    migratedPermissionProfile &&
    !(effectiveSandboxMode === "workspace-write" && hasWorkspaceCustomization)
  ) {
    setMigrationValue(migrationValues, ["default_permissions"], migratedPermissionProfile);
    if (hasPath(parsed, ["sandbox_mode"])) {
      removalPaths.push(["sandbox_mode"]);
    }
  } else if (sandboxMode === undefined && typeof legacySandboxMode === "string") {
    setMigrationValue(migrationValues, ["sandbox_mode"], legacySandboxMode);
  }

  if (isRecord(legacySandbox)) {
    removalPaths.push(["sandbox"]);
  }
}

function migrateScopedConfig(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
  scope: string[],
): void {
  const scoped = (...path: string[]): string[] => [...scope, ...path];
  const isRoot = scope.length === 0;

  migrateKey(
    parsed,
    migrationValues,
    removalPaths,
    scoped("experimental_instructions_file"),
    scoped("model_instructions_file"),
  );

  const usesOpenAIModelCatalog = usesManagedOpenAIModelCatalog(parsed, scope);
  if (!isRoot || !usesOpenAIModelCatalog) {
    migrateKey(
      parsed,
      migrationValues,
      removalPaths,
      scoped("model_personality"),
      scoped("personality"),
    );
  } else if (hasPath(parsed, scoped("model_personality"))) {
    removalPaths.push(scoped("model_personality"));
  }

  migrateApprovalPolicy(parsed, migrationValues, removalPaths, scope);
  migrateWebSearch(parsed, migrationValues, removalPaths, scope);
  migrateFeatureFlags(parsed, migrationValues, removalPaths, scope);

  for (const key of DEPRECATED_JS_REPL_KEYS) {
    if (hasPath(parsed, scoped(key))) {
      removalPaths.push(scoped(key));
    }
  }
  for (const path of [["tools", "view_image"], ["tools_view_image"]]) {
    if (hasPath(parsed, scoped(...path))) {
      removalPaths.push(scoped(...path));
    }
  }
}

function migrateApprovalPolicy(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
  scope: string[],
): void {
  const path = [...scope, "approval_policy"];
  const policy = getPath(parsed, path);
  if (policy === "unless-allow-listed" || policy === "unless-trusted") {
    setMigrationValue(migrationValues, path, "untrusted");
    return;
  }
  if (policy === "on-failure") {
    setMigrationValue(migrationValues, path, "on-request");
    return;
  }
  if (!isRecord(policy) || !isRecord(policy.reject)) {
    return;
  }
  const legacyGranular = Object.fromEntries(
    Object.entries(policy.reject).map(([key, value]) => [
      key,
      typeof value === "boolean" ? !value : value,
    ]),
  );
  const granularUpdates = missingValues(policy.granular, legacyGranular);
  if (Object.keys(granularUpdates).length > 0) {
    setMigrationValue(migrationValues, [...path, "granular"], granularUpdates);
  }
  removalPaths.push([...path, "reject"]);
}

function migrateWebSearch(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
  scope: string[],
): void {
  const scoped = (...path: string[]): string[] => [...scope, ...path];
  const toolsWebSearch = getPath(parsed, scoped("tools", "web_search"));
  const directModePaths = [
    scoped("web_search_request"),
    scoped("tools", "web_search_request"),
    ...(scope.length > 0 ? [scoped("tools_web_search")] : []),
  ];
  const featureModePaths = [
    scoped("features", "web_search"),
    scoped("features", "web_search_cached"),
    scoped("features", "web_search_request"),
  ];
  const modePaths = [...directModePaths, ...featureModePaths];
  const legacyPaths = [
    ...modePaths,
    ...(typeof toolsWebSearch === "boolean" ? [scoped("tools", "web_search")] : []),
  ];
  if (
    getPath(parsed, scoped("web_search")) === undefined &&
    (directModePaths.some((path) => hasPath(parsed, path)) ||
      featureModePaths.some((path) => getPath(parsed, path) === true))
  ) {
    setMigrationValue(
      migrationValues,
      scoped("web_search"),
      legacyWebSearchMode(parsed, scope),
    );
  }
  for (const path of legacyPaths) {
    if (hasPath(parsed, path)) {
      removalPaths.push(path);
    }
  }
}

function migrateFeatureFlags(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
  scope: string[],
): void {
  const scoped = (...path: string[]): string[] => [...scope, ...path];
  for (const [alias, canonical] of Object.entries(CODEX_TARGET.legacyFeatureAliases)) {
    const aliasPath = scoped("features", alias);
    if (!hasPath(parsed, aliasPath)) {
      continue;
    }
    if (
      alias !== "web_search" &&
      !CODEX_TARGET.removedFeatureKeys.includes(canonical as never) &&
      (!hasPath(parsed, scoped("features", canonical)) ||
        FEATURE_ALIASES_THAT_WIN_CONFLICTS.has(alias))
    ) {
      setMigrationValue(
        migrationValues,
        scoped("features", canonical),
        getPath(parsed, aliasPath),
      );
    }
    removalPaths.push(aliasPath);
  }

  const unifiedExecPath = scoped("experimental_use_unified_exec_tool");
  if (hasPath(parsed, unifiedExecPath)) {
    if (!hasPath(parsed, scoped("features", "unified_exec"))) {
      setMigrationValue(
        migrationValues,
        scoped("features", "unified_exec"),
        getPath(parsed, unifiedExecPath),
      );
    }
    removalPaths.push(unifiedExecPath);
  }

  for (const key of [
    ...CODEX_TARGET.removedFeatureKeys,
    ...CODEX_TARGET.retiredFeatureKeys,
  ]) {
    const path = scoped("features", key);
    if (hasPath(parsed, path)) {
      removalPaths.push(path);
    }
  }
}

function migrateLegacyUi(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
): void {
  const legacyUi = getPath(parsed, ["ui"]);
  if (!isRecord(legacyUi)) {
    return;
  }

  const tuiKeySet = new Set<string>(CODEX_TARGET.tuiKeys);
  const legacyUiEntries = Object.entries(legacyUi);
  const recognizedUi = Object.fromEntries(
    legacyUiEntries.filter(([key]) => tuiKeySet.has(key)),
  );
  const tuiUpdates = missingValues(getPath(parsed, ["tui"]), recognizedUi);
  const currentTui = getPath(parsed, ["tui"]);
  const prospectiveStatusLine =
    getPath(currentTui, ["status_line"]) ?? recognizedUi.status_line;
  const prospectiveTerminalTitle =
    getPath(currentTui, ["terminal_title"]) ?? recognizedUi.terminal_title;
  const migratedStatusLine = migrateAliases(prospectiveStatusLine, STATUS_LINE_ALIASES);
  const migratedTerminalTitle = migrateAliases(
    prospectiveTerminalTitle,
    TERMINAL_TITLE_ALIASES,
  );
  if (migratedStatusLine) {
    tuiUpdates.status_line = migratedStatusLine;
  }
  if (migratedTerminalTitle) {
    tuiUpdates.terminal_title = migratedTerminalTitle;
  }
  if (Object.keys(tuiUpdates).length > 0) {
    setMigrationValue(migrationValues, ["tui"], tuiUpdates);
  }

  const removableKeys = legacyUiEntries
    .map(([key]) => key)
    .filter((key) => tuiKeySet.has(key) || RETIRED_UI_KEYS.has(key));
  if (removableKeys.length === legacyUiEntries.length) {
    removalPaths.push(["ui"]);
  } else {
    removalPaths.push(...removableKeys.map((key) => ["ui", key]));
  }
}

function migrateTuiAliases(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
): void {
  for (const [key, aliases] of [
    ["status_line", STATUS_LINE_ALIASES],
    ["terminal_title", TERMINAL_TITLE_ALIASES],
  ] as const) {
    const value =
      getPath(parsed, ["tui", key]) ?? getPath(migrationValues, ["tui", key]);
    const migrated = migrateAliases(value, aliases);
    if (migrated) {
      setMigrationValue(migrationValues, ["tui", key], migrated);
    }
  }
}

function migrateMcpServerAliases(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
): void {
  const servers = getPath(parsed, ["mcp_servers"]);
  if (!isRecord(servers)) {
    return;
  }
  for (const serverName of Object.keys(servers)) {
    migrateKey(
      parsed,
      migrationValues,
      removalPaths,
      ["mcp_servers", serverName, "experimental_environment"],
      ["mcp_servers", serverName, "environment_id"],
    );
  }
}

function migrateKey(
  parsed: unknown,
  migrationValues: Record<string, unknown>,
  removalPaths: string[][],
  legacyPath: string[],
  canonicalPath: string[],
): void {
  if (!hasPath(parsed, legacyPath)) {
    return;
  }
  if (!hasPath(parsed, canonicalPath) && !hasPath(migrationValues, canonicalPath)) {
    setMigrationValue(migrationValues, canonicalPath, getPath(parsed, legacyPath));
  }
  removalPaths.push(legacyPath);
}

function configScopes(parsed: unknown): string[][] {
  const scopes: string[][] = [[]];
  const profiles = getPath(parsed, ["profiles"]);
  if (isRecord(profiles)) {
    scopes.push(...Object.keys(profiles).map((name) => ["profiles", name]));
  }
  return scopes;
}

function usesManagedOpenAIModelCatalog(parsed: unknown, scope: string[] = []): boolean {
  const provider = getPath(parsed, [...scope, "model_provider"]);
  return (
    (provider === undefined || provider === "openai") &&
    getPath(parsed, [...scope, "openai_base_url"]) === undefined &&
    getPath(parsed, [...scope, "oss_provider"]) === undefined &&
    getPath(parsed, [...scope, "model_catalog_json"]) === undefined
  );
}

function setMigrationValue(
  migrationValues: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let current = migrationValues;
  for (const segment of path.slice(0, -1)) {
    const child = Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : undefined;
    if (!isRecord(child)) {
      setOwnProperty(current, segment, {});
    }
    current = current[segment] as Record<string, unknown>;
  }
  setOwnProperty(current, path.at(-1) as string, value);
}

function uniquePaths(paths: string[][]): string[][] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = JSON.stringify(path);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseTarget(text: string): unknown {
  try {
    return parse(text, { integersAsBigInt: "asNeeded" });
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
  const migrated = [
    ...new Set(
      value.map((item) =>
        Object.prototype.hasOwnProperty.call(aliases, item) ? aliases[item] : item,
      ),
    ),
  ];
  return JSON.stringify(migrated) === JSON.stringify(value) ? undefined : migrated;
}

function legacyWebSearchMode(
  parsed: unknown,
  scope: string[],
): "cached" | "live" | "disabled" {
  const scoped = (...path: string[]): string[] => [...scope, ...path];
  if (getPath(parsed, scoped("features", "web_search_cached")) === true) {
    return "cached";
  }
  if (
    getPath(parsed, scoped("web_search_request")) === true ||
    getPath(parsed, scoped("tools", "web_search_request")) === true ||
    getPath(parsed, scoped("features", "web_search_request")) === true ||
    getPath(parsed, scoped("features", "web_search")) === true ||
    getPath(parsed, scoped("tools_web_search")) === true
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

function missingValues(
  canonical: unknown,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const canonicalRecord = isRecord(canonical) ? canonical : undefined;
  for (const [key, legacyValue] of Object.entries(legacy)) {
    if (!canonicalRecord || !Object.prototype.hasOwnProperty.call(canonicalRecord, key)) {
      setOwnProperty(result, key, legacyValue);
      continue;
    }
    const canonicalValue = canonicalRecord[key];
    if (isRecord(canonicalValue) && isRecord(legacyValue)) {
      const nested = missingValues(canonicalValue, legacyValue);
      if (Object.keys(nested).length > 0) {
        setOwnProperty(result, key, nested);
      }
    }
  }
  return result;
}

function setOwnProperty(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
