import { isAbsolute } from "node:path";

// CredentialExportConfig::validate in the pinned model-provider-info source.
export function validCredentialExportCommand(command: unknown): boolean {
  return typeof command === "string" && command.trim() !== "" &&
    (isAbsolute(command) || (!command.includes("/") && command !== "." && command !== ".." &&
      (process.platform !== "win32" || !/[\\:]/.test(command))));
}
