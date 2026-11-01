/** Evidence-bound computational appraisal. Unknown is absent, never an invented zero. */
export interface EmotionAppraisal {
  /** The feeling's object, not the source speaker. Never infer relationship feelings from a task. */
  concern?: 'relationship' | 'self' | 'owner' | 'other' | 'topic'
  /** An exact source substring used to keep object-specific feelings on topic. */
  topic?: string
  situation?: Partial<Record<SituationAxis, number>>
  /** Explicitly unknown axes; a new observer must explain omissions instead of inventing values. */
  unresolved?: string[]
  focus: 'event' | 'action' | 'object'
  affectedParty?: 'self' | 'owner' | 'other'
  agency?: 'self' | 'owner' | 'other' | 'unknown'
  desirability?: number
  desirabilityForOther?: number
  likingForOther?: number
  deservingness?: number
  praiseworthiness?: number
  appealingness?: number
  /** Explicit owner-directed approach/withdrawal; object liking is not a substitute. */
  pull?: number
  likelihood?: number
  controllability?: number
  unexpectedness?: number
  relevance?: number
  prospect?: 'pending' | 'confirmed' | 'disconfirmed' | 'none'
  suppliedEvidenceRef?: string
  suppliedBehaviorRef?: string
  unfairness?: number
  relationshipThreat?: number
  personalAttention?: number
  helplessness?: number
  /**
   * Optional adult-intimacy cue. The model proposes it; the host re-qualifies the
   * clause before any of it can reach a state. Never a substitute for `pull`.
   */
  eroticCue?: {
    kind: 'interest' | 'stop'
    /** interest only, finite [0,1]; a stop must not carry one. */
    strength?: number
    /** A whole clause of the current owner message, verbatim. */
    quote: string
  }
  quote: string
  confidence: number
}

export const SITUATION_AXES = ['novelty', 'knowledgeGap', 'goalBlockage', 'loss', 'permanence', 'separation', 'attachment', 'exposure', 'incongruity', 'aestheticImpact', 'recollection', 'safety', 'monotony', 'aversion', 'comparison'] as const
export type SituationAxis = typeof SITUATION_AXES[number]

const bipolar = ['desirability', 'desirabilityForOther', 'likingForOther', 'deservingness', 'praiseworthiness', 'appealingness', 'pull'] as const
const unit = ['likelihood', 'controllability', 'unexpectedness', 'relevance', 'unfairness', 'relationshipThreat', 'personalAttention', 'helplessness', 'confidence'] as const
const enums = { focus: ['event','action','object'], affectedParty: ['self','owner','other'], agency: ['self','owner','other','unknown'], prospect: ['pending','confirmed','disconfirmed','none'], concern: ['relationship','self','owner','other','topic'] }
const keys = new Set([...bipolar, ...unit, ...Object.keys(enums), 'quote', 'suppliedEvidenceRef','suppliedBehaviorRef', 'topic', 'situation', 'unresolved', 'eroticCue'])
const cueKeys = new Set(['kind', 'strength', 'quote'])
const cueKinds = ['interest', 'stop']

export function parseAppraisals(value: unknown): EmotionAppraisal[] {
  if (!Array.isArray(value) || value.length > 4) throw Error('appraisals must be an array with at most four entries')
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('invalid appraisal object')
    const row = { ...item } as Record<string, unknown>
    // Some models put an existing appraisal axis inside situation. Canonicalize
    // only already allowlisted numeric axes; reject disagreements and unknown keys.
    if (row['situation'] && typeof row['situation'] === 'object' && !Array.isArray(row['situation'])) {
      const axes = { ...row['situation'] } as Record<string, unknown>
      for (const key of [...bipolar, ...unit]) if (key !== 'confidence' && axes[key] !== undefined) {
        if (row[key] !== undefined && row[key] !== axes[key]) throw Error('conflicting appraisal axis placement')
        row[key] = axes[key]
        delete axes[key]
      }
      row['situation'] = axes
    }
    if (Object.keys(row).some(key => !keys.has(key))) throw Error('unknown or server-owned appraisal field')
    for (const [key, values] of Object.entries(enums)) if ((key === 'focus' || row[key] !== undefined) && !values.includes(String(row[key]))) throw Error(`invalid ${key}`)
    for (const key of [...bipolar, ...unit]) {
      const v = row[key]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < (bipolar.includes(key as typeof bipolar[number]) ? -1 : 0) || v > 1)) throw Error(`invalid ${key}`)
    }
    if (typeof row['quote'] !== 'string' || !row['quote'].trim() || row['quote'].length > 500 || typeof row['confidence'] !== 'number') throw Error('appraisal requires quote and confidence')
    if (row['suppliedEvidenceRef'] !== undefined && (typeof row['suppliedEvidenceRef'] !== 'string' || row['suppliedEvidenceRef'].length > 250)) throw Error('invalid evidence reference')
    if (row['suppliedBehaviorRef'] !== undefined && (typeof row['suppliedBehaviorRef'] !== 'string' || row['suppliedBehaviorRef'].length > 500)) throw Error('invalid behavior reference')
    if (row['topic'] !== undefined && (typeof row['topic'] !== 'string' || !row['topic'].trim() || row['topic'].length > 80)) throw Error('invalid emotion topic')
    if (row['situation'] !== undefined) {
      const axes = row['situation']
      if (!axes || typeof axes !== 'object' || Array.isArray(axes)) throw Error('invalid situation')
      for (const [key, value] of Object.entries(axes)) if (!SITUATION_AXES.includes(key as SituationAxis) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw Error('invalid situation axis')
    }
    if (row['unresolved'] !== undefined && (!Array.isArray(row['unresolved']) || row['unresolved'].length > 20 || row['unresolved'].some(key => typeof key !== 'string' || ![...bipolar, ...unit, ...Object.keys(enums)].includes(key)))) throw Error('invalid unresolved axes')
    if (row['eroticCue'] !== undefined) {
      const cue = row['eroticCue']
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) throw Error('invalid erotic cue')
      const fields = cue as Record<string, unknown>
      // Owner identity, age, permission, timestamps and source ids are host-owned and
      // must never arrive from the model.
      if (Object.keys(fields).some(key => !cueKeys.has(key))) throw Error('unknown or server-owned erotic cue field')
      if (!cueKinds.includes(String(fields['kind']))) throw Error('invalid erotic cue kind')
      const quote = fields['quote']
      if (typeof quote !== 'string' || !quote.trim() || quote.length > 300) throw Error('invalid erotic cue quote')
      const strength = fields['strength']
      if (fields['kind'] === 'interest') {
        if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) throw Error('interest cue requires a finite strength in [0,1]')
      } else if (strength !== undefined) throw Error('stop cue must not carry a strength')
    }
    return { ...row } as unknown as EmotionAppraisal
  })
}
