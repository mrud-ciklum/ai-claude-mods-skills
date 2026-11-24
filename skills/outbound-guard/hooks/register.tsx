import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import { CONFIG_FILE, LOG_FORMAT, NO_CONFIG, isGuarded, isListFinding, mayBeOutbound, parseConfig, place, plan, pushFindings, refusal, sentText, textFindings } from './guard'
import type { Config, Post, Push, Rules } from './guard'

const MOD_NAME = 'outbound-guard'
const isOn = atom({ plugin: 'outbound-guard', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'outbound-guard', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'outbound-guard', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'outbound-guard', key: 'switchedOff' } as const, [])

// A git call the guard makes to see what a push sends: never long, and never a hang that holds the command up for good.
const GIT_TIMEOUT_MS = 20_000

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// The user's list: names, guarded places, the logins a post may mention. No file means no
// names and no guarded places; keys, inline bodies, em dashes and mentions are checked all the same.
async function readConfig($: EngineInterface): Promise<Config> {
  const home = await $.env.get('HOME')
  if (!home) return NO_CONFIG
  const text = await $.fs.read(`${home}/${CONFIG_FILE}`).catch(() => undefined)
  if (text === undefined) return NO_CONFIG

  return parseConfig(typeof text === 'string' ? text : '')
}

const git = ($: EngineInterface, dir: string, args: readonly string[]): Promise<ProcessRunResult> =>
  $.process.run(['git', '-C', dir, ...args], { timeoutMs: GIT_TIMEOUT_MS })

async function remoteUrl($: EngineInterface, dir: string, name: string): Promise<string | undefined> {
  const r = await git($, dir, ['remote', 'get-url', '--push', name]).catch(() => undefined)

  return r?.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
}

// The remote a bare `git push` goes to: the branch's push remote, else origin.
async function pushRemote($: EngineInterface, dir: string): Promise<string> {
  const r = await git($, dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']).catch(() => undefined)
  const ref = r?.exitCode === 0 ? r.stdout.trim() : ''

  return ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : 'origin'
}

const guardedNote = (rules: Rules, target: string | undefined) =>
  rules.isGuarded ? [`(${target ?? 'An unknown repository'} counts as guarded by the list in ~/${CONFIG_FILE}.)`] : []

async function reviewPost($: EngineInterface, post: Post, config: Config): Promise<string[]> {
  const problems = [...post.problems]
  const target = post.target ?? (post.dir === undefined ? undefined : await remoteUrl($, post.dir, 'origin').then(url => (url === undefined ? undefined : place(url))))
  const rules: Rules = { config, isGuarded: isGuarded(target, config) }
  const found: string[] = []
  for (const item of post.texts) found.push(...textFindings(item, rules))
  for (const file of post.files) {
    const text = await $.fs
      .read(file.path)
      .then(v => (typeof v === 'string' ? v : undefined))
      .catch(() => undefined)
    if (text === undefined) problems.push(`${file.label} (${file.path}) cannot be read, so the guard cannot check it.`)
    else found.push(...textFindings({ label: file.label, text: sentText(text) }, rules))
  }

  return [...problems, ...found, ...(found.some(isListFinding) ? guardedNote(rules, target) : [])]
}

async function reviewPush($: EngineInterface, push: Push, config: Config): Promise<string[]> {
  if (push.dir === undefined) return ['the guard cannot tell which repository this push is from (a cd or -C to a path it cannot resolve): run it with a literal path.']
  const remoteName = push.isNew || (push.remote !== undefined && /[:/]/.test(push.remote)) ? undefined : (push.remote ?? (await pushRemote($, push.dir)))
  const url = push.isNew ? push.isNew.target : remoteName === undefined ? push.remote : await remoteUrl($, push.dir, remoteName)
  const target = url === undefined ? undefined : place(url)
  const rules: Rules = { config, isGuarded: isGuarded(target, config) }
  // The commits the remote does not have yet. A new repository, or a push to a bare URL, has nothing to subtract.
  const not = push.isNew ? [] : remoteName === undefined ? ['--not', '--remotes'] : ['--not', `--remotes=${remoteName}`]
  const listed = await git($, push.dir, ['log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', `--format=${LOG_FORMAT}`, ...push.revs, ...not]).catch((err: unknown) => errorText(err))
  const why = typeof listed === 'string' ? listed : listed.exitCode !== 0 ? (listed.stderr.trim().split('\n')[0] ?? `exit code ${listed.exitCode}`) : listed.isStdoutTruncated ? 'its changes are over 4 MiB' : undefined
  if (why !== undefined) {
    // A guarded place is not pushed to unchecked; elsewhere the push goes on and the user is told.
    if (rules.isGuarded) return [`the guard could not read what this push sends (${why}), and it goes to a guarded place: ${target ?? 'an unknown repository'}.`]
    try {
      $.ui.toast(`outbound-guard could not check this push: ${why}`)
    } catch {
      // a surface that shows no toasts loses only the notice
    }
    if (typeof listed === 'string' || listed.exitCode !== 0) return []
  }
  if (typeof listed === 'string') return []
  const found = pushFindings(listed.stdout, rules)

  return [...found, ...(found.some(isListFinding) ? guardedNote(rules, target) : [])]
}

export const register: Register = on => {
  // The Mods panel's switch: turned off there, the guard lets every command through.
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // Every Bash call passes here. One that sends nothing out (most) goes on after one regular
  // expression; a post or a push is read, and refused with the reasons when its text breaks a rule.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!mayBeOutbound(e.command) || !(await read($, isOn))) return next(e)
    const home = (await $.env.get('HOME').catch(() => undefined)) || undefined
    const cwd = await $.session.cwd().catch(() => undefined)
    const sends = plan(e.command, cwd, home)
    if (sends.length === 0) return next(e)
    const what = sends.map(s => s.what).join(', ')
    let config: Config
    try {
      config = await readConfig($)
    } catch (err) {
      return { deny: refusal(what, [`its list ~/${CONFIG_FILE} cannot be read (${errorText(err)}): ask the user to fix it.`]) }
    }
    const problems: string[] = []
    for (const send of sends) problems.push(...(send.kind === 'post' ? await reviewPost($, send, config) : await reviewPush($, send, config)))

    return problems.length === 0 ? next(e) : { deny: refusal(what, problems) }
  }).catch(($, e, next) =>
    // A guard that failed refuses only what may send something; any other command goes on.
    next.called ? next(e) : mayBeOutbound(String((e as { command?: unknown }).command ?? '')) ? { deny: 'outbound-guard failed while checking this command, so it was not run: it may send text out of this machine. Tell the user.' } : next(e),
  )
}

// ---- mods switch (shared block) ----
// The mods panel (mod 0) writes the names of the mods turned off to this file
// under HOME, and every session of every mod reads it; a mod not named there
// is on, and `quiet: true` asks the band's meters to show only what needs a
// look. This block is pasted unchanged into each mod of the family, which
// declares MOD_NAME and the atoms `isOn`, `isQuiet`, `switchedOff` and
// `switchSeenAt` (the last two keep the file's time and its whole off list): the
// engine follows $ only into functions of the same file, and state only
// through its own atoms.
const SWITCHES_FILE = '.claude/mods/state.json'
// How soon a switch flipped in any session reaches this one.
const SWITCH_POLL_MS = 1_500

// Reads the switch now, then keeps polling it.
async function watchSwitch($: EngineInterface): Promise<boolean> {
  const isNowOn = await refreshSwitch($)
  $.clock.every(SWITCH_POLL_MS, () => {
    void refreshSwitch($)
  })

  return isNowOn
}

// Reads the file only once its modification time moved; a file caught
// half-written fails to parse and is read again at the next poll.
async function refreshSwitch($: EngineInterface): Promise<boolean> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') {
      return await read($, isOn)
    }
    const path = `${home.replace(/\/$/, '')}/${SWITCHES_FILE}`
    let isNowOn = true
    let isNowQuiet = false
    if (await $.fs.exists(path)) {
      const { mtimeMs } = await $.fs.stat(path)
      if (mtimeMs === (await read($, switchSeenAt))) {
        return await read($, isOn)
      }
      const data: unknown = JSON.parse(await $.fs.read(path))
      await update($, switchSeenAt, () => mtimeMs)
      const record = typeof data === 'object' && data !== null ? (data as { off?: unknown; quiet?: unknown }) : {}
      const off = Array.isArray(record.off) ? record.off.filter((name): name is string => typeof name === 'string') : []
      isNowOn = !off.includes(MOD_NAME)
      isNowQuiet = record.quiet === true
      await update($, switchedOff, () => off)
    }
    if (isNowQuiet !== (await read($, isQuiet))) {
      await update($, isQuiet, () => isNowQuiet)
    }
    if (isNowOn !== (await read($, isOn))) {
      await update($, isOn, () => isNowOn)
    }

    return isNowOn
  } catch (error) {
    $.ui.log(`${MOD_NAME}: could not read the mods switches: ${error instanceof Error ? error.message : String(error)}`, {
      to: 'debug',
    })

    return read($, isOn)
  }
}
// ---- end of mods switch ----
