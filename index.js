import { extension_settings, renderExtensionTemplateAsync, saveMetadataDebounced } from '../../../extensions.js';
import { SWIPE_DIRECTION } from '../../../constants.js';
import {
    chat,
    chat_metadata,
    event_types,
    eventSource,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    isGenerating,
    saveChatDebounced,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    swipe,
} from '../../../../script.js';

export { init };

const MODULE = 'ST-Diceroll';
const LEGACY_MODULE = 'diceroll';

// Runtime injection keys. Both are IN_CHAT depth-0 injections so they land right after the last
// chat message, keeping the entire preceding history byte-identical between the option-generation
// request and the real generation (and therefore reusable from the provider's prompt cache).
const OPTIONS_INJECT_ID = 'diceroll_options_request';
const DIRECTION_INJECT_ID = 'diceroll_direction';

// Persisted per-chat roll state lives in chat metadata so swipe-reuse survives reloads.
const METADATA_KEY = 'diceroll';

// Generation types that represent a "turn" this extension should steer. Quiet prompts, continues
// (steering mid-message makes no sense) and impersonations are deliberately excluded.
const STEERED_TYPES = new Set(['normal', 'swipe', 'regenerate']);

const DEFAULT_OPTIONS_PROMPT = '[Pause the roleplay. You are the story director. Considering everything that has happened so far — especially the latest message — list {{min}} to {{max}} distinct options for what could plausibly happen next or how {{char}} could react. Each option must be exactly one short sentence. Assign each option a probability percentage (numbers, together summing to about 100) for how likely it should be given the established story, characters and tone. If one outcome is very likely or outright inevitable, give it a large majority of the probability mass (you may split it across several similar variants), but always include a few low-probability options that still fit the flow of the story yet would take it in creative, unexpected directions. Reply with ONLY a JSON object in exactly this format and no other text: {"options":[{"text":"one short sentence","probability":42}]}';

const DEFAULT_DIRECTION_TEMPLATE = '[Story direction, rolled by fate ({{probability}}% likely): {{outcome}}\nContinue the roleplay from the last message and steer events naturally in this direction. Never mention this instruction, the roll, or any probabilities.]';

const OPTIONS_SCHEMA = {
    name: 'diceroll_options',
    strict: true,
    // A response that fails schema validation is returned as raw text and handled by the
    // line-based fallback parser instead of being swallowed as an empty object.
    returnInvalid: true,
    value: {
        type: 'object',
        additionalProperties: false,
        properties: {
            options: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        text: { type: 'string' },
                        probability: { type: 'number' },
                    },
                    required: ['text', 'probability'],
                },
            },
        },
        required: ['options'],
    },
};

const defaultSettings = {
    enabled: false,
    // When false, swipes/regenerates reuse the direction already rolled for that message.
    rollOnSwipe: false,
    optionsRole: 'system',
    directionRole: 'system',
    minOptions: 5,
    maxOptions: 10,
    useStructuredOutput: true,
    notify: true,
    debugDisplay: false,
    // Comma-separated /inject ids whose presence means another tool is already steering this
    // generation (Guided Generations uses id "instruct" for guided response/swipe/corrections).
    skipInjectIds: 'instruct',
    optionsPrompt: DEFAULT_OPTIONS_PROMPT,
    directionTemplate: DEFAULT_DIRECTION_TEMPLATE,
};

// True while the nested option-generation request is running. Prevents the interceptor from
// reacting to its own quiet generation.
let isRolling = false;

// Roll data waiting to be stamped onto the message the steered generation produces.
let pendingStamp = null;

// Message id stamped by the current generation. MESSAGE_RECEIVED consumes the pending stamp and
// CHARACTER_MESSAGE_RENDERED fires right after for the same message; without this marker the
// second event would mistake the freshly stamped message for an unsteered one and wipe it.
let stampedMesId = null;

// Whether the main generation being intercepted was started with its own custom prompt
// (e.g. a swipe/regenerate triggered with an additional instruction). Tracked via
// GENERATION_STARTED because the interceptor does not receive the generation params.
let mainGenHasCustomPrompt = false;

// Exists only while a debug choice is regenerating its reply.
let debugSelection = null;

async function regenerateWithChoice(chatId, sourceData, chosenIndex) {
    const s = getSettings();
    const message = chat[chatId];
    if (!s.enabled || !s.debugDisplay || debugSelection || isGenerating()
        || chatId !== chat.length - 1 || !message || message.is_user || message.is_system
        || message.extra?.diceroll !== sourceData || !sourceData.options[chosenIndex]) {
        return;
    }
    if ($('#chat .mes .edit_textarea').length) {
        toastr.warning('Finish editing before choosing a direction.', 'Diceroll');
        return;
    }

    const data = structuredClone(sourceData);
    data.anchor = chat.findLastIndex(x => x.is_user);
    data.chosenIndex = chosenIndex;
    data.roll = null;
    data.direction = buildDirectionText(data, s);
    const selection = { data, metadata: chat_metadata, consumed: false };
    debugSelection = selection;
    try {
        // Core swipe saves the current reply and its metadata, appends a new slot, and
        // handles generation/failure recovery. Jump past all existing swipes even when
        // the user is currently viewing an earlier one.
        await swipe(null, SWIPE_DIRECTION.RIGHT, {
            message,
            forceSwipeId: Math.max(1, message.swipes?.length ?? 0),
        });
    } catch (error) {
        console.error('[Diceroll] Choice regeneration failed:', error);
        toastr.error('Could not regenerate the reply with this direction.', 'Diceroll');
    } finally {
        if (debugSelection === selection) {
            debugSelection = null;
            clearDirectionInjection();
            renderAllDebug();
        }
    }
}

globalThis.dicerollGenerateInterceptor = (...args) => onGenerationIntercept(...args);

function getSettings() {
    if (extension_settings[MODULE] === undefined && extension_settings[LEGACY_MODULE] !== undefined) {
        extension_settings[MODULE] = structuredClone(extension_settings[LEGACY_MODULE]);
        saveSettingsDebounced();
    }
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = {};
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extension_settings[MODULE];
}

/**
 * True when another tool is already steering this generation with a manual instruction:
 * either a script inject with a configured id (Guided Generations' guided swipe/response
 * inject `id=instruct` before triggering the generation), or a custom prompt passed
 * directly to the generation call.
 * @param {object} s Settings
 * @returns {boolean}
 */
function hasManualSteering(s) {
    if (mainGenHasCustomPrompt) {
        return true;
    }
    const injects = chat_metadata.script_injects ?? {};
    return String(s.skipInjectIds ?? '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
        .some(id => String(injects[id]?.value ?? '').trim());
}

function getRole(name) {
    return name === 'user' ? extension_prompt_roles.USER : extension_prompt_roles.SYSTEM;
}

function setDirectionInjection(text, roleName) {
    setExtensionPrompt(DIRECTION_INJECT_ID, text, extension_prompt_types.IN_CHAT, 0, false, getRole(roleName));
}

function clearDirectionInjection() {
    setDirectionInjection('', 'system');
}

function formatProbability(value) {
    const number = Number(value);
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

/**
 * Runs the option-generation request: the full current chat history plus the instruction injected
 * at depth 0, through the currently selected model/API.
 * @param {object} s Settings
 * @returns {Promise<string>} Raw model response
 */
async function generateOptions(s) {
    const instruction = substituteParams(
        String(s.optionsPrompt)
            .replaceAll('{{min}}', String(s.minOptions))
            .replaceAll('{{max}}', String(s.maxOptions)),
    );
    setExtensionPrompt(OPTIONS_INJECT_ID, instruction, extension_prompt_types.IN_CHAT, 0, false, getRole(s.optionsRole));
    try {
        return await generateQuietPrompt({
            quietPrompt: '',
            jsonSchema: s.useStructuredOutput ? OPTIONS_SCHEMA : null,
        });
    } finally {
        setExtensionPrompt(OPTIONS_INJECT_ID, '', extension_prompt_types.IN_CHAT, 0);
    }
}

function tryParseJson(text) {
    const candidates = [text];
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
        candidates.push(text.slice(objStart, objEnd + 1));
    }
    const arrStart = text.indexOf('[');
    const arrEnd = text.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
        candidates.push(text.slice(arrStart, arrEnd + 1));
    }
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // try the next candidate
        }
    }
    return null;
}

/**
 * Parses model output into a weighted option list. Prefers JSON (structured output or inline),
 * falls back to "text (25%)" / "25% - text" style lines.
 * @param {string} raw Raw model response
 * @returns {{text: string, probability: number}[]|null} At least two options, or null
 */
function parseOptions(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        return null;
    }

    let options = [];
    const parsed = tryParseJson(text);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.options) ? parsed.options : null);
    if (list) {
        options = list.map(item => ({
            text: String(item?.text ?? item?.option ?? '').trim(),
            probability: Number(item?.probability ?? item?.percent ?? item?.chance),
        }));
    } else {
        const trailing = /^(.+?)\s*[-–—:([]?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*[)\]]?\s*$/;
        const leading = /^(\d{1,3}(?:\.\d+)?)\s*%\s*[-–—:]?\s*(.+)$/;
        for (let line of text.split('\n')) {
            line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
            let match = line.match(trailing);
            if (match) {
                options.push({ text: match[1].trim(), probability: Number(match[2]) });
                continue;
            }
            match = line.match(leading);
            if (match) {
                options.push({ text: match[2].trim(), probability: Number(match[1]) });
            }
        }
    }

    options = options.filter(option => option.text && Number.isFinite(option.probability) && option.probability > 0);

    // Models occasionally return fractions instead of percentages.
    const total = options.reduce((sum, option) => sum + option.probability, 0);
    if (total > 0 && total <= 1.5) {
        options = options.map(option => ({ ...option, probability: option.probability * 100 }));
    }

    return options.length >= 2 ? options : null;
}

/**
 * Weighted random roll over the options.
 * @param {{text: string, probability: number}[]} options Parsed options
 * @returns {{options: object[], chosenIndex: number, roll: number, total: number}}
 */
function rollOptions(options) {
    const total = options.reduce((sum, option) => sum + option.probability, 0);
    const roll = Math.random() * total;
    let cumulative = 0;
    let chosenIndex = options.length - 1;
    for (let i = 0; i < options.length; i++) {
        cumulative += options[i].probability;
        if (roll < cumulative) {
            chosenIndex = i;
            break;
        }
    }
    return { options, chosenIndex, roll, total };
}

function buildDirectionText(rollData, s) {
    const chosen = rollData.options[rollData.chosenIndex];
    return substituteParams(
        String(s.directionTemplate)
            .replaceAll('{{outcome}}', chosen.text)
            .replaceAll('{{probability}}', formatProbability(chosen.probability)),
    );
}

/**
 * Temporarily hides the message being swiped away so the option request sees the same history as
 * the swipe generation itself (which pops the last message from its prompt).
 * @returns {(() => void)|null} Restore function
 */
function hideLastMessageForSwipe() {
    const target = chat[chat.length - 1];
    if (!target || target.is_user || target.is_system) {
        return null;
    }
    target.is_system = true;
    return () => {
        target.is_system = false;
    };
}

/**
 * Generation interceptor. Runs the option roll before the actual generation and injects the
 * rolled direction for the upcoming prompt build.
 * @param {object[]} coreChat Filtered chat that will be used for the prompt
 * @param {number} _contextSize Max context size
 * @param {(immediately: boolean) => void} _abort Abort function
 * @param {string} type Generation type
 */
async function onGenerationIntercept(coreChat, _contextSize, _abort, type) {
    const s = getSettings();

    // The nested option request triggers interceptors itself (as type 'quiet').
    if (isRolling || type === 'quiet') {
        return;
    }

    if (!s.enabled) {
        clearDirectionInjection();
        return;
    }

    // Tool-call recursion re-enters Generate as 'normal'; keep the current steering untouched
    // instead of rolling again mid-turn.
    const lastMessage = chat[chat.length - 1];
    if (lastMessage && !lastMessage.is_user && Array.isArray(lastMessage.extra?.tool_invocations)
        && !(debugSelection && !debugSelection.consumed)) {
        return;
    }

    // Never leak a stale direction into an unrelated generation type.
    clearDirectionInjection();
    pendingStamp = null;

    if (!STEERED_TYPES.has(type) || !chat.length) {
        return;
    }

    stampedMesId = null;

    // The message being replaced still shows the previous swipe's debug block; hide it as soon as
    // the new generation starts instead of leaving it stuck until the result arrives.
    if (type === 'swipe' || type === 'regenerate') {
        $(`#chat .mes[mesid="${chat.length - 1}"] .diceroll_debug`).remove();
    }

    // A clicked choice bypasses both option generation and roll-on-swipe, once only.
    if (debugSelection && !debugSelection.consumed && type === 'swipe'
        && debugSelection.metadata === chat_metadata) {
        debugSelection.consumed = true;
        const data = debugSelection.data;
        chat_metadata[METADATA_KEY] = data;
        saveMetadataDebounced();
        pendingStamp = data;
        setDirectionInjection(data.direction, s.directionRole);
        return;
    }

    // A guided swipe/response (or any generation carrying its own instruction) takes precedence:
    // no roll, no direction injection — the manual instruction alone steers this generation.
    if (hasManualSteering(s)) {
        console.debug('[Diceroll] Manual instruction detected, skipping the roll for this generation.');
        return;
    }

    // The roll belongs to the current user turn; swipes/regenerates of the same turn can reuse it.
    const anchor = chat.findLastIndex(x => x.is_user);
    const stored = chat_metadata[METADATA_KEY];
    const isRedo = type === 'swipe' || type === 'regenerate';

    if (isRedo && !s.rollOnSwipe && stored?.direction && stored.anchor === anchor) {
        pendingStamp = stored;
        setDirectionInjection(stored.direction, s.directionRole);
        return;
    }

    let rollData = null;
    isRolling = true;
    const restoreHidden = type === 'swipe' ? hideLastMessageForSwipe() : null;
    try {
        const raw = await generateOptions(s);
        const options = parseOptions(raw);
        if (!options) {
            throw new Error('Could not parse any options from the model response.');
        }
        rollData = rollOptions(options);
    } catch (error) {
        console.error('[Diceroll] Option generation failed:', error);
        toastr.warning('Continuing without steering. ' + (error?.message ?? ''), 'Diceroll: option roll failed', { escapeHtml: true });
    } finally {
        restoreHidden?.();
        isRolling = false;
    }

    if (!rollData) {
        return;
    }

    const data = {
        anchor,
        options: rollData.options,
        chosenIndex: rollData.chosenIndex,
        roll: rollData.roll,
        total: rollData.total,
        direction: '',
    };
    data.direction = buildDirectionText(rollData, s);

    chat_metadata[METADATA_KEY] = data;
    saveMetadataDebounced();
    pendingStamp = data;
    setDirectionInjection(data.direction, s.directionRole);

    if (s.notify) {
        const chosen = rollData.options[rollData.chosenIndex];
        toastr.info(`${chosen.text} (${formatProbability(chosen.probability)}%)`, '🎲 Diceroll', { escapeHtml: true });
    }
}

/**
 * Copies the roll that steered a finished generation onto the produced message, so the debug view
 * stays correct per message and survives reloads. When a main-type generation finishes WITHOUT a
 * roll (extension disabled, roll failed, or a manual instruction steered it), the roll record
 * inherited in place from the previous swipe's extra is dropped instead.
 * @param {number} chatId Message index
 * @param {string} type Generation type the message event was emitted with
 */
function stampMessage(chatId, type) {
    const message = chat[chatId];
    if (!message || message.is_user || message.is_system) {
        return;
    }
    if (pendingStamp) {
        message.extra = message.extra || {};
        message.extra.diceroll = structuredClone(pendingStamp);
        pendingStamp = null;
        stampedMesId = chatId;
        saveChatDebounced();
    } else if (STEERED_TYPES.has(type) && stampedMesId !== chatId && message.extra?.diceroll) {
        delete message.extra.diceroll;
        saveChatDebounced();
    }
}

function renderDebugForMessage(chatId) {
    const mesElement = $(`#chat .mes[mesid="${chatId}"]`);
    if (!mesElement.length) {
        return;
    }
    mesElement.find('.diceroll_debug').remove();

    const message = chat[chatId];
    const data = message?.extra?.diceroll;
    if (!getSettings().debugDisplay || !data || !Array.isArray(data.options)) {
        return;
    }

    // An overswipe points swipe_id one past the existing swipes while its generation is running;
    // the roll record on the message still belongs to the previous swipe then, so show nothing.
    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipes) && message.swipe_id >= message.swipes.length) {
        return;
    }

    const chosen = data.options[data.chosenIndex];
    const details = $('<details class="diceroll_debug"></details>');
    const rollInfo = Number.isFinite(data.roll) ? `, roll ${data.roll.toFixed(1)}/${formatProbability(data.total)}` : '';
    details.append($('<summary></summary>').text(`🎲 ${chosen?.text ?? '?'} (${formatProbability(chosen?.probability ?? 0)}%${rollInfo})`));

    const table = $('<table class="diceroll_debug_table"></table>');
    data.options.forEach((option, index) => {
        const row = $('<tr></tr>').toggleClass('diceroll_chosen', index === data.chosenIndex);
        row.append($('<td></td>').text(`${formatProbability(option.probability)}%`));
        const cell = $('<td></td>');
        if (getSettings().enabled && chatId === chat.length - 1 && !message.is_user && !message.is_system) {
            cell.append($('<button type="button" class="diceroll_choice"></button>')
                .text(option.text)
                .attr('title', 'Generate a new swipe with this direction, keeping all previous swipes')
                .on('click', () => regenerateWithChoice(chatId, data, index)));
        } else {
            cell.text(option.text);
        }
        row.append(cell);
        table.append(row);
    });
    details.append(table);
    details.append($('<div class="diceroll_debug_direction"></div>').text(data.direction ?? ''));

    const anchorElement = mesElement.find('.mes_block .mes_text').first();
    if (anchorElement.length) {
        anchorElement.after(details);
    } else {
        mesElement.append(details);
    }
}

function renderAllDebug() {
    $('#chat .mes').each((_, element) => {
        renderDebugForMessage(Number(element.getAttribute('mesid')));
    });
}

function loadSettingsUi() {
    const s = getSettings();
    $('#diceroll_enabled').prop('checked', s.enabled);
    $('#diceroll_roll_on_swipe').prop('checked', s.rollOnSwipe);
    $('#diceroll_structured').prop('checked', s.useStructuredOutput);
    $('#diceroll_notify').prop('checked', s.notify);
    $('#diceroll_debug').prop('checked', s.debugDisplay);
    $('#diceroll_min_options').val(s.minOptions);
    $('#diceroll_max_options').val(s.maxOptions);
    $('#diceroll_options_role').val(s.optionsRole);
    $('#diceroll_direction_role').val(s.directionRole);
    $('#diceroll_skip_inject_ids').val(s.skipInjectIds);
    $('#diceroll_options_prompt').val(s.optionsPrompt);
    $('#diceroll_direction_template').val(s.directionTemplate);
}

function setupListeners() {
    const bindCheckbox = (id, key, onChange = null) => {
        $(id).on('change', function () {
            getSettings()[key] = !!$(this).prop('checked');
            saveSettingsDebounced();
            onChange?.();
        });
    };

    bindCheckbox('#diceroll_enabled', 'enabled', () => {
        if (!getSettings().enabled) {
            clearDirectionInjection();
        }
    });
    bindCheckbox('#diceroll_roll_on_swipe', 'rollOnSwipe');
    bindCheckbox('#diceroll_structured', 'useStructuredOutput');
    bindCheckbox('#diceroll_notify', 'notify');
    bindCheckbox('#diceroll_debug', 'debugDisplay', renderAllDebug);

    $('#diceroll_min_options').on('input', function () {
        getSettings().minOptions = Math.max(2, Number($(this).val()) || defaultSettings.minOptions);
        saveSettingsDebounced();
    });
    $('#diceroll_max_options').on('input', function () {
        getSettings().maxOptions = Math.max(2, Number($(this).val()) || defaultSettings.maxOptions);
        saveSettingsDebounced();
    });
    $('#diceroll_options_role').on('change', function () {
        getSettings().optionsRole = String($(this).val());
        saveSettingsDebounced();
    });
    $('#diceroll_direction_role').on('change', function () {
        getSettings().directionRole = String($(this).val());
        saveSettingsDebounced();
    });
    $('#diceroll_skip_inject_ids').on('input', function () {
        getSettings().skipInjectIds = String($(this).val());
        saveSettingsDebounced();
    });
    $('#diceroll_options_prompt').on('input', function () {
        getSettings().optionsPrompt = String($(this).val());
        saveSettingsDebounced();
    });
    $('#diceroll_direction_template').on('input', function () {
        getSettings().directionTemplate = String($(this).val());
        saveSettingsDebounced();
    });
    $('#diceroll_options_prompt_restore').on('click', () => {
        getSettings().optionsPrompt = DEFAULT_OPTIONS_PROMPT;
        $('#diceroll_options_prompt').val(DEFAULT_OPTIONS_PROMPT);
        saveSettingsDebounced();
    });
    $('#diceroll_direction_template_restore').on('click', () => {
        getSettings().directionTemplate = DEFAULT_DIRECTION_TEMPLATE;
        $('#diceroll_direction_template').val(DEFAULT_DIRECTION_TEMPLATE);
        saveSettingsDebounced();
    });
}

async function init() {
    const settingsHtml = await renderExtensionTemplateAsync(`third-party/${MODULE}`, 'settings');
    $('#extensions_settings2').append(settingsHtml);
    loadSettingsUi();
    setupListeners();

    // A new user message starts a new turn; any previous roll no longer applies.
    eventSource.on(event_types.MESSAGE_SENT, () => {
        delete chat_metadata[METADATA_KEY];
    });

    // Runs before the interceptor within the same Generate() call, so the flag is always fresh.
    // The nested option request (type 'quiet') must not overwrite the outer generation's flag.
    eventSource.on(event_types.GENERATION_STARTED, (type, params, dryRun) => {
        if (type !== 'quiet' && !dryRun) {
            mainGenHasCustomPrompt = !!params?.quiet_prompt;
        }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (chatId, type) => stampMessage(chatId, type));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (chatId, type) => {
        stampMessage(chatId, type);
        renderDebugForMessage(chatId);
    });
    eventSource.on(event_types.MESSAGE_SWIPED, (chatId) => renderDebugForMessage(chatId));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        debugSelection = null;
        pendingStamp = null;
        stampedMesId = null;
        clearDirectionInjection();
        renderAllDebug();
    });

    // The direction is consumed by exactly one generation. GENERATION_ENDED also fires when the
    // nested option request finishes, which is why clearing is skipped while a roll is in flight.
    // With streaming, the UI unlock that emits GENERATION_ENDED happens BEFORE MESSAGE_RECEIVED,
    // so only the injection may be cleared here — the pending stamp must survive until the
    // message events consume it (the interceptor resets it at the start of every next turn).
    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (isRolling) {
            return;
        }
        clearDirectionInjection();
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        if (isRolling) {
            return;
        }
        pendingStamp = null;
        clearDirectionInjection();
    });
}
