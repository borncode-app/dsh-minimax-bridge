> **This repository has moved into one monorepo.**
>
> The whole MiniMax set — the credit proxy, the daily check-in, the model-list
> sync, the composer quota chip, the MiniMax Code bridge, and the shared grant
> reader — now lives in
> **[`borncode-app/dsh-minimax-kit`](https://github.com/borncode-app/dsh-minimax-kit)**,
> one repository with one Plugins entry.
>
> | this repo | new home |
> |---|---|
> | `dsh-minimax-auth` | `packages/dsh-minimax-auth` |
> | `dsh-minimax-credit` | `packages/dsh-minimax-credit` |
> | `dsh-minimax-checkin` | `packages/dsh-minimax-checkin` |
> | `dsh-minimax-model-sync` | `packages/dsh-minimax-model-sync` |
> | `dsh-minimax-bridge` | `packages/dsh-minimax-bridge` |
> | `dsh-model-quota` | `packages/dsh-model-quota` |
>
> The code and its history are unchanged; only the repository is shared. Install
> `dsh-minimax-kit` instead of the individual bundles. This repository stays
> open so the old links keep working.
<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-minimax-bridge</h1>
  <p><b>Use everything you already installed in MiniMax Code â€” skills, agents, MCP servers â€” from DeepSeek Harness.</b></p>
  <p>
    <a href="https://github.com/borncode-app/dsh-minimax-bridge/releases"><img alt="release" src="https://img.shields.io/github/v/release/borncode-app/dsh-minimax-bridge?style=flat-square&color=6C4BF6"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
    <img alt="plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6C4BF6?style=flat-square">
    <img alt="source" src="https://img.shields.io/badge/reads-~%2F.minimax-8957e5?style=flat-square">
  </p>
</div>

---

## Where the one-entry kit lives

This plugin, `dsh-minimax-credit`, `dsh-minimax-checkin`, `dsh-minimax-model-sync`
and `dsh-model-quota` are also published as one bundle:
**[`dsh-minimax-kit`](https://github.com/borncode-app/dsh-minimax-kit)**.

Install the kit instead if you want the whole MiniMax set from a single
**Plugins** entry. It ships these same packages as separate rows, so the code
here is unchanged and each part keeps its own switch â€” this repository stays
the home of the skills bridge and the agent presets.

## What it does

MiniMax Code keeps its own home directory (`~/.minimax` by default) with skills, agents, plugins, and a
`mcp.json`. This bundle **reads that directory in place** and republishes it inside the Harness â€” it never copies,
never syncs, and never takes ownership. MiniMax Code stays the owner and keeps updating its own files.

| what lives in MiniMax Code | how Harness sees it |
|---|---|
| `~/.minimax/skills/<name>/SKILL.md` | a skill in the Harness catalog |
| `~/.minimax/plugins/<plugin>/skills/<name>/SKILL.md` | same catalog (plugin-owned skills) |
| `~/.minimax/agents/<agent>/skills/` | same catalog |
| `~/.minimax/agents/<agent>/agent.md` | a **Harness agent preset** |
| `~/.minimax/mcp.json` | separate MCP rows in `cordis.patch.yml`, shipped **disabled** |

## Features

- **Two rows, one home** â€” `dsh-minimax-bridge` serves skills, `dsh-minimax-bridge/agents` republishes agents
  as selectable presets.
- **Nothing is copied** â€” files are read where they already are, so edits in MiniMax Code are live.
- **Watcher** â€” `watch: true` republishes the catalog when an agent is added, edited, or removed; no restart.
- **Tool mapping** â€” `tools:` in an agent's frontmatter is translated to Harness plugin rows
  (`bash` â†’ `dsh-tool-pwsh`, `grep/glob` â†’ `dsh-tool-fs-search`, `task_*` â†’ `dsh-tool-subagent-control`, â€¦).
  A read-only role stays read-only: no `write`/`edit` appears in its preset.
- **Prompt rendering** â€” `agent.md` is a MiniMax Handlebars template; the plugin renders it with
  `mode.coding: true`, `surface.cli: false`, drops the two MiniMax-only sections, and caps the result.
- **MCP stays opt-in** â€” `mcp-reverse` alone publishes 111 tools and `rea` 229; enabling them costs context on
  every request, so they arrive disabled and you choose.

## Requirements

| | |
|---|---|
| DeepSeek Harness | 0.2.x |
| Runtime | Node 24, supplied by the Harness runtime |
| MiniMax Code | Installed, with a populated `~/.minimax` (or point `minimaxHome` elsewhere) |
| Optional | Each MCP row needs its own toolchain (Ghidra/Jadx for `rea`, etc.) |

## Install

```bash
git clone https://github.com/borncode-app/dsh-minimax-bridge.git dsh-minimax-bridge
```

Then in DSH: **Plugins** â†’ install the bundle from that directory, or:

```
plugin_manager install_bundle target=C:\path\to\dsh-minimax-bridge
```

Restart once. Enable the MCP rows later, one at a time, after checking their env block.

## Configuration

`minimax-bridge` row â€” the skill provider:

| field | default | meaning |
|---|---|---|
| `minimaxHome` | `''` | Empty selects `$MINIMAX_HOME`, else `~/.minimax` |
| `includeUserSkills` | `true` | Read `<home>/skills` |
| `includePluginSkills` | `true` | Read `<home>/plugins/*/skills` |
| `includeAgentSkills` | `true` | Read `<home>/agents/*/skills` |
| `extraSkillDirs` | `[]` | Additional roots, read after the MiniMax ones |
| `watch` | `true` | Republish when MiniMax Code adds or edits a skill |

`minimax-agent-bridge` row â€” the agent presets:

| field | default | meaning |
|---|---|---|
| `minimaxHome` | `''` | Same resolution as above |
| `mode` | `coding` | Which MiniMax surface's prompt is published: `coding`, `work`, or `tui` |
| `includeBuiltin` | `true` | Publish the agents MiniMax Code ships |
| `includeUserAgents` | `true` | Publish agents the user created |
| `stripSections` | `Harness`, `Media Output` | Sections the Harness provides itself, so MiniMax's copy is dropped |
| `watch` | `true` | Republish on add / edit / remove |
| `maxPersonaChars` | `60000` | Upper bound on one published persona |

The bundle also inserts three MCP rows (`minimax-mcp-rea`, `minimax-mcp-photocraft`, `minimax-mcp-reverse`),
each `disabled: true` until you enable it â€” and each carrying **your** machine's absolute paths, which you must
review before turning on.

## How it works

```
~/.minimax/  â”€â”€readâ”€â”€â–¶ dsh-minimax-bridge â”€â”€â–¶ Harness skill catalog
     â”‚                        â”‚
     â”‚                        â””â”€â”€â–¶ Harness agent presets
     â””â”€â”€mcp.jsonâ”€â”€â–¶ separate disabled rows â”€â”€(you enable)â”€â”€â–¶ mcp__<server>__<tool>
```

Nothing is written back into `~/.minimax`. Remove the bundle and MiniMax Code is exactly as it was.

## Files

| file | role |
|---|---|
| `index.js` | skill provider: reads `~/.minimax`, publishes the catalog, watches for changes |
| `agents.js` | agent bridge: reads `agent.md`, renders the template, publishes presets |
| `cordis.patch.yml` | 2 plugin rows (enabled) + 3 MCP rows (disabled) |
| `locale/{en,th,zh}.json` | UI strings |
| `icon.svg` | plugin icon |
| `test-render.mjs` | renderer check against a real `agent.md` (not shipped to npm) |

## à¸ à¸²à¸©à¸²à¹„à¸—à¸¢

à¹ƒà¸«à¹‰ DSH à¹ƒà¸Šà¹‰à¸‚à¸­à¸‡à¸—à¸µà¹ˆà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡à¹„à¸§à¹‰à¹ƒà¸™ MiniMax Code (`~/.minimax`) à¹‚à¸”à¸¢ **à¸­à¹ˆà¸²à¸™à¹„à¸Ÿà¸¥à¹Œà¸ˆà¸²à¸à¸—à¸µà¹ˆà¹€à¸”à¸´à¸¡ à¹„à¸¡à¹ˆà¸à¹‡à¸­à¸› à¹„à¸¡à¹ˆ sync** â€”
MiniMax Code à¸¢à¸±à¸‡à¹€à¸›à¹‡à¸™à¹€à¸ˆà¹‰à¸²à¸‚à¸­à¸‡à¹„à¸Ÿà¸¥à¹Œà¹à¸¥à¸°à¸­à¸±à¸›à¹€à¸”à¸•à¸•à¸±à¸§à¹€à¸­à¸‡à¹„à¸”à¹‰à¸•à¸²à¸¡à¸›à¸à¸•à¸´

| à¸‚à¸­à¸‡à¹ƒà¸™ MiniMax Code | DSH à¸¡à¸­à¸‡à¹€à¸«à¹‡à¸™à¹€à¸›à¹‡à¸™ |
|---|---|
| `~/.minimax/skills/`, `plugins/*/skills/`, `agents/*/skills/` | skill à¹ƒà¸™à¹à¸„à¸•à¸•à¸²à¸¥à¹‡à¸­à¸ |
| `~/.minimax/agents/<name>/agent.md` | agent preset à¸‚à¸­à¸‡ DSH |
| `~/.minimax/mcp.json` | à¹à¸–à¸§ MCP à¹à¸¢à¸ **à¸›à¸´à¸”à¹„à¸§à¹‰à¸à¹ˆà¸­à¸™** (rea 229 tools / mcp-reverse 111 tools à¸à¸´à¸™ context à¸—à¸¸à¸à¹€à¸—à¸´à¸£à¹Œà¸™) |

- `watch: true` â†’ à¹à¸à¹‰/à¹€à¸žà¸´à¹ˆà¸¡/à¸¥à¸š agent à¹à¸¥à¹‰à¸§à¸­à¸±à¸›à¹€à¸”à¸•à¹€à¸­à¸‡à¹ƒà¸™à¹„à¸¡à¹ˆà¸à¸µà¹ˆà¸§à¸´à¸™à¸²à¸—à¸µ à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡à¸£à¸µà¸ªà¸•à¸²à¸£à¹Œà¸—
- agent à¸—à¸µà¹ˆà¸›à¸£à¸°à¸à¸²à¸¨ `tools:` à¹à¸šà¸š read-only (`explore`, `verifier`) à¸ˆà¸°à¹„à¸¡à¹ˆà¹„à¸”à¹‰ `write`/`edit` à¹€à¸¥à¸¢
- à¹à¸–à¸§ MCP à¸¡à¸µ absolute path à¸‚à¸­à¸‡à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸„à¸¸à¸“à¸­à¸¢à¸¹à¹ˆ â€” **à¸•à¸£à¸§à¸ˆà¸à¹ˆà¸­à¸™à¹€à¸›à¸´à¸”** à¸—à¸¸à¸à¹à¸–à¸§

## License

[MIT](LICENSE) Â© 2026 BornCode
