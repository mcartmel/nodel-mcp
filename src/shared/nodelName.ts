/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Nodel.reduce(name), not getVerySimpleName and not SimpleName.flatten.
 * Source: nodel-framework/src/main/java/org/nodel/core/Nodel.java (lines 78-121,
 * upstream revision e720d279c63d6b77dc9777ea6e4740148fd22edf).
 * Java char iteration matters: preserve UTF-16 units, case and significant
 * non-ASCII characters. Parenthesized comments nest and then resume; -- and //
 * end the name. The Java/JS Unicode tables can differ for newly assigned chars.
 */
export function reduceNodelName(name: string): string {
  let result = "",
    depth = 0,
    last = "";
  for (let index = 0; index < name.length; index++) {
    const ch = name[index]!;
    if (ch === "(") depth++;
    else if (depth > 0) {
      if (ch === ")") depth--;
    } else if ((ch === "-" && last === "-") || (ch === "/" && last === "/")) break;
    else if (/[A-Za-z0-9]/u.test(ch) || (ch.charCodeAt(0) > 127 && !/[\p{Zs}\p{Zl}\p{Zp}]/u.test(ch))) result += ch;
    last = ch;
  }
  return result;
}
