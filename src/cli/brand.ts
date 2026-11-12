/**
 * Product identity.
 *
 * Contract: `docs/adr/0005-project-name-and-parity-normalisation.md`. Every
 * user-facing occurrence of the program name goes through `PROGRAM`, so a
 * rename is one constant and parity normalisation stays mechanical.
 */

/** Our program name, as printed in usage, help and error text. */
export const PROGRAM = "droide";

/** Capitalised form used where the subject writes "Droid" (e.g. the tagline). */
export const DISPLAY = "Droide";

/** The subject's program name. Used only by tests and documentation. */
export const SUBJECT_PROGRAM = "droid";

/** Product version. Parity requires the subject's version string exactly. */
export const VERSION = "1.9.0";

/** Docs link printed at the end of the root help. Contract data from the spec. */
export const DOCS_URL = "https://docs.factory.ai/cli/getting-started/overview";
