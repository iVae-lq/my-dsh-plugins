import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient, text } from "./helpers/client-harness.mjs";

// The panel unmounts when closed (SafePanel renders SessionManagerPanel only
// while open), so both features here are about what survives that unmount:
// focus on open, and the view state (search text, filters, tab) across a close
// and reopen.

const sessions = [
  { id: "A-101", displayTitle: "修复 Alpha 登录", updatedAt: 300, createdAt: 100 },
  { id: "B-202", displayTitle: "Beta 回归", updatedAt: 200, createdAt: 300 },
  { id: "C-303", displayTitle: "草稿 Gamma", updatedAt: 100, createdAt: 200 },
];
const workspaces = [
  { id: "one", title: "项目一", path: "C:\\Projects\\One", sessionIds: ["A-101", "B-202"] },
  { id: "two", title: "项目二", path: "/two", sessionIds: ["C-303"] },
];

async function setup(t, options = {}) {
  const app = mountClient({ sessions, workspaces, archivedIds: [], current: "A-101", ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}

test("opening the panel focuses the session search box", async t => {
  const app = await setup(t);
  assert.equal(app.focusedLabels.at(-1), "搜索标题、ID、标签或备注",
    "the sessions search box must receive focus when the panel opens");
  assert.equal(app.control("搜索标题、ID、标签或备注").props.value, "");
});

test("switching to the workspaces tab moves focus to that search box", async t => {
  const app = await setup(t);
  assert.equal(app.focusedLabels.at(-1), "搜索标题、ID、标签或备注");
  await app.click("工作区管理");
  assert.equal(app.focusedLabels.at(-1), "搜索工作区名称或路径",
    "the workspaces search box must be focused after switching tabs");
});

test("reopening restores the search text, filters and sort order", async t => {
  const app = await setup(t);
  await app.change("搜索标题、ID、标签或备注", "Alpha");
  await app.click("已归档");
  await app.change("排序", "name-asc");
  await app.change("工作区", "workspace:one");
  await app.clickLabel("收藏筛选");
  assert.deepEqual(app.rowIds(), []);

  await app.remountPanel();

  assert.equal(app.control("搜索标题、ID、标签或备注").props.value, "Alpha", "search text is restored");
  assert.equal(app.control("排序").props.value, "name-asc", "sort order is restored");
  assert.equal(app.control("工作区").props.value, "workspace:one", "workspace filter is restored");
  assert.equal(app.control("收藏筛选").props["aria-pressed"], true, "the favorite toggle is restored");
  // Same combined filter as before the close: Alpha + archived + workspace one
  // + favorites matches nothing, and that is exactly what comes back.
  assert.deepEqual(app.rowIds(), []);
});

test("reopening restores the workspaces tab and its own query", async t => {
  const app = await setup(t);
  await app.click("工作区管理");
  await app.change("搜索工作区名称或路径", "项目二");
  await app.remountPanel();

  assert.equal(app.control("搜索工作区名称或路径").props.value, "项目二",
    "the workspaces tab is restored with its query");
  assert.equal(app.focusedLabels.at(-1), "搜索工作区名称或路径",
    "focus follows the restored tab");
});

test("the settings page is not restored; reopening lands on a searchable tab", async t => {
  const app = await setup(t);
  await app.click("会话管理");
  await app.click("插件设置");
  await app.remountPanel();

  // The settings page has no search box, so restoring it would leave the panel
  // without the focused entry point this feature promises.
  assert.ok(app.control("搜索标题、ID、标签或备注"), "the sessions search box is present after reopen");
  assert.equal(app.focusedLabels.at(-1), "搜索标题、ID、标签或备注");
});

test("reset filters clears the remembered view, so reopening stays clean", async t => {
  const app = await setup(t);
  await app.change("搜索标题、ID、标签或备注", "Beta");
  await app.click("已归档");
  await app.click("重置筛选");
  await app.remountPanel();

  assert.equal(app.control("搜索标题、ID、标签或备注").props.value, "");
  assert.equal(app.control("排序").props.value, "updated-desc");
  assert.deepEqual(app.rowIds(), ["A-101", "B-202", "C-303"]);
});

test("one-shot surface state such as selection is never restored", async t => {
  const app = await setup(t);
  await app.clickLabel("进入批量管理模式");
  await app.clickRow("A-101");
  await app.remountPanel();

  // Selection and select-mode are per-visit, unlike the view filters above.
  assert.ok(!text(app.tree).includes("已选 "), "no bulk selection survives the reopen");
});
