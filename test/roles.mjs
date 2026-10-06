import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from ['"][^'"]+['"];\n/gm, '')
    .replace('export { init };', '');

const USER = 1;
const SYSTEM = 0;

// Runs one steered generation and returns the role of the option request and of the direction.
async function roles({ model, api = 'openai', stored = {} }) {
    const injected = {};
    const sandbox = {
        console, structuredClone, $: () => ({ remove() {} }),
        chat: [{ is_user: true, mes: 'Hello' }], chat_metadata: {},
        extension_settings: { 'ST-Diceroll': { enabled: true, notify: false, ...stored } },
        extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { USER, SYSTEM },
        main_api: api, oai_settings: {}, getChatCompletionModel: () => model,
        saveMetadataDebounced() {}, saveSettingsDebounced() {},
        setExtensionPrompt(id, text, _type, _depth, _scan, role) {
            if (text) injected[id] = role;
        },
        substituteParams: text => text,
        toastr: { warning() {}, info() {} },
        generateQuietPrompt: async () => JSON.stringify({ options: [{ text: 'Open the door', probability: 60 }, { text: 'Run away', probability: 40 }] }),
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    await sandbox.dicerollGenerateInterceptor(sandbox.chat, 0, () => {}, 'normal');
    return { options: injected.diceroll_options_request, direction: injected.diceroll_direction, settings: sandbox.extension_settings['ST-Diceroll'] };
}

// Automatic: Claude keeps a system message, every other model gets a user message.
for (const model of ['anthropic/claude-sonnet-5.5', 'claude-opus-5-5']) {
    const r = await roles({ model });
    assert.deepEqual([r.options, r.direction], [SYSTEM, SYSTEM], model);
}
for (const model of ['xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3', 'google/gemini-3.8-flash']) {
    const r = await roles({ model });
    assert.deepEqual([r.options, r.direction], [USER, USER], model);
}
assert.equal((await roles({ api: 'textgenerationwebui', model: 'local' })).direction, USER);

// The stored 1.0.3 default moves to automatic once; explicit choices after that stay.
const migrated = await roles({ model: 'xiaomi/mimo-v2.6-pro', stored: { optionsRole: 'system', directionRole: 'system' } });
assert.deepEqual([migrated.settings.optionsRole, migrated.settings.directionRole, migrated.settings.autoRoles], ['auto', 'auto', true]);
assert.equal(migrated.direction, USER);
const explicit = await roles({ model: 'xiaomi/mimo-v2.6-pro', stored: { optionsRole: 'system', directionRole: 'system', autoRoles: true } });
assert.deepEqual([explicit.options, explicit.direction], [SYSTEM, SYSTEM]);
const user = await roles({ model: 'anthropic/claude-sonnet-5.5', stored: { optionsRole: 'user', directionRole: 'user' } });
assert.deepEqual([user.options, user.direction], [USER, USER]);

console.log('roles: ok');
