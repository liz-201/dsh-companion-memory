import { createHash } from 'node:crypto';
import { hostService } from '../adapters/host-service.js';
const record = (value) => value && typeof value === 'object' ? value : {};
/** No text classifier: explicit host identity wins; only persona sections form the fallback. */
export class PersonaContexts {
    repos;
    config;
    constructor(repos, config) {
        this.repos = repos;
        this.config = config;
    }
    resolve(agentValue, sections) {
        const agent = record(agentValue), session = record(agent['session']);
        const sessionId = String(session['id'] ?? '');
        let preset;
        const projections = record(hostService(record(agent['ctx']), 'sessionProjections'));
        if (typeof projections['stateOf'] === 'function') {
            try {
                preset = projections['stateOf'].call(projections, session, 'agentPreset');
            }
            catch { /* older host */ }
        }
        if (preset === undefined) {
            preset = record(session['header'])['agentPreset'];
            if (typeof session['snapshotEvents'] === 'function') {
                const events = session['snapshotEvents'].call(session);
                if (Array.isArray(events)) {
                    const selected = events.findLast(event => record(event)['type'] === 'agent-preset/selected');
                    if (selected)
                        preset = record(record(selected)['data'])['agentPreset'];
                }
            }
        }
        let id = this.config.integration.personaId || (typeof preset === 'string' && preset ? `preset:${preset}` : '');
        if (!id && Array.isArray(sections)) {
            const persona = sections.map(record).filter(section => {
                const name = String(section['name'] ?? '');
                return !name.startsWith('companion-memory:') && (name === 'deployment:persona-prefix' || /(?:^|:)persona$/.test(name)) && String(section['text'] ?? '').trim();
            }).map(section => [section['name'], String(section['text']).trim()]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
            id = persona.length ? `prompt:${createHash('sha256').update(JSON.stringify(persona)).digest('hex').slice(0, 24)}` : 'builtin';
        }
        const key = `local.persona:${sessionId}`;
        const previous = this.repos.getSetting(key);
        id ||= previous?.startsWith('prompt:') ? previous : 'builtin';
        if (this.repos.getSetting(key) !== id)
            this.repos.setSetting(key, id, Date.now());
        const profileKey = `persona.preset:${id}`;
        const configured = this.config.integration.personaPresets[id];
        const saved = this.repos.getSetting(profileKey);
        if (configured && saved !== configured)
            this.repos.setSetting(profileKey, configured, Date.now());
        return { id, preset: configured ?? (saved === 'gentle' || saved === 'irritable' || saved === 'balanced' ? saved : this.config.companion.preset) };
    }
}
//# sourceMappingURL=persona-context.js.map