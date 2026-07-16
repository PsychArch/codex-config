import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { adaptCodexTemplate, planCodexMigrations } from "./codex-migrations.js";
import {
  CODEX_TARGET,
  formatConfigIssues,
  inspectCodexConfig,
  type ConfigInspection,
  type ConfigIssue,
} from "./codex-policy.js";
import { atomicWriteFile, fileExists, readTextIfExists } from "./fs.js";
import { defaultSchemaPath, defaultTargetPath, defaultTemplatePath } from "./paths.js";
import { planConfigChange, type ChangeOperation, type ConfigChangePlan, type MergeMode } from "./toml-merge.js";

export interface CommandOptions {
  target?: string;
  template?: string;
  profile?: string;
  force?: boolean;
}

export interface ApplyOptions extends CommandOptions {
  dryRun?: boolean;
}

export interface CommandResult {
  ok: true;
  changed: boolean;
  target: string;
  template: string;
  mode: MergeMode;
  operations: ChangeOperation[];
  dryRun?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  codex: {
    sourceRevision: string;
    sourceCommitDate: string;
    minimumClientVersion: string;
    schema: string;
    defaultModel: string;
    supportedModels: string[];
  };
  target: {
    path: string;
    exists: boolean;
    validToml: boolean | null;
    compatible: boolean | null;
    clean: boolean | null;
    issues: ConfigIssue[];
  };
  template: {
    path: string;
    exists: boolean;
    validToml: boolean;
    compatible: boolean;
    clean: boolean;
    issues: ConfigIssue[];
  };
  authRequired: false;
}

export async function applyConfig(options: ApplyOptions): Promise<CommandResult> {
  const paths = resolvePaths(options);
  const mode = modeFromOptions(options);
  const templateText = await readFile(paths.template, "utf8");
  const targetText = await readTextIfExists(paths.target);
  const plan = await buildConfigPlan(targetText, templateText, mode, paths.target);

  if (plan.changed && !options.dryRun) {
    await atomicWriteFile(paths.target, plan.outputText);
  }

  return {
    ok: true,
    changed: plan.changed,
    target: paths.target,
    template: paths.template,
    mode,
    operations: plan.operations,
    dryRun: options.dryRun,
  };
}

export async function diffConfig(options: CommandOptions): Promise<CommandResult> {
  const paths = resolvePaths(options);
  const mode = modeFromOptions(options);
  const templateText = await readFile(paths.template, "utf8");
  const targetText = await readTextIfExists(paths.target);
  const plan = await buildConfigPlan(targetText, templateText, mode, paths.target);
  return {
    ok: true,
    changed: plan.changed,
    target: paths.target,
    template: paths.template,
    mode,
    operations: plan.operations,
  };
}

export async function doctor(options: CommandOptions): Promise<DoctorResult> {
  const paths = resolvePaths(options);
  const templateExists = await fileExists(paths.template);
  let templateInspection = emptyInspection();
  if (templateExists) {
    const templateText = await readFile(paths.template, "utf8");
    templateInspection = await inspectCodexConfig(
      planCodexMigrations(templateText).outputText,
      "template",
      { requireModel: true },
    );
  }

  const targetExists = await fileExists(paths.target);
  let targetInspection: ConfigInspection | null = null;
  if (targetExists) {
    targetInspection = await inspectCodexConfig(
      (await readTextIfExists(paths.target)) ?? "",
      "target",
      { requireModel: true },
    );
  }

  return {
    ok:
      templateExists &&
      templateInspection.valid &&
      templateInspection.clean &&
      targetExists &&
      Boolean(targetInspection?.valid && targetInspection.clean),
    codex: {
      sourceRevision: CODEX_TARGET.sourceRevision,
      sourceCommitDate: CODEX_TARGET.sourceCommitDate,
      minimumClientVersion: CODEX_TARGET.minimumClientVersion,
      schema: defaultSchemaPath(),
      defaultModel: CODEX_TARGET.defaultModel,
      supportedModels: CODEX_TARGET.models.map((model) => model.id),
    },
    target: {
      path: paths.target,
      exists: targetExists,
      validToml: targetInspection ? hasValidToml(targetInspection) : null,
      compatible: targetInspection?.valid ?? null,
      clean: targetInspection?.clean ?? null,
      issues: targetInspection?.issues ?? [],
    },
    template: {
      path: paths.template,
      exists: templateExists,
      validToml: templateExists && hasValidToml(templateInspection),
      compatible: templateExists && templateInspection.valid,
      clean: templateExists && templateInspection.clean,
      issues: templateInspection.issues,
    },
    authRequired: false,
  };
}

async function buildConfigPlan(
  targetText: string | undefined,
  templateText: string,
  mode: MergeMode,
  targetPath: string,
): Promise<ConfigChangePlan> {
  const normalizedTemplateText = planCodexMigrations(templateText).outputText;
  const templateInspection = await inspectCodexConfig(normalizedTemplateText, "template", {
    requireModel: true,
  });
  if (!templateInspection.clean) {
    throw new Error(`Template is not compatible with the GPT-5.6 target:\n${formatConfigIssues("template", templateInspection)}`);
  }

  const migrationPlan =
    targetText === undefined
      ? undefined
      : planCodexMigrations(targetText, { targetPath });
  const effectiveTemplateText = migrationPlan && mode === "missing"
    ? adaptCodexTemplate(migrationPlan.outputText, normalizedTemplateText)
    : normalizedTemplateText;
  const mergePlan = planConfigChange({
    targetText: migrationPlan?.outputText,
    templateText: effectiveTemplateText,
    mode,
    targetPath,
  });
  const mergedPlan = migrationPlan ? combinePlans(migrationPlan, mergePlan) : mergePlan;
  const finalMigrationPlan = migrationPlan
    ? planCodexMigrations(mergedPlan.outputText, { targetPath })
    : undefined;
  const plan = finalMigrationPlan
    ? combinePlans(mergedPlan, finalMigrationPlan)
    : mergedPlan;
  const finalInspection = await inspectCodexConfig(plan.outputText, "result", {
    requireModel: true,
  });
  if (!finalInspection.valid) {
    throw new Error(`Result is not compatible with the GPT-5.6 target:\n${formatConfigIssues("result", finalInspection)}`);
  }
  return plan;
}

function combinePlans(first: ConfigChangePlan, second: ConfigChangePlan): ConfigChangePlan {
  return {
    changed: first.changed || second.changed,
    outputText: second.outputText,
    operations: [...first.operations, ...second.operations],
  };
}

function emptyInspection(): ConfigInspection {
  return { valid: false, clean: false, issues: [] };
}

function hasValidToml(inspection: ConfigInspection): boolean {
  return !inspection.issues.some((issue) => issue.code === "invalid_toml");
}

function resolvePaths(options: CommandOptions): { target: string; template: string } {
  if (options.target && options.profile) {
    throw new Error("--target and --profile cannot be used together.");
  }
  const target = resolve(options.target ?? defaultTargetPath(options.profile));
  const template = resolve(options.template ?? defaultTemplatePath());
  return { target, template };
}

function modeFromOptions(options: CommandOptions): MergeMode {
  return options.force ? "override" : "missing";
}

export function formatTextResult(command: "apply" | "diff" | "check", result: CommandResult): string {
  const lines: string[] = [];
  const createsConfig = result.operations.some((operation) => operation.action === "create");
  if (command === "apply") {
    if (result.dryRun) {
      lines.push(
        result.changed
          ? createsConfig
            ? "Codex config would be created."
            : "Codex config would be updated."
          : "Codex config is already up to date.",
      );
    } else {
      lines.push(
        result.changed
          ? createsConfig
            ? "Codex config created."
            : "Codex config updated."
          : "Codex config is already up to date.",
      );
    }
  } else if (command === "check") {
    lines.push(
      result.changed ? "Codex config is not up to date." : "Codex config is up to date.",
    );
  } else {
    lines.push(
      result.changed ? "Codex config has pending updates." : "Codex config is up to date.",
    );
  }

  lines.push(`  ${displayPath(result.target)}`);
  if (result.changed) {
    lines.push(...formatOperationGroups(result.operations));
  }
  return `${lines.join("\n")}\n`;
}

export function formatDoctorText(result: DoctorResult): string {
  const lines = [
    result.ok ? "Codex config looks good." : "Codex config needs attention.",
    `  ${displayPath(result.target.path)}`,
  ];

  if (!result.target.exists) {
    lines.push("", "Config file not found.", "Run: codex-config apply");
  }

  const targetIssues = formatIssueGroups(result.target.issues);
  if (targetIssues.length > 0) {
    lines.push(...targetIssues);
  }

  const templateIssues = formatIssueGroups(result.template.issues, "Bundled recommendations");
  if (!result.template.exists) {
    lines.push("", "Bundled recommendations could not be found. Reinstall codex-config.");
  } else if (templateIssues.length > 0) {
    lines.push(...templateIssues);
  }

  if (result.ok) {
    lines.push("", "No compatibility issues found.");
  }

  return `${lines.join("\n")}\n`;
}

function formatOperationGroups(operations: ChangeOperation[]): string[] {
  const groups: Array<{ action: ChangeOperation["action"]; heading: string }> = [
    { action: "add", heading: "Added settings:" },
    { action: "update", heading: "Updated settings:" },
    { action: "remove", heading: "Removed obsolete settings:" },
    { action: "reformat", heading: "Reformatted after semantic TOML migration:" },
  ];
  const lines: string[] = [];
  for (const group of groups) {
    const paths = operations
      .filter((operation) => operation.action === group.action)
      .map((operation) => operation.path);
    if (paths.length === 0) {
      continue;
    }
    lines.push("", group.heading, ...paths.map((path) => `  - ${path}`));
  }
  return lines;
}

function formatIssueGroups(issues: ConfigIssue[], label?: string): string[] {
  const lines: string[] = [];
  for (const severity of ["error", "warning"] as const) {
    const matching = issues.filter((issue) => issue.severity === severity);
    if (matching.length === 0) {
      continue;
    }
    const heading = severity === "error" ? "Errors:" : "Warnings:";
    lines.push("", label ? `${label} - ${heading}` : heading);
    for (const issue of matching) {
      lines.push(`  - ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
    }
  }
  return lines;
}

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) {
    return "~";
  }
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function targetDirectory(options: CommandOptions): string {
  if (options.target && options.profile) {
    throw new Error("--target and --profile cannot be used together.");
  }
  return dirname(resolve(options.target ?? defaultTargetPath(options.profile)));
}
