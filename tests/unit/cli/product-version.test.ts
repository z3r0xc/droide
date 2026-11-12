import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PRODUCT_VERSION } from "../../../src/cli/brand.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  version?: unknown;
};

test("the product version matches package.json", () => {
  assert.equal(PRODUCT_VERSION, pkg.version);
});

test("the reported version is our release number", () => {
  assert.match(PRODUCT_VERSION, /^\d+\.\d+\.\d+$/);
});
