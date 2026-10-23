import { findRootObjectEnd } from './output-protocol.js';
const SAY_OPEN = '<say>';
const SAY_CLOSE = '</say>';
const EVT_OPEN = '<evt>';
const EVT_CLOSE = '</evt>';
/** 只保留可能是某个标记前缀的最短后缀（避免把 `<sa` 当正文输出又避免丢块）。 */
function pendingSuffix(buffer, markers) {
    let best = '';
    for (const marker of markers) {
        const max = Math.min(marker.length - 1, buffer.length);
        for (let len = max; len > 0; len -= 1) {
            const suffix = buffer.slice(buffer.length - len);
            if (marker.startsWith(suffix) && len > best.length)
                best = suffix;
        }
    }
    return best;
}
/** §7.2：只解码一次，且只认 XML 文本实体；不做 HTML 富文本或 DOM 解析。 */
export function decodeSayText(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}
/** 编码时先替换 & 再替换 <，保证解码一次可逆。 */
export function encodeSayText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export class StreamParser {
    evtMaxBytes;
    sayMaxChars;
    tolerateTrailing;
    state = 'WAIT_SAY';
    buffer = '';
    pendingHighSurrogate = '';
    sayRaw = '';
    sayText = null;
    evtRaw = null;
    evtBuffer = '';
    evtBytes = 0;
    problems = [];
    duplicateSay = false;
    duplicateEvt = false;
    partialEvt = null;
    plainText = null;
    finished = false;
    cancelled = false;
    closedSayEmitted = false;
    constructor(options = {}) {
        this.evtMaxBytes = options.evtMaxBytes ?? 2048;
        this.sayMaxChars = options.sayMaxChars ?? 20000;
        this.tolerateTrailing = options.tolerateTrailing ?? true;
    }
    get currentState() {
        return this.state;
    }
    /** 喂入一个流式分片；返回本片产生的语义事件（可为空数组）。 */
    feed(chunk) {
        const events = [];
        if (this.cancelled)
            return events;
        let text = chunk;
        // 处理被切开的代理对：上一片留下的高位 + 本片低位。
        if (this.pendingHighSurrogate !== '') {
            text = this.pendingHighSurrogate + text;
            this.pendingHighSurrogate = '';
        }
        const last = text.charCodeAt(text.length - 1);
        if (text !== '' && last >= 0xd800 && last <= 0xdbff) {
            this.pendingHighSurrogate = text.slice(-1);
            text = text.slice(0, -1);
        }
        if (text === '')
            return events;
        this.buffer += text;
        this.drain(events);
        return events;
    }
    /**
     * 流结束（正常结束或 stream cancel 后仍调用一次）。
     * 返回最终结果；未闭合的 say 会带上已收到的正文（由调用方决定是否发送）。
     */
    finish() {
        const events = [];
        if (!this.cancelled) {
            if (this.pendingHighSurrogate !== '') {
                this.buffer += this.pendingHighSurrogate;
                this.pendingHighSurrogate = '';
            }
            this.drain(events);
            this.closeOut(events);
        }
        this.finished = true;
        return { events, result: this.result() };
    }
    /** 上游取消：保留已收到的正文，不再尝试解析尾部标记。 */
    cancel() {
        this.cancelled = true;
        this.closeOut([]);
    }
    result() {
        return {
            state: this.state,
            say: this.sayText,
            evtRaw: this.evtRaw,
            problems: [...this.problems],
            duplicateSay: this.duplicateSay,
            duplicateEvt: this.duplicateEvt,
            partialEvt: this.partialEvt,
            plainText: this.plainText,
        };
    }
    // ---------- 内部 ----------
    drain(events) {
        let guard = 0;
        while (guard < 64) {
            guard += 1;
            if (!this.step(events))
                return;
        }
    }
    /** 推进一次状态；返回是否可能还有进展。 */
    step(events) {
        switch (this.state) {
            case 'WAIT_SAY': {
                const idx = this.buffer.indexOf(SAY_OPEN);
                if (idx < 0) {
                    // 整个缓冲恰好是 `<say>` 的前缀（流式分片切在标记中间）：等下一片，
                    // 不能当正文判死，否则 `<sa` + `y>` 会被误判成 text-before-say。
                    const keep = pendingSuffix(this.buffer, [SAY_OPEN]);
                    if (keep.length === this.buffer.length)
                        return false;
                    // 只有空白可以出现在 <say> 之前；其余文本说明模型没按协议输出。
                    const trimmed = this.buffer.trim();
                    if (trimmed !== '') {
                        this.problems.push('text-before-say');
                        // 留着原话：调用方按 §7.5 纯文本回退时要用它，不能把用户该看到的话丢掉。
                        this.plainText = this.buffer;
                        this.state = 'INVALID';
                        return false;
                    }
                    this.buffer = keep;
                    return false;
                }
                if (this.buffer.slice(0, idx).trim() !== '') {
                    this.problems.push('text-before-say');
                    this.state = 'INVALID';
                    return false;
                }
                this.buffer = this.buffer.slice(idx + SAY_OPEN.length);
                this.state = 'IN_SAY';
                events.push({ type: 'say-open' });
                return true;
            }
            case 'IN_SAY': {
                const idx = this.buffer.indexOf(SAY_CLOSE);
                if (idx < 0) {
                    // 检查是否有第二个 <say>（模型自说自话时会这样）。
                    const dup = this.buffer.indexOf(SAY_OPEN);
                    if (dup >= 0)
                        this.duplicateSay = true;
                    this.sayRaw += this.buffer;
                    if (this.sayRaw.length > this.sayMaxChars) {
                        this.sayRaw = this.sayRaw.slice(0, this.sayMaxChars);
                        this.problems.push('say-unclosed');
                    }
                    this.buffer = pendingSuffix(this.sayRaw, [SAY_CLOSE]);
                    this.sayRaw = this.sayRaw.slice(0, this.sayRaw.length - this.buffer.length);
                    events.push({ type: 'say-progress', text: this.sayRaw });
                    return false;
                }
                this.sayRaw += this.buffer.slice(0, idx);
                this.buffer = this.buffer.slice(idx + SAY_CLOSE.length);
                this.sayText = decodeSayText(this.sayRaw);
                this.state = 'AFTER_SAY';
                this.closedSayEmitted = true;
                events.push({ type: 'say-closed', text: this.sayText });
                return true;
            }
            case 'AFTER_SAY': {
                const trimmedStart = this.buffer.replace(/^\s+/, '');
                this.buffer = trimmedStart;
                if (this.buffer === '')
                    return false;
                if (this.buffer.startsWith(EVT_OPEN)) {
                    this.buffer = this.buffer.slice(EVT_OPEN.length);
                    this.state = 'IN_EVT';
                    this.evtBuffer = '';
                    this.evtBytes = 0;
                    events.push({ type: 'evt-open' });
                    return true;
                }
                const sayAgain = this.buffer.indexOf(SAY_OPEN);
                if (sayAgain >= 0) {
                    this.duplicateSay = true;
                    this.problems.push('duplicate-say');
                    this.buffer = '';
                    return false;
                }
                const partial = pendingSuffix(this.buffer, [EVT_OPEN, SAY_OPEN]);
                const filled = this.buffer.slice(0, this.buffer.length - partial.length);
                this.buffer = partial;
                if (filled.trim() !== '') {
                    this.problems.push('trailing-text');
                    if (!this.tolerateTrailing) {
                        this.state = 'INVALID';
                        return false;
                    }
                }
                return false;
            }
            case 'IN_EVT': {
                this.evtBuffer += this.buffer;
                this.buffer = '';
                const rootEnd = findRootObjectEnd(this.evtBuffer);
                const json = rootEnd === null ? this.evtBuffer : this.evtBuffer.slice(0, rootEnd);
                this.evtBytes = Buffer.byteLength(json, 'utf8');
                if (this.evtBytes > this.evtMaxBytes) {
                    this.partialEvt = this.evtBuffer.slice(0, 512);
                    this.problems.push('evt-oversize');
                    this.state = 'INVALID';
                    this.evtBuffer = '';
                    return false;
                }
                if (rootEnd === null)
                    return false;
                const tail = this.evtBuffer.slice(rootEnd).trimStart();
                if (tail === '' || (tail.length < EVT_CLOSE.length && EVT_CLOSE.startsWith(tail)))
                    return false;
                if (!tail.startsWith(EVT_CLOSE)) {
                    this.problems.push('evt-malformed');
                    this.state = 'INVALID';
                    return false;
                }
                this.evtRaw = json;
                events.push({ type: 'evt-closed', raw: json });
                this.buffer = tail.slice(EVT_CLOSE.length);
                this.evtBuffer = '';
                this.state = 'DONE';
                return true;
            }
            case 'DONE': {
                const rest = this.buffer;
                this.buffer = '';
                if (rest.trim() !== '') {
                    if (rest.includes(EVT_OPEN)) {
                        this.duplicateEvt = true;
                        this.problems.push('duplicate-evt');
                    }
                    else if (rest.includes(SAY_OPEN)) {
                        this.duplicateSay = true;
                        this.problems.push('duplicate-say');
                    }
                    else {
                        this.problems.push('trailing-text');
                        if (!this.tolerateTrailing)
                            this.state = 'INVALID';
                    }
                }
                return false;
            }
            case 'INVALID':
                return false;
            default:
                return false;
        }
    }
    closeOut(events) {
        if (this.state === 'WAIT_SAY') {
            const leftover = this.buffer.trim();
            if (leftover === '') {
                this.problems.push('missing-say');
                this.state = 'INVALID';
            }
            else {
                // 整段纯文本：没有协议封装。调用方按「纯文本回退」处理。
                this.problems.push('missing-say');
                this.sayText = this.sayText ?? decodeSayText(leftover);
                this.plainText = this.plainText ?? leftover;
                this.state = 'INVALID';
            }
            return;
        }
        if (this.state === 'IN_SAY') {
            this.sayRaw += this.buffer;
            this.buffer = '';
            this.problems.push('say-unclosed');
            this.sayText = decodeSayText(this.sayRaw);
            this.state = 'INVALID';
            if (!this.closedSayEmitted && this.sayText !== '') {
                this.closedSayEmitted = true;
                events.push({ type: 'say-closed', text: this.sayText });
            }
            return;
        }
        if (this.state === 'IN_EVT') {
            this.partialEvt = this.evtBuffer.slice(0, 512);
            this.problems.push('evt-unclosed');
            this.evtRaw = null;
            this.state = 'INVALID';
            return;
        }
        if (this.state === 'AFTER_SAY') {
            this.state = 'DONE';
            events.push({ type: 'done' });
            return;
        }
        if (this.state === 'DONE') {
            if (!this.finished)
                events.push({ type: 'done' });
            return;
        }
    }
}
/** 一次性解析（非流式返回、测试与回放用）。 */
export function parseComplete(text, options = {}) {
    const parser = new StreamParser(options);
    const events = parser.feed(text);
    const end = parser.finish();
    return { ...end.result, events: [...events, ...end.events] };
}
//# sourceMappingURL=stream-parser.js.map