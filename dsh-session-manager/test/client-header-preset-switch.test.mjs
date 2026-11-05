import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** Re-render the ad-hoc hosts until pending promises settle. */
async function settle(hosts) {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    for (const host of hosts) if (host && host.dirty) host.render();
  }
}

/** Mount the registered agent-preset chip the way the slot would render it. */
function mountChip(app, { preset = "standard", sessionId = "s1" } = {}) {
  const entry = app.registered.get("agent-preset");
  const state = { byId: { [sessionId]: { id: sessionId, projectionValues: { agentPreset: preset } } } };
  const props = { ...entry.options.inject(), t: app.t, useSessions: selector => selector(state), sessionId };
  // SafeHeaderPresetChip is a boundary; its render() yields the real chip element.
  const element = new entry.component(props).render();
  return app.mountComponent(element.type, element.props);
}

const isChip = node => node.type === "button" && String(node.props?.className || "").includes("sm-presetChip");
const isChoice = node => node.type === "button" && String(node.props?.className || "").includes("sm-choiceItem");
const byValue = (items, value) => items.find(item => item.props["data-choice-value"] === value);
const textOf = (tree, className) => nodes(tree, n => n.props?.className === className).map(text);

async function openMenu(app, chip) {
  chip.find(isChip).props.onClick();
  await settle([chip]);
  const menuNode = chip.find(node => node.type?.name === "HeaderPresetMenu");
  assert.ok(menuNode, "the preset menu opens");
  return app.mountComponent(menuNode.type, menuNode.props);
}

test("header preset chip shadows DSH's read-only agent-preset label through a lower slot priority", () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1" });
  const entry = app.registered.get("agent-preset");
  assert.ok(entry, "agent-preset entry registered");
  assert.equal(entry.options.name, "conversation.session.header.actions");
  assert.equal(entry.options.order, -10);
  assert.ok(entry.options.priority < 0, "a negative priority is rendered instead of the shipped label (priority 0)");
  app.dispose();
});

test("the header menu shows localized name, preset id and description, and switches through /preset-migrate", async () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1" });
  await app.flush();
  const chip = mountChip(app);
  assert.equal(text(chip.find(isChip)), "标准模式");
  const menu = await openMenu(app, chip);
  const surface = menu.find(n => n.props?.className === "sm-presetMenu");
  assert.ok(surface, "the menu uses the dialog surface class");
  const items = menu.findAll(isChoice);
  assert.deepEqual(items.map(item => item.props["data-choice-value"]), ["standard", "cordis", "custom", "bad"]);
  assert.deepEqual(textOf(byValue(items, "cordis"), "sm-choiceHint"), ["cordis"]);
  assert.match(textOf(byValue(items, "cordis"), "sm-choiceDesc").join(""), /用对话定制 DSH/);
  assert.deepEqual(textOf(byValue(items, "custom"), "sm-choiceDesc"), ["Hand-made"]);
  assert.equal(byValue(items, "standard").props["aria-checked"], true, "the current preset is checked");
  assert.equal(byValue(items, "bad").props.disabled, true, "a preset that failed to load cannot be chosen");
  assert.match(text(byValue(items, "bad")), /加载失败，无法切换/);
  byValue(items, "cordis").props.onClick();
  await settle([chip, menu]);
  const request = app.requests.find(r => r.url === "/session-manager/api/preset-migrate");
  assert.ok(request, "the shared migrate endpoint is called");
  assert.deepEqual(JSON.parse(request.options.body), { sessionId: "s1", toPreset: "cordis" });
  assert.ok(app.refreshCalls.includes("sessions"), "the session list refreshes like a panel migration");
  assert.deepEqual(app.alerts, [], "a successful header switch does not interrupt with an alert");
  menu.dispose(); chip.dispose(); app.dispose();
});

test("choosing the current preset is a no-op", async () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1" });
  const chip = mountChip(app, { preset: "cordis" });
  assert.equal(text(chip.find(isChip)), "创造模式");
  const menu = await openMenu(app, chip);
  byValue(menu.findAll(isChoice), "cordis").props.onClick();
  await settle([chip, menu]);
  assert.equal(app.requests.filter(r => r.url === "/session-manager/api/preset-migrate").length, 0);
  menu.dispose(); chip.dispose(); app.dispose();
});

test("a refused switch (turn still running) is reported and the chip stays usable", async () => {
  const app = mountClient({
    sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1",
    migratePreset: async () => ({ ok: false, code: "session-busy", error: "该会话的回合仍在运行，请等它结束（或先停止）后再切换预设。" }),
  });
  const chip = mountChip(app);
  const menu = await openMenu(app, chip);
  byValue(menu.findAll(isChoice), "cordis").props.onClick();
  await settle([chip, menu]);
  assert.equal(app.alerts.length, 1);
  assert.match(String(app.alerts[0]), /切换 Agent 预设失败：该会话的回合仍在运行/);
  assert.notEqual(chip.find(isChip).props.disabled, true, "the chip is re-enabled after the failure");
  menu.dispose(); chip.dispose(); app.dispose();
});

test("the chip renders nothing for a session that records no preset", () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1" });
  const entry = app.registered.get("agent-preset");
  const props = { ...entry.options.inject(), t: app.t, useSessions: selector => selector({ byId: { s1: { id: "s1" } } }), sessionId: "s1" };
  const element = new entry.component(props).render();
  const chip = app.mountComponent(element.type, element.props);
  assert.equal(chip.tree, null);
  chip.dispose(); app.dispose();
});

test("the header menu joins the dialog surface rules: opacity fill, theme fallback and frosted-glass blur", () => {
  // One shared definition, not a copy: the menu is listed in the same rules as the dialogs.
  assert.match(SRC, /"\.sm-presetMenu,\.sm-nativeDialog,\.sm-panelDialog,\.sm-migrateDialog,\.sm-settingsCard\{--sm-dialog-surface:[^}]*--sm-dialog-fill:color-mix\(in srgb,var\(--sm-dialog-surface\) var\(--sm-dialog-opacity,100%\),transparent\)\}"/);
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-presetMenu,\[data-sm-theme=dark\] \.sm-nativeDialog[^{]*\{--sm-dialog-surface-fallback:#1f1f23\}/);
  assert.match(SRC, /html\[data-sm-translucent\] \.sm-presetMenu,html\[data-sm-translucent\] \.sm-nativeDialog[^{]*\{[^}]*backdrop-filter:blur\(var\(--sm-glass-blur,24px\)\)/);
  assert.match(SRC, /"\.sm-presetMenu\{position:fixed;[^"]*background:var\(--sm-dialog-fill\)/);
});

/** The harness renders one component level: mount a dialog's ChoiceList to see its rows. */
function choiceRows(app, dialogHost) {
  const list = dialogHost.find(n => typeof n.type === "function" && n.type.name === "ChoiceList");
  assert.ok(list, "the dialog renders a ChoiceList");
  const host = app.mountComponent(list.type, list.props);
  return { list, host, items: host.findAll(isChoice) };
}

function mountMigrateDialog(app, currentPreset) {
  return app.mountComponent(app.exports.MigratePresetDialog, { open: true, t: app.t, sessionId: "s1", currentPreset, onCancel() {}, onRun() {} });
}

test("the panel's migrate dialog lists presets with localized name, id, description and a current badge", async () => {
  const app = mountClient({
    sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1",
    fetchPresetScan: async () => ({ ok: true, result: { rows: [{ sessionId: "s1", finalPreset: "standard" }], availablePresets: ["standard", "cordis", "custom", "bad"] } }),
  });
  await app.flush();
  const dialog = mountMigrateDialog(app, "standard");
  await settle([dialog]);
  let rows = choiceRows(app, dialog);
  assert.deepEqual(rows.items.map(item => item.props["data-choice-value"]), ["standard", "cordis", "custom", "bad"]);
  assert.equal(byValue(rows.items, "standard").props.role, "radio");
  assert.deepEqual(textOf(byValue(rows.items, "standard"), "sm-choiceBadge"), ["当前"]);
  assert.match(text(byValue(rows.items, "standard")), /^标准模式standard当前处理代码、文件和资料/);
  assert.match(textOf(byValue(rows.items, "cordis"), "sm-choiceDesc").join(""), /用对话定制 DSH/);
  assert.equal(byValue(rows.items, "bad").props.disabled, true);
  const confirm = () => dialog.find(n => n.type === "button" && String(n.props?.className || "").includes("sm-nativeDialogConfirm"));
  assert.equal(confirm().props.disabled, true, "the current preset cannot be re-applied");
  byValue(rows.items, "cordis").props.onClick();
  await settle([dialog]);
  rows.host.dispose();
  rows = choiceRows(app, dialog);
  assert.equal(rows.list.props.value, "cordis");
  assert.equal(byValue(rows.items, "cordis").props["aria-checked"], true);
  assert.equal(confirm().props.disabled, false);
  rows.host.dispose(); dialog.dispose(); app.dispose();
});

test("a migrate dialog for a preset that no longer exists flags it instead of hiding it", async () => {
  const app = mountClient({
    sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1",
    fetchPresetScan: async () => ({ ok: true, result: { rows: [{ sessionId: "s1", finalPreset: "gone" }], availablePresets: ["standard"] } }),
    fetchPresets: async () => ({ ok: true, result: { presets: [{ id: "standard" }] } }),
  });
  const dialog = mountMigrateDialog(app, "gone");
  await settle([dialog]);
  const rows = choiceRows(app, dialog);
  const gone = byValue(rows.items, "gone");
  assert.ok(gone);
  assert.equal(gone.props.disabled, true);
  assert.match(text(gone), /该预设已不存在/);
  rows.host.dispose(); dialog.dispose(); app.dispose();
});

test("without /presets (older host) the migrate dialog still lists the scanned ids, named where known", async () => {
  const app = mountClient({
    sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1",
    fetchPresetScan: async () => ({ ok: true, result: { rows: [{ sessionId: "s1", finalPreset: "standard" }], availablePresets: ["standard", "cordis", "x-custom"] } }),
    fetchPresets: async () => ({ ok: false, error: "not found: GET /presets" }),
  });
  const dialog = mountMigrateDialog(app, "standard");
  await settle([dialog]);
  const rows = choiceRows(app, dialog);
  assert.deepEqual(rows.items.map(item => item.props["data-choice-value"]), ["standard", "cordis", "x-custom"]);
  assert.match(text(byValue(rows.items, "cordis")), /^创造模式cordis/);
  assert.equal(text(byValue(rows.items, "x-custom")), "x-custom");
  rows.host.dispose(); dialog.dispose(); app.dispose();
});

test("the bulk choice dialog uses the rich preset list for described options and keeps <select> for plain ones", async () => {
  const app = mountClient({ sessions: [{ id: "s1", displayTitle: "Alpha" }], current: "s1" });
  const { BulkChoiceDialog } = app.exports;
  const rich = app.mountComponent(BulkChoiceDialog, {
    open: true, t: app.t, title: "迁移预设",
    options: [{ value: "standard", label: "标准模式", hint: "standard", description: "处理代码" }, { value: "bad", label: "bad", disabled: true, problem: "加载失败，无法切换" }],
    onCancel() {}, onApply() {},
  });
  const rows = choiceRows(app, rich);
  assert.deepEqual(rows.items.map(item => item.props["data-choice-value"]), ["standard", "bad"]);
  assert.equal(rich.find(n => n.type === "select"), undefined, "no bare <select> for described presets");
  const confirm = () => rich.find(n => n.type === "button" && String(n.props?.className || "").includes("sm-nativeDialogConfirm"));
  assert.equal(confirm().props.disabled, true, "nothing is chosen until a row is clicked");
  byValue(rows.items, "standard").props.onClick();
  await settle([rich]);
  assert.equal(confirm().props.disabled, false);
  const plain = app.mountComponent(BulkChoiceDialog, {
    open: true, t: app.t, title: "移动至工作区", options: [{ value: "ws1", label: "Workspace 1" }], onCancel() {}, onApply() {},
  });
  assert.ok(plain.find(n => n.type === "select" && n.props?.className === "sm-viewSelect"), "plain choices keep the unified select");
  rows.host.dispose(); rich.dispose(); plain.dispose(); app.dispose();
});

test("bulk preset migration builds its choices from /presets with the scan as a fallback", () => {
  assert.match(SRC, /const onBulkPreset = \(\) => \{[\s\S]*?loadPresetRoster\(true\)[\s\S]*?setBulkPresetOptions\(presetChoiceOptions\(t, roster,/);
});
