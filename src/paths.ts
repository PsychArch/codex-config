import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultCodexHomePath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return configuredHome ? resolve(configuredHome) : resolve(homedir(), ".codex");
}

export function defaultTargetPath(profile?: string): string {
  const filename = profile ? `${validateProfileName(profile)}.config.toml` : "config.toml";
  return join(defaultCodexHomePath(), filename);
}

export function defaultTemplatePath(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDirectory, "../config.toml.template");
}

export function defaultSchemaPath(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDirectory, "../config.schema.json");
}

export function validateProfileName(profile: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new Error(`Invalid profile name \`${profile}\`; use a plain name such as \`work\`.`);
  }
  return profile;
}
