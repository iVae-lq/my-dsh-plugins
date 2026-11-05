import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

test("auto-update: startup timer triggers maybeAutoCheck after 1.5s delay", async () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // Asserts startup effect sets 1500ms timer calling maybeAutoCheck with isStartup
  assert.match(src, /setTimeout\(\s*\(\)\s*=>\s*\{\s*updateStore\.maybeAutoCheck\(\{\s*isStartup:\s*true\s*\}\)/);
  assert.match(src, /,\s*1500\s*\)/);
});

test("auto-update: shouldAutoCheck logic covers 6h interval, 30m failure cooldown, available status, and autoCheck toggle", () => {
  const harness = mountClient();
  const { updateStore } = harness.exports;

  const now = 1000000000000;

  // 1. Initially enabled, no previous check -> should check
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  updateStore.state.checkedAt = null;
  updateStore.lastFailedAt = null;
  assert.equal(updateStore.shouldAutoCheck(now), true, "Fresh startup should allow check");

  // 2. Successful check within 6 hours -> do NOT check
  updateStore.state.checkedAt = now - (2 * 60 * 60 * 1000); // 2 hours ago
  assert.equal(updateStore.shouldAutoCheck(now), false, "Within 6 hours should not check");

  // 3. Successful check older than 6 hours -> should check
  updateStore.state.checkedAt = now - (6 * 60 * 60 * 1000 + 1000); // 6 hours + 1s ago
  assert.equal(updateStore.shouldAutoCheck(now), true, "Older than 6 hours should check");

  // 4. Failed check within 30 minutes -> do NOT check
  updateStore.state.checkedAt = null;
  updateStore.lastFailedAt = now - (10 * 60 * 1000); // 10 minutes ago
  assert.equal(updateStore.shouldAutoCheck(now), false, "Within 30 min cooldown should not check");

  // 5. Failed check older than 30 minutes -> should check
  updateStore.lastFailedAt = now - (30 * 60 * 1000 + 1000); // 30 min + 1s ago
  assert.equal(updateStore.shouldAutoCheck(now), true, "After 30 min cooldown should allow check");

  // 6. When status is already 'available' (update found) -> do NOT check again
  updateStore.lastFailedAt = null;
  updateStore.state.checkedAt = null;
  updateStore.state.status = "available";
  assert.equal(updateStore.shouldAutoCheck(now), false, "When update already found should not re-check");

  // 7. When status is 'checking' or 'updating' -> do NOT check
  updateStore.state.status = "checking";
  assert.equal(updateStore.shouldAutoCheck(now), false, "When already checking should not duplicate");
  updateStore.state.status = "updating";
  assert.equal(updateStore.shouldAutoCheck(now), false, "When updating should not duplicate");

  // 8. When autoCheck is disabled -> do NOT check under any circumstance
  updateStore.state.status = "idle";
  updateStore.setAutoCheck(false);
  assert.equal(updateStore.shouldAutoCheck(now), false, "Disabled autoCheck must not check");

  harness.dispose();
});

test("auto-update: opening panel after >6 hours triggers silent update check", async () => {
  let checkCalls = 0;
  const harness = mountClient({
    fetchUpdateCheck: async () => {
      checkCalls++;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          hasUpdate: false
        }
      };
    }
  });

  const { updateStore, panelStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  // Last checked 7 hours ago
  const sevenHoursAgo = Date.now() - (7 * 60 * 60 * 1000);
  updateStore.state.checkedAt = sevenHoursAgo;
  updateStore.lastFailedAt = null;

  checkCalls = 0;
  // Panel transitions from closed to open
  panelStore.open = false;
  panelStore.set(true);

  await harness.flush();
  assert.equal(checkCalls, 1, "Opening panel after >6h must trigger update check");
  assert.ok(updateStore.state.checkedAt > sevenHoursAgo, "checkedAt must be updated after successful check");

  harness.dispose();
});

test("auto-update: repeatedly opening panel within 6 hours does not trigger duplicate checks", async () => {
  let checkCalls = 0;
  const harness = mountClient({
    fetchUpdateCheck: async () => {
      checkCalls++;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          hasUpdate: false
        }
      };
    }
  });

  const { updateStore, panelStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  // Set checkedAt to 1 hour ago
  updateStore.state.checkedAt = Date.now() - (1 * 60 * 60 * 1000);
  updateStore.lastFailedAt = null;

  checkCalls = 0;
  // Open and close repeatedly
  panelStore.open = false;
  panelStore.set(true);
  panelStore.set(false);
  panelStore.set(true);

  await harness.flush();
  assert.equal(checkCalls, 0, "Repeated panel opens within 6 hours must not trigger checks");

  harness.dispose();
});

test("auto-update: panel re-render or switching tabs does not trigger duplicate checks", async () => {
  let checkCalls = 0;
  const harness = mountClient({
    workspaces: [{ id: "ws1", name: "Main", path: "/test", sessionIds: [] }],
    fetchUpdateCheck: async () => {
      checkCalls++;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          hasUpdate: false
        }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  updateStore.state.checkedAt = Date.now();
  checkCalls = 0;

  // Switch tabs in panel
  const navTabs = nodes(harness.tree[0], n => n.type === "button" && n.props?.role === "tab");
  assert.ok(navTabs.length >= 2, "Tabs must be present");
  navTabs[1].props.onClick(); // switch to workspaces tab
  await harness.flush();

  navTabs[0].props.onClick(); // switch back to sessions tab
  await harness.flush();

  assert.equal(checkCalls, 0, "Tab switching must not trigger update checks");

  harness.dispose();
});

test("auto-update: failed check enforces 30m cooldown before re-attempting", async () => {
  let checkCalls = 0;
  const harness = mountClient({
    fetchUpdateCheck: async () => {
      checkCalls++;
      return {
        ok: false,
        error: "Network failure"
      };
    }
  });

  const { updateStore, panelStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  updateStore.state.checkedAt = null;
  updateStore.lastFailedAt = Date.now() - (15 * 60 * 1000); // Failed 15 min ago

  checkCalls = 0;
  panelStore.open = false;
  panelStore.set(true);

  await harness.flush();
  assert.equal(checkCalls, 0, "Failed check within 30 min cooldown must not be retried on panel open");

  // After 30 minutes, it should retry
  updateStore.lastFailedAt = Date.now() - (31 * 60 * 1000);
  panelStore.open = false;
  panelStore.set(true);

  await harness.flush();
  assert.equal(checkCalls, 1, "Failed check after 30 min cooldown must be retried on panel open");

  harness.dispose();
});

test("auto-update: manual check is exempt from 6h and 30m restrictions but prevents concurrent duplicate requests", async () => {
  let checkCalls = 0;
  const harness = mountClient({
    fetchUpdateCheck: async () => {
      checkCalls++;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          hasUpdate: true
        }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.setAutoCheck(true);
  // Set checkedAt to 5 minutes ago and lastFailedAt to 5 minutes ago
  updateStore.state.checkedAt = Date.now() - (5 * 60 * 1000);
  updateStore.lastFailedAt = Date.now() - (5 * 60 * 1000);
  updateStore.state.status = "idle";

  checkCalls = 0;
  // Manual check succeeds despite recent check
  const res = await updateStore.checkForUpdate({ manual: true, openDialog: false });
  assert.equal(checkCalls, 1, "Manual check must bypass interval and cooldown restrictions");
  assert.equal(res.status, "available");

  // When status is 'checking', duplicate manual call returns immediately
  updateStore.state.status = "checking";
  const duplicate = await updateStore.checkForUpdate({ manual: true });
  assert.equal(checkCalls, 1, "Concurrent call must not initiate duplicate request");
  assert.equal(duplicate.status, "checking");

  harness.dispose();
});

test("auto-update: finding update does not open modal dialog and marks available status", async () => {
  const harness = mountClient({
    fetchUpdateCheck: async () => ({
      ok: true,
      result: {
        currentVersion: "1.0.0",
        latestVersion: "1.2.0",
        hasUpdate: true
      }
    })
  });

  const { updateStore, panelStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  updateStore.state.dialogOpen = false;
  updateStore.state.checkedAt = null;

  // Auto check triggered via maybeAutoCheck
  await updateStore.maybeAutoCheck();
  assert.equal(updateStore.state.status, "available", "Status must be available");
  assert.equal(updateStore.state.latestVersion, "1.2.0");
  assert.equal(updateStore.state.dialogOpen, false, "Auto-check must be silent and NOT open dialog");

  // When update is found, subsequent panel opens do not duplicate check
  assert.equal(updateStore.shouldAutoCheck(), false, "Already available status should not trigger check again");

  harness.dispose();
});

test("auto-update: request timeout aborts and enters 30m failure cooldown", async () => {
  let passedSignal = null;
  const harness = mountClient({
    fetchUpdateCheck: async (options) => {
      passedSignal = options?.signal;
      const err = new Error("检查更新超时");
      err.name = "AbortError";
      throw err;
    }
  });

  const { updateStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  updateStore.state.checkedAt = null;
  updateStore.lastFailedAt = null;

  const now = Date.now();
  await updateStore.checkForUpdate({ manual: true, openDialog: false });

  assert.ok(passedSignal, "AbortSignal must be forwarded in fetch options");
  assert.equal(updateStore.state.status, "error", "Must transition to error on timeout");
  assert.equal(updateStore.state.error, "检查更新超时", "Error message must indicate timeout");
  assert.ok(updateStore.lastFailedAt >= now, "lastFailedAt must be recorded");

  // Subsequent auto-checks must be blocked within 30 min cooldown
  assert.equal(updateStore.shouldAutoCheck(now + 1000), false, "Must enter 30-minute failure cooldown");

  harness.dispose();
});

test("auto-update: panel open triggers exactly one update check without duplicate entry", async () => {
  let checkCalls = 0;
  const harness = mountClient({
    fetchUpdateCheck: async () => {
      checkCalls++;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          hasUpdate: false
        }
      };
    }
  });

  const { updateStore, panelStore } = harness.exports;
  updateStore.setAutoCheck(true);
  updateStore.state.status = "idle";
  updateStore.state.checkedAt = Date.now() - (7 * 60 * 60 * 1000); // 7 hours ago
  updateStore.lastFailedAt = null;

  checkCalls = 0;
  // Opening panel triggers check
  panelStore.open = false;
  panelStore.set(true);

  await harness.flush();
  assert.equal(checkCalls, 1, "Opening panel must trigger exactly 1 update check");

  // Additional re-render of panel must not trigger a second check
  await harness.flush();
  assert.equal(checkCalls, 1, "No duplicate check should be triggered after mount/render");

  harness.dispose();
});
