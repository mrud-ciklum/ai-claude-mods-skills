/** One installed mod, as its folder's mod.json card and plugin.json describe it. */
export type ModEntry = {
  /** The plugin's name, as its plugin.json declares it: what the switches file names. */
  name: string
  /** Its place in the panel; this panel itself is 0. */
  order: number
  /** What the panel calls it. */
  title: string
  /** One line on what it shows or changes. */
  summary: string
  /** The panel's section it is listed in, as its card names it: Readings, Conversation, Checks or Guards. */
  group?: string
  /** The choices it offers under its row, as its card lists them (none when absent). */
  settings?: ModSetting[]
}

/** One choice a mod offers in the panel, as its mod.json card's `settings` lists it. */
export type ModSetting = {
  /** The key the mod reads its value under, in the switches file's `modSettings[<mod>]`. */
  key: string
  /** What the panel calls it. */
  label: string
  /** The values to pick from, or `models`: the models the /config menu offers. */
  options: string[] | 'models'
  /** The value until one is picked. */
  default: string
}

/** The switches every session shares, in ~/.claude/mods/state.json. */
export type Switches = {
  /** The names of the mods turned off; a mod not named here is on. */
  off: string[]
  /** Whether a new session opens the panel: the person's last open or close decides. */
  isPaneWanted: boolean
  /** Quiet mode: the band's meters show only what needs a look. */
  quiet: boolean
  /** Whether the mods play their sounds, and speak their news aloud. */
  settings: { sounds: boolean; voice: boolean }
  /** Each mod's picked choices, by its name, then by the setting's key (absent in older files). */
  modSettings?: Record<string, Record<string, string>>
  /** When a session last wrote the file, in epoch milliseconds. */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    mods: {
      mods: ModEntry[]
      switches: Switches
      switchesSeenAt: number
      isPaneOpen: boolean
      isPaneShown: boolean
      isSectionOpen: boolean
      models: string[]
      // Today's model calls each mod made, as cost-meter counts them in ~/.claude/mods/side-models.json.
      sideModels: Record<string, { calls: number; tokens: number }>
    }
  }
}
