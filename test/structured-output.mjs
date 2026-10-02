import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from ['"][^'"]+['"];\n/gm, '')
    .replace('export { init };', '');

async function optionRequestSchema({ api = 'openai', model, useStructuredOutput = true }) {
    const requests = [];
    const sandbox = {
        console, structuredClone, $: () => ({ remove() {} }),
        chat: [{ is_user: true, mes: 'Hello' }], chat_metadata: {},
        extension_settings: { 'ST-Diceroll': { enabled: true, notify: false, useStructuredOutput } },
        extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { USER: 1, SYSTEM: 0 },
        main_api: api, oai_settings: {}, getChatCompletionModel: () => model,
        saveMetadataDebounced() {}, saveSettingsDebounced() {},
        setExtensionPrompt() {}, substituteParams: text => text,
        toastr: { warning() {}, info() {} },
        generateQuietPrompt: async params => {
            requests.push(params);
            return JSON.stringify({ options: [{ text: 'Open the door', probability: 60 }, { text: 'Run away', probability: 40 }] });
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    await sandbox.dicerollGenerateInterceptor(sandbox.chat, 0, () => {}, 'normal');
    assert.equal(requests.length, 1);
    return requests[0].jsonSchema;
}

// Providers that constrain decoding without touching the prompt keep structured output.
for (const model of ['z-ai/glm-5.3', 'moonshotai/kimi-k3', 'gpt-5.6']) {
    assert.equal((await optionRequestSchema({ model }))?.name, 'diceroll_options', model);
}

// Claude, directly or through a router, must keep the reply's prompt prefix: no schema.
for (const model of ['anthropic/claude-sonnet-5.5', 'claude-opus-5-5', 'anthropic/claude-fable-5.1', 'us.anthropic.claude-opus-5-5']) {
    assert.equal(await optionRequestSchema({ model }), null, model);
}

assert.equal(await optionRequestSchema({ model: 'z-ai/glm-5.3', useStructuredOutput: false }), null);
assert.equal((await optionRequestSchema({ api: 'textgenerationwebui', model: 'claude-like-local-model' }))?.name, 'diceroll_options');

console.log('structured-output: ok');
