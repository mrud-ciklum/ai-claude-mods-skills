import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, ThemeKey } from 'claude-code'

import type { ModEntry, ModSetting, Switches } from '../types'

// This mod's own plugin name: the panel lists it first and never switches it off.
const SELF = 'mods'
// The band whose toolbar carries the Mods button; while it is on, this mod draws no button of its own.
const BAND = 'context-band'
const PANE_ID = 'mods'
const PANE_TITLE = 'Mods'
// How wide the docked panel asks to be, in cells; a width the person dragged wins.
const PANE_COLUMNS = 46
// Under HOME: where mods are installed, and the switches every session shares.
const SKILLS_DIR = '.claude/skills'
const SWITCHES_FILE = '.claude/mods/state.json'
// A mod folder that carries this card is one the panel lists.
const CARD_FILE = 'mod.json'
// How often a session picks up switches another session flipped, and,
// while the panel is open, looks for mods installed since.
const POLL_MS = 1_500
const RESCAN_MS = 5_000
// Mods 1 to 9 switch with their digit while the panel holds the keys.
const LAST_HOTKEY = 9
// A card without an order sorts after every numbered mod.
const UNORDERED = 99

const DEFAULT_SWITCHES: Switches = {
  off: [],
  isPaneWanted: true,
  quiet: false,
  settings: { sounds: true, voice: false },
  modSettings: {},
  updatedAt: 0,
}
// What a `models` setting offers where the /config menu lists no model choices.
const FALLBACK_MODELS = ['sonnet', 'opus', 'haiku']
// Full model ids offered after the aliases, to pin one version: an alias always
// means the newest of its family, and the engine tells a mod neither which
// version that is nor which ids exist. Kept by hand from the alias table of
// Claude Code 2.1.326; add a new model's id here when one comes out.
const PINNED_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']
// The family aliases, labelled as the newest of their family in a select.
const FAMILY_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable'])

const mods = atom({ plugin: 'mods', key: 'mods' } as const, [])
const switches = atom({ plugin: 'mods', key: 'switches' } as const, DEFAULT_SWITCHES)
// The switches file's modification time when last read: a poll reads the file only once it changed.
const switchesSeenAt = atom({ plugin: 'mods', key: 'switchesSeenAt' } as const, -1)
const isPaneOpen = atom({ plugin: 'mods', key: 'isPaneOpen' } as const, false)
// Open and drawn: while the person can see the panel, the band carries no button for it.
const isPaneShown = atom({ plugin: 'mods', key: 'isPaneShown' } as const, false)
// Where the surface places no pane (an older desktop), the list opens in the band instead.
const isSectionOpen = atom({ plugin: 'mods', key: 'isSectionOpen' } as const, false)
// The models a `models` setting offers, read from the /config menu when the mods are scanned.
const models = atom({ plugin: 'mods', key: 'models' } as const, [...FALLBACK_MODELS, ...PINNED_MODELS])
// Today's model calls by mod, from the file cost-meter keeps: shown under each mod's row.
const sideModels = atom({ plugin: 'mods', key: 'sideModels' } as const, {} as Record<string, { calls: number; tokens: number }>)
const SIDE_MODELS_FILE = '.claude/mods/side-models.json'

// Today's counts from cost-meter's file; nothing when the file or today is not there.
async function loadSideModels($: EngineInterface): Promise<void> {
  const path = await homePath($, SIDE_MODELS_FILE)
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const data = await readJson($, path)
  const today = data?.[day]
  const out: Record<string, { calls: number; tokens: number }> = {}
  if (typeof today === 'object' && today !== null) {
    for (const [mod, tally] of Object.entries(today as Record<string, Record<string, unknown>>)) {
      const n = (key: string) => (typeof tally[key] === 'number' ? (tally[key] as number) : 0)
      out[mod] = { calls: n('calls'), tokens: n('input') + n('output') }
    }
  }
  if (JSON.stringify(out) !== JSON.stringify(await read($, sideModels))) await update($, sideModels, () => out)
}

const shortTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await loadSwitches($)
    await rescan($)
    await $.command.register({
      name: 'mods',
      description: 'Mods panel: turn each mod on or off',
      argumentHint: '[on|off <number or name> | all on|off]',
    })
    $.clock.every(POLL_MS, () => {
      void loadSwitches($)
      void followPane($)
    })
    $.clock.every(RESCAN_MS, () => {
      void rescanWhileOpen($)
    })
    if ((await read($, switches)).isPaneWanted) {
      // Opened unasked: a narrow terminal keeps it undrawn until it widens or the person opens it.
      await openPane($, false)
    }

    return started
  })

  // `/mods` opens the panel; `/mods off 2`, `/mods on 2`, `/mods all off` switch from the prompt.
  on('command.run', { command: 'mods' }, async ($, e) => {
    await loadSwitches($)
    await rescan($)
    if (e.args.trim() !== '') {
      return { text: await runArgs($, e.args.trim()) }
    }
    await showMods($)

    return (await read($, isPaneShown)) || (await read($, isSectionOpen)) ? {} : { text: listing(await read($, mods), await read($, switches)) }
  }).catch(() => ({ text: 'The mods panel did not open; details are in the debug log.' }))

  // The band (context-band) draws the Mods button in its toolbar; its press opens
  // the list here, and the band's own sections close the list in the band.
  on('ui.press', { plugin: BAND }, async ($, e, next) => {
    const pressed = await next(e)
    if (e.element === 'mods') {
      await showMods($)
    } else if (e.element === 'details' || e.element === 'runners') {
      await update($, isSectionOpen, () => false)
    }

    return pressed
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    await update($, isPaneShown, () => false)
    if (e.origin.kind === 'person') {
      await wantPane($, false)
    }

    return closed
  }).catch(($, e, next) => next(e))

  // The list in the band, when it is open there, under the other mods' rows;
  // and while the band is off, a button of this mod's own to reach the list.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inner = await next(e)
    if (e.props.hasSurvey) {
      return inner
    }
    const list = await read($, mods)
    const current = await read($, switches)
    const isBandOn = list.some(mod => mod.name === BAND) && isOn(current, BAND)
    const isOpenHere = await read($, isSectionOpen)
    const needsButton = !isBandOn && !(await read($, isPaneShown))
    if (!isOpenHere && !needsButton) {
      return inner
    }
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const columns = e.props.bodyColumns
    const switchable = list.filter(mod => mod.name !== SELF)
    const onCount = switchable.filter(mod => isOn(current, mod.name)).length

    // No digit hotkeys here: a bare digit in an empty prompt presses a band button.
    const modRow = (mod: ModEntry) => {
      const isSelf = mod.name === SELF
      const isModOn = isSelf || isOn(current, mod.name)

      return (
        <Box justifyContent="space-between" columnGap={2}>
          {gridRow(
            ui,
            {
              name: isModOn ? '● on' : '○ off',
              nameColor: isModOn ? 'success' : 'inactive',
              figure: String(mod.order),
              lines: [{ text: mod.title, isBold: isModOn }, ...(mod.summary === '' ? [] : [{ text: mod.summary, isDim: true }])],
            },
            columns,
          )}
          {isSelf ? (
            <Text dimColor>always</Text>
          ) : (
            <Button
              key={`switch:${mod.name}`}
              label={isModOn ? 'Turn off' : 'Turn on'}
              dimColor={isModOn}
              onPress={() => setMod($, mod.name, !isModOn)}
            />
          )}
        </Box>
      )
    }

    const withButton = needsButton ? (
      <Box flexDirection="row" gap={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {inner}
        </Box>
        <Button key="mods" label={PANE_TITLE} dimColor={!isOpenHere} onPress={() => showMods($)} />
      </Box>
    ) : (
      inner
    )
    if (!isOpenHere) {
      return withButton
    }
    const section = (
      <Box key={pieceKey('section', 0, SELF)} flexDirection="column">
        {(
          <Box justifyContent="space-between" flexWrap="wrap" columnGap={2}>
            {gridRow(
              ui,
              {
                name: PANE_TITLE,
                isHeader: true,
                figure: '',
                lines: [{ text: `${onCount} of ${switchable.length} on · applies to every session`, isDim: true }],
              },
              columns,
            )}
            <Box gap={1} flexShrink={0}>
              <Button key="all-on" label="All on" dimColor={onCount === switchable.length} onPress={() => setAll($, true)} />
              <Button key="all-off" label="All off" dimColor={onCount === 0} onPress={() => setAll($, false)} />
              <Button
                key="quiet"
                label={current.quiet ? 'Quiet mode: on' : 'Quiet mode: off'}
                dimColor={!current.quiet}
                onPress={() => setQuiet($, !current.quiet)}
              />
            </Box>
          </Box>
        )}
        {sections(list).flatMap(part => [
          ...(part.group === null ? [] : [<Text bold dimColor>{part.group}</Text>]),
          ...part.mods.map(modRow),
        ])}
      </Box>
    )

    return placeInBand(ui, withButton, SECTIONS_SLOT, section, e.props.bodyColumns)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, mods)
    const current = await read($, switches)
    // Sounds and the voice, picked from the surface's own select where it draws one.
    const settingsRow = (surface: typeof e.surface) => {
      if (surface === 'mobile') {
        return null
      }
      const { Select } = $.ui.resolve(e as typeof e & { surface: 'terminal' | 'desktop' | 'vscode' })
      const pick = (name: keyof Switches['settings'], label: string) => (
        <Select
          key={`setting:${name}`}
          label={label}
          value={current.settings[name] ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'on' },
            { value: 'off', label: 'off' },
          ]}
          onSelect={value => {
            void setSetting($, name, value === 'on')
          }}
        />
      )

      return (
        <Box gap={2} flexWrap="wrap">
          {pick('sounds', 'Sounds')}
          {pick('voice', 'Voice')}
        </Box>
      )
    }
    const switchable = list.filter(mod => mod.name !== SELF)
    const onCount = switchable.filter(mod => isOn(current, mod.name)).length
    const allOn = onCount === switchable.length
    const modelChoices = await read($, models)
    const spent = await read($, sideModels)

    // A mod's own choices, its card's settings, under its row where the surface draws a select.
    const modSettingsRow = (mod: ModEntry) => {
      const settings = mod.settings ?? []
      if (settings.length === 0 || e.surface === 'mobile') {
        return null
      }
      const { Select } = $.ui.resolve(e as typeof e & { surface: 'terminal' | 'desktop' | 'vscode' })
      const picked = current.modSettings?.[mod.name] ?? {}

      return (
        <Box marginLeft={5} gap={2} flexWrap="wrap">
          {settings.map(setting => {
            const value = picked[setting.key] ?? setting.default
            const listed = setting.options === 'models' ? modelChoices : setting.options
            // A value no longer offered (a model gone from the menu) still shows as picked.
            const options = listed.includes(value) ? listed : [value, ...listed]

            return (
              <Select
                key={`mod-setting:${mod.name}:${setting.key}`}
                label={setting.label}
                value={value}
                options={options.map(option => ({
                  value: option,
                  // An alias moves to each new version; a full id stays put.
                  label: setting.options === 'models' && FAMILY_ALIASES.has(option) ? `${option} (latest)` : option,
                }))}
                onSelect={chosen => {
                  void setModSetting($, mod.name, setting.key, chosen)
                }}
              />
            )
          })}
        </Box>
      )
    }

    const modRow = (mod: ModEntry) => {
      const isSelf = mod.name === SELF
      const isModOn = isSelf || isOn(current, mod.name)
      const digit = mod.order >= 1 && mod.order <= LAST_HOTKEY ? { hotkey: String(mod.order) } : {}

      return (
        <Box flexDirection="column">
          <Box gap={1} justifyContent="space-between">
            <Box gap={1}>
              <Text dimColor>{String(mod.order).padStart(2, ' ')}</Text>
              <Text color={isModOn ? 'success' : 'inactive'}>{isModOn ? '●' : '○'}</Text>
              <Text bold={isModOn} dimColor={!isModOn}>
                {mod.title}
              </Text>
            </Box>
            {isSelf ? (
              <Text dimColor>always</Text>
            ) : (
              <Button
                key={`switch:${mod.name}`}
                label={isModOn ? 'Turn off' : 'Turn on'}
                dimColor={isModOn}
                {...digit}
                onPress={() => setMod($, mod.name, !isModOn)}
              />
            )}
          </Box>
          {mod.summary !== '' && (
            <Box marginLeft={5}>
              <Text dimColor>{mod.summary}</Text>
            </Box>
          )}
          {spent[mod.name] ? (
            <Box marginLeft={5}>
              <Text dimColor>{`Today: ${shortTokens(spent[mod.name]?.tokens ?? 0)} tokens in ${spent[mod.name]?.calls ?? 0} model ${spent[mod.name]?.calls === 1 ? 'call' : 'calls'}`}</Text>
            </Box>
          ) : null}
          {modSettingsRow(mod)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{PANE_TITLE}</Text>
          <Text dimColor>{`${onCount} of ${switchable.length} on · applies to every session`}</Text>
        </Box>
        <Box gap={1} flexWrap="wrap">
          <Button key="all-on" label="All on" dimColor={allOn} onPress={() => setAll($, true)} />
          <Button key="all-off" label="All off" dimColor={onCount === 0} onPress={() => setAll($, false)} />
          <Button
            key="quiet"
            label={current.quiet ? 'Quiet mode: on' : 'Quiet mode: off'}
            dimColor={!current.quiet}
            onPress={() => setQuiet($, !current.quiet)}
          />
        </Box>
        {settingsRow(e.surface)}
        {sections(list).map(section => (
          <Box flexDirection="column">
            {section.group === null ? null : (
              <Box gap={1}>
                <Text bold dimColor>
                  {section.group}
                </Text>
                <Text dimColor>{`${section.mods.filter(mod => isOn(current, mod.name)).length} of ${section.mods.length} on`}</Text>
              </Box>
            )}
            {section.mods.map(modRow)}
          </Box>
        ))}
        {switchable.length === 0 && <Text dimColor>No other mods yet.</Text>}
      </Box>
    )
  })
}

// Opens the panel. Returns null once the surface drew it, else why it waits.
async function openPane($: EngineInterface, isAsked: boolean): Promise<string | null> {
  await rescan($)
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })
  await update($, isPaneOpen, () => true)
  await update($, isPaneShown, () => opened.isPlaced)
  if (isAsked) {
    await wantPane($, true)
  }

  return opened.isPlaced ? null : `The mods panel waits: ${opened.reason}`
}

// The person asked for the list: close it where it is open, else open it in the
// pane, and where the surface places no pane, in the band.
async function showMods($: EngineInterface): Promise<void> {
  if (await read($, isSectionOpen)) {
    await update($, isSectionOpen, () => false)

    return
  }
  if (await read($, isPaneShown)) {
    await $.ui.close({ id: PANE_ID })
    await update($, isPaneOpen, () => false)
    await update($, isPaneShown, () => false)
    await wantPane($, false)

    return
  }
  const waiting = await openPane($, true)
  if (waiting !== null) {
    // A pane the surface will not place is closed rather than left waiting.
    await $.ui.close({ id: PANE_ID })
    await update($, isPaneOpen, () => false)
    await update($, isSectionOpen, () => true)
  }
}

// The person closes the panel from its frame; a terminal that widens draws one that waited.
async function followPane($: EngineInterface): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(open => open.id === PANE_ID)
    const isOpen = pane !== undefined
    const isShown = pane?.isPlaced === true
    if (isOpen !== (await read($, isPaneOpen))) {
      await update($, isPaneOpen, () => isOpen)
    }
    if (isShown !== (await read($, isPaneShown))) {
      await update($, isPaneShown, () => isShown)
    }
  } catch (error) {
    $.ui.log(`mods: could not list the panes: ${messageOf(error)}`, { to: 'debug' })
  }
}

// New sessions open the panel the way the person last left it.
async function wantPane($: EngineInterface, isWanted: boolean): Promise<void> {
  const current = await readSwitchesFile($)
  if (current.isPaneWanted !== isWanted) {
    await writeSwitches($, { ...current, isPaneWanted: isWanted })
  }
}

async function setMod($: EngineInterface, name: string, isWanted: boolean): Promise<void> {
  const current = await readSwitchesFile($)
  const off = current.off.filter(other => other !== name)
  await writeSwitches($, { ...current, off: isWanted ? off : [...off, name] })
}

function settingsIn(value: unknown): Switches['settings'] {
  const record = typeof value === 'object' && value !== null ? (value as { sounds?: unknown; voice?: unknown }) : {}

  return { sounds: record.sounds !== false, voice: record.voice === true }
}

async function setSetting($: EngineInterface, name: keyof Switches['settings'], isWanted: boolean): Promise<void> {
  const current = await readSwitchesFile($)
  await writeSwitches($, { ...current, settings: { ...current.settings, [name]: isWanted } })
}

// Keeps one mod's choice in the shared file, where that mod reads it.
async function setModSetting($: EngineInterface, mod: string, key: string, value: string): Promise<void> {
  const current = await readSwitchesFile($)
  const all = current.modSettings ?? {}
  await writeSwitches($, { ...current, modSettings: { ...all, [mod]: { ...(all[mod] ?? {}), [key]: value } } })
}

async function setQuiet($: EngineInterface, isQuietWanted: boolean): Promise<void> {
  const current = await readSwitchesFile($)
  await writeSwitches($, { ...current, quiet: isQuietWanted })
}

async function setAll($: EngineInterface, isWanted: boolean): Promise<void> {
  const current = await readSwitchesFile($)
  const names = (await read($, mods)).map(mod => mod.name).filter(name => name !== SELF)
  await writeSwitches($, { ...current, off: isWanted ? [] : names })
}

async function runArgs($: EngineInterface, args: string): Promise<string> {
  const words = args.toLowerCase().split(/\s+/)
  const list = await read($, mods)
  const [verb, ...rest] = words
  const target = rest.join(' ')
  if (verb === 'all' && (target === 'on' || target === 'off')) {
    await setAll($, target === 'on')
  } else if (verb === 'quiet' && (target === 'on' || target === 'off')) {
    await setQuiet($, target === 'on')
  } else if ((verb === 'sounds' || verb === 'voice') && (target === 'on' || target === 'off')) {
    await setSetting($, verb, target === 'on')
  } else if ((verb === 'on' || verb === 'off') && target !== '') {
    const mod = list.find(
      candidate =>
        String(candidate.order) === target ||
        candidate.name.toLowerCase() === target ||
        candidate.title.toLowerCase() === target,
    )
    if (mod === undefined || mod.name === SELF) {
      return `No mod to switch by that name or number: ${target}\n\n${listing(list, await read($, switches))}`
    }
    await setMod($, mod.name, verb === 'on')
  } else {
    return `Did not understand "${args}". Examples: /mods off 2, /mods on 2, /mods all off, /mods quiet on.\n\n${listing(list, await read($, switches))}`
  }

  return listing(list, await read($, switches))
}

function listing(list: readonly ModEntry[], current: Switches): string {
  const rows = list.map(mod => {
    const isModOn = mod.name === SELF || isOn(current, mod.name)

    return `${mod.order} ${isModOn ? '●' : '○'} ${mod.title}${mod.name === SELF ? ' - always' : ''}`
  })

  const notes = [
    current.quiet ? 'Quiet mode on' : '',
    current.settings.sounds ? '' : 'Sounds off',
    current.settings.voice ? 'Voice news on' : '',
  ].filter(Boolean)

  return [...rows, ...notes].join('\n')
}

function isOn(current: Switches, name: string): boolean {
  return !current.off.includes(name)
}

// The poll: reads the shared file only when its modification time moved.
async function loadSwitches($: EngineInterface): Promise<void> {
  try {
    const path = await homePath($, SWITCHES_FILE)
    if (!(await $.fs.exists(path))) {
      return
    }
    const { mtimeMs } = await $.fs.stat(path)
    if (mtimeMs === (await read($, switchesSeenAt))) {
      return
    }
    const parsed = parseSwitches(await $.fs.read(path))
    await update($, switchesSeenAt, () => mtimeMs)
    // A file caught half-written is read again when the writer's next change moves the time.
    if (parsed !== null) {
      await update($, switches, () => parsed)
    }
  } catch (error) {
    $.ui.log(`mods: could not read the switches: ${messageOf(error)}`, { to: 'debug' })
  }
}

// What the file says now, so a change made here keeps what another session changed.
async function readSwitchesFile($: EngineInterface): Promise<Switches> {
  try {
    const path = await homePath($, SWITCHES_FILE)
    if (await $.fs.exists(path)) {
      const parsed = parseSwitches(await $.fs.read(path))
      if (parsed !== null) {
        return parsed
      }
    }
  } catch (error) {
    $.ui.log(`mods: could not read the switches: ${messageOf(error)}`, { to: 'debug' })
  }

  return read($, switches)
}

async function writeSwitches($: EngineInterface, wanted: Switches): Promise<void> {
  const written: Switches = {
    off: [...new Set(wanted.off)].sort(),
    isPaneWanted: wanted.isPaneWanted,
    quiet: wanted.quiet,
    settings: wanted.settings,
    modSettings: wanted.modSettings ?? {},
    updatedAt: await $.clock.now(),
  }
  const path = await homePath($, SWITCHES_FILE)
  await $.fs.write(path, `${JSON.stringify(written, null, 2)}\n`)
  await update($, switches, () => written)
  // The poll would read this write back; it is already in hand.
  const { mtimeMs } = await $.fs.stat(path)
  await update($, switchesSeenAt, () => mtimeMs)
}

function parseSwitches(text: string): Switches | null {
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return null
    }
    const record = data as Record<string, unknown>
    const off = Array.isArray(record.off) ? record.off.filter((name): name is string => typeof name === 'string') : []

    return {
      off,
      isPaneWanted: record.isPaneWanted !== false,
      quiet: record.quiet === true,
      settings: settingsIn(record.settings),
      modSettings: modSettingsIn(record.modSettings),
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    }
  } catch {
    return null
  }
}

// Each mod's picked choices: string values only, by mod, then by key.
function modSettingsIn(value: unknown): Record<string, Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, Record<string, string>> = {}
  for (const [mod, picks] of Object.entries(value)) {
    if (typeof picks !== 'object' || picks === null || Array.isArray(picks)) {
      continue
    }
    const kept = Object.entries(picks).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    if (kept.length > 0) {
      out[mod] = Object.fromEntries(kept)
    }
  }

  return out
}

// The choices a card offers: each with a key, a label, its options (a list, or
// `models`) and a default; an entry missing one is left out.
function settingsOf(value: unknown): ModSetting[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item: unknown): ModSetting[] => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const record = item as Record<string, unknown>
    const key = textOf(record.key)
    const fallback = textOf(record.default)
    const options =
      record.options === 'models'
        ? ('models' as const)
        : Array.isArray(record.options)
          ? record.options.filter((option): option is string => typeof option === 'string' && option !== '')
          : []
    if (key === null || fallback === null || options.length === 0) {
      return []
    }

    return [{ key, label: textOf(record.label) ?? key, options, default: fallback }]
  })
}

// The models the /config menu offers for a judge or a helper: its model row's
// choices, less `default`, the plan-mode pairing and the 1M-context variants;
// then the pinned full ids it does not list already.
async function loadModels($: EngineInterface): Promise<void> {
  const rows = await $.config.list().catch(() => [])
  const listed = (rows.find(row => row.key === 'model')?.options ?? []).filter(
    option => option !== 'default' && option !== 'opusplan' && !option.includes('['),
  )
  const aliases = listed.length > 0 ? listed : FALLBACK_MODELS
  const found = [...aliases, ...PINNED_MODELS.filter(id => !aliases.includes(id))]
  if (JSON.stringify(found) !== JSON.stringify(await read($, models))) {
    await update($, models, () => found)
  }
}

async function rescanWhileOpen($: EngineInterface): Promise<void> {
  if (await read($, isPaneOpen)) {
    await rescan($)
  }
}

// The panel's sections, in this order: the group a mod's card names. This panel itself comes
// first with no heading; a mod whose card names no group, or one not listed here, comes last.
// With no card naming a group, the list is one section with no headings.
const GROUPS = ['Readings', 'Conversation', 'Checks', 'Guards']
const OTHER_GROUP = 'Other'

function sections(list: readonly ModEntry[]): { group: string | null; mods: ModEntry[] }[] {
  const self = list.filter(mod => mod.name === SELF)
  const rest = list.filter(mod => mod.name !== SELF)
  if (!rest.some(mod => mod.group !== undefined)) {
    return [{ group: null, mods: [...self, ...rest] }]
  }
  const groupOf = (mod: ModEntry) => (mod.group !== undefined && GROUPS.includes(mod.group) ? mod.group : OTHER_GROUP)
  const named = [...GROUPS, OTHER_GROUP].map(group => ({ group, mods: rest.filter(mod => groupOf(mod) === group) })).filter(section => section.mods.length > 0)

  return [...(self.length > 0 ? [{ group: null, mods: self }] : []), ...named]
}

// Every folder under ~/.claude/skills that carries a mod.json card, in the cards' order.
async function rescan($: EngineInterface): Promise<void> {
  try {
    const dir = await homePath($, SKILLS_DIR)
    if (!(await $.fs.exists(dir))) {
      return
    }
    const found: ModEntry[] = []
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'dir' && !entry.isLink) {
        continue
      }
      const root = `${dir}/${entry.name}`
      const card = await readJson($, `${root}/${CARD_FILE}`)
      if (card === null) {
        continue
      }
      const manifest = await readJson($, `${root}/.claude-plugin/plugin.json`)
      const name = textOf(manifest?.name) ?? entry.name
      if (found.some(known => known.name === name)) {
        continue
      }
      found.push({
        name,
        order: typeof card.order === 'number' && Number.isFinite(card.order) ? card.order : UNORDERED,
        title: textOf(card.title) ?? name,
        summary: textOf(card.summary) ?? '',
        ...(typeof card.group === 'string' && card.group.trim() !== '' ? { group: card.group.trim() } : {}),
        settings: settingsOf(card.settings),
      })
    }
    found.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    if (found.some(mod => (mod.settings ?? []).some(setting => setting.options === 'models'))) {
      await loadModels($)
    }
    await loadSideModels($).catch(() => undefined)
    const before = await read($, mods)
    if (JSON.stringify(before) !== JSON.stringify(found)) {
      await update($, mods, () => found)
    }
  } catch (error) {
    $.ui.log(`mods: could not list the installed mods: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | null> {
  if (!(await $.fs.exists(path))) {
    return null
  }
  try {
    const data: unknown = JSON.parse(await $.fs.read(path))

    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

async function homePath($: EngineInterface, relative: string): Promise<string> {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') {
    throw new Error('HOME is not set')
  }

  return `${home.replace(/\/$/, '')}/${relative}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- band layout (shared block) ----
// The engine runs the family's band hooks in an order no mod controls, so the
// band (context-band) draws three keyed slots in its middle wherever it stands:
// CHIPS_SLOT, the one line of readings, each a chip keyed `chip:NN:<mod>`;
// METERS_SLOT under it, for pieces keyed `meter:NN:<mod>` (a reading's card,
// shown while the pointer is on its chip, waits hidden there: placeReadings puts
// both); and SECTIONS_SLOT above the task row, for pieces keyed
// `section:NN:<mod>`. NN is the mod's order, and a slot keeps its pieces in key
// order. A mod that finds the band in what lies beneath it puts its piece into
// the slot; one that does not stacks the piece around it, and the band, when it
// stands outside, moves the stacked pieces into its slots.
// When the person set the band's height, the slots sit in a middle keyed
// `FIT_PREFIX<rows>` that keeps to at most that many rows: a piece put in refits
// it, what runs past the end leaves from the bottom, and a note keyed
// `NOTE_PREFIX<rows out>` says how many rows are out. A band with less to show
// is shorter, never padded.
// The note is a button keyed SHOW_ALL_KEY whoever draws it: the band hears its
// press and gives the height back to auto.
// This block is pasted unchanged into each mod that draws in the band.
const CHIPS_SLOT = 'context-band:chips'
const METERS_SLOT = 'context-band:meters'
const SECTIONS_SLOT = 'context-band:sections'
const FIT_PREFIX = 'context-band:fit:'
const NOTE_PREFIX = 'context-band:note:'
const SHOW_ALL_KEY = 'band-show-all'
// Cells between two chips on their line.
const CHIP_GAP = 2
// About the pixels of a row where a surface draws an Svg (the desktop's line).
const SVG_ROW_PIXELS = 20

type TreeNode = { type?: unknown; key?: unknown; props?: Record<string, unknown>; children?: unknown[] }

function keyOf(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }
  const tree = node as TreeNode
  const key = tree.key ?? tree.props?.key

  return typeof key === 'string' ? key : undefined
}

function pieceKey(kind: 'chip' | 'meter' | 'section', order: number, mod: string): string {
  return `${kind}:${String(order).padStart(2, '0')}:${mod}`
}

// Puts `piece` into the band's slot when the band lies beneath; else stacks it
// above (a chip or a meter) or below (a section) what lies beneath. `columns` is the
// band's width (`bodyColumns`), what a refit wraps the rows in.
function placeInBand(ui: ElementTable, inner: RenderElement, slot: string, piece: RenderElement, columns: number): RenderElement {
  const placed = insertInto(ui, inner, slot, piece, columns)
  if (placed !== null) {
    return placed as RenderElement
  }
  const { Box } = ui

  return slot === SECTIONS_SLOT ? (
    <Box flexDirection="column">
      {inner}
      {piece}
    </Box>
  ) : (
    <Box flexDirection="column">
      {piece}
      {inner}
    </Box>
  )
}

// A meter mod's readings in the band: each one a chip on the band's one line of
// figures, its tone saying when it needs a look. A chip with more to say has a
// card, drawn hidden in METERS_SLOT and shown while the pointer is on the chip:
// the reading's row without a bar. No reading grows into a row with a bar.
type BandReading = { row: GridRow; chip: GridChip }

function placeReadings(
  ui: ElementTable,
  inner: RenderElement,
  readings: readonly BandReading[],
  order: number,
  mod: string,
  columns: number,
): RenderElement {
  const { Box } = ui
  if (readings.length === 0) {
    return inner
  }
  // A chip and its card share a hover group, one per reading across the family.
  const scopeOf = (reading: BandReading) => `${mod}:${reading.chip.name}`.slice(0, 64)
  const chips = (
    <Box key={pieceKey('chip', order, mod)} columnGap={CHIP_GAP} flexWrap="wrap">
      {readings.map(reading => (
        <Box hover={{ scope: scopeOf(reading) }} flexShrink={0}>
          {gridChip(ui, reading.chip)}
        </Box>
      ))}
    </Box>
  )
  const placed = placeInBand(ui, inner, CHIPS_SLOT, chips, columns)
  const cards = readings.filter(reading => reading.row.lines.some(line => line.text !== ''))
  if (cards.length === 0) {
    return placed
  }
  const hidden = (
    <Box key={pieceKey('meter', order, mod)} flexDirection="column">
      {cards.map(reading => (
        <Box display="none" hover={{ scope: scopeOf(reading), display: 'flex' }}>
          {gridRow(ui, { name: reading.row.name, figure: reading.row.figure, ...(reading.row.color === undefined ? {} : { color: reading.row.color }), lines: reading.row.lines }, columns)}
        </Box>
      ))}
    </Box>
  )

  return placeInBand(ui, placed, METERS_SLOT, hidden, columns)
}

// `node` with `piece` in its slot, in key order, and the middle of a set height
// that holds the slot refitted; null when no such slot lies under `node`.
function insertInto(ui: ElementTable, node: unknown, slot: string, piece: unknown, columns: number): unknown {
  if (typeof node !== 'object' || node === null) {
    return null
  }
  const tree = node as TreeNode
  const children = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  const key = keyOf(node)
  if (key === slot) {
    return { ...tree, children: [...children, piece].sort(byPieceKey) }
  }
  for (let index = 0; index < children.length; index++) {
    const placed = insertInto(ui, children[index], slot, piece, columns)
    if (placed !== null) {
      const copy = [...children]
      copy[index] = placed
      const next = { ...tree, children: copy }

      return key?.startsWith(FIT_PREFIX) === true ? fitBand(ui, next, Number(key.slice(FIT_PREFIX.length)), columns) : next
    }
  }

  return null
}

// The band's middle in at most `rows` rows: what it holds from the top while it
// fits, then a note of the rows left out. A column that runs past the end is cut
// inside; the slots stay, empty if need be, so a mod placing later still finds
// them, and the engine's own nodes always stay: a surface draws its part there.
// A middle fitted before keeps its count.
function fitBand(ui: ElementTable, middle: unknown, rows: number, columns: number): RenderElement {
  const { Box, Button } = ui
  const tree = (typeof middle === 'object' && middle !== null ? middle : {}) as TreeNode
  const all = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  const noteKey = all.map(keyOf).find(key => key?.startsWith(NOTE_PREFIX) === true)
  const outBefore = noteKey === undefined ? 0 : Number(noteKey.slice(NOTE_PREFIX.length)) || 0
  const content = all.filter(child => keyOf(child)?.startsWith(NOTE_PREFIX) !== true)
  const room = Math.max(0, rows)
  const total = rowsOf(content, columns)
  const isWhole = outBefore === 0 && total <= room
  const cut = isWhole ? { kept: content, used: total } : trimRows(content, Math.max(0, room - 1), columns)
  const out = outBefore + total - cut.used
  const noteRows = out > 0 && room > 0 ? 1 : 0

  return (
    <Box key={`${FIT_PREFIX}${room}`} flexDirection="column">
      {cut.kept as RenderElement[]}
      {noteRows > 0 && (
        <Box key={`${NOTE_PREFIX}${out}`}>
          <Button key={SHOW_ALL_KEY} plain dimColor onPress={() => undefined}>
            {`▾ ${out} more ${bandRowsWord(out)} hidden · show all`}
          </Button>
        </Box>
      )}
    </Box>
  )
}

// The nodes from the top that fit in `room` rows and the rows they take: a
// column that runs past the end is opened and cut inside, a row or a text is
// left out whole; past the end only the slots stay, emptied, and the engine's
// nodes, which take no row of their own.
function trimRows(nodes: readonly unknown[], room: number, columns: number): { kept: unknown[]; used: number } {
  const kept: unknown[] = []
  let used = 0
  let isFull = false
  for (const node of flatNodes(nodes)) {
    const key = keyOf(node)
    const isSlot = key === CHIPS_SLOT || key === METERS_SLOT || key === SECTIONS_SLOT
    const tree = node as TreeNode
    if (isFull) {
      if (isSlot) {
        kept.push({ ...tree, children: engineNodesIn(tree.children ?? []) })
      } else {
        kept.push(...engineNodesIn([node]))
      }
      continue
    }
    const size = rowsOf(node, columns)
    if (used + size <= room) {
      kept.push(node)
      used += size
      continue
    }
    isFull = true
    if (tree.type === 'Box' && tree.props?.flexDirection === 'column') {
      const inner = trimRows(Array.isArray(tree.children) ? tree.children : [], room - used, roomInside(tree, columns))
      if (inner.kept.length > 0 || isSlot) {
        kept.push({ ...tree, children: inner.kept })
        used += inner.used
      }
    } else if (isSlot) {
      kept.push({ ...tree, children: engineNodesIn(tree.children ?? []) })
    } else {
      kept.push(...engineNodesIn([node]))
    }
  }

  return { kept, used }
}

// The engine's own nodes (`type: 'engine'`) anywhere among `nodes`: where a
// surface draws the engine's part of the site, which a tree must carry on.
function engineNodesIn(nodes: readonly unknown[]): unknown[] {
  return flatNodes(nodes).flatMap(node => {
    if (typeof node !== 'object' || node === null) {
      return []
    }
    const tree = node as TreeNode

    return tree.type === 'engine' ? [node] : engineNodesIn(Array.isArray(tree.children) ? tree.children : [])
  })
}

// About how many rows a tree takes `columns` cells across: a column adds its
// children up, a row takes its tallest, a hidden Box none; a Text its lines,
// each wrapped in the room its row leaves it beside the parts of fixed width.
function rowsOf(node: unknown, columns: number): number {
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child: unknown) => sum + rowsOf(child, columns), 0)
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return linesIn(String(node), columns)
  }
  if (typeof node !== 'object' || node === null) {
    return 0
  }
  const tree = node as TreeNode
  const props = tree.props ?? {}
  if (props.display === 'none' || tree.type === 'engine') {
    return 0
  }
  if (tree.type === 'Svg') {
    // CSS pixels, about a row each SVG_ROW_PIXELS.
    return typeof props.height === 'number' ? Math.max(1, Math.ceil(props.height / SVG_ROW_PIXELS)) : 1
  }
  if (typeof props.height === 'number') {
    return props.height
  }
  const children = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  if (tree.type === 'Text') {
    const text = bandTextOf(children)

    return typeof props.wrap === 'string' && props.wrap.startsWith('truncate') ? text.split('\n').length : linesIn(text, columns)
  }
  if (tree.type !== 'Box') {
    return 1
  }
  const room = roomInside(tree, columns)
  if (props.flexDirection === 'column') {
    return children.reduce((sum: number, child) => sum + rowsOf(child, room), 0)
  }
  const gap = typeof props.columnGap === 'number' ? props.columnGap : typeof props.gap === 'number' ? props.gap : 0
  const widths = children.map(child => Math.min(room, cellsAcross(child)))
  if (props.flexWrap === 'wrap') {
    // Lines of whole children, each as tall as its tallest.
    let rows = 0
    let line = 0
    let lineRows = 0
    children.forEach((child, index) => {
      const width = widths[index] ?? 0
      if (line > 0 && line + gap + width > room) {
        rows += lineRows
        line = 0
        lineRows = 0
      }
      line += (line > 0 ? gap : 0) + width
      lineRows = Math.max(lineRows, rowsOf(child, Math.max(1, width)))
    })

    return rows + lineRows
  }
  // One line: the last child wraps in what the others leave it.
  const others = widths.slice(0, -1).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1)

  return children.reduce(
    (most: number, child, index) =>
      Math.max(most, rowsOf(child, index === children.length - 1 ? Math.max(1, room - others) : Math.max(1, widths[index] ?? 1))),
    0,
  )
}

// The cells a node takes across on one line, unwrapped.
function cellsAcross(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child: unknown) => sum + cellsAcross(child), 0)
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return Math.max(0, ...String(node).split('\n').map(cellsIn))
  }
  if (typeof node !== 'object' || node === null) {
    return 0
  }
  const tree = node as TreeNode
  const props = tree.props ?? {}
  if (props.display === 'none' || tree.type === 'engine') {
    return 0
  }
  const margins = sideCells(props)
  if (typeof props.width === 'number') {
    return props.width + margins
  }
  const children = flatNodes(Array.isArray(tree.children) ? tree.children : [])
  if (tree.type === 'Button') {
    const label = typeof props.label === 'string' && props.label !== '' ? props.label : bandTextOf(children)

    return cellsIn(label) + (props.plain === true ? 0 : 4) + margins
  }
  if (tree.type === 'Text') {
    return Math.max(0, ...bandTextOf(children).split('\n').map(cellsIn)) + margins
  }
  if (tree.type !== 'Box') {
    return margins
  }
  const across = children.map(cellsAcross)
  if (props.flexDirection === 'column') {
    return Math.max(0, ...across) + margins
  }
  const gap = typeof props.columnGap === 'number' ? props.columnGap : typeof props.gap === 'number' ? props.gap : 0

  return across.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1) + margins
}

// The cells a Box gives its children: its width, or what its parent gives,
// less its margins, padding and border.
function roomInside(tree: TreeNode, columns: number): number {
  const props = tree.props ?? {}
  const outer = typeof props.width === 'number' ? props.width : columns - sideCells(props)

  return Math.max(1, outer - paddingCells(props))
}

function sideCells(props: Record<string, unknown>): number {
  const number = (value: unknown) => (typeof value === 'number' ? value : 0)
  const margin = number(props.margin)
  const marginX = number(props.marginX)

  return number(props.marginLeft) + number(props.marginRight) + 2 * marginX + 2 * margin
}

function paddingCells(props: Record<string, unknown>): number {
  const number = (value: unknown) => (typeof value === 'number' ? value : 0)

  return (
    number(props.paddingLeft) +
    number(props.paddingRight) +
    2 * number(props.paddingX) +
    2 * number(props.padding) +
    (typeof props.borderStyle === 'string' ? 2 : 0)
  )
}

// Rows a text takes `columns` cells across, each line wrapped.
function linesIn(text: string, columns: number): number {
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(cellsIn(line) / Math.max(1, columns))), 0)
}

// Cells a line takes: a wide glyph (an emoji, a CJK one) two, the rest one.
function cellsIn(line: string): number {
  let cells = 0
  for (const glyph of line) {
    cells += /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(glyph) ? 2 : 1
  }

  return cells
}

function bandTextOf(children: readonly unknown[]): string {
  return children
    .map(child =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : typeof child === 'object' && child !== null && Array.isArray((child as TreeNode).children)
          ? bandTextOf((child as TreeNode).children ?? [])
          : '',
    )
    .join('')
}

// Children as the engine lays them out: nested lists opened, the empty ones
// (`false`, `null`) dropped.
function flatNodes(nodes: readonly unknown[]): unknown[] {
  return nodes.flatMap(node => (Array.isArray(node) ? flatNodes(node) : node === null || node === undefined || node === false || node === true ? [] : [node]))
}

function bandRowsWord(count: number): string {
  return count === 1 ? 'row' : 'rows'
}

// The pieces keyed `<kind>:...` anywhere under `node`, and `node` without them.
function takePieces(node: unknown, kind: 'chip' | 'meter' | 'section'): { rest: unknown; pieces: unknown[] } {
  if (typeof node !== 'object' || node === null) {
    return { rest: node, pieces: [] }
  }
  if (keyOf(node)?.startsWith(`${kind}:`) === true) {
    return { rest: null, pieces: [node] }
  }
  const tree = node as TreeNode
  if (!Array.isArray(tree.children)) {
    return { rest: node, pieces: [] }
  }
  const pieces: unknown[] = []
  const kept: unknown[] = []
  for (const child of tree.children) {
    const taken = takePieces(child, kind)
    pieces.push(...taken.pieces)
    if (taken.rest !== null) {
      kept.push(taken.rest)
    }
  }

  return { rest: pieces.length === 0 ? node : { ...tree, children: kept }, pieces }
}

function byPieceKey(a: unknown, b: unknown): number {
  return (keyOf(a) ?? '').localeCompare(keyOf(b) ?? '')
}
// ---- end of band layout ----

// ---- band grid (shared block) ----
// Every mod that draws rows in the band lays them on one grid, so names,
// figures and bars line up across mods: a name column, a right-aligned
// figure, a bar of GRID_BAR cells, then the text, one line or a column of
// them. This block is pasted unchanged into each mod that draws band rows.
const GRID_NAME = 12
const GRID_FIGURE = 5
const GRID_BAR = 20
// Narrower than this, rows keep their figures and drop the bars.
const GRID_MIN_COLUMNS = 70

type GridLine = { text: string; color?: ThemeKey; isDim?: boolean; isBold?: boolean }

type GridRow = {
  name: string
  nameColor?: ThemeKey
  isHeader?: boolean
  figure: string
  color?: ThemeKey
  // Absent (and no barText): the row has no bar and its text starts where the bar would.
  percent?: number
  // Drawn in the bar's place instead of a bar of `percent`, GRID_BAR cells wide (a sparkline).
  barText?: string
  barColor?: ThemeKey
  lines: GridLine[]
}

function gridRow(ui: ElementTable, row: GridRow, columns: number): RenderElement {
  const { Box, Text } = ui
  const hasBar = (row.percent !== undefined || row.barText !== undefined) && columns >= GRID_MIN_COLUMNS
  const colorOrDim = (color: ThemeKey | undefined, isDim: boolean) =>
    color === undefined ? { dimColor: isDim } : { color, dimColor: isDim }

  return (
    <Box gap={1}>
      <Box width={GRID_NAME} flexShrink={0}>
        <Text {...colorOrDim(row.nameColor, row.nameColor === undefined && row.isHeader !== true)} bold={row.isHeader === true}>
          {row.name}
        </Text>
      </Box>
      <Box width={GRID_FIGURE} flexShrink={0} justifyContent="flex-end">
        <Text {...colorOrDim(row.color, false)} bold>
          {row.figure}
        </Text>
      </Box>
      {hasBar && <Text {...colorOrDim(row.barColor ?? row.color, false)}>{row.barText ?? gridBar(row.percent ?? 0)}</Text>}
      <Box flexDirection="column" flexShrink={1}>
        {row.lines.map(line => (
          <Text {...colorOrDim(line.color, line.isDim === true)} bold={line.isBold === true}>
            {line.text}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function gridBar(percent: number): string {
  const filled = Math.max(0, Math.min(GRID_BAR, Math.round((percent / 100) * GRID_BAR)))

  return '█'.repeat(filled) + '░'.repeat(GRID_BAR - filled)
}
// A reading at rest, drawn as a chip on the band's one line of quiet figures:
// its name dim, its figure in its tone.
type GridChip = { name: string; figure: string; color?: ThemeKey }

function gridChip(ui: ElementTable, chip: GridChip): RenderElement {
  const { Box, Text } = ui

  return (
    <Box gap={1} flexShrink={0}>
      <Text dimColor>{chip.name}</Text>
      {chip.color === undefined ? <Text bold>{chip.figure}</Text> : <Text color={chip.color} bold>{chip.figure}</Text>}
    </Box>
  )
}
// ---- end of band grid ----
