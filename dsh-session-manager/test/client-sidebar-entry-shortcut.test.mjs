import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

/** Minimal DSH shortcut service: records registrations and serves a catalog. */
function shortcutStub(rows) {
  let snapshot = rows;
  const listeners = new Set();
  const registered = [];
  return {
    registered,
    register(command) { registered.push(command); return () => {}; },
    catalog: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    publish(next) { snapshot = next; for (const listener of [...listeners]) listener(); },
  };
}
const toggleRow = (overrides = {}) => ({
  id: "session-manager.toggle",
  binding: { code: "KeyS", modifiers: ["control"] },
  issue: null,
  conflicts: [],
  keys: ["Ctrl", "+", "S"],
  aria: "Control+S",
  ...overrides,
});
const footerButton = app => nodes(app.footerTree, n => n.type === "button" && String(n.props?.className || "").includes("sm-footerBtn"))[0];
const shortcutText = app => {
  const button = footerButton(app);
  const span = button && nodes(button, n => n.props?.className === "sm-footerBtn-shortcut")[0];
  return span ? text(span) : "";
};

test("shortcut defaults: Ctrl+S / Cmd+S in the desktop app, Ctrl+Alt+S kept for the browser", () => {
  const shortcuts = shortcutStub([toggleRow()]);
  const app = mountClient({ shortcuts });
  assert.equal(shortcuts.registered.length, 1);
  const command = shortcuts.registered[0];
  assert.equal(command.id, "session-manager.toggle");
  // The bundle runs in its own vm realm: compare plain JSON, not prototypes.
  const defaults = JSON.parse(JSON.stringify(command.defaults));
  for (const profile of ["desktop:windows", "desktop:macos", "desktop:linux"]) {
    assert.deepEqual(defaults[profile], { code: "KeyS", modifiers: ["primary"] }, profile);
  }
  // DSH's Web profiles reject a bare Mod+S default, so the browser keeps Mod+Alt+S.
  for (const profile of ["web:windows", "web:macos"]) {
    assert.deepEqual(defaults[profile], { code: "KeyS", modifiers: ["primary", "alt"] }, profile);
  }
  app.dispose();
});

test("the sidebar entry shows the binding actually in effect and follows rebinding", async () => {
  const shortcuts = shortcutStub([toggleRow()]);
  const app = mountClient({ shortcuts });
  await app.flush();
  assert.equal(text(nodes(footerButton(app), n => n.props?.className === "sm-footerBtn-label")[0]), "会话与工作区");
  assert.equal(shortcutText(app), "Ctrl+S");
  assert.equal(footerButton(app).props["aria-keyshortcuts"], "Control+S");
  assert.equal(footerButton(app).props.title, "会话与工作区 (Ctrl+S)");

  // A user override published by DSH Settings -> Shortcuts.
  shortcuts.publish([toggleRow({ binding: { code: "KeyK", modifiers: ["control", "shift"] }, keys: ["Ctrl", "+", "Shift", "+", "K"], aria: "Control+Shift+K" })]);
  await app.flush();
  assert.equal(shortcutText(app), "Ctrl+Shift+K");

  // A conflicting or cleared binding would not fire, so nothing is shown.
  shortcuts.publish([toggleRow({ conflicts: ["other.command"] })]);
  await app.flush();
  assert.equal(shortcutText(app), "");
  shortcuts.publish([toggleRow({ binding: null, keys: [], aria: undefined })]);
  await app.flush();
  assert.equal(shortcutText(app), "");
  assert.equal(footerButton(app).props.title, undefined);
  app.dispose();
});

test("macOS keycaps stay adjacent and two-key chords keep a space", async () => {
  const shortcuts = shortcutStub([toggleRow({ binding: { code: "KeyS", modifiers: ["meta"] }, keys: ["⌘", "S"], aria: "Meta+S" })]);
  const app = mountClient({ shortcuts });
  await app.flush();
  assert.equal(shortcutText(app), "⌘S");
  shortcuts.publish([toggleRow({ binding: { code: "KeyF", secondCode: "KeyG", modifiers: ["control"] }, keys: ["Ctrl", "+", "F", "G"], aria: undefined })]);
  await app.flush();
  assert.equal(shortcutText(app), "Ctrl+F G");
  app.dispose();
});

test("without a shortcut service the sidebar entry renders just its label", async () => {
  const app = mountClient();
  await app.flush();
  assert.equal(text(footerButton(app)), "会话与工作区");
  assert.equal(shortcutText(app), "");
  app.dispose();
});

test("settings: hiding the sidebar entry drops the button but keeps the panel reachable", async () => {
  const app = mountClient({ shortcuts: shortcutStub([toggleRow()]) });
  await app.flush();
  const { SessionManagerSettingsCard, updateStore } = app.exports;
  assert.equal(updateStore.getShowSidebarEntry(), true, "shown by default");
  const card = app.mountComponent(SessionManagerSettingsCard, { t: app.t });
  const toggle = () => nodes(card.tree, n => n.type === "input" && n.props?.type === "checkbox" && n.props?.["aria-label"] === app.t("settings.sidebarEntry"))[0];
  assert.ok(toggle(), "the settings card exposes the sidebar entry switch");
  assert.equal(toggle().props.checked, true);
  assert.ok(text(card.tree).includes("左侧边栏入口"));

  toggle().props.onChange({ target: { checked: false } });
  await app.flush();
  card.render();
  assert.equal(toggle().props.checked, false);
  assert.equal(app.localStorage.getItem("dsh-session-manager-show-sidebar-entry"), "0");
  assert.equal(footerButton(app), undefined, "the sidebar entry is hidden");
  assert.ok(nodes(app.footerTree, n => typeof n.type === "function" && n.type.prototype?.render).length > 0,
    "the panel the slot hosts still renders (shortcut / title-bar button keep working)");

  toggle().props.onChange({ target: { checked: true } });
  await app.flush();
  assert.ok(footerButton(app), "the entry comes back");
  assert.equal(shortcutText(app), "Ctrl+S");
  card.dispose(); app.dispose();
});

test("a stored 'hidden' preference is honoured on load", async () => {
  const app = mountClient({ initialStorage: { "dsh-session-manager-show-sidebar-entry": "0" } });
  await app.flush();
  assert.equal(app.exports.updateStore.getShowSidebarEntry(), false);
  assert.equal(footerButton(app), undefined);
  app.dispose();
});

test("the workspaces page search uses the same search field as the sessions page", async () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1" });
  await app.flush();
  const sessionsField = nodes(app.tree, n => n.props?.className === "sm-ocSearch")[0];
  assert.ok(sessionsField, "sessions page search field");
  await app.click(app.t("panel.tab.workspaces"));
  const wsField = nodes(app.tree, n => n.props?.className === "sm-ocSearch sm-wsSearch")[0];
  assert.ok(wsField, "workspaces search is wrapped in the shared .sm-ocSearch field");
  assert.ok(nodes(wsField, n => n.type === "svg").length === 1, "with the same search icon");
  const input = nodes(wsField, n => n.type === "input")[0];
  assert.equal(input.props.className, "sm-queryInput");
  assert.equal(input.props.type, "search");
  assert.equal(input.props["aria-label"], app.t("workspace.search"));
  app.dispose();
});
