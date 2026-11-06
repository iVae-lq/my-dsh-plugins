import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reading `ctx.<service>` for a service the plugin does not list in `inject` THROWS on a real
// Cordis context (`cannot get property "<service>" without inject`). That is what made the
// panel's "New session" button do nothing. Services outside `inject` must be read through
// `ctx.get(name)`, which returns undefined instead of throwing.

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const injected = JSON.parse(/const inject = (\[[^\]]*\]);/.exec(SRC)[1]);

test("the injected services are the ones the plugin reads directly", () => {
  assert.deepEqual(injected, ["slots", "sessions", "workspaces", "locale", "uiWorkspace"]);
});

test("DSH services outside `inject` are never read as ctx.<name>", () => {
  for (const name of ["layout", "contextMenus", "shortcuts", "remoteAccess", "sidebarRight"]) {
    assert.ok(!injected.includes(name));
    const direct = SRC.match(new RegExp("\\bctx\\??\\." + name + "\\b", "g")) || [];
    assert.deepEqual(direct, [], `ctx.${name} must be read via ctx.get("${name}")`);
  }
});
