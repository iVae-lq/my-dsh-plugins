/**
 * Regression coverage for Issue #34:
 *   "统一窗口关闭行为"
 *
 * Requirements:
 *   - 会话管理主面板：点击外部关闭，Esc 关闭，关闭按钮关闭。
 *   - 删除、移动、迁移及普通确认窗口：点击外部取消并关闭，Esc 取消并关闭。
 *   - 更新窗口：保留点击外部关闭的行为。
 *   - 标记窗口（标签/备注）：点击外部不关闭，允许用户继续操作 DSH 主界面、选中文字及复制内容。
 *   - 正在执行操作的窗口：禁止通过外部点击或 Esc 意外关闭。
 *   - 多窗口叠加时，只允许关闭最上层可关闭窗口，不能穿透关闭底层主面板。
 *   - 点击标记窗口外部区域时，不应间接关闭其所属主面板并导致标记窗口被卸载。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function countMatches(pat) {
  let n = 0;
  let pos = 0;
  while ((pos = SRC.indexOf(pat, pos)) >= 0) { n++; pos += pat.length; }
  return n;
}

test("issue #34 static guards: exactly 9 window keydown listeners and 5 ae.blur() calls", () => {
  assert.equal(countMatches('window.addEventListener("keydown", handler);'), 9);
  assert.equal(countMatches('window.removeEventListener("keydown", handler);'), 9);
  assert.equal(countMatches("ae.blur();"), 5);
  const backdropOnMouseDown = SRC.match(/className: "sm-nativeDialogBackdrop"[\s\S]{0,200}onMouseDown:/g) || [];
  assert.equal(backdropOnMouseDown.length, 0, "No backdrop may use onMouseDown to close");
});

test("issue #34: ConfirmDialog closes on outside click and Esc, but not when clicking inside", async () => {
  const harness = mountClient();
  const { ConfirmDialog } = harness.exports;

  let cancelled = false;
  let confirmed = false;

  const comp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Test Confirm",
    onCancel: () => { cancelled = true; },
    onConfirm: () => { confirmed = true; }
  });

  // 1. Click inside dialog does not close
  const insideTarget = {
    closest(sel) {
      return sel.includes("sm-confirmDialog") || sel.includes("sm-nativeDialog");
    }
  };
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: insideTarget
  });
  assert.equal(cancelled, false, "Clicking inside ConfirmDialog must not cancel");

  // Wait 60ms to exceed the 50ms mount guard
  await new Promise(r => setTimeout(r, 60));

  // 2. Click outside triggers onCancel
  const outsideTarget = {
    closest() { return null; }
  };
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: outsideTarget
  });
  assert.equal(cancelled, true, "Clicking outside ConfirmDialog must cancel");

  // 3. Reset and test Esc
  cancelled = false;
  harness.keydown({ key: "Escape" });
  assert.equal(cancelled, true, "Esc on ConfirmDialog must cancel");

  comp.dispose();
  harness.dispose();
});

test("issue #34: ConfirmDialog prevents closing via outside click or Esc when busy", async () => {
  const harness = mountClient();
  const { ConfirmDialog } = harness.exports;

  let cancelled = false;
  const comp = harness.mountComponent(ConfirmDialog, {
    open: true,
    busy: true,
    title: "Busy Confirm",
    onCancel: () => { cancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));

  // Outside click while busy -> no-op
  const outsideTarget = { closest() { return null; } };
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: outsideTarget
  });
  assert.equal(cancelled, false, "Outside click must not cancel when busy");

  // Esc while busy -> no-op
  harness.keydown({ key: "Escape" });
  assert.equal(cancelled, false, "Esc must not cancel when busy");

  comp.dispose();
  harness.dispose();
});

test("issue #34: MoveDialog and MigratePresetDialog close on outside click and respect busy", async () => {
  const harness = mountClient();
  const { MoveDialog, MigratePresetDialog } = harness.exports;

  // MoveDialog
  let moveCancelled = false;
  const moveComp = harness.mountComponent(MoveDialog, {
    open: true,
    workspaces: [{ id: "ws1", title: "WS 1" }, { id: "ws2", title: "WS 2" }],
    onCancel: () => { moveCancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: { closest() { return null; } }
  });
  assert.equal(moveCancelled, true, "Outside click on MoveDialog must cancel");
  moveComp.dispose();

  // MigratePresetDialog
  let migrateCancelled = false;
  const migrateComp = harness.mountComponent(MigratePresetDialog, {
    open: true,
    sessionId: "s1",
    onCancel: () => { migrateCancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: { closest() { return null; } }
  });
  assert.equal(migrateCancelled, true, "Outside click on MigratePresetDialog must cancel");
  migrateComp.dispose();

  harness.dispose();
});

test("issue #34: SessionManagerPanel closes on outside click and Esc when idle", async () => {
  const harness = mountClient();
  assert.equal(harness.isOpen(), true, "Panel should be initially open");

  // 1. Esc closes panel
  harness.keydown({ key: "Escape" });
  assert.equal(harness.isOpen(), false, "Esc should close panel");

  // 2. Re-open panel
  const { panelStore } = harness.exports;
  panelStore.set(true);
  assert.equal(harness.isOpen(), true, "Panel re-opened");

  await new Promise(r => setTimeout(r, 60));

  // 3. Click outside closes panel
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: { closest() { return null; } }
  });
  assert.equal(harness.isOpen(), false, "Outside click should close panel");

  harness.dispose();
});

test("issue #34: clicking outside does NOT close panel when AnnotationDialog is open", async () => {
  const harness = mountClient({
    sessions: [{ id: "s1", displayTitle: "Session 1" }],
    sessionAnnotations: { s1: {} },
    language: "zh"
  });
  await harness.flush();
  assert.equal(harness.isOpen(), true);

  // Click edit annotations button for row s1
  await harness.clickLabel("编辑标签、备注和优先级: Session 1");
  await harness.flush();

  await new Promise(r => setTimeout(r, 60));

  // User clicks into DSH main UI / outside area (e.g. to copy text)
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: { closest() { return null; } }
  });

  // Panel MUST NOT be closed!
  assert.equal(harness.isOpen(), true, "Panel must stay open when AnnotationDialog is active");

  harness.dispose();
});

test("issue #34: topmost dialog closes first on Esc and outside click without penetrating to bottom panel", async () => {
  const harness = mountClient({
    sessions: [{ id: "s1", displayTitle: "Session 1" }],
    language: "zh"
  });
  assert.equal(harness.isOpen(), true);

  const { ConfirmDialog } = harness.exports;
  let confirmCancelled = false;

  // Mount a ConfirmDialog on top of the open panel
  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Confirm on top",
    onCancel: () => { confirmCancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));

  // Outside click while ConfirmDialog is open
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: { closest() { return null; } }
  });

  // ConfirmDialog closes, but the underlying panel MUST NOT CLOSE
  assert.equal(confirmCancelled, true, "Topmost ConfirmDialog receives cancel on outside click");
  assert.equal(harness.isOpen(), true, "Underlying SessionManagerPanel must not close when child dialog was clicked outside");

  confirmComp.dispose();
  harness.dispose();
});

test("issue #34: clicking on SessionManagerPanel closes secondary dialogs while keeping panel open", async () => {
  const harness = mountClient({
    sessions: [{ id: "s1", displayTitle: "Session 1" }],
    language: "zh"
  });
  assert.equal(harness.isOpen(), true);

  const { ConfirmDialog, MoveDialog, BatchPreviewDialog } = harness.exports;

  // 1. ConfirmDialog: clicking on SessionManagerPanel closes ConfirmDialog, panel stays open
  let confirmCancelled = false;
  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Confirm Dialog",
    onCancel: () => { confirmCancelled = true; }
  });
  await new Promise(r => setTimeout(r, 60));

  const panelClickTarget = {
    closest(sel) {
      if (sel.includes("sm-confirmDialog") || sel.includes("sm-bulkDialog")) return null;
      if (sel.includes("sm-panelDialog") || sel.includes("sm-nativeDialog")) return {};
      return null;
    }
  };
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: panelClickTarget
  });
  assert.equal(confirmCancelled, true, "Clicking SessionManagerPanel must close ConfirmDialog");
  assert.equal(harness.isOpen(), true, "SessionManagerPanel must remain open after secondary dialog closed");
  confirmComp.dispose();

  // 2. MoveDialog: clicking on SessionManagerPanel closes MoveDialog, panel stays open
  let moveCancelled = false;
  const moveComp = harness.mountComponent(MoveDialog, {
    open: true,
    workspaces: [{ id: "ws1", title: "WS 1" }],
    onCancel: () => { moveCancelled = true; }
  });
  await new Promise(r => setTimeout(r, 60));

  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: panelClickTarget
  });
  assert.equal(moveCancelled, true, "Clicking SessionManagerPanel must close MoveDialog");
  assert.equal(harness.isOpen(), true, "SessionManagerPanel must remain open after secondary dialog closed");
  moveComp.dispose();

  // 3. BatchPreviewDialog: clicking on SessionManagerPanel closes BatchPreviewDialog, panel stays open
  let batchCancelled = false;
  const batchComp = harness.mountComponent(BatchPreviewDialog, {
    open: true,
    action: "delete",
    actionLabel: "删除会话",
    onCancel: () => { batchCancelled = true; }
  });
  await new Promise(r => setTimeout(r, 60));

  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: panelClickTarget
  });
  assert.equal(batchCancelled, true, "Clicking SessionManagerPanel must close BatchPreviewDialog");
  assert.equal(harness.isOpen(), true, "SessionManagerPanel must remain open after secondary dialog closed");
  batchComp.dispose();

  harness.dispose();
});

test("issue #34: clicking outside when secondary dialogs are open closes them one by one", async () => {
  const harness = mountClient({
    sessions: [{ id: "s1", displayTitle: "Session 1" }],
    language: "zh"
  });
  assert.equal(harness.isOpen(), true);

  const { BatchPreviewDialog, updateStore } = harness.exports;

  // 1. Batch dialog: click outside closes batch dialog FIRST, panel stays open. Next click outside closes panel.
  let batchCancelled = false;
  const batchComp = harness.mountComponent(BatchPreviewDialog, {
    open: true,
    action: "delete",
    actionLabel: "删除会话",
    onCancel: () => { batchCancelled = true; }
  });
  await new Promise(r => setTimeout(r, 60));

  const outsideTarget = { closest() { return null; } };
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: outsideTarget
  });
  assert.equal(batchCancelled, true, "First outside click closes BatchPreviewDialog");
  assert.equal(harness.isOpen(), true, "SessionManagerPanel stays open after BatchPreviewDialog dismissed");
  batchComp.dispose();

  // Second outside click closes the panel
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: outsideTarget
  });
  assert.equal(harness.isOpen(), false, "Second outside click closes SessionManagerPanel");

  // Reopen panel for UpdateDialog test
  const { panelStore } = harness.exports;
  panelStore.set(true);
  assert.equal(harness.isOpen(), true);
  await new Promise(r => setTimeout(r, 60));

  // 2. UpdateDialog: click backdrop closes UpdateDialog FIRST, panel stays open
  const { UpdateDialog, OverlayLayer } = harness.exports;
  updateStore.openDialog();
  assert.equal(updateStore.getSnapshot().dialogOpen, true);
  const updateComp = harness.mountComponent(UpdateDialog, { t: harness.t });
  assert.equal(updateComp.tree.type, OverlayLayer);
  const layerComp = harness.mountComponent(OverlayLayer, updateComp.tree.props);

  // Click on the backdrop of OverlayLayer
  const backdropNode = nodes(layerComp.tree, node => node.props?.className?.includes("sm-overlayBackdrop"))[0];
  assert.ok(backdropNode, "UpdateDialog backdrop must exist in tree");
  let propagationStopped = false;
  let immediateStopped = false;
  backdropNode.props.onClick({
    target: backdropNode,
    currentTarget: backdropNode,
    stopPropagation() { propagationStopped = true; },
    stopImmediatePropagation() { immediateStopped = true; }
  });

  assert.equal(propagationStopped, true, "Backdrop click must stopPropagation");
  assert.equal(immediateStopped, true, "Backdrop click must stopImmediatePropagation");
  assert.equal(updateStore.getSnapshot().dialogOpen, false, "Clicking backdrop closes UpdateDialog");
  assert.equal(harness.isOpen(), true, "SessionManagerPanel stays open when UpdateDialog is closed via backdrop");
  layerComp.dispose();
  updateComp.dispose();

  // Subsequent outside click closes panel
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: outsideTarget
  });
  assert.equal(harness.isOpen(), false, "Subsequent outside click closes SessionManagerPanel");

  harness.dispose();
});

test("issue #34 & #33: BatchPreviewDialog title is '删除会话' when action is delete, and subagent warning has 2 lines", () => {
  const harness = mountClient({ language: "zh" });
  const { BatchPreviewDialog, ConfirmDialog } = harness.exports;

  // 1. BatchPreviewDialog with action: "delete" has title "删除会话"
  const batchComp = harness.mountComponent(BatchPreviewDialog, {
    open: true,
    action: "delete",
    actionLabel: "删除会话",
    sessions: [{ id: "s1", displayTitle: "Test Session" }],
    warning: "将连带删除 2 个关联的子智能体会话。\n删除操作不可撤销，请确认后再继续。"
  });

  const batchTitleNode = nodes(batchComp.tree, node => node.props?.id === "sm-batch-preview-title")[0];
  assert.ok(batchTitleNode, "Title element sm-batch-preview-title must exist");
  assert.equal(text(batchTitleNode), "删除会话", "Batch delete dialog title must be '删除会话'");

  const batchWarnNode = nodes(batchComp.tree, node => node.props?.className?.includes("sm-bulkDialogWarn"))[0];
  assert.ok(batchWarnNode, "Warning box must exist");
  const warnText = text(batchWarnNode);
  assert.ok(warnText.includes("将连带删除 2 个关联的子智能体会话。"), "Line 1 should contain subagent warning");
  assert.ok(warnText.includes("删除操作不可撤销，请确认后再继续。"), "Line 2 should contain non-reversible warning");
  assert.ok(!warnText.includes("其独立历史记录也会被删除"), "Should remove redundant clause");
  const lines = warnText.split("\n");
  assert.equal(lines.length, 2, "Warning should be formatted into exactly two lines");
  assert.equal(lines[0].trim(), "将连带删除 2 个关联的子智能体会话。");
  assert.equal(lines[1].trim(), "删除操作不可撤销，请确认后再继续。");
  batchComp.dispose();

  // 2. ConfirmDialog with 2-line subagent delete warning
  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "删除会话",
    description: "「Test Session」：删除，不可恢复",
    warning: "将连带删除 3 个关联的子智能体会话。\n删除操作不可撤销，请确认后再继续。"
  });

  const confirmTitleNode = nodes(confirmComp.tree, node => node.props?.id === "sm-confirm-dialog-title")[0];
  assert.ok(confirmTitleNode, "Title element sm-confirm-dialog-title must exist");
  assert.equal(text(confirmTitleNode), "删除会话");

  const confirmWarnNode = nodes(confirmComp.tree, node => node.props?.className?.includes("sm-bulkDialogWarn"))[0];
  assert.ok(confirmWarnNode, "ConfirmDialog warning must exist");
  const cLines = text(confirmWarnNode).split("\n");
  assert.equal(cLines.length, 2, "ConfirmDialog warning should be two lines");
  assert.equal(cLines[0].trim(), "将连带删除 3 个关联的子智能体会话。");
  assert.equal(cLines[1].trim(), "删除操作不可撤销，请确认后再继续。");
  confirmComp.dispose();

  harness.dispose();
});

test("issue #34: outside click uses capturing phase and intercepts click to prevent triggering underlying button", async () => {
  const harness = mountClient();
  const { ConfirmDialog } = harness.exports;

  let cancelled = false;
  let underlyingExecuted = false;

  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Delete Confirm",
    onCancel: () => { cancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));

  // Simulated button sitting beneath the dialog
  const underlyingButton = {
    closest(sel) { return null; },
    onClick() { underlyingExecuted = true; }
  };

  // Dispatch click to underlying button
  const result = harness.dispatchClick(underlyingButton);

  // Capturing phase listener intercepted the event
  assert.equal(result.stopped, true, "Event must be stopped in capturing phase");
  assert.equal(result.defaultPrevented, true, "Default action must be prevented");
  assert.equal(cancelled, true, "Dialog must have received onCancel");
  assert.equal(underlyingExecuted, false, "Underlying button onClick must NOT be executed");

  confirmComp.dispose();
  harness.dispose();
});

test("issue #34 & #33: confirm button is disabled and clicks guarded when preview is loading or failed", async () => {
  const harness = mountClient();
  const { ConfirmDialog, BatchPreviewDialog } = harness.exports;

  // 1. ConfirmDialog with confirmDisabled = true
  let singleConfirmed = false;
  const singleComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Delete Session",
    confirmDisabled: true,
    onConfirm: () => { singleConfirmed = true; }
  });

  const singleConfirmBtn = nodes(singleComp.tree, n => n.type === "button" && (n.props?.className?.includes("sm-nativeDialogConfirm") || n.props?.className?.includes("sm-nativeDialogDanger")))[0];
  assert.ok(singleConfirmBtn, "Confirm button must exist");
  assert.equal(singleConfirmBtn.props.disabled, true, "Confirm button must be disabled when confirmDisabled is true");
  singleConfirmBtn.props.onClick();
  assert.equal(singleConfirmed, false, "onConfirm must not be called when disabled");
  singleComp.dispose();

  // 2. BatchPreviewDialog with loading = true
  let batchLoadingExecuted = false;
  const batchLoadingComp = harness.mountComponent(BatchPreviewDialog, {
    open: true,
    action: "delete",
    actionLabel: "删除会话",
    sessions: [{ id: "s1" }],
    loading: true,
    onExecute: () => { batchLoadingExecuted = true; }
  });

  const batchLoadingBtn = nodes(batchLoadingComp.tree, n => n.type === "button" && (n.props?.className?.includes("sm-nativeDialogConfirm") || n.props?.className?.includes("sm-nativeDialogDanger")))[0];
  assert.ok(batchLoadingBtn, "Batch confirm button must exist");
  assert.equal(batchLoadingBtn.props.disabled, true, "Batch confirm button must be disabled when loading");
  batchLoadingBtn.props.onClick();
  assert.equal(batchLoadingExecuted, false, "onExecute must not be called when loading");
  batchLoadingComp.dispose();

  // 3. BatchPreviewDialog with error
  let batchErrorExecuted = false;
  const batchErrorComp = harness.mountComponent(BatchPreviewDialog, {
    open: true,
    action: "delete",
    actionLabel: "删除会话",
    sessions: [{ id: "s1" }],
    error: "Failed to fetch subagents",
    onExecute: () => { batchErrorExecuted = true; }
  });

  const batchErrorBtn = nodes(batchErrorComp.tree, n => n.type === "button" && (n.props?.className?.includes("sm-nativeDialogConfirm") || n.props?.className?.includes("sm-nativeDialogDanger")))[0];
  assert.ok(batchErrorBtn, "Batch confirm button must exist");
  assert.equal(batchErrorBtn.props.disabled, true, "Batch confirm button must be disabled when preview failed");
  batchErrorBtn.props.onClick();
  assert.equal(batchErrorExecuted, false, "onExecute must not be called when error is present");
  batchErrorComp.dispose();

  harness.dispose();
});

test("issue #34: stacked dialogs: clicking underlying dialog cancels ONLY the topmost dialog and intercepts the click", async () => {
  const harness = mountClient();
  const { MoveDialog, ConfirmDialog } = harness.exports;

  let moveCancelled = false;
  let confirmCancelled = false;

  // Mount Dialog 1 (MoveDialog, bottom)
  const moveComp = harness.mountComponent(MoveDialog, {
    open: true,
    workspaces: [{ id: "ws1", title: "WS 1" }],
    onCancel: () => { moveCancelled = true; }
  });

  // Mount Dialog 2 (ConfirmDialog, top)
  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Confirm on top of Move",
    onCancel: () => { confirmCancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));

  // 1. Click on a button inside MoveDialog (underlying dialog)
  const moveBtn = nodes(moveComp.tree, n => n.type === "button")[0];
  assert.ok(moveBtn, "Underlying MoveDialog must have buttons");

  const clickEvent = harness.dispatchClick(moveBtn);

  // Event must have been intercepted (default prevented / propagation stopped)
  assert.equal(clickEvent.stopped, true, "Click on underlying dialog must be intercepted by topmost dialog");
  assert.equal(clickEvent.defaultPrevented, true, "Default action must be prevented on underlying click");
  assert.equal(confirmCancelled, true, "Topmost ConfirmDialog must be cancelled");
  assert.equal(moveCancelled, false, "Underlying MoveDialog must NOT be cancelled");

  // Dispose the closed ConfirmDialog (simulates unmount in React)
  confirmComp.dispose();

  // 2. Now MoveDialog is topmost. Clicking outside should close MoveDialog.
  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: { closest() { return null; } }
  });
  assert.equal(moveCancelled, true, "MoveDialog cancels on next outside click once topmost");

  moveComp.dispose();
  harness.dispose();
});

test("issue #34: stacked dialogs: Esc closes topmost dialog only in sequence", async () => {
  const harness = mountClient();
  const { MoveDialog, ConfirmDialog } = harness.exports;

  let moveCancelled = false;
  let confirmCancelled = false;

  const moveComp = harness.mountComponent(MoveDialog, {
    open: true,
    workspaces: [{ id: "ws1", title: "WS 1" }],
    onCancel: () => { moveCancelled = true; }
  });

  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Confirm on top",
    onCancel: () => { confirmCancelled = true; }
  });

  // 1. First Esc: only topmost (ConfirmDialog) cancels
  harness.keydown({ key: "Escape" });
  assert.equal(confirmCancelled, true, "First Esc closes topmost ConfirmDialog");
  assert.equal(moveCancelled, false, "First Esc must NOT close underlying MoveDialog");

  confirmComp.dispose();

  // 2. Second Esc: MoveDialog now cancels
  harness.keydown({ key: "Escape" });
  assert.equal(moveCancelled, true, "Second Esc closes remaining MoveDialog");

  moveComp.dispose();
  harness.dispose();
});

test("issue #34: stacked bulk dialogs: clicking underlying dialog cancels only topmost bulk dialog", async () => {
  const harness = mountClient();
  const { BatchPreviewDialog, BulkTagInputDialog } = harness.exports;

  let previewCancelled = false;
  let tagCancelled = false;

  const previewComp = harness.mountComponent(BatchPreviewDialog, {
    open: true,
    action: "delete",
    actionLabel: "删除",
    sessions: [{ id: "s1" }],
    onCancel: () => { previewCancelled = true; }
  });

  const tagComp = harness.mountComponent(BulkTagInputDialog, {
    open: true,
    title: "Add tags on top",
    onCancel: () => { tagCancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));

  // Click on BatchPreviewDialog's inner element
  const previewInner = nodes(previewComp.tree, n => n.type === "div" && n.props?.className?.includes("sm-bulkDialogSummary"))[0];
  assert.ok(previewInner, "BatchPreviewDialog inner summary must exist");

  const clickEvent = harness.dispatchClick(previewInner);

  assert.equal(clickEvent.stopped, true, "Click on underlying bulk dialog must be intercepted by topmost bulk dialog");
  assert.equal(clickEvent.defaultPrevented, true, "Default action must be prevented on underlying click");
  assert.equal(tagCancelled, true, "Topmost BulkTagInputDialog must be cancelled");
  assert.equal(previewCancelled, false, "Underlying BatchPreviewDialog must remain open");

  tagComp.dispose();
  previewComp.dispose();
  harness.dispose();
});

test("issue #34: clicking inside topmost dialog in stacked dialogs does not cancel either dialog", async () => {
  const harness = mountClient();
  const { MoveDialog, ConfirmDialog } = harness.exports;

  let moveCancelled = false;
  let confirmCancelled = false;

  const moveComp = harness.mountComponent(MoveDialog, {
    open: true,
    workspaces: [{ id: "ws1", title: "WS 1" }],
    onCancel: () => { moveCancelled = true; }
  });

  const confirmComp = harness.mountComponent(ConfirmDialog, {
    open: true,
    title: "Topmost Confirm",
    onCancel: () => { confirmCancelled = true; }
  });

  await new Promise(r => setTimeout(r, 60));

  // Click inside ConfirmDialog's own section
  const confirmBtn = nodes(confirmComp.tree, n => n.type === "button")[0];
  assert.ok(confirmBtn, "ConfirmDialog button must exist");

  harness.dispatchWindowEvent("click", {
    type: "click",
    defaultPrevented: false,
    target: confirmBtn
  });

  assert.equal(confirmCancelled, false, "Clicking inside topmost dialog must NOT cancel it");
  assert.equal(moveCancelled, false, "Clicking inside topmost dialog must NOT cancel underlying dialog");

  confirmComp.dispose();
  moveComp.dispose();
  harness.dispose();
});
