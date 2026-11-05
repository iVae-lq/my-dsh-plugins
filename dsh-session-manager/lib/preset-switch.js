/**
 * Rebind a live Agent to another Agent preset without losing per-Agent tools.
 *
 * A preset composition may install tools into the Agent's OWN scope layer
 * rather than its standing composition layer: DSH's `tool-subagent` row with
 * `modelSelectionSettings: true` installs `subagent` and
 * `list_subagent_models` per Agent. `agentPresets.recompose()` rebinds the
 * Agent and emits a single `tools/change`; every mounted composition reacts to
 * that one event in listener order: the source tears its Agent install down,
 * the target installs its own. Both run on microtasks, so when the target was
 * mounted before the source (cordis → standard, cordis → ptc, ptc → standard)
 * the install runs first, fails with
 * `tool "list_subagent_models" is already registered in this scope`, and the
 * target caches that failed install. The Agent then lacks both tools until
 * DSH restarts.
 *
 * Passing through an empty preset registered only for the switch separates
 * the two halves. Every composition first tears its Agent install down, which
 * also drops any failed install it cached. The target then installs into an
 * empty layer, whatever order the compositions were mounted in.
 *
 * @module dsh-session-manager/preset-switch
 */

/** Id prefix of the temporary transit presets; never a user-selectable target. */
export const TRANSIT_PRESET_PREFIX = "session-manager-transit-";

/**
 * Whether an id names a temporary transit preset.
 * @param {unknown} id - preset id to test.
 * @returns {boolean} true for ids minted by {@link recomposeAgentPreset}.
 */
export function isTransitPresetId(id) {
  return typeof id === "string" && id.startsWith(TRANSIT_PRESET_PREFIX);
}

let transitCounter = 0;

const errorText = (error) => String(error?.message ?? error);
const macrotask = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Agent's visible tool names as a comparable string.
 * @param {any} tools - DSH `tools` service, if any.
 * @param {any} agent - live Agent; DSH uses the Agent itself as its scope key.
 * @returns {string | undefined} sorted names, or undefined when unreadable.
 */
function agentToolNames(tools, agent) {
  try {
    if (typeof tools?.view === "function") return [...tools.view(agent).visible.keys()].sort().join("\n");
    if (typeof tools?.schemas === "function") return (tools.schemas(agent) ?? []).map((schema) => schema?.name).sort().join("\n");
  } catch {
    // An unreadable registry leaves only the macrotask wait below.
  }
  return undefined;
}

/**
 * Wait until the Agent's tool set stops changing. Composition teardown and
 * installs run on microtasks, so one macrotask normally settles them; the
 * bounded poll covers anything slower.
 * @param {any} tools - DSH `tools` service, if any.
 * @param {any} agent - live Agent.
 * @param {{ maxRounds?: number, intervalMs?: number }} [options] - poll bounds.
 * @returns {Promise<void>} resolves once two reads agree or the bound is hit.
 */
export async function settleAgentTools(tools, agent, { maxRounds = 25, intervalMs = 20 } = {}) {
  let previous = agentToolNames(tools, agent);
  for (let round = 0; round < maxRounds; round += 1) {
    await macrotask(round === 0 ? 0 : intervalMs);
    const current = agentToolNames(tools, agent);
    if (current === previous) return;
    previous = current;
  }
}

/**
 * Move the Agent onto a freshly registered empty preset.
 * @returns {Promise<(() => Promise<void>) | undefined>} the transit's release,
 *   or undefined when no transit could be entered (the caller then switches
 *   directly, which is what older builds did).
 */
async function enterTransit({ presets, agent, tools, logger }) {
  if (typeof presets.register !== "function") return undefined;
  transitCounter += 1;
  const id = `${TRANSIT_PRESET_PREFIX}${Date.now().toString(36)}-${transitCounter}`;
  let unregister;
  try {
    unregister = await presets.register({ id, name: "session-manager transit", plugins: [] });
  } catch (error) {
    logger?.warn?.(`session-manager: transit preset unavailable, switching directly: ${errorText(error)}`);
    return undefined;
  }
  const release = async () => {
    try {
      if (typeof unregister === "function") await unregister();
    } catch (error) {
      logger?.warn?.(`session-manager: failed to retire transit preset "${id}": ${errorText(error)}`);
    }
  };
  try {
    await presets.recompose(agent.ctx, id);
  } catch (error) {
    await release();
    logger?.warn?.(`session-manager: transit preset could not be entered, switching directly: ${errorText(error)}`);
    return undefined;
  }
  await settleAgentTools(tools, agent);
  return release;
}

/**
 * Rebind a live Agent to `toPreset`, so the switch applies from the next
 * message without restarting DSH. DSH's `agentPresets.select()` refuses once a
 * session has started; `recompose()` is the primitive it uses. A failure
 * propagates after the original composition is restored.
 * @param {{ presets: any, agent: any, toPreset: string, tools?: any, logger?: any }} options
 * @returns {Promise<boolean>} true when the live Agent was rebound.
 */
export async function recomposeAgentPreset({ presets, agent, toPreset, tools, logger }) {
  if (agent === undefined || agent === null || !agent.ctx || typeof presets?.recompose !== "function") return false;
  const composed = typeof presets.composedPreset === "function" ? presets.composedPreset(agent.ctx) : undefined;
  if (composed === toPreset) return false;
  const release = await enterTransit({ presets, agent, tools, logger });
  try {
    try {
      await presets.recompose(agent.ctx, toPreset);
    } catch (error) {
      // Never leave the Agent parked on the empty transit composition.
      if (release !== undefined && typeof composed === "string") {
        try {
          await presets.recompose(agent.ctx, composed);
        } catch (restoreError) {
          logger?.warn?.(`session-manager: could not restore preset "${composed}" after a failed switch: ${errorText(restoreError)}`);
        }
      }
      throw error;
    }
    await settleAgentTools(tools, agent);
  } finally {
    if (release !== undefined) await release();
  }
  return true;
}
