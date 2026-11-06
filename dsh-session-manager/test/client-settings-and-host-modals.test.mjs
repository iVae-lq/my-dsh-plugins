import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

// 1. The left column's bottom row holds two settings entries: DSH's own ("System settings",
//    left) and this plugin's ("Plugin settings", right).
// 2. DSH's own modals (rename a session/workspace, delete confirmations, Settings) are portaled
//    to <body> at z-index 1000 -- under this plugin's overlay root (1050) -- so a dialog opened
//    from the panel rendered beneath the panel's mask. While one is open the overlay root yields
//    (a `data-sm-host-modal` rule drops it to 900) and clicks / Esc are left to that dialog.

const sessions = [{ id: "A-101", displayTitle: "Alpha", updatedAt: 300, createdAt: 100 }];
const workspaces = [{ id: "one", title: "项目一", path: "C:\\Projects\\One", sessionIds: ["A-101"] }];

function shortcutsService({ commands = ["settings.open"], throws = false } = {}) {
  const invoked = [];
  return {
    invoked,
    service: {
      invoke(id, context) { if (throws) throw new Error("boom"); invoked.push({ id, context }); },
      catalog: { getSnapshot: () => commands.map(id => ({ id })), subscribe: () => () => {} },
    },
  };
}
async function setup(t, options = {}) {
  const app = mountClient({ sessions, workspaces, current: "A-101", ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}
const settingsButtons = app => nodes(app.tree[0], n => n.type === "button" && n.props?.["data-settings-kind"]);

// ── 1. System settings + Plugin settings ────────────────────────────────────

test("one row: System settings on the left, Plugin settings on the right", async t => {
  const sc = shortcutsService();
  const app = await setup(t, { services: { shortcuts: sc.service } });
  const row = nodes(app.tree[0], n => n.props?.className === "sm-ocSettingsRow")[0];
  assert.ok(row, "the settings row exists");
  const buttons = settingsButtons(app);
  assert.deepEqual(buttons.map(n => [n.props["data-settings-kind"], text(n)]), [["system", "系统设置"], ["plugin", "插件设置"]]);
  // They really are the row's two children, in that order.
  assert.deepEqual(row.props.children.flat().filter(Boolean).map(n => n.props["data-settings-kind"]), ["system", "plugin"]);
});

test("System settings runs DSH's settings.open command by id and leaves the page", async t => {
  const sc = shortcutsService();
  const app = await setup(t, { services: { shortcuts: sc.service } });
  settingsButtons(app)[0].props.onClick();
  await app.flush();
  assert.equal(sc.invoked.length, 1);
  assert.equal(sc.invoked[0].id, "settings.open");
  assert.equal(sc.invoked[0].context.modal, null, "never reported as 'inside a modal', which would CLOSE the dialog");
  assert.equal(sc.invoked[0].context.region, "page");
  assert.equal(app.isOpen(), false, "DSH's dialog sits under this page, so the page closes");
});

test("Plugin settings still opens the plugin's own settings page", async t => {
  const app = await setup(t, { services: { shortcuts: shortcutsService().service } });
  settingsButtons(app)[1].props.onClick();
  await app.flush();
  assert.equal(nodes(app.tree[0], n => n.type?.name === "SessionManagerSettingsCard").length, 1);
  assert.equal(app.isOpen(), true);
});

test("without a shortcut service only Plugin settings is shown", async t => {
  const app = await setup(t);
  assert.deepEqual(settingsButtons(app).map(n => [n.props["data-settings-kind"], text(n)]), [["plugin", "插件设置"]]);
});

test("a host that does not register settings.open gets no System settings button", async t => {
  const app = await setup(t, { services: { shortcuts: shortcutsService({ commands: ["session.new"] }).service } });
  assert.deepEqual(settingsButtons(app).map(n => n.props["data-settings-kind"]), ["plugin"]);
});

test("a failing settings command keeps the page open", async t => {
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = original; });
  const app = await setup(t, { services: { shortcuts: shortcutsService({ throws: true }).service } });
  settingsButtons(app)[0].props.onClick();
  await app.flush();
  assert.equal(app.isOpen(), true);
  assert.ok(errors.some(line => line.includes("DSH settings")));
});

// ── 2. DSH's own dialogs are not hidden under the panel ─────────────────────

function modals(initial = []) {
  const state = { list: initial, overlayRoot: { contains: node => node.insideOverlay === true } };
  return {
    state,
    options: {
      querySelectorAll: selector => (selector.includes("aria-modal") ? state.list : []),
      getElementById: id => (id === "dsh-session-manager-overlay-root" ? state.overlayRoot : null),
    },
  };
}
const HOST_ATTR = "data-sm-host-modal";

test("a DSH dialog open when the panel opens drops the overlay below it", async t => {
  const m = modals([{ id: "rename-dialog" }]);
  const app = await setup(t, m.options);
  assert.ok(app.rootAttributes.has(HOST_ATTR));
});

test("no DSH dialog, no marker", async t => {
  const app = await setup(t, modals([]).options);
  assert.ok(!app.rootAttributes.has(HOST_ATTR));
});

test("this plugin's own dialogs (inside its overlay root) are not host dialogs", async t => {
  const app = await setup(t, modals([{ insideOverlay: true }]).options);
  assert.ok(!app.rootAttributes.has(HOST_ATTR));
});

test("a dialog that opens later (e.g. Rename picked from the native menu) is picked up, and released when it closes", async t => {
  const m = modals([]);
  const app = await setup(t, m.options);
  assert.ok(!app.rootAttributes.has(HOST_ATTR));
  m.state.list = [{ id: "rename-dialog" }];
  await app.runIntervals();
  assert.ok(app.rootAttributes.has(HOST_ATTR), "the overlay yields while the dialog is open");
  m.state.list = [];
  await app.runIntervals();
  assert.ok(!app.rootAttributes.has(HOST_ATTR), "and comes back once it is gone");
});

test("the marker never outlives the panel", async t => {
  const m = modals([{ id: "rename-dialog" }]);
  const app = mountClient({ sessions, workspaces, current: "A-101", ...m.options });
  await app.flush();
  assert.ok(app.rootAttributes.has(HOST_ATTR));
  app.dispose();
  assert.ok(!app.rootAttributes.has(HOST_ATTR));
});

test("the rule that lowers the overlay is scoped to the marker and beats the overlay's own z-index", async t => {
  const app = await setup(t);
  const css = app.styleTags.map(tag => tag.textContent).join("\n");
  assert.match(css, /html\[data-sm-host-modal\] #dsh-session-manager-overlay-root\{z-index:900!important\}/,
    "900 is below the host's modals (1000) yet above the app");
  assert.match(css, /#dsh-session-manager-overlay-root\{[^}]*z-index:1050!important/, "the normal level is unchanged");
});

test("Esc belongs to the DSH dialog while one is open, and closes the panel again afterwards", async t => {
  const m = modals([{ id: "rename-dialog" }]);
  const app = await setup(t, m.options);
  app.keydown({ key: "Escape" });
  assert.equal(app.isOpen(), true);
  m.state.list = [];
  app.keydown({ key: "Escape" });
  assert.equal(app.isOpen(), false);
});

test("a click inside a DSH dialog does not count as a click outside the panel", async t => {
  const m = modals([{ id: "rename-dialog" }]);
  const app = await setup(t, m.options);
  await new Promise(resolve => setTimeout(resolve, 70)); // the page ignores clicks during its first 50ms
  const target = { closest: () => null };
  app.dispatchClick(target, { composedPath: () => [target] });
  assert.equal(app.isOpen(), true, "the dialog owns the click");
  m.state.list = [];
  app.dispatchClick(target, { composedPath: () => [target] });
  assert.equal(app.isOpen(), false, "with no dialog it is an outside click as before");
});

test("host dialogs are recognised the way DSH's own keyboard layer recognises modals", async t => {
  const seen = [];
  await setup(t, { querySelectorAll: selector => { seen.push(selector); return []; } });
  assert.ok(seen.includes("[role=\"dialog\"][aria-modal=\"true\"]"));
});
