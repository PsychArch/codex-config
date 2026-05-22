import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteFile, fileExists, readTextIfExists } from "./fs.js";
import { defaultTargetPath, defaultTemplatePath } from "./paths.js";
import { planConfigChange, validateToml, type ChangeOperation, type MergeMode } from "./toml-merge.js";

export interface CommandOptions {
  target?: string;
  template?: string;
  overrideAll?: boolean;
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
  target: {
    path: string;
    exists: boolean;
    validToml: boolean | null;
  };
  template: {
    path: string;
    exists: boolean;
    validToml: boolean;
  };
  authRequired: false;
}

export async function applyConfig(options: ApplyOptions): Promise<CommandResult> {
  const paths = resolvePaths(options);
  const mode = modeFromOptions(options);
  const templateText = await readFile(paths.template, "utf8");
  const targetText = await readTextIfExists(paths.target);
  const plan = planConfigChange({ targetText, templateText, mode, targetPath: paths.target });

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
  const plan = planConfigChange({ targetText, templateText, mode, targetPath: paths.target });
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
  let templateValid = false;
  if (templateExists) {
    validateToml(await readFile(paths.template, "utf8"), "template");
    templateValid = true;
  }

  const targetExists = await fileExists(paths.target);
  let targetValid: boolean | null = null;
  if (targetExists) {
    validateToml((await readTextIfExists(paths.target)) ?? "", "target");
    targetValid = true;
  }

  return {
    ok: templateExists && templateValid && (!targetExists || targetValid === true),
    target: {
      path: paths.target,
      exists: targetExists,
      validToml: targetValid,
    },
    template: {
      path: paths.template,
      exists: templateExists,
      validToml: templateValid,
    },
    authRequired: false,
  };
}

function resolvePaths(options: CommandOptions): { target: string; template: string } {
  const target = resolve(options.target ?? defaultTargetPath());
  const template = resolve(options.template ?? defaultTemplatePath());
  return { target, template };
}

function modeFromOptions(options: CommandOptions): MergeMode {
  return options.overrideAll ? "override" : "missing";
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
  return [
    result.ok ? "codex-config is ready." : "codex-config is not ready.",
    `target: ${result.target.path}`,
    `target exists: ${String(result.target.exists)}`,
    `target valid TOML: ${String(result.target.validToml)}`,
    `template: ${result.template.path}`,
    `template exists: ${String(result.template.exists)}`,
    `template valid TOML: ${String(result.template.validToml)}`,
    "auth required: false",
  ].join("\n") + "\n";
}

export function targetDirectory(options: CommandOptions): string {
  return dirname(resolve(options.target ?? defaultTargetPath()));
}
