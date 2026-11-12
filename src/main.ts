/**
 * Process entry point.
 *
 * The CLI surface is specified in `specs/10-cli-surface.md`; this module only
 * wires the router and delegates. Behaviour that is not in a spec does not
 * belong here.
 */
import { run } from "./cli/router.ts";

void run(process.argv);