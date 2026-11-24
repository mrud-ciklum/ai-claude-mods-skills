import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const MOD_NAME = 'lesson-catcher'
const isOn = atom({ plugin: 'lesson-catcher', key: 'isOn' } as const, true)
const switchSeenAt = atom({ plugin: 'lesson-catcher', key: 'switchSeenAt' } as const, -1)
const isQuiet = atom({ plugin: 'lesson-catcher', key: 'isQuiet' } as const, false)
const switchedOff = atom({ plugin: 'lesson-catcher', key: 'switchedOff' } as const, [])
const lesson = atom({ plugin: 'lesson-catcher', key: 'lesson' } as const, null as { text: string; at: number } | null)
const isOwnPrompt = atom({ plugin: 'lesson-catcher', key: 'isOwnPrompt' } as const, false)

// What a correction sounds like, in Ukrainian and English: the person tells the model it did
// something again, or not as asked. A plain "no" or a new instruction is not one.
const CORRECTION =
  /(?:^|[\s,.!?«"(])(?:ти\s+знову|знову\s+ти|я\s+ж\s+(?:казав|просив|писав)|я\s+вже\s+(?:казав|просив|писав)|не\s+так[,.!]|не\s+те[,.!]|навіщо\s+ти|чого\s+ти\s+(?:знову|не)|ти\s+не\s+(?:зробив|перевірив|прочитав|послухав)|you\s+(?:did\s+it\s+)?again|i\s+(?:already\s+)?(?:told|asked)\s+you|that'?s\s+not\s+what\s+i|don'?t\s+do\s+that\s+again|stop\s+doing|why\s+did\s+you)/iu

export const soundsLikeCorrection = (text: string) => CORRECTION.test(` ${text.slice(0, 2_000)}`)

// The prompt a press of Remember submits: the correction in the person's words, and what to keep of it.
export const rememberPrompt = (text: string) =>
  [
    'The user just corrected you. Their words:',
    `"""${text.slice(0, 2_000)}"""`,
    'Save this as a feedback memory, following your memory rules: what to do differently, why (in their words where you can), and when it applies. Update an existing memory that covers it rather than adding a second one. Keep it to the specifics; do not widen it. Then say in one line what you saved.',
  ].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($)

    return next(e)
  })

  // A prompt that reads as a correction is kept for the button; the next prompt of the person's clears it.
  on('prompt.submit', async ($, e, next) => {
    if (await read($, isOwnPrompt)) {
      await update($, isOwnPrompt, () => false)

      return next(e)
    }
    if (e.origin?.kind === 'composer' && (await read($, isOn))) {
      const text = e.text
      const at = await $.clock.now()
      await update($, lesson, () => (soundsLikeCorrection(text) ? { text, at } : null))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // One line above the prompt while a correction waits: Remember, or Dismiss.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const caught = await read($, lesson)
    if (e.props.hasSurvey || caught === null || !(await read($, isOn))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box justifyContent="space-between" columnGap={2}>
        <Box columnGap={1} flexShrink={1}>
          <Text bold>Lesson</Text>
          <Text dimColor wrap="truncate-end">
            That read as a correction. Save it as a rule the model keeps?
          </Text>
        </Box>
        <Box columnGap={1} flexShrink={0}>
          <Button key="lesson-remember" label="Remember" onPress={() => remember($)} />
          <Button key="lesson-dismiss" label="Dismiss" dimColor onPress={() => update($, lesson, () => null)} />
        </Box>
      </Box>
    )
  })
}

async function remember($: EngineInterface) {
  const caught = await read($, lesson)
  if (caught === null) return
  await update($, lesson, () => null)
  await update($, isOwnPrompt, () => true)
  await $.prompt.submit({ text: rememberPrompt(caught.text) })
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
