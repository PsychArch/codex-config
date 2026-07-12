#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

program
  .name("codex-config")
  .description("Keep your Codex configuration up to date as Codex evolves.")
  .version(packageVersion)
  .option("--json", "print machine-readable JSON");

program
  .command("apply")
  .description("Update Codex config with recommended settings.")
  .option("--target <path>", "target config.toml path")
  .option("-p, --profile <name>", "target $CODEX_HOME/<name>.config.toml")
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
  .description("Preview recommended updates without changing the config.")
  .option("--target <path>", "target config.toml path")
  .option("-p, --profile <name>", "target $CODEX_HOME/<name>.config.toml")
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
  .description("Exit nonzero when the Codex config needs an update.")
  .option("--target <path>", "target config.toml path")
  .option("-p, --profile <name>", "target $CODEX_HOME/<name>.config.toml")
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
  .description("Check the Codex config for compatibility issues.")
  .option("--target <path>", "target config.toml path")
  .option("-p, --profile <name>", "target $CODEX_HOME/<name>.config.toml")
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
