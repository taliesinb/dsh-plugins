/**
 * dsh-enforce-model-preset — bind agent presets to model selections.
 *
 * DSH has no native model→preset coupling: the preset is fixed per session
 * (while blank) and the model is an independent per-session selection. This
 * plugin listens for committed `model/selection` session events and, when the
 * selected model matches a configured rule and the session has not started,
 * switches that session's agent preset through `ctx.agentPresets.select` —
 * the same queued, blank-checked path the GUI picker uses.
 *
 * Config:
 *
 *   rules:                       # first match wins, checked in order
 *     - provider: apple          # required; '*' matches any provider
 *       model: foundation        # optional; omitted or '*' matches any model
 *       preset: minimal-no-tools # required preset id (shipped or user preset)
 *     - provider: lmstudio
 *       preset: minimal
 *     - provider: '*'            # catch-all restores the standard preset when
 *       preset: standard         # a blank session moves to an unmapped model;
 *                                # remove it to leave unmapped models alone
 *
 * Semantics and limits:
 * - Enforcement runs only on `model/selection` events of top-level sessions
 *   (children join their parent's composition and are never touched).
 * - A session that already produced a turn is locked by DSH itself; the switch
 *   is refused with `agent-preset/locked`, which this plugin treats as normal
 *   (the mapping applies to NEW sessions, mid-session model changes keep the
 *   running composition).
 * - A manual preset choice on a blank session is overridden by the next model
 *   selection that matches a rule — this is an *enforce* plugin. Remove the
 *   catch-all rule (or narrow rules) if manual choices should win more often.
 */

import { appendFileSync } from 'node:fs'

export const name = 'enforce-model-preset'

export const inject = ['agents', 'agentPresets', 'sessionProjections', 'agentDefaultModel']

/**
 * Validate one rule shape, failing plugin load loudly on misconfiguration.
 * @param {unknown} rule - candidate rule from config.
 * @param {number} index - position in the rules list, for the error message.
 */
function validateRule(rule, index) {
  const where = `enforce-model-preset: rules[${index}]`
  if (typeof rule !== 'object' || rule === null) throw new Error(`${where} must be an object`)
  const { provider, model, preset } = rule
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error(`${where}.provider must be a non-empty string ('*' for any)`)
  }
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    throw new Error(`${where}.model must be a non-empty string ('*' for any) when present`)
  }
  if (typeof preset !== 'string' || preset.length === 0) {
    throw new Error(`${where}.preset must be a non-empty preset id`)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ rules?: Array<{ provider: string, model?: string, preset: string }> }} config - model→preset rules.
 */
export function apply(ctx, config) {
  const rules = Array.isArray(config?.rules) ? config.rules : []
  rules.forEach(validateRule)
  if (rules.length === 0) {
    ctx.logger.warn('enforce-model-preset: no rules configured; plugin is inert')
    return
  }

  /** First rule matching a selection, or undefined. */
  const match = selection => rules.find(rule =>
    (rule.provider === '*' || rule.provider === selection.provider)
    && (rule.model === undefined || rule.model === '*' || rule.model === selection.model))

  /** Switch one blank session to the rule's preset; refusals are normal. */
  async function enforce(session, selection, rule, knownAgent) {
    let current
    try {
      current = ctx.sessionProjections.stateOf(session, 'agentPreset')
    } catch {
      return // projection absent: roster not mounted for this session shape
    }
    trace(`enforce ${session.id}: current=${String(current)} -> ${rule.preset}`)
    if (current === rule.preset) return
    const agent = knownAgent ?? ctx.agents.get(session.id)
    if (agent === undefined) return // no live agent (e.g. cold log replay)
    try {
      await ctx.agentPresets.select(agent, rule.preset)
      trace(`selected ${rule.preset} for ${session.id}`)
      ctx.logger.info(
        `enforce-model-preset: session "${session.id}" → preset "${rule.preset}" `
        + `(model ${selection.provider}/${selection.model})`,
      )
    } catch (error) {
      // The session started before the switch committed: DSH's own lock, the
      // exact behavior we want for mid-session model changes.
      const text = String(error)
      if ((error !== null && typeof error === 'object' && error.code === 'agent-preset/locked')
        || text.includes('agent-preset/locked') || text.includes('already started')) return
      trace(`select failed for ${session.id}: ${text}`)
      ctx.logger.warn(
        `enforce-model-preset: could not switch session "${session.id}" to `
        + `preset "${rule.preset}": ${text}`,
      )
    }
  }

  // A session that never picks a model runs on the deployment default, and
  // that default may be a mapped provider (the picker "remembers" Apple
  // Foundation by making it the default): no `model/selection` event ever
  // fires. Enforce at agent creation on the effective default; a later
  // explicit selection re-enforces through the event path below.
  const trace = (line) => { if (process.env.ENFORCE_PRESET_TRACE) { try { appendFileSync(process.env.ENFORCE_PRESET_TRACE, `${new Date().toISOString()} ${line}\n`) } catch {} } }
  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    trace(`agent/created ${session.id} depth=${String(session.header?.delegationDepth)} seq=${String(session.seq)}`)
    if ((session.header?.delegationDepth ?? 0) > 0) return
    // Blank = no turn has run (the preamble events make a fresh session's seq
    // non-zero, so seq is not the test); `agentPresets.select` re-checks this
    // under its queue and refuses with agent-preset/locked otherwise.
    let boundary
    try {
      boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    } catch {
      boundary = undefined
    }
    if (boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) return
    let selection
    try {
      selection = ctx.agentDefaultModel.currentSelection()
    } catch (error) {
      trace(`default selection failed: ${String(error)}`)
      return
    }
    trace(`default selection ${JSON.stringify(selection)}`)
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return
    const rule = match(selection)
    trace(`rule ${JSON.stringify(rule)}`)
    if (rule === undefined) return
    void enforce(session, selection, rule, agent).catch((error) => {
      ctx.logger.warn(`enforce-model-preset: enforcement at creation failed: ${String(error)}`)
    })
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'model/selection') return
    // Children join their parent's composition; only top-level sessions map.
    if ((session.header?.delegationDepth ?? 0) > 0) return
    const selection = event.data
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return
    const rule = match(selection)
    if (rule === undefined) return
    void enforce(session, selection, rule).catch((error) => {
      ctx.logger.warn(`enforce-model-preset: enforcement failed: ${String(error)}`)
    })
  })
}
