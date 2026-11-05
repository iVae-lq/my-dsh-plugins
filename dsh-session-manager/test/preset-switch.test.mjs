import test from "node:test";
import assert from "node:assert/strict";
import { recomposeAgentPreset, isTransitPresetId, settleAgentTools, TRANSIT_PRESET_PREFIX } from "../lib/preset-switch.js";

/**
 * A model of DSH 0.2.x live preset switching, faithful to the parts that
 * matter here:
 * - every mounted composition listens to `tools/change` in mount order;
 * - `tool-subagent` with `modelSelectionSettings` installs its tools into the
 *   Agent's OWN layer on a microtask, and tears them down on a microtask;
 * - a duplicate name in one layer throws, and the composition caches the
 *   failed install for that Agent (it is never retried).
 */
function fakeDsh({ withRegister = true } = {}) {
  const agent = { id: "s1", ctx: { agentCtx: true } };
  const layer = new Map();
  const errors = [];
  const listeners = [];
  const definitions = new Map();
  const calls = { recompose: [], registered: [], retired: [] };
  let bound;

  function mountComposition(id, toolNames) {
    let cache;
    listeners.push(() => {
      if (bound === id) {
        if (cache !== undefined) return;
        cache = "pending";
        Promise.resolve().then(() => {
          const duplicate = toolNames.find((name) => layer.has(name));
          if (duplicate !== undefined) {
            cache = "failed";
            errors.push(`tool "${duplicate}" is already registered in this scope`);
            return;
          }
          for (const name of toolNames) layer.set(name, id);
          cache = "ok";
        });
      } else if (cache !== undefined) {
        cache = undefined;
        Promise.resolve().then(() => {
          for (const name of toolNames) if (layer.get(name) === id) layer.delete(name);
        });
      }
    });
    definitions.set(id, { id });
  }

  const delegation = ["list_subagent_models", "subagent"];
  mountComposition("standard", delegation); // dsh-web-app mounts standard first …
  mountComposition("cordis", delegation);   // … and cordis last

  const presets = {
    switches: new Map(),
    definitions,
    composedPreset: (c) => (c === agent.ctx ? bound : undefined),
    async recompose(c, id) {
      calls.recompose.push(id);
      if (!definitions.has(id)) throw new Error(`Unknown agent preset: ${id}`);
      bound = id;
      for (const listener of [...listeners]) listener();
      return { id };
    },
    async list() { return [...definitions.keys()].map((id) => ({ id })); },
  };
  if (withRegister) {
    presets.register = async (definition) => {
      if (definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      assert.deepEqual(definition.plugins, [], "the transit composition must be empty");
      calls.registered.push(definition.id);
      mountComposition(definition.id, []);
      return async () => {
        definitions.delete(definition.id);
        calls.retired.push(definition.id);
      };
    };
  }
  const tools = { view: () => ({ visible: new Map(layer) }) };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { agent, presets, tools, layer, errors, calls, settle, bind: async (id) => { bound = id; for (const l of [...listeners]) l(); await settle(); } };
}

const names = (dsh) => [...dsh.layer.keys()].sort();

test("model check: a direct recompose back to an earlier-mounted preset loses subagent tools (the DSH race)", async () => {
  const dsh = fakeDsh();
  await dsh.bind("standard");
  assert.deepEqual(names(dsh), ["list_subagent_models", "subagent"]);
  await dsh.presets.recompose(dsh.agent.ctx, "cordis");
  await dsh.settle();
  assert.deepEqual(names(dsh), ["list_subagent_models", "subagent"], "forward switch works");
  await dsh.presets.recompose(dsh.agent.ctx, "standard");
  await dsh.settle();
  assert.deepEqual(names(dsh), [], "cordis → standard drops both tools");
  assert.deepEqual(dsh.errors, ['tool "list_subagent_models" is already registered in this scope']);
});

test("switching through the transit preset keeps subagent tools in both directions", async () => {
  const dsh = fakeDsh();
  await dsh.bind("standard");
  const opts = { presets: dsh.presets, agent: dsh.agent, tools: dsh.tools };
  for (let round = 0; round < 3; round += 1) {
    assert.equal(await recomposeAgentPreset({ ...opts, toPreset: "cordis" }), true);
    assert.equal(dsh.presets.composedPreset(dsh.agent.ctx), "cordis");
    assert.deepEqual(names(dsh), ["list_subagent_models", "subagent"]);
    assert.equal(await recomposeAgentPreset({ ...opts, toPreset: "standard" }), true);
    assert.equal(dsh.presets.composedPreset(dsh.agent.ctx), "standard");
    assert.deepEqual(names(dsh), ["list_subagent_models", "subagent"]);
  }
  assert.deepEqual(dsh.errors, []);
  assert.equal(dsh.calls.registered.length, 6, "one transit per switch");
  assert.deepEqual(dsh.calls.retired, dsh.calls.registered, "every transit is retired");
  assert.ok(dsh.calls.registered.every(isTransitPresetId));
  assert.ok(![...dsh.presets.definitions.keys()].some(isTransitPresetId), "no transit preset is left in the roster");
  assert.deepEqual(dsh.calls.recompose.slice(0, 2), [dsh.calls.registered[0], "cordis"], "transit first, then the target");
});

test("a switch heals an Agent whose earlier direct switch lost its tools", async () => {
  const dsh = fakeDsh();
  await dsh.bind("standard");
  await dsh.bind("cordis");
  await dsh.bind("standard");
  assert.deepEqual(names(dsh), [], "broken by the old direct path");
  const opts = { presets: dsh.presets, agent: dsh.agent, tools: dsh.tools };
  await recomposeAgentPreset({ ...opts, toPreset: "cordis" });
  await recomposeAgentPreset({ ...opts, toPreset: "standard" });
  assert.deepEqual(names(dsh), ["list_subagent_models", "subagent"]);
});

test("without agentPresets.register the switch falls back to one direct recompose", async () => {
  const dsh = fakeDsh({ withRegister: false });
  await dsh.bind("standard");
  assert.equal(await recomposeAgentPreset({ presets: dsh.presets, agent: dsh.agent, tools: dsh.tools, toPreset: "cordis" }), true);
  assert.deepEqual(dsh.calls.recompose, ["cordis"]);
  assert.equal(dsh.presets.composedPreset(dsh.agent.ctx), "cordis");
});

test("a failed target restores the original preset, retires the transit and rethrows", async () => {
  const dsh = fakeDsh();
  await dsh.bind("standard");
  await assert.rejects(
    recomposeAgentPreset({ presets: dsh.presets, agent: dsh.agent, tools: dsh.tools, toPreset: "missing" }),
    /Unknown agent preset: missing/,
  );
  assert.equal(dsh.presets.composedPreset(dsh.agent.ctx), "standard", "never parked on the empty transit");
  assert.deepEqual(names(dsh), ["list_subagent_models", "subagent"]);
  assert.deepEqual(dsh.calls.retired, dsh.calls.registered);
});

test("a transit that cannot be registered or entered degrades to a direct switch", async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const dsh = fakeDsh();
  await dsh.bind("standard");
  dsh.presets.register = async () => { throw new Error("register refused"); };
  assert.equal(await recomposeAgentPreset({ presets: dsh.presets, agent: dsh.agent, tools: dsh.tools, toPreset: "cordis", logger }), true);
  assert.deepEqual(dsh.calls.recompose, ["cordis"]);
  assert.match(warnings[0], /register refused/);

  const other = fakeDsh();
  await other.bind("standard");
  const recompose = other.presets.recompose;
  other.presets.recompose = async (c, id) => {
    if (isTransitPresetId(id)) throw new Error("transit broken");
    return recompose(c, id);
  };
  assert.equal(await recomposeAgentPreset({ presets: other.presets, agent: other.agent, tools: other.tools, toPreset: "cordis", logger }), true);
  assert.equal(other.presets.composedPreset(other.agent.ctx), "cordis");
  assert.deepEqual(other.calls.retired, other.calls.registered, "the unused transit is retired");
  assert.match(warnings[1], /transit broken/);
});

test("no rebind when the Agent already runs the target, or when there is no live Agent", async () => {
  const dsh = fakeDsh();
  await dsh.bind("standard");
  assert.equal(await recomposeAgentPreset({ presets: dsh.presets, agent: dsh.agent, tools: dsh.tools, toPreset: "standard" }), false);
  assert.equal(await recomposeAgentPreset({ presets: dsh.presets, agent: undefined, toPreset: "cordis" }), false);
  assert.deepEqual(dsh.calls.recompose, []);
  assert.deepEqual(dsh.calls.registered, []);
});

test("transit ids are recognisable and settling tolerates an unreadable tool registry", async () => {
  assert.equal(isTransitPresetId(`${TRANSIT_PRESET_PREFIX}abc-1`), true);
  assert.equal(isTransitPresetId("standard"), false);
  assert.equal(isTransitPresetId(undefined), false);
  await settleAgentTools({ view: () => { throw new Error("boom"); } }, {}, { maxRounds: 2, intervalMs: 1 });
  await settleAgentTools(undefined, {}, { maxRounds: 2, intervalMs: 1 });
});
