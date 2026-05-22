import { parse } from "smol-toml";

export type MergeMode = "missing" | "override";

export interface PlanConfigChangeOptions {
  targetText: string | undefined;
  templateText: string;
  mode: MergeMode;
  targetPath?: string;
}

export interface ChangeOperation {
  action: "create" | "add" | "update";
  path: string;
}

export interface ConfigChangePlan {
  changed: boolean;
  outputText: string;
  operations: ChangeOperation[];
}

interface ScannedEntry {
  tablePath: string[];
  keyPath: string[];
  fullPath: string[];
  valueLines: string[];
  insertionLines: string[];
  start: number;
  end: number;
  order: number;
}

interface TableLocation {
  path: string[];
  header: number | undefined;
  start: number;
  end: number;
}

interface ScanResult {
  entries: ScannedEntry[];
  entryByPath: Map<string, ScannedEntry>;
  tables: Map<string, TableLocation>;
  lines: string[];
}

interface Mutation {
  start: number;
  end: number;
  lines: string[];
}

export function planConfigChange(options: PlanConfigChangeOptions): ConfigChangePlan {
  const templateText = normalizeNewlines(options.templateText);
  const templateParsed = parseToml(templateText, "template");
  const templateScan = scanToml(templateText, true);

  if (options.targetText === undefined) {
    return {
      changed: true,
      outputText: ensureTrailingNewline(templateText),
      operations: [{ action: "create", path: options.targetPath ?? "~/.codex/config.toml" }],
    };
  }

  const targetText = normalizeNewlines(options.targetText);
  const targetParsed = parseToml(targetText, "target");
  const targetScan = scanToml(targetText, false);
  const operations: ChangeOperation[] = [];
  const mutations: Mutation[] = [];
  const missingByTable = new Map<string, ScannedEntry[]>();

  for (const entry of templateScan.entries) {
    const fullKey = pathKey(entry.fullPath);
    const templateValue = getPath(templateParsed, entry.fullPath);
    const targetHasValue = hasPath(targetParsed, entry.fullPath);

    if (!targetHasValue) {
      const tableKey = pathKey(entry.tablePath);
      const group = missingByTable.get(tableKey) ?? [];
      group.push(entry);
      missingByTable.set(tableKey, group);
      operations.push({ action: "add", path: formatPath(entry.fullPath) });
      continue;
    }

    if (options.mode === "override") {
      const targetValue = getPath(targetParsed, entry.fullPath);
      if (!deepEqual(templateValue, targetValue)) {
        const targetEntry = targetScan.entryByPath.get(fullKey);
        if (!targetEntry) {
          throw new Error(
            `Cannot override ${formatPath(entry.fullPath)} because it is not represented as a standalone TOML key.`,
          );
        }
        mutations.push({
          start: targetEntry.start,
          end: targetEntry.end,
          lines: entry.valueLines,
        });
        operations.push({ action: "update", path: formatPath(entry.fullPath) });
      }
    }
  }

  for (const [tableKey, entries] of missingByTable) {
    entries.sort((a, b) => a.order - b.order);
    const tablePath = entries[0]?.tablePath ?? [];
    const table = targetScan.tables.get(tableKey);
    if (table) {
      const insertAt = tableInsertIndex(targetScan.lines, table);
      mutations.push({
        start: insertAt,
        end: insertAt,
        lines: linesForExistingTableInsert(targetScan.lines, insertAt, entries),
      });
    } else {
      const insertAt = targetScan.lines.length;
      mutations.push({
        start: insertAt,
        end: insertAt,
        lines: linesForNewTable(targetScan.lines, tablePath, entries),
      });
    }
  }

  if (mutations.length === 0) {
    return {
      changed: false,
      outputText: ensureTrailingNewline(targetText),
      operations,
    };
  }

  const outputLines = applyMutations(targetScan.lines, mutations);
  return {
    changed: true,
    outputText: ensureTrailingNewline(outputLines.join("\n")),
    operations,
  };
}

export function validateToml(text: string, label: string): void {
  parseToml(text, label);
}

function parseToml(text: string, label: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} TOML: ${message}`);
  }
}

function scanToml(text: string, includeLeadingComments: boolean): ScanResult {
  const lines = splitLines(text);
  const entries: ScannedEntry[] = [];
  const tables = new Map<string, TableLocation>();
  const entryByPath = new Map<string, ScannedEntry>();
  let currentTable: string[] = [];
  let currentTableKey = pathKey([]);
  let pendingCommentStart: number | undefined;
  let order = 0;

  tables.set(currentTableKey, { path: [], header: undefined, start: 0, end: lines.length });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const header = parseHeader(line);
    if (header) {
      closeTable(tables, currentTableKey, i);
      currentTable = header.path;
      currentTableKey = pathKey(currentTable);
      tables.set(currentTableKey, {
        path: currentTable,
        header: i,
        start: i + 1,
        end: lines.length,
      });
      pendingCommentStart = undefined;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "") {
      pendingCommentStart = undefined;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (pendingCommentStart === undefined) {
        pendingCommentStart = i;
      }
      continue;
    }

    const keyLine = parseKeyLine(line);
    if (!keyLine) {
      pendingCommentStart = undefined;
      continue;
    }

    const end = valueEndLine(lines, i, keyLine.valueStartColumn);
    const keyPath = parseTomlPath(keyLine.keySource);
    const fullPath = [...currentTable, ...keyPath];
    const start =
      includeLeadingComments && pendingCommentStart !== undefined
        ? pendingCommentStart
        : i;
    const entry: ScannedEntry = {
      tablePath: currentTable,
      keyPath,
      fullPath,
      valueLines: lines.slice(i, end),
      insertionLines: lines.slice(start, end),
      start: i,
      end,
      order,
    };
    order += 1;
    entries.push(entry);
    entryByPath.set(pathKey(fullPath), entry);
    pendingCommentStart = undefined;
    i = end - 1;
  }

  closeTable(tables, currentTableKey, lines.length);
  return { entries, entryByPath, tables, lines };
}

function closeTable(tables: Map<string, TableLocation>, tableKey: string, end: number): void {
  const table = tables.get(tableKey);
  if (table) {
    table.end = end;
  }
}

function parseHeader(line: string): { path: string[] } | undefined {
  const trimmed = stripInlineComment(line).trim();
  const match = trimmed.match(/^\[{1,2}(.+?)\]{1,2}$/);
  if (!match?.[1]) {
    return undefined;
  }
  return { path: parseTomlPath(match[1].trim()) };
}

function parseKeyLine(line: string): { keySource: string; valueStartColumn: number } | undefined {
  const equalIndex = findFirstEqual(line);
  if (equalIndex < 0) {
    return undefined;
  }
  const keySource = line.slice(0, equalIndex).trim();
  if (keySource === "") {
    return undefined;
  }
  return { keySource, valueStartColumn: equalIndex + 1 };
}

function findFirstEqual(line: string): number {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (quote === "\"" && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = undefined;
      }
      escaped = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return -1;
    }
    if (char === "=") {
      return i;
    }
  }
  return -1;
}

function valueEndLine(lines: string[], start: number, valueStartColumn: number): number {
  let depth = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const from = i === start ? valueStartColumn : 0;
    for (let column = from; column < line.length; column += 1) {
      const char = line[column];
      if (quote) {
        if (quote === "\"" && char === "\\" && !escaped) {
          escaped = true;
          continue;
        }
        if (char === quote && !escaped) {
          quote = undefined;
        }
        escaped = false;
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        continue;
      }
      if (char === "#") {
        break;
      }
      if (char === "[" || char === "{") {
        depth += 1;
      } else if (char === "]" || char === "}") {
        depth -= 1;
      }
    }
    if (depth <= 0 && !quote) {
      return i + 1;
    }
  }
  return start + 1;
}

function parseTomlPath(source: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      current += char;
      if (quote === "\"" && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = undefined;
      }
      escaped = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ".") {
      segments.push(unquoteKey(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(unquoteKey(current.trim()));
  return segments.filter((segment) => segment.length > 0);
}

function unquoteKey(segment: string): string {
  if (segment.startsWith("\"") && segment.endsWith("\"")) {
    return JSON.parse(segment) as string;
  }
  if (segment.startsWith("'") && segment.endsWith("'")) {
    return segment.slice(1, -1);
  }
  return segment;
}

function stripInlineComment(line: string): string {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (quote === "\"" && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = undefined;
      }
      escaped = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function linesForExistingTableInsert(
  targetLines: string[],
  insertAt: number,
  entries: ScannedEntry[],
): string[] {
  const insertLines = entries.flatMap((entry) => entry.insertionLines);
  if (insertLines.length === 0) {
    return [];
  }
  if (insertAt > 0 && targetLines[insertAt - 1]?.trim() === "") {
    return insertLines;
  }
  return insertLines;
}

function linesForNewTable(
  targetLines: string[],
  tablePath: string[],
  entries: ScannedEntry[],
): string[] {
  const block: string[] = [];
  if (targetLines.length > 0 && targetLines[targetLines.length - 1]?.trim() !== "") {
    block.push("");
  }
  if (tablePath.length > 0) {
    block.push(`[${tablePath.map(formatTomlKey).join(".")}]`);
  }
  block.push(...entries.flatMap((entry) => entry.insertionLines));
  return block;
}

function tableInsertIndex(lines: string[], table: TableLocation): number {
  let index = table.end;
  while (index > table.start && lines[index - 1]?.trim() === "") {
    index -= 1;
  }
  return index;
}

function applyMutations(lines: string[], mutations: Mutation[]): string[] {
  const sorted = [...mutations].sort((a, b) => {
    if (a.start !== b.start) {
      return b.start - a.start;
    }
    return b.end - a.end;
  });
  const output = [...lines];
  for (const mutation of sorted) {
    output.splice(mutation.start, mutation.end - mutation.start, ...mutation.lines);
  }
  return output;
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

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function splitLines(text: string): string[] {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

function formatPath(path: string[]): string {
  return path.map(formatTomlKey).join(".");
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
