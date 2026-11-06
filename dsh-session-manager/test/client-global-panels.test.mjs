import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

// The DSH sidebar's global panels (Plugins, Scheduled tasks, Context insights, IM, ...) are
// `sidebar.panellist` slot entries. The panel lists them in its left column so they are
// reachable without the sidebar. Opening one goes through `layout.selectPanel(id)` and then
// leaves the panel page so DSH's own panel is what shows.

const sessions = [{ id: "A-101", displayTitle: "Alpha", updatedAt: 300, createdAt: 100 }];
const workspaces = [{ id: "one", title: "项目一", path: "C:\\Projects\\One", sessionIds: ["A-101"] }];

const Glyph = () => ({ type: "svg", props: { "data-glyph": "ok", children: [] } });
const entry = (id, label, order, component = Glyph) => ({ options: { id, order, label }, component });
const PANELS = [
  entry("schedules", () => "自动化任务", 10),
  entry("plugins", () => "插件", 0),
  entry("context", "上下文洞察", 20),
];

async function setup(t, options = {}) {
  const app = mountClient({ sessions, workspaces, current: "A-101", sidebarPanels: PANELS, ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}
const panelButtons = app => nodes(app.tree[0], n => n.type === "button" && n.props?.["data-panel-id"]);

test("every sidebar panel is listed, in the sidebar's own order, with its label", async t => {
  const app = await setup(t);
  assert.deepEqual(panelButtons(app).map(n => [n.props["data-panel-id"], text(n)]),
    [["plugins", "插件"], ["schedules", "自动化任务"], ["context", "上下文洞察"]]);
});

test("the panel list sits above the Settings button, below the projects", async t => {
  const app = await setup(t);
  const foot = nodes(app.tree[0], n => n.props?.className === "sm-ocSideFoot")[0];
  const kids = foot.props.children.flat().filter(Boolean);
  assert.equal(kids[0].props.className, "sm-ocPanels");
  assert.equal(kids.at(-1).props.className, "sm-ocSettingsRow", "the settings row stays the last entry");
});

test("clicking a panel opens it through layout.selectPanel and leaves the page", async t => {
  const app = await setup(t);
  panelButtons(app).find(n => n.props["data-panel-id"] === "schedules").props.onClick();
  await app.flush();
  assert.deepEqual(app.selectPanelCalls, ["schedules"]);
  assert.equal(app.isOpen(), false, "the page closes so DSH's panel is visible");
});

test("without the layout service nothing happens and the page stays open", async t => {
  const app = await setup(t, { services: { layout: undefined } });
  panelButtons(app)[0].props.onClick();
  await app.flush();
  assert.deepEqual(app.selectPanelCalls, []);
  assert.equal(app.isOpen(), true);
});

test("a panel registered later appears and a removed one disappears", async t => {
  const app = await setup(t);
  app.setSidebarPanels([...PANELS, entry("im", "消息", 30)]);
  await app.flush();
  assert.deepEqual(panelButtons(app).map(n => n.props["data-panel-id"]), ["plugins", "schedules", "context", "im"]);
  app.setSidebarPanels(PANELS.filter(p => p.options.id !== "context"));
  await app.flush();
  assert.deepEqual(panelButtons(app).map(n => n.props["data-panel-id"]), ["plugins", "schedules"]);
});

test("a panel's own glyph component is drawn; one without a component gets a letter badge", async t => {
  const app = await setup(t, { sidebarPanels: [entry("plugins", "插件", 0), entry("bare", "Bare", 1, null)] });
  const [withIcon, bare] = panelButtons(app);
  const glyph = nodes(withIcon, n => n.type?.name === "GlobalPanelGlyph")[0];
  assert.equal(glyph.props.icon, PANELS[0].component, "the registered component is passed through");
  assert.equal(nodes(bare, n => n.type?.name === "GlobalPanelGlyph")[0].props.icon, null);
});

test("a throwing label falls back to the panel id, and an entry without an id is skipped", async t => {
  const app = await setup(t, {
    sidebarPanels: [
      { options: { id: "weird", label: () => { throw new Error("no locale yet"); } }, component: Glyph },
      { options: { label: "no id" }, component: Glyph },
    ],
  });
  assert.deepEqual(panelButtons(app).map(n => [n.props["data-panel-id"], text(n)]), [["weird", "weird"]]);
});

test("no panels registered means no list at all", async t => {
  const app = await setup(t, { sidebarPanels: [] });
  assert.equal(nodes(app.tree[0], n => n.props?.className === "sm-ocPanels").length, 0);
});

test("the glyph boundary swaps a crashing icon for a letter badge", async t => {
  const app = await setup(t);
  const glyph = nodes(app.tree[0], n => n.type?.name === "GlobalPanelGlyph")[0];
  const Boundary = glyph.type;
  const crashed = Object.assign(new Boundary({ icon: Glyph, label: "上下文洞察" }), { state: Boundary.getDerivedStateFromError() });
  const badge = crashed.render();
  assert.equal(badge.props.className, "sm-ocBadge");
  assert.equal(text(badge), "上");
});
