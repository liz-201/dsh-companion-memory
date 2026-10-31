import type { ContinuousAffectState } from './continuous-affect.js'
import type { Mood } from './types.js'

/** Compatibility view from identified OCC components; PAD alone is not invertible. */
export function continuousMood(state: ContinuousAffectState | null, fallback: Mood): Mood {
  if (!state || !state.emotions.length && !state.experiences?.length) return {...fallback}
  const maximum = (categories: string[]): number => Math.max(0,...state.emotions.filter(e=>categories.includes(e.category)).map(e=>e.intensity))
  const experience = (kinds: string[]): number => Math.max(0,...(state.experiences ?? []).filter(e=>kinds.includes(e.kind)).map(e=>e.intensity))
  return {
    anger: state.ownerDirectedAnger ?? maximum(['anger','reproach','hate','resentment']),
    hurt: Math.max(maximum(['distress','disappointment','remorse','shame','pity','fears-confirmed']),experience(['grief','loneliness','frustration','embarrassment'])),
    joy: Math.max(maximum(['joy','happy-for','gratitude','gratification','satisfaction','relief','pride','admiration','love']),experience(['interest','amusement','awe','calm','tenderness'])),
    tension: Math.max(maximum(['fear','fears-confirmed']),experience(['anxiety','surprise'])),
    expressiveness: Math.max(.2,Math.min(1,maximum(state.emotions.map(e=>e.category)))),
  }
}

/** Both real ingress paths use this view; factual-query scoring remains zero. */
export function retrievalArousal(state: ContinuousAffectState | null, fallback: Mood): number {
  if (state && (state.emotions.length || state.experiences?.length)) return Math.max(0,Math.min(1,state.pad.emotion.arousal))
  return Math.max(0,Math.min(1,fallback.anger*.5+fallback.tension*.3+fallback.hurt*.2))
}
