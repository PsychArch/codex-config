import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultTargetPath(): string {
  return resolve(homedir(), ".codex/config.toml");
}

export function defaultTemplatePath(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDirectory, "../config.toml.template");
}
