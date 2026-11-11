import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderTemplate } from './agents.js'

const home = join(homedir(), '.minimax')
const sources = [
  join(home, 'agents/.builtin/mavis/agent.md'),
  join(home, 'agents/.builtin/explore/agent.md'),
  join(home, 'agents/.builtin/worker/agent.md'),
  join(home, 'agents/.builtin/verifier/agent.md'),
]

const stripSections = (text, names) => {
  let result = text
  for (const name of names) {
    const heading = new RegExp(`^(#{1,6}) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`, 'm')
    const found = heading.exec(result)
    if (found === null) continue
    const level = found[1].length
    const rest = result.slice(found.index + found[0].length)
    const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest)
    const end = next === null ? result.length : found.index + found[0].length + next.index
    result = `${result.slice(0, found.index)}${result.slice(end)}`
  }
  return result
}

for (const path of sources) {
  const raw = await readFile(path, 'utf8')
  const start = raw.indexOf('\n---', 4)
  const body = raw.slice(raw.indexOf('\n', start + 1) + 1)
  const rendered = renderTemplate(body, 'coding')
  const text = stripSections(rendered, ['Harness', 'Media Output']).replace(/\n{3,}/g, '\n\n').trim()
  const headings = text.split('\n').filter(line => /^#{1,6} /.test(line)).join(' | ')
  const leftover = text.match(/\{\{[^}]*\}\}/g)
  const stray = text.match(/^\s*\}\s*$/m)
  console.log(`\n=== ${path.split(/[\\/]/).slice(-2, -1)[0]} ===`)
  console.log(`chars=${text.length}`)
  console.log(`headings=${headings}`)
  console.log(`leftover markers: ${leftover === null ? 'none' : leftover.join(' ')}`)
  console.log(`stray braces: ${stray === null ? 'none' : 'FOUND'}`)
}
