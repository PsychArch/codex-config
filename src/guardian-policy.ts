import type { ConfigIssue } from "./codex-policy.js";

// guardian-context/src/budget.rs and preparation/transcript.rs in Codex.
const SECTION_MINIMUMS: Readonly<Record<string, bigint>> = {
  transcript_messages: 5000n, transcript_tools: 1000n, transcript_selected_exec_results: 0n,
  root_conversation_messages: 900n, retained_user_instructions: 900n,
  trusted_user_answers: 900n, sender_user_messages: 900n, planned_action: 900n,
  previous_reviews: 900n, trusted_tools: 900n, trusted_skills: 900n,
  transcript_images: 900n, node_repl_evidence: 900n, permission_context: 900n,
};
const SECTION_ALIASES: Readonly<Record<string, string>> = {
  root_messages: "root_conversation_messages", retained_instructions: "retained_user_instructions",
  user_answers: "trusted_user_answers", sender_messages: "sender_user_messages",
  tool_descriptions: "planned_action", planned_action_tool_descriptions: "planned_action",
  images: "transcript_images", repl_evidence: "node_repl_evidence",
};

export function guardianPolicyIssues(parsed: unknown): ConfigIssue[] {
  if (!isRecord(parsed)) return [];
  const issues: ConfigIssue[] = [];
  const issue = (code: string, path: string, message: string): void => {
    issues.push({ severity: "error", code, path, message });
  };
  if (isRecord(parsed.auto_review)) {
    for (const key of ["extra_policy", "experimental_policy_template", "experimental_denial_reconsideration_prompt"]) {
      if (Object.hasOwn(parsed.auto_review, key)) {
        issue("removed_guardian_policy", `auto_review.${key}`, key === "extra_policy"
          ? "Codex no longer consumes auto_review.extra_policy. Move enforced additional rules to guardian_extra_policy in managed requirements.toml. This tool preserves the text for manual migration."
          : "Codex no longer consumes this Guardian prompt override. Review and remove it manually; this tool preserves the text.");
      }
    }
  }
  if (!isRecord(parsed.features)) return issues;
  issues.push(...instructionLimitIssues(parsed.features.guardianv3));
  const guardian = parsed.features.guardianv2;
  if (!isRecord(guardian)) return issues;
  for (const mode of ["sync", "async"] as const) {
    if (guardian[`${mode}_elastic_budgeting`] !== true) continue;
    issues.push(...elasticIssues(guardian[`${mode}_elastic_sections`], mode));
  }
  return issues;
}

function instructionLimitIssues(guardian: unknown): ConfigIssue[] {
  if (!isRecord(guardian)) return [];
  const limit = integer(guardian.max_instruction_tokens);
  if (limit === undefined || limit < 0n) return [];
  const prompts = [
    ["housekeeper", "routing_instructions"],
    ["reviewer", "retrieval_instructions"],
  ] as const;
  const issues: ConfigIssue[] = [];
  for (const [section, key] of prompts) {
    const settings = guardian[section];
    if (!isRecord(settings)) continue;
    const prompt = settings[key];
    if (typeof prompt !== "string") continue;
    const trimmed = prompt.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    const tokens = Math.ceil(Buffer.byteLength(trimmed, "utf8") / 4);
    if (BigInt(tokens) > limit) {
      issues.push({
        severity: "error",
        code: "guardian_instruction_token_limit",
        path: `features.guardianv3.${section}.${key}`,
        message: `Estimated ${tokens} tokens exceeds max_instruction_tokens = ${limit}.`,
      });
    }
  }
  return issues;
}

function elasticIssues(sections: unknown, mode: "sync" | "async"): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (code: string, path: string, message: string): void => {
    issues.push({ severity: "error", code, path, message });
  };
  const path = `features.guardianv2.${mode}_elastic_sections`;
  if (!isRecord(sections) || Object.keys(sections).length === 0) {
    issue("guardian_elastic_sections_required", path, "Enabled Guardian elastic budgeting requires a nonempty section map.");
    return issues;
  }
  const minimums = new Map(Object.entries(SECTION_MINIMUMS));
  const seen = new Set<string>();
  let canSum = true;
  for (const [name, limits] of Object.entries(sections)) {
    const canonical = Object.hasOwn(SECTION_ALIASES, name) ? SECTION_ALIASES[name] : name;
    const sectionPath = `${path}.${JSON.stringify(name)}`;
    if (!minimums.has(canonical)) {
      issue("guardian_elastic_unknown_section", sectionPath, "Unknown Guardian elastic section name.");
      canSum = false;
      continue;
    }
    if (seen.has(canonical)) {
      issue("guardian_elastic_duplicate_section", sectionPath, "This section is configured more than once through aliases.");
    }
    seen.add(canonical);
    if (!isRecord(limits)) { canSum = false; continue; } // Schema reports malformed limits.
    const names = limits.nested_tool_names;
    if (canonical === "transcript_selected_exec_results") {
      if (mode === "async") {
        issue("guardian_elastic_selected_exec_sync_only", sectionPath,
          "transcript_selected_exec_results is only supported for sync elastic budgeting.");
      }
      if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string" || name.trim() === "")) {
        issue("guardian_elastic_nested_tool_names", `${sectionPath}.nested_tool_names`,
          "Selected exec results require nonempty nested_tool_names with no blank entries.");
      }
    } else if (Array.isArray(names) && names.length > 0) {
      issue("guardian_elastic_nested_tool_names", `${sectionPath}.nested_tool_names`,
        "nested_tool_names is only supported for transcript_selected_exec_results.");
    }
    const minimum = integer(limits.min_total_section_tokens);
    const entry = integer(limits.max_section_entry_tokens);
    const maximum = integer(limits.max_total_section_tokens);
    if (minimum === undefined || entry === undefined) { canSum = false; continue; }
    minimums.set(canonical, minimum);
    if (minimum <= 0n || entry <= 0n || entry > minimum || entry > 9000n ||
      (maximum !== undefined && maximum < minimum)) {
      issue("guardian_elastic_section_limits", sectionPath,
        "Section minimum and entry limits must be positive, entry <= minimum and <= 9000, and an explicit maximum must be >= minimum.");
    }
  }
  if (canSum && [...minimums.values()].reduce((sum, value) => sum + value, 0n) !== 128000n) {
    issue("guardian_elastic_minimum_total", path,
      "Guardian elastic section minimums, including defaults for omitted sections, must sum to 128000 tokens.");
  }
  return issues;
}

function integer(value: unknown): bigint | undefined {
  return typeof value === "bigint" ? value :
    typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
