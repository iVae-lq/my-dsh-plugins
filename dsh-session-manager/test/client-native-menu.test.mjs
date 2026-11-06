import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

// DSH's own context-menu service (`ctx.contextMenus`) draws the sidebar's session and
// workspace menus, including every row other plugins contribute (dsh-sidebar-row-menu's
// "open with", "delete permanently", ...). The panel keeps its own session menu and hands
// over to the native one; the project column and workspace rows have no menu of their own,
// so they open the native one directly. The plugin does not list the service in `inject`,
// so it is read through `ctx.get` -- the harness throws on a direct `ctx.contextMenus` read.

const sessions = [
  { id: "A-101", displayTitle: "修复 Alpha 登录", updatedAt: 300, createdAt: 100 },
  { id: "C-303", displayTitle: "草稿 Gamma", updatedAt: 100, createdAt: 200 },
];
const workspaces = [
  { id: "one", title: "项目一", path: "C:\\Projects\\One", sessionIds: ["A-101"] },
  { id: "two", title: "项目二", path: "D:\\Work\\Two", sessionIds: [] },
];

// The bundle runs in a vm context, so the objects it builds have another realm's prototypes and
// never `deepStrictEqual` the test realm's literals. Round-trip through JSON to compare by value.
const plain = value => JSON.parse(JSON.stringify(value));

function nativeMenus() {
  const opened = [];
  const state = { active: null };
  return {
    state,
    get opened() { return plain(opened); },
    service: { open: (target, point) => { opened.push({ target, point }); }, active: { getSnapshot: () => state.active } },
  };
}
async function setup(t, { menus = nativeMenus(), ...options } = {}) {
  const app = mountClient({ sessions, workspaces, current: "A-101", services: { contextMenus: menus.service }, ...options });
  t.after(() => app.dispose());
  await app.flush();
  return { app, menus };
}
const event = (extra = {}) => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, clientX: 120, clientY: 80, ...extra });
const projectItems = app => nodes(app.tree[0], n => n.type === "button" && String(n.props?.className).includes("sm-ocProjectItem"));
const projectItem = (app, title) => projectItems(app).find(n => n.props.title === title);

test("a session's right-click menu keeps its own actions and ends with 'More actions…'", async t => {
  const { app } = await setup(t);
  assert.ok(app.openRowMenu("修复 Alpha 登录"));
  const labels = nodes(app.tree, n => n.type === "button" && String(n.props?.className).includes("sm-ocCtxItem")).map(n => text(n));
  for (const own of ["收藏会话", "标记待回看", "标签/备注", "归档", "移动至工作区", "迁移预设", "删除会话"]) {
    assert.ok(labels.includes(own), `own action still present: ${own} (have ${labels.join(" | ")})`);
  }
  assert.equal(labels.at(-1), "更多操作…", "the native entry is the last one");
  assert.ok(nodes(app.tree, n => n.props?.className === "sm-ocCtxSep").length >= 3, "it sits behind its own separator");
});

test("'More actions…' opens DSH's native session menu for that session at the menu's position", async t => {
  const { app, menus } = await setup(t);
  const entry = app.rowButton("A-101", "更多操作…");
  assert.ok(entry, "the entry exists");
  entry.props.onClick();
  assert.deepEqual(menus.opened, [{
    target: { kind: "session", value: { sessionId: "A-101", displayTitle: "修复 Alpha 登录" } },
    point: { x: 40, y: 40 },
  }]);
});

test("without DSH's context-menu service the panel behaves as before (no native entry anywhere)", async t => {
  const app = mountClient({ sessions, workspaces, current: "A-101" });
  t.after(() => app.dispose());
  await app.flush();
  assert.ok(app.openRowMenu("修复 Alpha 登录"));
  const labels = nodes(app.tree, n => n.type === "button" && String(n.props?.className).includes("sm-ocCtxItem")).map(n => text(n));
  assert.ok(!labels.includes("更多操作…"));
  assert.equal(projectItem(app, "C:\\Projects\\One").props.onContextMenu, undefined, "project items keep no menu");
});

test("right-clicking a project opens DSH's native workspace menu", async t => {
  const { app, menus } = await setup(t);
  const item = projectItem(app, "D:\\Work\\Two");
  const e = event();
  item.props.onContextMenu(e);
  assert.equal(e.defaultPrevented, true, "the browser menu is suppressed");
  assert.deepEqual(menus.opened, [{
    target: { kind: "workspace", value: { workspaceId: "two", path: "D:\\Work\\Two", displayTitle: "项目二" } },
    point: { x: 120, y: 80 },
  }]);
});

test("the native workspace menu is addressed with DSH's own workspace id", async t => {
  const { app, menus } = await setup(t, {
    clientWorkspaces: [{ workspaceId: "ws-1", path: "c:/projects/one/", sessionIds: ["A-101"] }, { workspaceId: "ws-2", path: "D:\\Work\\Two", sessionIds: [] }],
  });
  projectItem(app, "C:\\Projects\\One").props.onContextMenu(event());
  assert.equal(menus.opened[0].target.value.workspaceId, "ws-1");
});

test("a project DSH does not know opens nothing instead of a menu for the wrong workspace", async t => {
  const { app, menus } = await setup(t, { clientWorkspaces: [{ workspaceId: "ws-x", path: "Z:\\Elsewhere", sessionIds: [] }] });
  const e = event();
  projectItem(app, "D:\\Work\\Two").props.onContextMenu(e);
  assert.deepEqual(menus.opened, []);
  assert.equal(e.defaultPrevented, true, "still no browser menu over the panel");
});

test("clicking a project still toggles the filter (right-click support does not change left click)", async t => {
  const { app } = await setup(t);
  projectItem(app, "D:\\Work\\Two").props.onClick();
  await app.flush();
  assert.equal(app.control("工作区").props.value, "workspace:two");
});

test("the Workspaces page rows open the native workspace menu as well", async t => {
  const { app, menus } = await setup(t);
  await app.click("工作区管理");
  const row = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "one")[0];
  assert.ok(row, "workspace row rendered");
  row.props.onContextMenu(event({ clientX: 33, clientY: 44 }));
  assert.deepEqual(menus.opened, [{
    target: { kind: "workspace", value: { workspaceId: "one", path: "C:\\Projects\\One", displayTitle: "项目一" } },
    point: { x: 33, y: 44 },
  }]);
});

test("Esc closes the panel only when no native menu is open", async t => {
  const { app, menus } = await setup(t);
  menus.state.active = { kind: "session", value: { sessionId: "A-101" } };
  app.keydown({ key: "Escape" });
  assert.equal(app.isOpen(), true, "the native menu owns this Esc");
  menus.state.active = null;
  app.keydown({ key: "Escape" });
  assert.equal(app.isOpen(), false, "with no native menu Esc closes the panel as before");
});

test("a click inside DSH's native menu is not a click outside the panel", async t => {
  const { app } = await setup(t);
  await new Promise(resolve => setTimeout(resolve, 70)); // the page ignores clicks during its first 50ms
  const item = { closest: () => null };
  const menu = { matches: selector => selector.includes("[role=\"menu\"]") && selector.includes("[data-context-menu]") };
  app.dispatchClick(item, { composedPath: () => [item, menu] });
  assert.equal(app.isOpen(), true, "picking a native menu item keeps the panel open");
  app.dispatchClick(item, { composedPath: () => [item] });
  assert.equal(app.isOpen(), false, "a genuine outside click still closes it");
});

test("while the panel is open the native menu is lifted above it, and only then", async t => {
  const { app } = await setup(t);
  const css = app.styleTags.map(tag => tag.textContent).join("\n");
  assert.match(css, /html\[data-sm-panel-open\] \[data-context-menu\]\{z-index:100010!important\}/);
  assert.ok(!/(^|[^\]])\[data-context-menu\]\{z-index/.test(css.replace(/html\[data-sm-panel-open\] \[data-context-menu\]/g, "")),
    "the rule is scoped to the open panel, never global");
});
