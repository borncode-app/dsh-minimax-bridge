<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-minimax-bridge</h1>
  <p><b>Use everything you already installed in MiniMax Code — skills, agents, MCP servers — from DeepSeek Harness.</b></p>
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
here is unchanged and each part keeps its own switch — this repository stays
the home of the skills bridge and the agent presets.

## What it does

MiniMax Code keeps its own home directory (`~/.minimax` by default) with skills, agents, plugins, and a
`mcp.json`. This bundle **reads that directory in place** and republishes it inside the Harness — it never copies,
never syncs, and never takes ownership. MiniMax Code stays the owner and keeps updating its own files.

| what lives in MiniMax Code | how Harness sees it |
|---|---|
| `~/.minimax/skills/<name>/SKILL.md` | a skill in the Harness catalog |
| `~/.minimax/plugins/<plugin>/skills/<name>/SKILL.md` | same catalog (plugin-owned skills) |
| `~/.minimax/agents/<agent>/skills/` | same catalog |
| `~/.minimax/agents/<agent>/agent.md` | a **Harness agent preset** |
| `~/.minimax/mcp.json` | separate MCP rows in `cordis.patch.yml`, shipped **disabled** |

## Features

- **Two rows, one home** — `dsh-minimax-bridge` serves skills, `dsh-minimax-bridge/agents` republishes agents
  as selectable presets.
- **Nothing is copied** — files are read where they already are, so edits in MiniMax Code are live.
- **Watcher** — `watch: true` republishes the catalog when an agent is added, edited, or removed; no restart.
- **Tool mapping** — `tools:` in an agent's frontmatter is translated to Harness plugin rows
  (`bash` → `dsh-tool-pwsh`, `grep/glob` → `dsh-tool-fs-search`, `task_*` → `dsh-tool-subagent-control`, …).
  A read-only role stays read-only: no `write`/`edit` appears in its preset.
- **Prompt rendering** — `agent.md` is a MiniMax Handlebars template; the plugin renders it with
  `mode.coding: true`, `surface.cli: false`, drops the two MiniMax-only sections, and caps the result.
- **MCP stays opt-in** — `mcp-reverse` alone publishes 111 tools and `rea` 229; enabling them costs context on
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

Then in DSH: **Plugins** → install the bundle from that directory, or:

```
plugin_manager install_bundle target=C:\path\to\dsh-minimax-bridge
```

Restart once. Enable the MCP rows later, one at a time, after checking their env block.

## Configuration

`minimax-bridge` row — the skill provider:

| field | default | meaning |
|---|---|---|
| `minimaxHome` | `''` | Empty selects `$MINIMAX_HOME`, else `~/.minimax` |
| `includeUserSkills` | `true` | Read `<home>/skills` |
| `includePluginSkills` | `true` | Read `<home>/plugins/*/skills` |
| `includeAgentSkills` | `true` | Read `<home>/agents/*/skills` |
| `extraSkillDirs` | `[]` | Additional roots, read after the MiniMax ones |
| `watch` | `true` | Republish when MiniMax Code adds or edits a skill |

`minimax-agent-bridge` row — the agent presets:

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
each `disabled: true` until you enable it — and each carrying **your** machine's absolute paths, which you must
review before turning on.

## How it works

```
~/.minimax/  ──read──▶ dsh-minimax-bridge ──▶ Harness skill catalog
     │                        │
     │                        └──▶ Harness agent presets
     └──mcp.json──▶ separate disabled rows ──(you enable)──▶ mcp__<server>__<tool>
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

## ภาษาไทย

ให้ DSH ใช้ของที่ติดตั้งไว้ใน MiniMax Code (`~/.minimax`) โดย **อ่านไฟล์จากที่เดิม ไม่ก็อป ไม่ sync** —
MiniMax Code ยังเป็นเจ้าของไฟล์และอัปเดตตัวเองได้ตามปกติ

| ของใน MiniMax Code | DSH มองเห็นเป็น |
|---|---|
| `~/.minimax/skills/`, `plugins/*/skills/`, `agents/*/skills/` | skill ในแคตตาล็อก |
| `~/.minimax/agents/<name>/agent.md` | agent preset ของ DSH |
| `~/.minimax/mcp.json` | แถว MCP แยก **ปิดไว้ก่อน** (rea 229 tools / mcp-reverse 111 tools กิน context ทุกเทิร์น) |

- `watch: true` → แก้/เพิ่ม/ลบ agent แล้วอัปเดตเองในไม่กี่วินาที ไม่ต้องรีสตาร์ท
- agent ที่ประกาศ `tools:` แบบ read-only (`explore`, `verifier`) จะไม่ได้ `write`/`edit` เลย
- แถว MCP มี absolute path ของเครื่องคุณอยู่ — **ตรวจก่อนเปิด** ทุกแถว

## License

[MIT](LICENSE) © 2026 BornCode
