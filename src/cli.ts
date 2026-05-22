#!/usr/bin/env node
import { program } from "commander";
import {
  applyConfig,
  diffConfig,
  doctor,
  formatDoctorText,
  formatTextResult,
  type CommandOptions,
} from "./commands.js";

interface CliOptions extends CommandOptions {
  json?: boolean;
  dryRun?: boolean;
}

let jsonMode = false;

program
  .name("codex-config")
  .description("Idempotently apply config.toml.template to ~/.codex/config.toml.")
  .version("0.2.0")
  .option("--json", "print machine-readable JSON");

program
  .command("apply")
  .description("Apply the template to the target config.")
  .option("--target <path>", "target config.toml path")
  .option("--template <path>", "template config.toml path")
  .option("-f, --force", "overwrite template-covered keys that already exist")
  .option("--dry-run", "show planned changes without writing")
  .option("--json", "print machine-readable JSON")
  .action(async (options: CliOptions) => {
    jsonMode = shouldUseJson(options);
    const result = await applyConfig(options);
    writeResult(jsonMode, result, formatTextResult("apply", result));
  });

program
  .command("diff")
  .description("Show whether applying the template would change the target.")
  .option("--target <path>", "target config.toml path")
  .option("--template <path>", "template config.toml path")
  .option("-f, --force", "compare using force behavior")
  .option("--json", "print machine-readable JSON")
  .action(async (options: CliOptions) => {
    jsonMode = shouldUseJson(options);
    const result = await diffConfig(options);
    writeResult(jsonMode, result, formatTextResult("diff", result));
  });

program
  .command("check")
  .description("Exit nonzero when the target is not up to date with the template.")
  .option("--target <path>", "target config.toml path")
  .option("--template <path>", "template config.toml path")
  .option("-f, --force", "check using force behavior")
  .option("--json", "print machine-readable JSON")
  .action(async (options: CliOptions) => {
    jsonMode = shouldUseJson(options);
    const result = await diffConfig(options);
    writeResult(jsonMode, result, formatTextResult("check", result));
    if (result.changed) {
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Validate default paths and TOML parser readiness.")
  .option("--target <path>", "target config.toml path")
  .option("--template <path>", "template config.toml path")
  .option("--json", "print machine-readable JSON")
  .action(async (options: CliOptions) => {
    jsonMode = shouldUseJson(options);
    const result = await doctor(options);
    writeResult(jsonMode, result, formatDoctorText(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program.exitOverride();

try {
  await program.parseAsync();
} catch (error) {
  if (isCommanderHelpOrVersion(error)) {
    process.exitCode = 0;
  } else {
    printError(error, jsonMode);
    process.exitCode = 1;
  }
}

function writeResult(json: boolean | undefined, value: unknown, text: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(text);
}

function printError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`error: ${message}\n`);
}

function shouldUseJson(options: CliOptions): boolean {
  return Boolean(options.json || program.opts<{ json?: boolean }>().json);
}

function isCommanderHelpOrVersion(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "commander.helpDisplayed" || code === "commander.version";
}
