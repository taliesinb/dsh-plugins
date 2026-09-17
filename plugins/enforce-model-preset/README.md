# tali-enforce-model-preset

Bind agent presets to model selections. DSH has no native model→preset
coupling — the preset is fixed per session (while blank) and the model is an
independent selection. This plugin listens for committed `model/selection`
session events and, when the selection matches a configured rule and the
session has not produced a turn, switches that session's agent preset through
`ctx.agentPresets.select` — the same queued, blank-checked path the GUI picker
uses.

Written 2026-09-03 so tiny local models (Apple Foundation on-device via AFM,
small LM Studio models) automatically get tiny compositions instead of the
~8.3k-token standard prompt+toolbelt. Full background and the provider setup
recipe: `~/projects/deepseek-harness/apple-foundation-model-provider.md`.

## Config

```yaml
rules:                       # first match wins, checked in order
  - provider: apple          # required; '*' matches any provider
    model: foundation        # optional; omitted or '*' matches any model
    preset: minimal-no-tools # required preset id (shipped or user preset)
  - provider: lmstudio
    preset: minimal
  - provider: '*'            # catch-all restores `standard` when a blank
    preset: standard         # session moves to an unmapped model; remove it
                             # to let manual preset choices stand
```

`minimal-no-tools` is a user preset (persona-only, zero tool schemas) at
`~/.dsh/.agent-presets/minimal-no-tools/`.

## Semantics and limits

- Acts only on `model/selection` events of top-level sessions
  (`delegationDepth === 0`); subagents join their parent's composition.
- A session that already ran a turn is locked by DSH itself
  (`agent-preset/locked`); the plugin treats that refusal as normal, so
  mid-session model changes keep the running composition.
- A manual preset choice on a blank session is overridden by the next matching
  model selection — this is an *enforce* plugin.
- Services used: `agents` (live agent lookup), `agentPresets` (`select`),
  `sessionProjections` (`agentPreset` state; skip when already on target).

## Default-model sessions

A session that never picks a model runs on the deployment default
(`agent-default-model`), and the picker "remembers" a choice by making it the
default — so no `model/selection` event fires for such sessions. The plugin
therefore also enforces at `agent/created` for fresh top-level sessions,
using `ctx.agentDefaultModel.currentSelection()`; an explicit selection later
re-enforces through the event path. (Found on alpha: Apple Foundation as the
default left a blank session on `standard`, 8K of tool schemas on the wire.)
