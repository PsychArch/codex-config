import { parse, stringify, TomlDate } from "smol-toml";

export type MergeMode = "missing" | "override";

export interface PlanConfigChangeOptions {
  targetText: string | undefined;
  templateText: string;
  mode: MergeMode;
  targetPath?: string;
}

export interface ChangeOperation {
  action: "create" | "add" | "update" | "remove" | "reformat";
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

  if (options.targetText === undefined) {
    return {
      changed: true,
      outputText: ensureTrailingNewline(templateText),
      operations: [{ action: "create", path: options.targetPath ?? "~/.codex/config.toml" }],
    };
  }

  const targetText = normalizeNewlines(options.targetText);
  const targetParsed = parseToml(targetText, "target");
  const semanticPlan = planSemanticChange(targetParsed, templateParsed, options.mode);
  if (semanticPlan.operations.length === 0) {
    return {
      changed: false,
      outputText: ensureTrailingNewline(targetText),
      operations: [],
    };
  }

  try {
    const surgicalPlan = planConfigChangeSurgically({
      ...options,
      targetText,
      templateText,
    });
    if (semanticEqual(parseToml(surgicalPlan.outputText, "result"), semanticPlan.output)) {
      return {
        changed: true,
        outputText: surgicalPlan.outputText,
        operations: semanticPlan.operations,
      };
    }
  } catch {
    // Some valid TOML representations (notably inline tables, dotted keys,
    // arrays of tables, and multiline strings) cannot be edited safely by the
    // line-oriented fast path. Fall back to a canonical semantic rewrite.
  }

  const outputText = ensureTrailingNewline(
    stringify(semanticPlan.output, { numbersAsFloat: true }),
  );
  if (!semanticEqual(parseToml(outputText, "result"), semanticPlan.output)) {
    throw new Error("Could not serialize the intended TOML merge without changing its meaning.");
  }
  return {
    changed: true,
    outputText,
    operations: [
      ...semanticPlan.operations,
      { action: "reformat", path: options.targetPath ?? "config.toml" },
    ],
  };
}

function planConfigChangeSurgically(options: PlanConfigChangeOptions): ConfigChangePlan {
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

  const tableGroups = [...missingByTable.entries()];
  tableGroups.sort(([leftKey], [rightKey]) => {
    const leftExists = targetScan.tables.has(leftKey);
    const rightExists = targetScan.tables.has(rightKey);
    return leftExists === rightExists ? 0 : leftExists ? -1 : 1;
  });

  for (const [tableKey, entries] of tableGroups) {
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

export function planConfigRemovals(
  targetText: string,
  paths: ReadonlyArray<ReadonlyArray<string>>,
  targetPath = "config.toml",
): ConfigChangePlan {
  const normalizedTarget = normalizeNewlines(targetText);
  const targetParsed = parseToml(normalizedTarget, "target");
  const output = cloneTomlValue(targetParsed);
  const operations: ChangeOperation[] = [];
  for (const readonlyPath of paths) {
    const path = [...readonlyPath];
    if (path.length === 0) {
      throw new Error("A TOML removal path cannot be empty.");
    }
    if (!hasPath(output, path)) {
      continue;
    }
    deletePath(output, path);
    operations.push({ action: "remove", path: formatPath(path) });
  }

  if (operations.length === 0) {
    return {
      changed: false,
      outputText: ensureTrailingNewline(normalizedTarget),
      operations,
    };
  }

  try {
    const surgicalPlan = planConfigRemovalsSurgically(normalizedTarget, paths);
    if (semanticEqual(parseToml(surgicalPlan.outputText, "result"), output)) {
      return {
        changed: true,
        outputText: surgicalPlan.outputText,
        operations,
      };
    }
  } catch {
    // See planConfigChange: canonical rewriting is safer than emitting TOML
    // whose surface edit no longer matches the intended semantic document.
  }

  const outputText = ensureTrailingNewline(stringify(output, { numbersAsFloat: true }));
  if (!semanticEqual(parseToml(outputText, "result"), output)) {
    throw new Error("Could not serialize the intended TOML removal without changing its meaning.");
  }
  return {
    changed: true,
    outputText,
    operations: [...operations, { action: "reformat", path: targetPath }],
  };
}

function planConfigRemovalsSurgically(
  targetText: string,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): ConfigChangePlan {
  const normalizedTarget = normalizeNewlines(targetText);
  const targetParsed = parseToml(normalizedTarget, "target");
  const targetScan = scanToml(normalizedTarget, false);
  const operations: ChangeOperation[] = [];
  const mutations: Mutation[] = [];

  for (const readonlyPath of paths) {
    const path = [...readonlyPath];
    if (!hasPath(targetParsed, path)) {
      continue;
    }
    const targetEntry = targetScan.entryByPath.get(pathKey(path));
    if (targetEntry) {
      mutations.push({ start: targetEntry.start, end: targetEntry.end, lines: [] });
      operations.push({ action: "remove", path: formatPath(path) });
      continue;
    }

    const tableRanges = [...targetScan.tables.values()]
      .filter(
        (table) =>
          table.header !== undefined && pathIsPrefix(path, table.path),
      )
      .map((table) => ({ start: table.header as number, end: table.end, lines: [] }));
    if (tableRanges.length > 0) {
      mutations.push(...tableRanges);
      operations.push({ action: "remove", path: formatPath(path) });
      continue;
    }

    const descendantEntries = targetScan.entries.filter((entry) =>
      pathIsPrefix(path, entry.fullPath),
    );
    if (descendantEntries.length === 0) {
      throw new Error(
        `Cannot remove ${formatPath(path)} because it is not represented as a standalone TOML key.`,
      );
    }
    mutations.push(
      ...descendantEntries.map((entry) => ({
        start: entry.start,
        end: entry.end,
        lines: [],
      })),
    );
    operations.push({ action: "remove", path: formatPath(path) });
  }

  if (mutations.length === 0) {
    return {
      changed: false,
      outputText: ensureTrailingNewline(normalizedTarget),
      operations,
    };
  }

  return {
    changed: true,
    outputText: ensureTrailingNewline(applyMutations(targetScan.lines, mutations).join("\n")),
    operations,
  };
}

function parseToml(text: string, label: string): unknown {
  try {
    return parse(text, { integersAsBigInt: true });
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
  const sorted = mutations.map((mutation, index) => ({ mutation, index })).sort((a, b) => {
    if (a.mutation.start !== b.mutation.start) {
      return b.mutation.start - a.mutation.start;
    }
    if (a.mutation.end !== b.mutation.end) {
      return b.mutation.end - a.mutation.end;
    }
    return b.index - a.index;
  });
  const output = [...lines];
  for (const { mutation } of sorted) {
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
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return semanticEqual(left, right);
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (left instanceof TomlDate || right instanceof TomlDate) {
    return (
      left instanceof TomlDate &&
      right instanceof TomlDate &&
      left.toISOString() === right.toISOString()
    );
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.constructor === right.constructor &&
      left.getTime() === right.getTime()
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          semanticEqual(left[key], right[key]),
      )
    );
  }
  if (typeof left === "number" && typeof right === "number" && left === 0 && right === 0) {
    return true;
  }
  return Object.is(left, right);
}

function planSemanticChange(
  target: unknown,
  template: unknown,
  mode: MergeMode,
): { output: unknown; operations: ChangeOperation[] } {
  const output = cloneTomlValue(target);
  const operations: ChangeOperation[] = [];
  const replacedAncestors = new Set<string>();
  for (const entry of leafEntries(template)) {
    const targetHasValue = hasPath(target, entry.path);
    if (!targetHasValue) {
      const conflictingAncestor = nonTableAncestor(target, entry.path);
      if (conflictingAncestor && mode === "missing") {
        throw new Error(
          `Cannot add ${formatPath(entry.path)} because ${formatPath(conflictingAncestor)} is not a table.`,
        );
      }
      setPath(
        output,
        entry.path,
        cloneTomlValue(entry.value),
        conflictingAncestor !== undefined,
      );
      if (conflictingAncestor) {
        const key = pathKey(conflictingAncestor);
        if (!replacedAncestors.has(key)) {
          operations.push({ action: "update", path: formatPath(conflictingAncestor) });
          replacedAncestors.add(key);
        }
      } else {
        operations.push({ action: "add", path: formatPath(entry.path) });
      }
      continue;
    }
    if (isRecord(entry.value) && Object.keys(entry.value).length === 0) {
      if (mode === "override" && !isRecord(getPath(target, entry.path))) {
        setPath(output, entry.path, {}, true);
        operations.push({ action: "update", path: formatPath(entry.path) });
      }
      continue;
    }
    if (mode === "override" && !semanticEqual(getPath(target, entry.path), entry.value)) {
      setPath(output, entry.path, cloneTomlValue(entry.value), true);
      operations.push({ action: "update", path: formatPath(entry.path) });
    }
  }
  return { output, operations };
}

function nonTableAncestor(root: unknown, path: string[]): string[] | undefined {
  let current = root;
  for (const [index, segment] of path.slice(0, -1).entries()) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
    if (!isRecord(current)) {
      return path.slice(0, index + 1);
    }
  }
  return undefined;
}

function leafEntries(
  value: unknown,
  path: string[] = [],
): Array<{ path: string[]; value: unknown }> {
  if (!isRecord(value)) {
    return [{ path, value }];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return path.length === 0 ? [] : [{ path, value }];
  }
  return entries.flatMap(([key, child]) =>
    leafEntries(child, [...path, key]),
  );
}

function setPath(root: unknown, path: string[], value: unknown, replace: boolean): void {
  if (!isRecord(root) || path.length === 0) {
    throw new Error(`Cannot set ${formatPath(path)} in a non-table TOML document.`);
  }
  let current = root;
  for (const [index, segment] of path.slice(0, -1).entries()) {
    const existing = Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : undefined;
    if (existing === undefined) {
      setOwnProperty(current, segment, {});
    } else if (!isRecord(existing)) {
      if (!replace) {
        throw new Error(
          `Cannot add ${formatPath(path)} because ${formatPath(path.slice(0, index + 1))} is not a table.`,
        );
      }
      setOwnProperty(current, segment, {});
    }
    current = current[segment] as Record<string, unknown>;
  }
  setOwnProperty(current, path.at(-1) as string, value);
}

function deletePath(root: unknown, path: string[]): void {
  if (!isRecord(root) || path.length === 0) {
    return;
  }
  let current = root;
  for (const segment of path.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return;
    }
    const child = current[segment];
    if (!isRecord(child)) {
      return;
    }
    current = child;
  }
  delete current[path.at(-1) as string];
}

function setOwnProperty(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneTomlValue(value: unknown): unknown {
  if (value instanceof TomlDate) {
    return new TomlDate(value.toISOString());
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.map(cloneTomlValue);
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      setOwnProperty(clone, key, cloneTomlValue(child));
    }
    return clone;
  }
  return value;
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

function pathIsPrefix(prefix: string[], path: string[]): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

function formatPath(path: string[]): string {
  return path.map(formatTomlKey).join(".");
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
