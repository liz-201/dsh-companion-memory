const bipolar = ['desirability', 'desirabilityForOther', 'likingForOther', 'deservingness', 'praiseworthiness', 'appealingness', 'pull'];
const unit = ['likelihood', 'controllability', 'unexpectedness', 'relevance', 'unfairness', 'relationshipThreat', 'personalAttention', 'helplessness', 'confidence'];
const enums = { focus: ['event', 'action', 'object'], affectedParty: ['self', 'owner', 'other'], agency: ['self', 'owner', 'other', 'unknown'], prospect: ['pending', 'confirmed', 'disconfirmed', 'none'] };
const keys = new Set([...bipolar, ...unit, ...Object.keys(enums), 'quote', 'suppliedEvidenceRef', 'suppliedBehaviorRef']);
export function parseAppraisals(value) {
    if (!Array.isArray(value) || value.length > 4)
        throw Error('appraisals must be an array with at most four entries');
    return value.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw Error('invalid appraisal object');
        const row = item;
        if (Object.keys(row).some(key => !keys.has(key)))
            throw Error('unknown or server-owned appraisal field');
        for (const [key, values] of Object.entries(enums))
            if ((key === 'focus' || row[key] !== undefined) && !values.includes(String(row[key])))
                throw Error(`invalid ${key}`);
        for (const key of [...bipolar, ...unit]) {
            const v = row[key];
            if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < (bipolar.includes(key) ? -1 : 0) || v > 1))
                throw Error(`invalid ${key}`);
        }
        if (typeof row['quote'] !== 'string' || !row['quote'].trim() || row['quote'].length > 500 || typeof row['confidence'] !== 'number')
            throw Error('appraisal requires quote and confidence');
        if (row['suppliedEvidenceRef'] !== undefined && (typeof row['suppliedEvidenceRef'] !== 'string' || row['suppliedEvidenceRef'].length > 250))
            throw Error('invalid evidence reference');
        if (row['suppliedBehaviorRef'] !== undefined && (typeof row['suppliedBehaviorRef'] !== 'string' || row['suppliedBehaviorRef'].length > 500))
            throw Error('invalid behavior reference');
        return { ...row };
    });
}
//# sourceMappingURL=emotion-appraisal.js.map