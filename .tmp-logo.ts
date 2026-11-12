import { LOGO_FULL_ROWS, LOGO_MINI_ROWS } from "./src/ui/tokens.ts";
import { displayWidth } from "./src/ui/text.ts";
console.log(LOGO_FULL_ROWS.map((r) => [displayWidth(r), r.length]));
console.log(LOGO_MINI_ROWS.map((r) => [displayWidth(r), r.length]));
