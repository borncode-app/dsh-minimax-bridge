import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'

/**
 * Publish the agents of a MiniMax Code home as Harness agent presets.
 *
 * MiniMax Code keeps each agent's definition in one Markdown file with YAML
 * frontmatter — `agent.md` — beside its runtime state. The built-in roles live
 * under `<minimaxHome>/agents/.builtin/<name>/agent.md`; a role the user
 * creates lives under `<minimaxHome>/agents/<name>/agent.md`.
 *
 * This plugin reads those files in place and registers one Harness agent preset
 * per role, so the same roles are selectable in the Harness without a copy.
 * A file MiniMax Code rewrites is re-read and re-registered; a role it adds is
 * published; a role it removes is withdrawn.
 *
 * The body of a MiniMax agent is a Handlebars template rendered against the
 * MiniMax Code runtime. The renderer here keeps the branch a coding agent
 * takes, drops the branches reserved for MiniMax Code's other surfaces, and
 * resolves the feature flags to the values a Harness session actually has.
 *
 * @module @local/dsh-minimax-bridge/agents
 */

/** The MiniMax Code surface whose prompt matches a Harness session. */
const DEFAULT_MODE = 'coding'

/** Frontmatter file of one agent definition. */
const AGENT_FILE = 'agent.md'

/** Coalesce a burst of filesystem events into one rescan. */
const WATCH_DEBOUNCE_MS = 300

/** Where the published roster is recorded beside this package. */
const STATUS_PATH = fileURLToPath(new URL('./agents-status.json', import.meta.url))

/**
 * The tool surface an agent gets when it declares none.
 *
 * It mirrors the MiniMax Code tool set a full agent runs with, mapped onto the
 * Harness names that mean the same thing.
 */
const DEFAULT_TOOLS = [
  'read',
  'read_image',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'todowrite',
  'web_fetch',
  'skill',
  'task_query',
  'task_output',
  'task_stop',
]

export const name = 'minimax-agent-bridge'

export const inject = ['agentPresets']

export const Config = z.object({
  /** MiniMax Code home; empty selects `$MINIMAX_HOME`, else `~/.minimax`. */
  minimaxHome: z.string().default(''),
  /** MiniMax Code surface whose prompt is published. */
  mode: z.string().default(DEFAULT_MODE),
  /** Publish the built-in roles under `<home>/agents/.builtin`. */
  includeBuiltin: z.boolean().default(true),
  /** Publish the roles the user created under `<home>/agents`. */
  includeUserAgents: z.boolean().default(true),
  /**
   * Prompt sections to leave out of the published persona. The Harness
   * assembles its own harness and tool guidance, so the MiniMax Code harness
   * section would only repeat it — and it names a `bash` tool this deployment
   * does not have. The media section describes `<media>` tags that only the
   * MiniMax Code client renders.
   */
  stripSections: z.array(z.string()).default(['Harness', 'Media Output']),
  /** Watch the agents directory and republish on a change. */
  watch: z.boolean().default(true),
  /** Maximum characters of one published persona. */
  maxPersonaChars: z.number().default(60000),
})

export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const published = new Map()

  /**
   * Publish every role the MiniMax home currently defines.
   * @returns the number of roles published.
   */
  const publish = async () => {
    const agents = await readAgents(settings)
    const wanted = new Set()
    const errors = []
    for (const agent of agents) {
      wanted.add(agent.id)
      const previous = published.get(agent.id)
      if (previous !== undefined && previous.fingerprint === agent.fingerprint) continue
      await withdraw(agent.id)
      const outcome = await registerPreset(ctx, agent, settings)
      if (outcome.error !== undefined) {
        errors.push({ id: agent.id, error: outcome.error })
        continue
      }
      published.set(agent.id, { disposer: outcome.disposer, fingerprint: agent.fingerprint })
      ctx.logger.info(`minimax-agent-bridge: published agent "${agent.id}" as an agent preset`)
    }
    for (const id of [...published.keys()]) {
      if (wanted.has(id)) continue
      await withdraw(id)
      ctx.logger.info(`minimax-agent-bridge: withdrew agent "${id}"`)
    }
    await record(ctx, agents, errors)
    return published.size
  }

  /**
   * Release one published preset.
   * @param id - preset identity to release.
   */
  const withdraw = async (id) => {
    const entry = published.get(id)
    if (entry === undefined) return
    published.delete(id)
    try {
      await entry.disposer()
    } catch (error) {
      ctx.logger.warn(`minimax-agent-bridge: could not withdraw "${id}": ${message(error)}`)
    }
  }

  ctx.effect(() => () => {
    for (const entry of published.values()) {
      void entry.disposer().catch(() => {})
    }
    published.clear()
  }, 'minimax-agent-bridge')

  const watcher = settings.watch
    ? openAgentsWatcher(settings.home, () => {
      void publish().catch(error => ctx.logger.warn(`minimax-agent-bridge: ${message(error)}`))
    }, ctx.logger)
    : undefined

  ctx.effect(() => () => {
    watcher?.close()
  }, 'minimax-agent-bridge watcher')

  void publish().catch(error => ctx.logger.warn(`minimax-agent-bridge: ${message(error)}`))
}

/**
 * Record the published roster where a person can read it.
 *
 * The registry's own roster is the truth about what a preset looks like after
 * it mounted, so the file carries that, not what this plugin believes it
 * published.
 *
 * @param ctx - the plugin context.
 * @param agents - the agent definitions this plugin read.
 */
async function record(ctx, agents, errors) {
  let roster = []
  let rosterError
  try {
    roster = await ctx.agentPresets.list()
  } catch (error) {
    rosterError = message(error)
    ctx.logger.warn(`minimax-agent-bridge: could not read the preset roster: ${rosterError}`)
  }
  const own = new Set(agents.map(agent => agent.id))
  let compositions = []
  try {
    compositions = await ctx.agentPresets.inspectCompositions()
  } catch (error) {
    ctx.logger.warn(`minimax-agent-bridge: could not inspect the presets: ${message(error)}`)
  }
  const mine = roster.filter(preset => own.has(preset.id))
  const toolSets = {}
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    for (const preset of mine) {
      try {
        const lease = await ctx.agentPresets.acquireScope(preset.id)
        try {
          toolSets[preset.id] = tools.schemas(lease.key).map(schema => schema.name).sort()
        } finally {
          await lease.dispose?.()
        }
      } catch (error) {
        toolSets[preset.id] = [`error: ${message(error)}`]
      }
    }
  }
  const report = {
    at: new Date().toISOString(),
    errors,
    rosterError,
    rosterSize: roster.length,
    agents: agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      source: agent.source,
      path: agent.path,
      model: agent.model,
      effort: agent.effort,
      tools: agent.tools,
    })),
    presets: mine.map(preset => {
      const inspection = compositions.find(entry => entry.id === preset.id)
      return {
        id: preset.id,
        name: preset.name,
        description: preset.description,
        broken: preset.broken,
        modules: inspection?.modules.map(module => module.moduleName) ?? [],
        leakedServices: inspection?.leakedServices ?? [],
        visibleTools: toolSets[preset.id] ?? [],
      }
    }),
  }
  try {
    await writeFile(STATUS_PATH, `${JSON.stringify(report, undefined, 2)}\n`)
  } catch (error) {
    ctx.logger.warn(`minimax-agent-bridge: could not write ${STATUS_PATH}: ${message(error)}`)
  }
}

/**
 * Read one configuration value, tolerating a value the config editor keeps
 * behind a getter.
 * @param config - the row's validated configuration.
 * @param field - field name to read.
 * @param fallback - value used when the field is absent.
 * @returns the resolved value.
 */
function read(config, field, fallback) {
  const value = config?.[field]
  if (value === undefined) return fallback
  const resolved = typeof value.get === 'function' ? value.get() : value
  return resolved === undefined ? fallback : resolved
}

/**
 * Turn a row configuration into the immutable settings this plugin works from.
 * @param config - the row's validated configuration.
 * @returns resolved settings with an absolute MiniMax home.
 */
function resolveSettings(config) {
  const configured = read(config, 'minimaxHome', '')
  const home = configured.length > 0
    ? expandHome(configured)
    : expandHome(process.env.MINIMAX_HOME ?? join(homedir(), '.minimax'))
  return {
    home,
    mode: read(config, 'mode', DEFAULT_MODE),
    includeBuiltin: read(config, 'includeBuiltin', true),
    includeUserAgents: read(config, 'includeUserAgents', true),
    stripSections: read(config, 'stripSections', ['Harness', 'Media Output']),
    watch: read(config, 'watch', true),
    maxPersonaChars: read(config, 'maxPersonaChars', 60000),
  }
}

/**
 * Expand a leading `~` in a configured path.
 * @param value - path that may start with `~`.
 * @returns an absolute path.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Read every agent definition the MiniMax home publishes.
 * @param settings - resolved plugin settings.
 * @returns one record per readable agent definition.
 */
async function readAgents(settings) {
  const agents = []
  const root = join(settings.home, 'agents')
  if (settings.includeUserAgents) {
    for (const directory of await childDirectories(root)) {
      const agent = await readAgent(directory, 'minimax')
      if (agent !== undefined) agents.push(agent)
    }
  }
  if (settings.includeBuiltin) {
    for (const directory of await childDirectories(join(root, '.builtin'))) {
      const agent = await readAgent(directory, 'minimax-builtin')
      if (agent !== undefined) agents.push(agent)
    }
  }
  return agents
}

/**
 * Read one agent definition directory.
 * @param directory - directory holding the definition file.
 * @param source - label of where the definition came from.
 * @returns the agent record, or `undefined` when the directory holds none.
 */
async function readAgent(directory, source) {
  const path = join(directory, AGENT_FILE)
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (!isAbsentPathError(error)) return undefined
    return undefined
  }
  const split = splitFrontmatter(raw)
  if (split === undefined) return undefined
  let data
  try {
    data = parseYaml(split.yaml)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const name = typeof data.name === 'string' ? data.name : undefined
  if (name === undefined || name.length === 0) return undefined
  const tools = Array.isArray(data.tools)
    ? data.tools.filter(tool => typeof tool === 'string')
    : []
  const toolsDeclared = Array.isArray(data.tools)
  const features = data.features !== null && typeof data.features === 'object' && !Array.isArray(data.features)
    ? data.features
    : {}
  const display = data['x-mavis'] !== null && typeof data['x-mavis'] === 'object' && !Array.isArray(data['x-mavis'])
    ? data['x-mavis']
    : {}
  const body = split.body
  return {
    id: `minimax-${name}`,
    name: typeof display.displayName === 'string' && display.displayName.length > 0
      ? display.displayName
      : name,
    description: typeof data.description === 'string' ? data.description : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    effort: typeof data.effort === 'string' ? data.effort : undefined,
    tools,
    toolsDeclared,
    delegation: features.delegation === true,
    source,
    path,
    body,
    fingerprint: createHash('sha256').update(raw).digest('hex'),
  }
}

/**
 * Register one agent as a Harness agent preset.
 * @param ctx - the plugin context.
 * @param agent - the agent record.
 * @param settings - resolved plugin settings.
 * @returns the definition disposer, or `undefined` when the preset failed.
 */
async function registerPreset(ctx, agent, settings) {
  const persona = buildPersona(agent, settings)
  if (persona === undefined) {
    ctx.logger.warn(`minimax-agent-bridge: "${agent.id}" has no publishable prompt text`)
    return { error: 'the agent has no publishable prompt text' }
  }
  const definition = {
    id: agent.id,
    name: agent.name,
    description: describe(agent),
    order: 100,
    plugins: buildPlugins(agent, persona),
  }
  try {
    return { disposer: await ctx.agentPresets.register(definition) }
  } catch (error) {
    ctx.logger.warn(`minimax-agent-bridge: "${agent.id}" failed to mount: ${message(error)}`)
    return { error: message(error) }
  }
}

/**
 * Describe one agent for the preset roster.
 * @param agent - the agent record.
 * @returns a one-line description.
 */
function describe(agent) {
  const parts = []
  if (agent.description !== undefined) parts.push(agent.description)
  if (agent.model !== undefined) parts.push(`model ${agent.model}`)
  if (agent.effort !== undefined) parts.push(`effort ${agent.effort}`)
  const suffix = parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : ''
  return `${parts[0] ?? `Agent imported from MiniMax Code (${agent.source}).`}${suffix}`
}

/**
 * Render one agent's prompt into the persona text of its preset.
 * @param agent - the agent record.
 * @param settings - resolved plugin settings.
 * @returns the persona text, or `undefined` when nothing remains.
 */
function buildPersona(agent, settings) {
  const rendered = renderTemplate(agent.body, settings.mode)
  const stripped = stripSections(rendered, settings.stripSections)
  const text = stripped.replace(/\n{3,}/g, '\n\n').trim()
  if (text.length === 0) return undefined
  if (text.length > settings.maxPersonaChars) {
    return `${text.slice(0, settings.maxPersonaChars)}\n\n[the rest of this agent's prompt was omitted]`
  }
  return text
}

/**
 * Build the plugin rows of one agent's preset.
 * @param agent - the agent record.
 * @param persona - the rendered persona text.
 * @returns the child entry list of the preset.
 */
function buildPlugins(agent, persona) {
  // An agent that declares no tool list is a full agent: MiniMax Code gives it
  // the whole surface, and its `features` say what else it may do.
  const tools = new Set(agent.toolsDeclared ? agent.tools : DEFAULT_TOOLS)
  const plugins = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: persona },
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    {
      id: 'time-context',
      name: '@deepseek-ai/dsh-time-context',
    },
  ]

  if (tools.has('read') || tools.has('read_image') || tools.has('write') || tools.has('edit')) {
    plugins.push({
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: {
        read: tools.has('read'),
        readImage: tools.has('read_image'),
        write: tools.has('write'),
        edit: tools.has('edit'),
        applyPatch: false,
      },
    })
  }
  if (tools.has('grep') || tools.has('glob')) {
    plugins.push({
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    })
  }
  if (tools.has('bash')) {
    plugins.push({
      id: 'tool-shell',
      name: process.platform === 'win32'
        ? '@deepseek-ai/dsh-tool-pwsh'
        : '@deepseek-ai/dsh-tool-bash',
    })
  }
  if (tools.has('todowrite')) {
    plugins.push({
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    })
  }
  if (tools.has('web_fetch') || tools.has('web_search')) {
    plugins.push({
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: {
        search: tools.has('web_search'),
        fetch: tools.has('web_fetch'),
      },
    })
  }
  if (tools.has('skill')) {
    plugins.push({
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
    })
    plugins.push({
      id: 'tool-skill',
      name: '@deepseek-ai/dsh-tool-skill',
    })
  }
  if (tools.has('task_query') || tools.has('task_output') || tools.has('task_stop')) {
    plugins.push({
      id: 'tool-subagent-control',
      name: '@deepseek-ai/dsh-tool-subagent-control',
    })
  }
  if (agent.delegation) {
    plugins.push({
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { provider: 'spawn', toolName: 'subagent' },
    })
  }
  plugins.push({
    id: 'tool-ask-user',
    name: '@deepseek-ai/dsh-tool-ask-user',
  })
  plugins.push({
    id: 'tool-present',
    name: '@deepseek-ai/dsh-tool-present',
  })
  plugins.push({
    id: 'tool-jobs',
    name: '@deepseek-ai/dsh-tool-jobs',
  })
  return plugins
}

/**
 * Render a MiniMax agent template for a Harness session.
 *
 * The renderer understands the Handlebars subset the agent files use: `if` and
 * `unless` blocks with an optional `else` branch, comments, and inline
 * expressions. An `if` keeps its first branch, an `unless` keeps its body only
 * when the condition is false, and an unknown condition is treated as true so
 * role instructions are not silently dropped.
 *
 * @param text - the template body.
 * @param mode - the MiniMax Code surface to render.
 * @returns the rendered text.
 */
export function renderTemplate(text, mode = DEFAULT_MODE) {
  const context = {
    mode,
    persona: { enabled: true },
    surface: { interactive: true, cli: false },
    memory: { enabled: true },
    skills: { mavis: true },
    ptc: { enabled: false },
  }
  const token = /\{\{\{[\s\S]*?\}\}\}|\{\{[\s\S]*?\}\}/g
  const stack = []
  let out = ''
  let last = 0
  let match
  while ((match = token.exec(text)) !== null) {
    const raw = match[0].slice(2, -2).trim()
    const visible = stack.every(frame => frame.keep)
    if (raw.startsWith('!')) {
      last = token.lastIndex
      continue
    }
    if (raw.startsWith('#')) {
      const parsed = /^#(\w+)\s*([\s\S]*)$/.exec(raw)
      const kind = parsed[1]
      const expression = parsed[2].trim()
      if (visible) out += text.slice(last, match.index)
      last = token.lastIndex
      stack.push({
        kind,
        expression,
        keep: visible && branchValue(kind, expression, context),
        start: out.length,
        parentVisible: visible,
      })
      continue
    }
    if (raw.startsWith('/')) {
      const frame = stack.pop()
      if (visible) out += text.slice(last, match.index)
      last = token.lastIndex
      continue
    }
    if (raw === 'else') {
      const frame = stack[stack.length - 1]
      if (frame !== undefined) {
        out = out.slice(0, frame.start)
        frame.keep = frame.parentVisible && alternativeValue(frame, context)
      }
      last = token.lastIndex
      continue
    }
    // An inline expression resolves against the MiniMax Code runtime, which
    // this renderer does not have; its text is left out.
    last = token.lastIndex
  }
  out += text.slice(last)
  return out
}

/**
 * Decide the value of a block's first branch.
 * @param kind - block kind.
 * @param expression - block condition.
 * @param context - render context.
 * @returns whether the branch is kept.
 */
function branchValue(kind, expression, context) {
  if (kind === 'if') return truthy(expression, context)
  if (kind === 'unless') return !truthy(expression, context)
  if (kind === 'each' || kind === 'with') return false
  return true
}

/**
 * Decide the value of a block's `else` branch.
 * @param frame - the open block.
 * @param context - render context.
 * @returns whether the alternative branch is kept.
 */
function alternativeValue(frame, context) {
  if (frame.kind === 'if') return !truthy(frame.expression, context)
  if (frame.kind === 'unless') return truthy(frame.expression, context)
  return false
}

/**
 * Evaluate one template condition against the render context.
 * @param expression - the condition text.
 * @param context - render context.
 * @returns whether the condition holds.
 */
function truthy(expression, context) {
  const text = expression.trim().replace(/^\((.*)\)$/s, '$1').trim()
  switch (text) {
    case 'mode.coding':
      return context.mode === 'coding'
    case 'mode.work':
    case 'mode.tui':
      return context.mode === text.slice('mode.'.length)
    case 'persona.enabled':
    case 'surface.interactive':
    case 'memory.enabled':
    case 'skills.mavis':
      return true
    case 'surface.cli':
      return false
    case '(lookup (lookup @root "ptc") "enabled")':
      return context.ptc.enabled
    default:
      return true
  }
}

/**
 * Remove named sections from a rendered prompt.
 *
 * A section runs from its heading to the next heading of the same or a higher
 * level, so removing a subsection leaves its siblings in place.
 *
 * @param text - the rendered prompt.
 * @param names - section headings to remove.
 * @returns the prompt without those sections.
 */
function stripSections(text, names) {
  if (names.length === 0) return text
  let result = text
  for (const name of names) {
    const heading = new RegExp(`^(#{1,6}) ${escapeRegExp(name)}\\b.*$`, 'm')
    const found = heading.exec(result)
    if (found === null) continue
    const level = found[1].length
    const start = found.index
    const rest = result.slice(start + found[0].length)
    const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest)
    const end = next === null ? result.length : start + found[0].length + next.index
    result = `${result.slice(0, start)}${result.slice(end)}`
  }
  return result
}

/**
 * Escape the characters of a string that carry meaning in a regular expression.
 * @param value - the string to escape.
 * @returns the escaped string.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split a document into its frontmatter block and body.
 * @param text - the raw file text.
 * @returns the YAML block and the body after the closing delimiter.
 */
function splitFrontmatter(text) {
  const raw = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return {
        yaml: raw.slice(firstLineEnd + 1, lineStart),
        body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * List the immediate subdirectories of a directory, skipping dot entries.
 * @param directory - directory to list.
 * @returns absolute subdirectory paths; empty when the directory is absent.
 */
async function childDirectories(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(directory, entry.name)
    try {
      const info = await stat(full)
      if (info.isDirectory()) found.push(full)
    } catch {
      // An entry that vanished while listing is simply skipped.
    }
  }
  return found.sort((left, right) => left.localeCompare(right))
}

/**
 * Watch the agents directory and report when a role may have changed.
 * @param home - the MiniMax Code home.
 * @param onChange - called after a relevant change settles.
 * @param logger - the plugin's logger.
 * @returns handle with `close()`.
 */
function openAgentsWatcher(home, onChange, logger) {
  const target = join(home, 'agents')
  let timer
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, WATCH_DEBOUNCE_MS)
    timer.unref?.()
  }
  let watcher
  try {
    watcher = watch(target, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename === null || filename === undefined) {
        schedule()
        return
      }
      if (String(filename).toLowerCase().endsWith(AGENT_FILE)) schedule()
    })
    watcher.on('error', (error) => {
      logger.warn(`minimax-agent-bridge: watching ${target} failed: ${message(error)}`)
    })
  } catch {
    // A home without an agents directory publishes nothing yet.
  }
  return {
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      try {
        watcher?.close()
      } catch {
        // A watcher that is already closed needs no further work.
      }
    },
  }
}

/**
 * Whether an error reports an absent path.
 * @param error - the caught value.
 * @returns whether the path does not exist.
 */
function isAbsentPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

/**
 * Render a thrown value.
 * @param error - the caught value.
 * @returns its message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
