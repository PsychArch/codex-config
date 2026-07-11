import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { planCodexMigrations } from "./codex-migrations.js";
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
    templateInspection = await inspectCodexConfig(await readFile(paths.template, "utf8"), "template", {
      requireModel: true,
    });
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
      (!targetInspection || (targetInspection.valid && targetInspection.clean)),
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
  const templateInspection = await inspectCodexConfig(templateText, "template", {
    requireModel: true,
  });
  if (!templateInspection.clean) {
    throw new Error(`Template is not compatible with the GPT-5.6 target:\n${formatConfigIssues("template", templateInspection)}`);
  }

  const migrationPlan = targetText === undefined ? undefined : planCodexMigrations(targetText);
  const mergePlan = planConfigChange({
    targetText: migrationPlan?.outputText,
    templateText,
    mode,
    targetPath,
  });
  const plan = migrationPlan ? combinePlans(migrationPlan, mergePlan) : mergePlan;
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
  if (command === "apply") {
    if (result.dryRun) {
      lines.push(result.changed ? "Changes would be applied." : "Already up to date.");
    } else {
      lines.push(result.changed ? "Config updated." : "Already up to date.");
    }
  } else if (command === "check") {
    lines.push(result.changed ? "Config is not up to date." : "Config is up to date.");
  } else {
    lines.push(result.changed ? "Changes found." : "No changes.");
  }

  lines.push(`target: ${result.target}`);
  lines.push(`template: ${result.template}`);
  lines.push(`mode: ${result.mode}`);
  for (const operation of result.operations) {
    lines.push(`${operation.action}: ${operation.path}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatDoctorText(result: DoctorResult): string {
  const lines = [
    result.ok ? "codex-config is ready." : "codex-config is not ready.",
    `Codex source: ${result.codex.sourceRevision}`,
    `minimum Codex version: ${result.codex.minimumClientVersion}`,
    `default model: ${result.codex.defaultModel}`,
    `supported models: ${result.codex.supportedModels.join(", ")}`,
    `target: ${result.target.path}`,
    `target exists: ${String(result.target.exists)}`,
    `target valid TOML: ${String(result.target.validToml)}`,
    `target compatible: ${String(result.target.compatible)}`,
    `target clean: ${String(result.target.clean)}`,
    `template: ${result.template.path}`,
    `template exists: ${String(result.template.exists)}`,
    `template valid TOML: ${String(result.template.validToml)}`,
    `template compatible: ${String(result.template.compatible)}`,
    `template clean: ${String(result.template.clean)}`,
    "auth required: false",
  ];
  for (const issue of result.target.issues) {
    lines.push(`${issue.severity}: target${issue.path ? `.${issue.path}` : ""}: ${issue.message}`);
  }
  for (const issue of result.template.issues) {
    lines.push(`${issue.severity}: template${issue.path ? `.${issue.path}` : ""}: ${issue.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export function targetDirectory(options: CommandOptions): string {
  if (options.target && options.profile) {
    throw new Error("--target and --profile cannot be used together.");
  }
  return dirname(resolve(options.target ?? defaultTargetPath(options.profile)));
}
