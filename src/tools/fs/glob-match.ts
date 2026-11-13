/**
 * Glob matching for the filesystem tools.
 *
 * Contract: `specs/30-tools-and-sandbox.md` B18-B20. The conversion
 * (`packages/utils/src/text/glob.ts`, `globToRegex.ts`): no start anchor
 * (partial path matching), an end anchor, `**` across separators, `*`
 * within one segment, `?` for one character, `[...]` classes, `{a,b}` braces,
 * and a leading `!` negating the match.
 */

/** Expands the first top-level brace group; returns the original when none. */
export function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];
  let depth = 0;
  let end = -1;
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return [pattern];
  const body = pattern.slice(start + 1, end);
  const options: string[] = [];
  let current = "";
  let nested = 0;
  for (const char of body) {
    if (char === "{") nested += 1;
    if (char === "}") nested -= 1;
    if (char === "," && nested === 0) {
      options.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  options.push(current);
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const expanded: string[] = [];
  for (const option of options) {
    for (const combination of expandBraces(prefix + option + suffix)) {
      expanded.push(combination);
    }
  }
  return expanded;
}

/** The regular-expression source for one glob pattern (no braces, no `!`). */
export function globToRegExpSource(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        source += pattern.slice(index, end + 1);
        index = end;
      }
    } else if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += ".";
    } else if (".+^$(){}|\\".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
    index += 1;
  }
  return source.endsWith("$") ? source : `${source}$`;
}

/** Whether `filePath` matches `pattern`; a leading `!` negates the result. */
export function matchesGlob(
  filePath: string,
  pattern: string,
  caseSensitive = true,
): boolean {
  const negated = pattern.startsWith("!");
  const actual = negated ? pattern.slice(1) : pattern;
  if (actual.length === 0) return false;
  const matched = expandBraces(actual).some((expanded) =>
    new RegExp(
      globToRegExpSource(expanded),
      caseSensitive ? undefined : "i",
    ).test(filePath),
  );
  return negated ? !matched : matched;
}

/**
 * Whether a directory entry name matches an ignore pattern. `node_modules/**`
 * names the directory itself, so the trailing segment wildcard is tried on the
 * name alone as well as on a path under it.
 */
export function matchesEntryPattern(name: string, pattern: string): boolean {
  if (matchesGlob(name, pattern)) return true;
  const trimmed = pattern.replace(/\/\*\*?$/, "");
  return trimmed !== pattern && matchesGlob(name, trimmed);
}
