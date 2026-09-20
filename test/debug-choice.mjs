import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from ['"][^'"]+['"];\n/gm, '')
    .replace('export { init };', '');

function setup({ rollOnSwipe = true, busy = false, swipeId = 0, swipes = ['First reply', 'Second reply', 'Third reply'] } = {}) {
    const buttons = [];
    const injections = new Map();
    const handlers = new Map();
    const state = { generations: 0, optionRequests: 0, busy };
    const data = {
        anchor: 0, chosenIndex: 0, roll: 2, total: 100,
        options: [{ text: 'Open the door', probability: 75 }, { text: 'Run away', probability: 25 }],
        direction: 'old direction',
    };
    const chat = [{ is_user: true }, {
        is_user: false, mes: swipes?.[swipeId] ?? 'Original reply', extra: { diceroll: data },
        ...(swipes ? {
            swipe_id: swipeId, swipes: [...swipes],
            swipe_info: swipes.map((_, index) => ({ extra: { diceroll: { ...structuredClone(data), chosenIndex: index % 2 } } })),
        } : {}),
    }];
    function $(selector) {
        const element = {
            length: String(selector).includes('edit_textarea') ? 0 : 1,
            find: () => element, first: () => element,
            remove: () => element, append: () => element, after: () => element,
            toggleClass: () => element, text: () => element, attr: () => element,
            prop: () => element, val: () => element, each: () => element,
            on: (event, callback) => { element[event] = callback; return element; },
        };
        if (String(selector).startsWith('<button')) buttons.push(element);
        return element;
    }
    const sandbox = {
        console, structuredClone, $, chat, chat_metadata: {},
        extension_settings: { 'ST-Diceroll': { enabled: true, debugDisplay: true, rollOnSwipe, notify: false } },
        extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { USER: 1, SYSTEM: 0 },
        event_types: new Proxy({}, { get: (_, name) => name }),
        eventSource: { on: (name, handler) => handlers.set(name, handler) },
        renderExtensionTemplateAsync: async () => '',
        saveMetadataDebounced() {}, saveChatDebounced() {}, saveSettingsDebounced() {},
        setExtensionPrompt: (id, text) => injections.set(id, text),
        substituteParams: text => text,
        isGenerating: () => state.busy,
        SWIPE_DIRECTION: { RIGHT: 'right' },
        toastr: { warning() {}, error() {}, info() {} },
        generateQuietPrompt: async () => {
            state.optionRequests++;
            return JSON.stringify({ options: data.options });
        },
        Generate: () => { throw new Error('Destructive regeneration must not be used'); },
        swipe: async (event, direction, args) => {
            assert.equal(event, null);
            assert.equal(direction, 'right');
            assert.equal(args.message, chat[1]);
            assert.equal(args.forceSwipeId, Math.max(1, chat[1].swipes?.length ?? 0));
            state.generations++;
            if (state.generateOverride) return state.generateOverride();
            // Model core swipe bookkeeping: save the visible variant, append at the end,
            // keep the message object, and stamp the new variant before saving it.
            const message = chat[1];
            message.swipe_id ??= 0;
            message.swipes ??= [message.mes];
            message.swipe_info ??= [];
            message.swipes[message.swipe_id] = message.mes;
            message.swipe_info[message.swipe_id] = { extra: structuredClone(message.extra) };
            message.swipe_id = args.forceSwipeId;
            const type = 'swipe';
            await handlers.get('GENERATION_STARTED')(type, {}, false);
            await sandbox.dicerollGenerateInterceptor(chat, 0, () => {}, type);
            state.direction = injections.get('diceroll_direction');
            handlers.get('GENERATION_ENDED')(); // Streaming ends before the message event.
            message.mes = 'New reply';
            message.swipes.push(message.mes);
            handlers.get('MESSAGE_RECEIVED')(1, type);
            handlers.get('CHARACTER_MESSAGE_RENDERED')(1, type);
            message.swipe_info[message.swipe_id] = { extra: structuredClone(message.extra) };
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source + '\nglobalThis.api = { init, renderDebugForMessage, regenerateWithChoice };', sandbox);
    return { sandbox, state, data, chat, buttons, injections, handlers };
}

for (const rollOnSwipe of [true, false]) {
    const t = setup({ rollOnSwipe });
    await t.sandbox.api.init();
    // A deliberate debug choice also works while a guided-generation inject exists.
    t.sandbox.chat_metadata.script_injects = { instruct: { value: 'manual direction' } };
    t.sandbox.api.renderDebugForMessage(1);
    assert.equal(t.buttons.length, 2);
    await t.buttons[1].click();
    assert.equal(t.state.generations, 1);
    assert.equal(t.state.optionRequests, 0);
    assert.match(t.state.direction, /Run away/);
    assert.equal(t.chat[1].extra.diceroll.chosenIndex, 1);
    assert.equal(t.chat[1].extra.diceroll.roll, null);
    assert.equal(t.chat[1].extra.diceroll.options.length, 2);
    assert.equal(t.sandbox.chat_metadata.diceroll.chosenIndex, 1);
    assert.equal(t.injections.get('diceroll_direction'), '');
    assert.equal(t.data.chosenIndex, 0);
    // The next ordinary turn must roll again, with no leaked debug override.
    delete t.sandbox.chat_metadata.script_injects;
    t.chat.push({ is_user: true });
    await t.sandbox.dicerollGenerateInterceptor(t.chat, 0, () => {}, 'normal');
    assert.equal(t.state.optionRequests, 1);
}

for (const invalid of ['busy', 'older', 'stale', 'disabled']) {
    const t = setup({ busy: invalid === 'busy' });
    await t.sandbox.api.init();
    if (invalid === 'older') t.chat.push({ is_user: true });
    if (invalid === 'stale') t.chat[1].extra.diceroll = structuredClone(t.data);
    if (invalid === 'disabled') t.sandbox.extension_settings['ST-Diceroll'].enabled = false;
    await t.sandbox.api.regenerateWithChoice(1, t.data, 1);
    assert.equal(t.state.generations, 0, invalid);
}

{
    const t = setup();
    await t.sandbox.api.init();
    let finish;
    t.state.generateOverride = () => new Promise(resolve => { finish = resolve; });
    const first = t.sandbox.api.regenerateWithChoice(1, t.data, 1);
    await t.sandbox.api.regenerateWithChoice(1, t.data, 0);
    assert.equal(t.state.generations, 1, 'double-click must not start a second generation');
    finish(); // Simulate an early return, e.g. no backend connection.
    await first;
    delete t.state.generateOverride;
    await t.sandbox.api.regenerateWithChoice(1, t.data, 0);
    assert.equal(t.state.generations, 2, 'early return must release the selection');
}

// Appending from any existing variant must preserve every prior text and its roll data.
for (const swipeId of [0, 1, 2]) {
    const t = setup({ swipeId });
    await t.sandbox.api.init();
    const original = t.chat[1];
    const oldSwipes = [...original.swipes];
    const oldInfo = structuredClone(original.swipe_info);
    oldInfo[swipeId] = { extra: structuredClone(original.extra) };
    await t.sandbox.api.regenerateWithChoice(1, t.data, 1);
    assert.equal(t.chat[1], original);
    assert.equal(original.swipe_id, 3);
    assert.deepEqual(original.swipes, [...oldSwipes, 'New reply']);
    assert.deepEqual(original.swipe_info.slice(0, 3), oldInfo);
    assert.equal(original.swipe_info[3].extra.diceroll.chosenIndex, 1);
    assert.equal(t.state.optionRequests, 0);
}

{
    const t = setup({ swipes: null });
    await t.sandbox.api.init();
    await t.sandbox.api.regenerateWithChoice(1, t.data, 1);
    assert.deepEqual(t.chat[1].swipes, ['Original reply', 'New reply']);
    assert.equal(t.chat[1].swipe_info[0].extra.diceroll.chosenIndex, 0);
    assert.equal(t.chat[1].swipe_info[1].extra.diceroll.chosenIndex, 1);
}
console.log('Debug choice regression checks passed.');
