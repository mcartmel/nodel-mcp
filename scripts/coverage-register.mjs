import { register } from "node:module";
import { register as registerTypeScript } from "tsx/esm/api";

// Register after tsx: tests are transpiled by tsx, production modules are not.
// The asynchronous hook API is available at the Node 22.13 tooling floor.
registerTypeScript();
register("./coverage-loader.mjs", import.meta.url);
