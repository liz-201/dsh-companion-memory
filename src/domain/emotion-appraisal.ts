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
  quote: string
  confidence: number
}

export const SITUATION_AXES = ['novelty', 'knowledgeGap', 'goalBlockage', 'loss', 'permanence', 'separation', 'attachment', 'exposure', 'incongruity', 'aestheticImpact', 'recollection', 'safety', 'monotony', 'aversion', 'comparison'] as const
export type SituationAxis = typeof SITUATION_AXES[number]

const bipolar = ['desirability', 'desirabilityForOther', 'likingForOther', 'deservingness', 'praiseworthiness', 'appealingness', 'pull'] as const
const unit = ['likelihood', 'controllability', 'unexpectedness', 'relevance', 'unfairness', 'relationshipThreat', 'personalAttention', 'helplessness', 'confidence'] as const
const enums = { focus: ['event','action','object'], affectedParty: ['self','owner','other'], agency: ['self','owner','other','unknown'], prospect: ['pending','confirmed','disconfirmed','none'], concern: ['relationship','self','owner','other','topic'] }
const keys = new Set([...bipolar, ...unit, ...Object.keys(enums), 'quote', 'suppliedEvidenceRef','suppliedBehaviorRef', 'topic', 'situation', 'unresolved'])

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
    return { ...row } as unknown as EmotionAppraisal
  })
}
