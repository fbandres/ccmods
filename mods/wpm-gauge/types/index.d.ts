declare module 'claude-code' {
  interface PluginState {
    'wpm-gauge': { wpm: Wpm; peak: Wpm }
  }
}

export type Wpm = number
