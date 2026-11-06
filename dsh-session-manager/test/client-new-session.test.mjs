import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient } from "./helpers/client-harness.mjs";

// "New session" on the panel home page. Regression: the handler read `ctx.layout`
// directly, but `layout` is not in the plugin's `inject` list, so on DSH the read throws
// (`cannot get property "layout" without inject`), the surrounding try/catch swallowed it,
// and `startSession` was never reached -- the button did nothing. The harness reproduces
// that throw, so these tests fail against any code that reads `ctx.layout` directly.

const sessions = [
  { id: "A-101", displayTitle: "Alpha", updatedAt: 300, createdAt: 100 },
  { id: "C-303", displayTitle: "Gamma", updatedAt: 100, createdAt: 200 },
];
const workspaces = [
  { id: "one", title: "项目一", path: "C:\\Projects\\One", sessionIds: ["A-101"] },
  { id: "two", title: "项目二", path: "D:\\Work\\Two", sessionIds: ["C-303"] },
];

async function setup(t, options = {}) {
  const app = mountClient({ sessions, workspaces, current: "A-101", ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}
const newSessionButton = app => app.find(node => node.type === "button" && node.props?.className?.includes("sm-ocNew"))[0];

test("New session without a selected project starts a session with no explicit workspace", async t => {
  const app = await setup(t);
  newSessionButton(app).props.onClick();
  assert.deepEqual(app.startSessionCalls, [[]],
    "no argument: DSH picks the workspace of the last opened session, exactly like the tab bar's +");
});

test("New session inside a selected project targets that workspace", async t => {
  const app = await setup(t);
  await app.change("工作区", "workspace:two");
  newSessionButton(app).props.onClick();
  assert.deepEqual(app.startSessionCalls, [["two"]]);
});

test("the panel is dismissed back to the conversation before the new session opens", async t => {
  const app = await setup(t);
  newSessionButton(app).props.onClick();
  assert.deepEqual(app.selectPanelCalls, [null], "any global panel (plugins, tasks...) is left first");
  assert.equal(app.startSessionCalls.length, 1);
});

test("a failing layout service never blocks starting the session", async t => {
  const app = await setup(t, { services: { layout: { selectPanel() { throw new Error("boom"); } } } });
  newSessionButton(app).props.onClick();
  assert.equal(app.startSessionCalls.length, 1);
});

test("a host without the layout service still starts the session", async t => {
  const app = await setup(t, { services: { layout: undefined } });
  newSessionButton(app).props.onClick();
  assert.equal(app.startSessionCalls.length, 1);
});

test("'All projects' and 'Ungrouped' behave like no selection", async t => {
  const app = await setup(t);
  for (const value of ["all", "ungrouped"]) {
    await app.change("工作区", value);
    newSessionButton(app).props.onClick();
  }
  assert.deepEqual(app.startSessionCalls, [[], []]);
});

test("the panel's project id is mapped onto DSH's own workspace id", async t => {
  // The host API names a workspace `id`; DSH's client model calls it `workspaceId`.
  // When the two disagree the client's id (matched by path) is the one startSession needs.
  const app = await setup(t, {
    clientWorkspaces: [
      { workspaceId: "ws-1", path: "c:/projects/one/", sessionIds: ["A-101"] },
      { workspaceId: "ws-2", path: "D:\\Work\\Two", sessionIds: ["C-303"] },
    ],
  });
  await app.change("工作区", "workspace:two");
  newSessionButton(app).props.onClick();
  assert.deepEqual(app.startSessionCalls, [["ws-2"]]);
});

test("a project DSH does not know is reported instead of starting in the wrong workspace", async t => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = original; });
  const app = await setup(t, { clientWorkspaces: [{ workspaceId: "ws-x", path: "Z:\\Elsewhere", sessionIds: [] }] });
  await app.change("工作区", "workspace:two");
  newSessionButton(app).props.onClick();
  assert.deepEqual(app.startSessionCalls, [], "no session may be created in a different workspace");
  assert.ok(errors.some(line => line.includes("new session")), "the failure is logged");
});
