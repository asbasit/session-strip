export type Dot = 'working' | 'new' | 'seen'

export type Row = {
  id: string
  title: string
  at: number
  link?: string
  dot: Dot
}

declare module 'claude-code' {
  interface PluginState {
    'session-strip': {
      rows: Row[]
      now: number
      query: string
      isHidden: boolean
      isOff: boolean
    }
  }
}
