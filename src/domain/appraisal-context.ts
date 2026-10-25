export interface TurnCue { intent: 'stop_joking' | 'distress' | 'none'; persistent: false }
/** Only explicit communication cues; no relationship mutation or hostile keyword scoring. */
export function turnCue(text: string): TurnCue {
  if (/别(?:再)?(?:开玩笑|玩梗|闹)|认真一点|我现在不想开玩笑/.test(text)) return { intent: 'stop_joking', persistent: false }
  if (/我(?:现在|今天|真的)?(?:很|有点|特别)?(?:难过|失落|害怕|委屈|难受)/.test(text) && !/[“「『]|比如|台词|引用/.test(text)) return { intent: 'distress', persistent: false }
  return { intent: 'none', persistent: false }
}
