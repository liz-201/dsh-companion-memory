/** Evidence-bound computational appraisal. Unknown is absent, never an invented zero. */
export interface EmotionAppraisal {
  focus: 'event' | 'action' | 'object'
  affectedParty?: 'self' | 'owner' | 'other'
  agency?: 'self' | 'owner' | 'other' | 'unknown'
  desirability?: number
  desirabilityForOther?: number
  likingForOther?: number
  deservingness?: number
  praiseworthiness?: number
  appealingness?: number
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

const bipolar = ['desirability', 'desirabilityForOther', 'likingForOther', 'deservingness', 'praiseworthiness', 'appealingness'] as const
const unit = ['likelihood', 'controllability', 'unexpectedness', 'relevance', 'unfairness', 'relationshipThreat', 'personalAttention', 'helplessness', 'confidence'] as const
const enums = { focus: ['event','action','object'], affectedParty: ['self','owner','other'], agency: ['self','owner','other','unknown'], prospect: ['pending','confirmed','disconfirmed','none'] }
const keys = new Set([...bipolar, ...unit, ...Object.keys(enums), 'quote', 'suppliedEvidenceRef','suppliedBehaviorRef'])

export function parseAppraisals(value: unknown): EmotionAppraisal[] {
  if (!Array.isArray(value) || value.length > 4) throw Error('appraisals must be an array with at most four entries')
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('invalid appraisal object')
    const row = item as Record<string, unknown>
    if (Object.keys(row).some(key => !keys.has(key))) throw Error('unknown or server-owned appraisal field')
    for (const [key, values] of Object.entries(enums)) if ((key === 'focus' || row[key] !== undefined) && !values.includes(String(row[key]))) throw Error(`invalid ${key}`)
    for (const key of [...bipolar, ...unit]) {
      const v = row[key]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < (bipolar.includes(key as typeof bipolar[number]) ? -1 : 0) || v > 1)) throw Error(`invalid ${key}`)
    }
    if (typeof row['quote'] !== 'string' || !row['quote'].trim() || row['quote'].length > 500 || typeof row['confidence'] !== 'number') throw Error('appraisal requires quote and confidence')
    if (row['suppliedEvidenceRef'] !== undefined && (typeof row['suppliedEvidenceRef'] !== 'string' || row['suppliedEvidenceRef'].length > 250)) throw Error('invalid evidence reference')
    if (row['suppliedBehaviorRef'] !== undefined && (typeof row['suppliedBehaviorRef'] !== 'string' || row['suppliedBehaviorRef'].length > 500)) throw Error('invalid behavior reference')
    return { ...row } as unknown as EmotionAppraisal
  })
}
