import { watch } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'

/**
 * Serve the skills of a MiniMax Code home directory to this Harness.
 *
 * MiniMax Code keeps every skill it installs on disk under
 * `<minimaxHome>/skills`. Its plugins keep theirs under
 * `<minimaxHome>/plugins/<plugin>/skills`, and its custom agents under
 * `<minimaxHome>/agents/<agent>/skills`. This provider reads those directories
 * in place — nothing is copied — so an update MiniMax Code applies to a skill
 * file is what the next load returns, and a plugin or agent it installs while
 * this Harness runs is picked up by the next catalog build.
 *
 * The provider registers on `ctx.skills` in the global layer. A skill an agent
 * preset already provides keeps winning a duplicate name, because a preset's
 * layer outranks the global one; only names this Harness does not already have
 * are added.
 *
 * @module @local/dsh-minimax-bridge
 */

/** Instructions file of a directory-bundle skill. */
const SKILL_FILE = 'SKILL.md'

/** Public skill-name grammar, mirrored from the skill registry. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Home subdirectories whose changes can alter this provider's catalog. */
const WATCH_DIRS = ['skills', 'plugins', 'agents']

/** Coalesce a burst of filesystem events into one invalidation. */
const WATCH_DEBOUNCE_MS = 250

export const name = 'minimax-bridge'

export const inject = ['skills']

export const Config = z.object({
  /** MiniMax Code home; empty selects `$MINIMAX_HOME`, else `~/.minimax`. */
  minimaxHome: z.string().default(''),
  /** Provider name registered on the skill registry. */
  providerName: z.string().default('minimax'),
  /** Read `<home>/skills`, the skills MiniMax Code installs for the user. */
  includeUserSkills: z.boolean().default(true),
  /** Read `<home>/plugins/<plugin>/skills` for every installed plugin. */
  includePluginSkills: z.boolean().default(true),
  /** Read `<home>/agents/<agent>/skills` for every custom agent. */
  includeAgentSkills: z.boolean().default(true),
  /** Additional skill roots, read after the MiniMax ones. */
  extraSkillDirs: z.array(z.string()).default([]),
  /** Watch the roots and republish the catalog when they change. */
  watch: z.boolean().default(true),
  /**
   * Precedence inside the global layer. The value sits after project and custom
   * roots and before the user's own `~/.agents/skills` tree, so a user copy of a
   * skill still wins a name that MiniMax Code also ships.
   */
  rank: z.number().default(450),
})

export function apply(ctx, config) {
  const settings = resolveSettings(config)
  let provider
  ctx.skills.registerProvider((control) => {
    provider = new MinimaxSkillProvider(ctx, control, settings)
    ctx.logger.info(
      `minimax-bridge: serving skills from ${settings.home}`
        + `${settings.includePluginSkills ? ', its plugin skills' : ''}`
        + `${settings.includeAgentSkills ? ', its agent skills' : ''}`,
    )
    return provider
  })
  ctx.effect(() => () => {
    provider?.dispose()
  }, 'minimax-bridge')
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
 * Turn a row configuration into the immutable settings the provider works from.
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
    providerName: read(config, 'providerName', 'minimax'),
    includeUserSkills: read(config, 'includeUserSkills', true),
    includePluginSkills: read(config, 'includePluginSkills', true),
    includeAgentSkills: read(config, 'includeAgentSkills', true),
    extraSkillDirs: (read(config, 'extraSkillDirs', []) ?? []).map(expandHome),
    watch: read(config, 'watch', true),
    rank: read(config, 'rank', 450),
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

/** Skill provider that maps a MiniMax Code home into the skill registry. */
class MinimaxSkillProvider {
  constructor(ctx, control, settings) {
    this.ctx = ctx
    this.control = control
    this.settings = settings
    this.name = settings.providerName
    this.closed = false
    this.watcher = settings.watch
      ? openSkillWatcher(settings.home, () => {
        if (!this.closed) this.control.invalidate()
      }, ctx.logger)
      : undefined
    control.signal.addEventListener('abort', () => {
      this.dispose()
    }, { once: true })
  }

  /**
   * Enumerate the directories this provider reads. Every call re-reads the
   * MiniMax home, so a plugin or agent installed while the session runs becomes
   * a root for the next catalog build.
   * @returns roots in precedence order.
   */
  async roots() {
    const home = this.settings.home
    const roots = []
    if (this.settings.includeUserSkills) {
      roots.push({ path: join(home, 'skills'), source: 'minimax-user' })
    }
    if (this.settings.includePluginSkills) {
      for (const plugin of await childDirectories(join(home, 'plugins'))) {
        roots.push({ path: join(plugin, 'skills'), source: 'minimax-plugin' })
      }
    }
    if (this.settings.includeAgentSkills) {
      for (const agent of await childDirectories(join(home, 'agents'))) {
        roots.push({ path: join(agent, 'skills'), source: 'minimax-agent' })
      }
    }
    for (const directory of this.settings.extraSkillDirs) {
      roots.push({ path: directory, source: 'minimax-custom' })
    }
    return roots
  }

  /**
   * Describe every skill this provider can serve.
   * @param options - lookup options; `signal` cancels discovery.
   * @returns catalog candidates, or an incomplete observation when a root fails.
   */
  async list(options = {}) {
    const signal = options.signal
    const candidates = []
    let complete = true
    for (const root of await this.roots()) {
      throwIfAborted(signal)
      let entries
      try {
        entries = await readdir(root.path, { withFileTypes: true })
      } catch (error) {
        if (isAbsentPathError(error)) continue
        complete = false
        this.ctx.logger.warn(`minimax-bridge: skill root "${root.path}" skipped: ${message(error)}`)
        continue
      }
      for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
        throwIfAborted(signal)
        const locator = await locateSkill(root, entry)
        if (locator === undefined) continue
        let parsed
        try {
          parsed = await readSkill(locator.path)
        } catch (error) {
          this.ctx.logger.warn(`minimax-bridge: ${locator.path} skipped: ${message(error)}`)
          continue
        }
        if (!parsed.ok) {
          this.ctx.logger.warn(`minimax-bridge: ${locator.path} ignored: ${parsed.reason}`)
          continue
        }
        const skill = parsed.skill
        candidates.push({
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          invocation: skill.invocation,
          source: root.source,
          provider: this.name,
          rank: this.settings.rank,
          locator,
          resourceBase: { kind: 'directory', path: locator.directory },
          path: skill.path,
          ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
        })
      }
    }
    return complete ? candidates : { candidates, complete }
  }

  /**
   * Load one skill body, re-reading the file so a skill MiniMax Code updates
   * after discovery returns its current text.
   * @param candidate - this provider's candidate, carrying its locator.
   * @returns the full skill, or `undefined` when the file is gone.
   */
  async get(candidate) {
    const parsed = await readSkill(candidate.locator.path)
    if (!parsed.ok) {
      if (parsed.missing === true) return undefined
      this.ctx.logger.warn(`minimax-bridge: ${candidate.locator.path} ignored: ${parsed.reason}`)
      return undefined
    }
    const skill = parsed.skill
    return {
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
      invocation: skill.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: candidate.locator.directory },
      path: skill.path,
      ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
      content: skill.content,
    }
  }

  /** Release the host watcher. */
  dispose() {
    this.closed = true
    this.watcher?.close()
    this.watcher = undefined
  }
}

/**
 * Resolve the instructions file a root entry stands for.
 * @param root - the root being scanned.
 * @param entry - one direct child of that root.
 * @returns the locator, or `undefined` for an entry that is not a skill.
 */
async function locateSkill(root, entry) {
  if (entry.name.startsWith('.')) return undefined
  const full = join(root.path, entry.name)
  const kind = await entryKind(full, entry)
  if (kind === 'directory') return { path: join(full, SKILL_FILE), directory: full }
  if (kind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
    return { path: full, directory: root.path }
  }
  return undefined
}

/**
 * Classify a directory entry, following a symbolic link to the target it names.
 * @param full - absolute path of the entry.
 * @param entry - the directory entry.
 * @returns `directory`, `file`, or `undefined`.
 */
async function entryKind(full, entry) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return undefined
  try {
    const info = await stat(full)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
  } catch {
    return undefined
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
  } catch (error) {
    if (isAbsentPathError(error)) return []
    throw error
  }
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(directory, entry.name)
    if (await entryKind(full, entry) === 'directory') found.push(full)
  }
  return found.sort((left, right) => left.localeCompare(right))
}

/**
 * Read and parse one skill instructions file.
 * @param filePath - absolute path of the instructions file.
 * @returns a parsed skill, or the reason the file is not a usable skill.
 */
async function readSkill(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isAbsentPathError(error)) return { ok: false, missing: true, reason: 'the file is absent' }
    return { ok: false, reason: message(error) }
  }
  const split = splitFrontmatter(text)
  if (split === undefined) {
    return { ok: false, reason: 'the file must start with YAML frontmatter delimited by ---' }
  }
  let data
  try {
    data = parseYaml(split.yaml)
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${message(error)}` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'the frontmatter must be a mapping' }
  }
  const skillName = stringField(data, 'name')
  if (skillName === undefined || !SKILL_NAME.test(skillName)) {
    return { ok: false, reason: `frontmatter requires a kebab-case name, received "${skillName ?? ''}"` }
  }
  const description = stringField(data, 'description')
  if (description === undefined) {
    return { ok: false, reason: 'frontmatter requires a description' }
  }
  let invocation
  try {
    invocation = parseInvocation(data)
  } catch (error) {
    return { ok: false, reason: message(error) }
  }
  let resolved = filePath
  try {
    resolved = await realpath(filePath)
  } catch {
    // The file read above succeeded, so the unresolved path is still usable.
  }
  return {
    ok: true,
    skill: {
      name: skillName,
      description,
      ...stringField(data, 'whenToUse') === undefined
        ? {}
        : { whenToUse: stringField(data, 'whenToUse') },
      invocation,
      metadata: isMapping(data.metadata) ? data.metadata : undefined,
      path: resolved,
      content: split.body.trim(),
    },
  }
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
 * Resolve the invocation policy a skill's frontmatter declares.
 * @param data - parsed frontmatter.
 * @returns the policy; both surfaces are permitted by default.
 */
function parseInvocation(data) {
  const disableModelInvocation = booleanField(data, 'disable-model-invocation')
  const userInvocable = booleanField(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/**
 * Read a required non-empty string field.
 * @param data - parsed frontmatter.
 * @param field - field name.
 * @returns the value, or `undefined` when absent or empty.
 */
function stringField(data, field) {
  const value = data[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Read an optional boolean field using the documented boolean spellings.
 * @param data - parsed frontmatter.
 * @param field - field name.
 * @returns the boolean, or `undefined` when absent.
 */
function booleanField(data, field) {
  if (!Object.hasOwn(data, field)) return undefined
  const value = data[field]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
      default:
        break
    }
  }
  throw new TypeError(`frontmatter field "${field}" must be a boolean`)
}

/**
 * Whether a parsed YAML value is a mapping.
 * @param value - candidate value.
 * @returns whether it is a non-array object.
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Watch the MiniMax roots and report when the served catalog may have changed.
 * @param home - the MiniMax Code home.
 * @param onChange - called after a relevant change settles.
 * @param logger - the plugin's logger.
 * @returns handle with `close()`.
 */
function openSkillWatcher(home, onChange, logger) {
  const watchers = []
  let timer
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, WATCH_DEBOUNCE_MS)
    timer.unref?.()
  }
  for (const directory of WATCH_DIRS) {
    const target = join(home, directory)
    try {
      const watcher = watch(target, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined) {
          schedule()
          return
        }
        if (isRelevantChange(String(filename))) schedule()
      })
      watcher.on('error', (error) => {
        logger.warn(`minimax-bridge: watching ${target} failed: ${message(error)}`)
      })
      watchers.push(watcher)
    } catch {
      // A root that does not exist yet is discovered by the next catalog build.
    }
  }
  return {
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // A watcher that is already closed needs no further work.
        }
      }
      watchers.length = 0
    },
  }
}

/**
 * Decide whether a change under a watched root can alter the catalog.
 * @param relativePath - path reported by the watcher, relative to the root.
 * @returns whether the change is relevant.
 */
function isRelevantChange(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return true
  if (segments[0] === 'skills') return true
  if (segments[0] !== 'plugins' && segments[0] !== 'agents') return false
  if (segments.length <= 2) return true
  if (segments.includes('skills')) return true
  return segments[segments.length - 1].toLowerCase() === 'skill.md'
}

/**
 * Throw the caller's abort reason when the lookup was cancelled.
 * @param signal - the lookup's abort signal.
 */
function throwIfAborted(signal) {
  if (signal?.aborted !== true) return
  throw signal.reason instanceof Error ? signal.reason : new Error('skill lookup aborted')
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
