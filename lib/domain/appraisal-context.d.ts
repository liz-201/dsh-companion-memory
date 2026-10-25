export interface TurnCue {
    intent: 'stop_joking' | 'distress' | 'none';
    persistent: false;
}
/** Only explicit communication cues; no relationship mutation or hostile keyword scoring. */
export declare function turnCue(text: string): TurnCue;
