/**
 * Product identity.
 *
 * Contract: `docs/adr/0010-own-brand-and-snapshot-harness.md`. Every
 * user-facing occurrence of the program name, the version and the docs link
 * goes through these constants, so a rename or a release is one edit.
 */

/** Our program name, as printed in usage, help and error text. */
export const PROGRAM = "droide";

/** Capitalised form used in prose and the tagline. */
export const DISPLAY = "Droide";

/**
 * The release number, printed by `--version` and compared against the release
 * feed. `tests/unit/cli/product-version.test.ts` keeps it equal to
 * `package.json`, so a bump cannot silently leave `update --check` lying.
 */
export const PRODUCT_VERSION = "0.7.1";

/** One-line positioning, used in the root help and the shell header. */
export const TAGLINE = "a terminal coding agent for your repository";

/** Where the CLI points for documentation: this project's own pages. */
export const DOCS_URL = "https://github.com/z3r0xc/droide#readme";
