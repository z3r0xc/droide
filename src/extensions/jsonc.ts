/**
 * JSON with comments. Contract: `specs/60-extensions-mcp-and-skills.md` B2
 * (`mcp.json` is JSONC) and B33 (`.factory-plugin/plugin.json` is optional
 * JSONC).
 *
 * The readers accept comments and trailing commas; everything else is plain
 * JSON. The scanner copies string literals verbatim so a `//` inside a string
 * is never mistaken for a comment.
 */

export class JsoncParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JsoncParseError";
  }
}

function stripComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      output += text.slice(index, end);
      index = end;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      output += text.slice(index, end);
      index = end;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? "")) {
        lookahead += 1;
      }
      const next = text[lookahead];
      if (next === "}" || next === "]") {
        index += 1;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Parse JSONC text. Trailing commas are accepted. The result is untrusted. */
export function parseJsonc(text: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const cleaned = stripTrailingCommas(stripComments(withoutBom));
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new JsoncParseError(message, { cause: error });
  }
}
