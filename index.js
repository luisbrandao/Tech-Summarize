import { debounce, isTrueBoolean } from '../../../utils.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxPromptTokens,
    setExtensionPrompt,
    animation_easing,
} from '../../../../script.js';
import { loadMovingUIState, power_user } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { debounce_timeout } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { macros, MacroCategory } from '../../../macros/macro-system.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { MacrosParser } from '/scripts/macros.js';

const MODULE_NAME = 'tech_summarize';
const SETTINGS_KEY = 'tech_summarize';

// Derive the extension name from the script URL for renderExtensionTemplateAsync.
// Built-in: "memory" | Third-party: "third-party/Tech-Summarize"
const extensionName = new URL('.', import.meta.url).pathname
    .replace(/^\/scripts\/extensions\//, '')
    .replace(/\/$/, '');

let inApiCall = false;

/** Shorthand accessor for this extension's settings. */
function settings() {
    return extension_settings[SETTINGS_KEY];
}

async function countSourceTokens(text, padding = 0) {
    return await getTokenCountAsync(text, padding);
}

async function getSourceContextSize() {
    const overrideLength = settings().overrideResponseLength;
    return getMaxPromptTokens(overrideLength);
}

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

const prompt_builders = {
    DEFAULT: 0,
    RAW_BLOCKING: 1,
    RAW_NON_BLOCKING: 2,
    CONNECTION_PROFILE: 3,
};

// --- Section definitions ---
const summarySections = ['characters', 'body', 'lore'];

// Base directory of this extension, derived from import.meta.url for portability.
const extensionBaseUrl = new URL('.', import.meta.url).toString();

// Default prompts loaded from external files at init time.
const defaultSectionPrompts = {
    characters: '',
    body: '',
    lore: '',
};

/**
 * Load default section prompts from text files next to this script.
 * Uses extensionBaseUrl so paths survive if the plugin is moved/renamed.
 */
async function loadDefaultPrompts() {
    const files = {
        characters: 'default-prompt-characters.txt',
        body: 'default-prompt-body.txt',
        lore: 'default-prompt-lore.txt',
    };
    for (const [section, filename] of Object.entries(files)) {
        try {
            const response = await fetch(new URL(filename, extensionBaseUrl));
            if (response.ok) {
                defaultSectionPrompts[section] = (await response.text()).trim();
            } else {
                console.warn(`Failed to load default prompt for ${section}: ${response.status}`);
            }
        } catch (error) {
            console.warn(`Error loading default prompt for ${section}:`, error);
        }
    }
}

const defaultSectionLabels = {
    characters: 'Characters',
    body: 'Events & Plot',
    lore: 'World & Lore',
};

const defaultTemplate = '<roleplay_abstract>\n<session_characters>\n{{summary_characters}}\n</session_characters>\n\n<session_timeline>\n{{summary_body}}\n</session_timeline>\n\n<session_lore>\n{{summary_lore}}\n</session_lore>\n</roleplay_abstract>';

const defaultSettings = {
    SkipWIAN: false,
    source: 'main',
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    depth: 2,
    overrideResponseLength: 0,
    overrideResponseLengthMin: 0,
    overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16,
    maxMessagesPerRequest: 0,
    maxMessagesPerRequestMin: 0,
    maxMessagesPerRequestMax: 250,
    maxMessagesPerRequestStep: 1,
    prompt_builder: prompt_builders.DEFAULT,
    // [Connection profile builder] Independent connection for summarization, so it can run on a
    // different model than the main reply. "current" = SillyTavern's active connection profile.
    connectionProfile: 'current',
    // [Connection profile builder] Completion preset. "current" = the profile's own preset.
    completionPreset: 'current',
    // [Connection profile builder] Context budget (tokens) for composing the summary prompt.
    // 0 = auto: use the profile/preset's own context size (falling back to the app's max context).
    connectionContextSize: 0,
    // Per-section settings (prompts populated after loadDefaultPrompts)
    sections: {
        characters: { prompt: '', content: '' },
        body: { prompt: '', content: '' },
        lore: { prompt: '', content: '' },
    },
};

/**
 * Assemble the combined summary from all sections into the injection template.
 * @returns {string} Formatted memory value ready for injection
 */
function formatMemoryValue() {
    const sections = settings().sections || {};
    const chars = (sections.characters && sections.characters.content) || '';
    const body = (sections.body && sections.body.content) || '';
    const lore = (sections.lore && sections.lore.content) || '';

    if (!chars && !body && !lore) {
        return '';
    }

    const template = settings().template || defaultTemplate;
    return substituteParamsExtended(template, {
        summary_characters: chars.trim(),
        summary_body: body.trim(),
        summary_lore: lore.trim(),
        // Keep backward compat: {{summary}} resolves to the combined text
        summary: [chars.trim(), body.trim(), lore.trim()].filter(Boolean).join('\n\n'),
    });
}

// --- Settings load/save ---

function loadSettings() {
    if (Object.keys(settings()).length === 0) {
        Object.assign(settings(), defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (key === 'sections') continue;
        if (settings()[key] === undefined) {
            settings()[key] = defaultSettings[key];
        }
    }

    // Migrate: if old-style prompt/content exist but no sections, migrate
    if (!settings().sections) {
        settings().sections = JSON.parse(JSON.stringify(defaultSettings.sections));
        // If there was old prompt/content, put into body section
        if (settings().prompt && settings().prompt !== defaultSettings.prompt) {
            settings().sections.body.prompt = settings().prompt;
        }
    }

    // Ensure all sections exist with defaults
    for (const section of summarySections) {
        if (!settings().sections[section]) {
            settings().sections[section] = JSON.parse(JSON.stringify(defaultSettings.sections[section]));
        }
        const sec = settings().sections[section];
        // Use file-loaded defaults for prompts when empty or undefined
        if (!sec.prompt) sec.prompt = defaultSectionPrompts[section] || '';
        if (sec.content === undefined) sec.content = '';
    }

    // Load global controls
    $('#ts_skipWIAN').prop('checked', settings().SkipWIAN).trigger('input');
    $('#ts_template').val(settings().template).trigger('input');
    $('#ts_depth').val(settings().depth).trigger('input');
    $('#ts_role').val(settings().role).trigger('input');
    $(`input[name="ts_position"][value="${settings().position}"]`).prop('checked', true).trigger('input');
    $(`input[name="ts_prompt_builder"][value="${settings().prompt_builder}"]`).prop('checked', true).trigger('input');
    $('#ts_override_response_length').val(settings().overrideResponseLength).trigger('input');
    $('#ts_max_messages_per_request').val(settings().maxMessagesPerRequest).trigger('input');
    $('#ts_include_wi_scan').prop('checked', settings().scan).trigger('input');
    populateConnectionProfiles();
    populateCompletionPresets();
    $('#ts_connection_context').val(settings().connectionContextSize);
    toggleConnectionBlock();

    // Load per-section controls
    for (const section of summarySections) {
        const sec = settings().sections[section];
        $(`#ts_section_content_${section}`).val(sec.content);
        $(`#ts_section_prompt_${section}`).val(sec.prompt);
    }
}

// --- Global event handlers ---

function onSkipWIANInput() {
    const value = Boolean($(this).prop('checked'));
    settings().SkipWIAN = value;
    saveSettingsDebounced();
}

function onTemplateInput() {
    const value = $(this).val();
    settings().template = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onDepthInput() {
    const value = $(this).val();
    settings().depth = Number(value);
    reinsertMemory();
    saveSettingsDebounced();
}

function onRoleInput() {
    const value = $(this).val();
    settings().role = Number(value);
    reinsertMemory();
    saveSettingsDebounced();
}

function onPositionChange(e) {
    const value = e.target.value;
    settings().position = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onIncludeWIScanInput() {
    const value = !!$(this).prop('checked');
    settings().scan = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onPromptBuilderInput(e) {
    const value = Number(e.target.value);
    settings().prompt_builder = value;
    toggleConnectionBlock();
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    const value = $(this).val();
    settings().overrideResponseLength = Number(value);
    $('#ts_override_response_length_value').text(settings().overrideResponseLength);
    saveSettingsDebounced();
}

function onMaxMessagesPerRequestInput() {
    const value = $(this).val();
    settings().maxMessagesPerRequest = Number(value);
    $('#ts_max_messages_per_request_value').text(settings().maxMessagesPerRequest);
    saveSettingsDebounced();
}

// --- Connection profile UI ---

function populateConnectionProfiles() {
    const select = $('#ts_connection_profile');
    select.empty();
    select.append($('<option>').val('current').text('Use current connection'));
    try {
        const ctx = getContext();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles ?? [];
        for (const p of profiles) {
            if (p?.name) select.append($('<option>').val(p.name).text(p.name));
        }
    } catch (error) {
        console.warn('Tech-Summarize: failed to load connection profiles:', error);
    }
    select.val(settings().connectionProfile);
}

function populateCompletionPresets() {
    const select = $('#ts_completion_preset');
    select.empty();
    select.append($('<option>').val('current').text('Use connection profile default'));
    try {
        const ctx = getContext();
        const profile = resolveProfileByName(ctx, settings().connectionProfile);
        const apiId = profile?.mode === 'cc' ? 'openai' : 'textgenerationwebui';
        const presetManager = ctx.getPresetManager(apiId);
        const names = presetManager?.getPresetList?.()?.preset_names ?? [];
        const list = Array.isArray(names) ? names : Object.keys(names);
        for (const name of list) {
            select.append($('<option>').val(name).text(name));
        }
    } catch (error) {
        console.warn('Tech-Summarize: failed to load completion presets:', error);
    }
    select.val(settings().completionPreset);
}

/** Shows the connection profile controls only when the connection-profile builder is selected. */
function toggleConnectionBlock() {
    $('#ts_connection_block').toggle(settings().prompt_builder === prompt_builders.CONNECTION_PROFILE);
}

function onConnectionProfileChange() {
    settings().connectionProfile = String($(this).val());
    settings().completionPreset = 'current';
    populateCompletionPresets();
    saveSettingsDebounced();
}

function onCompletionPresetChange() {
    settings().completionPreset = String($(this).val());
    saveSettingsDebounced();
}

function onConnectionContextInput() {
    settings().connectionContextSize = Number($(this).val()) || 0;
    saveSettingsDebounced();
}

// --- Per-section event handlers ---

function onSectionContentInput(section) {
    const value = $(`#ts_section_content_${section}`).val();
    settings().sections[section].content = value;
    reinsertMemory();
    saveSectionToMessage();
    saveSettingsDebounced();
}

function onSectionPromptInput(section) {
    const value = $(`#ts_section_prompt_${section}`).val();
    settings().sections[section].prompt = value;
    saveSettingsDebounced();
}

function onSectionPromptRestoreClick(section) {
    $(`#ts_section_prompt_${section}`).val(defaultSectionPrompts[section]).trigger('input');
}

/**
 * Restore all section prompts and the injection template to their defaults.
 * Leaves the summary contents (and every other setting) untouched.
 */
function onResetPromptsClick() {
    for (const section of summarySections) {
        $(`#ts_section_prompt_${section}`).val(defaultSectionPrompts[section]).trigger('input');
    }
    $('#ts_template').val(defaultTemplate).trigger('input');
    toastr.success('Section prompts and injection template restored to defaults.', 'Tech-Summarize');
}

// --- Chat memory storage ---

/**
 * Get the latest section-based memory from the chat.
 * @param {Array} chat Chat messages
 * @returns {object} Object with section contents: {characters, body, lore}
 */
function getLatestMemoryFromChat(chat) {
    const empty = { characters: '', body: '', lore: '' };
    if (!Array.isArray(chat) || !chat.length) {
        return empty;
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) {
            // Handle legacy string format
            if (typeof mes.extra.memory === 'string') {
                return { characters: '', body: mes.extra.memory, lore: '' };
            }
            return {
                characters: mes.extra.memory.characters || '',
                body: mes.extra.memory.body || '',
                lore: mes.extra.memory.lore || '',
            };
        }
    }

    return empty;
}

/**
 * Get the index of the latest memory summary from the chat.
 * @param {Array} chat Chat messages
 * @returns {number} Index of the latest memory summary or -1 if not found
 */
function getIndexOfLatestChatSummary(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return -1;
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) {
            return chat.indexOf(mes);
        }
    }

    return -1;
}

function isContextChanged(context) {
    const newContext = getContext();
    if (newContext.groupId !== context.groupId
        || newContext.chatId !== context.chatId
        || (!newContext.groupId && (newContext.characterId !== context.characterId))) {
        console.log('Context changed, summary discarded');
        return true;
    }
    return false;
}

function onChatChanged() {
    const context = getContext();
    const latestMemory = getLatestMemoryFromChat(context.chat);
    setSectionContents(latestMemory, false);
}

/**
 * Set all section contents from an object and update the UI.
 * @param {object} memoryObj {characters, body, lore}
 * @param {boolean} saveToMessage Whether to save to chat message extra
 * @param {number|null} index Chat message index to save to
 */
function setSectionContents(memoryObj, saveToMessage, index = null) {
    const sections = settings().sections;
    for (const section of summarySections) {
        sections[section].content = memoryObj[section] || '';
        $(`#ts_section_content_${section}`).val(sections[section].content);
    }

    // Update the extension prompt injection
    const formatted = formatMemoryValue();
    setExtensionPrompt(MODULE_NAME, formatted, settings().position, settings().depth, settings().scan, settings().role);

    const context = getContext();
    if (saveToMessage && context.chat.length) {
        const idx = index ?? context.chat.length - 2;
        const mes = context.chat[idx < 0 ? 0 : idx];
        if (!mes.extra) {
            mes.extra = {};
        }
        mes.extra.memory = {
            characters: sections.characters.content,
            body: sections.body.content,
            lore: sections.lore.content,
        };
        saveChatDebounced();
    }
}

/**
 * Set a single section's content and save.
 * @param {string} section Section name
 * @param {string} value Section content
 * @param {boolean} saveToMessage Whether to save to chat
 * @param {number|null} index Chat message index
 */
function setSectionContent(section, value, saveToMessage, index = null) {
    settings().sections[section].content = value;
    $(`#ts_section_content_${section}`).val(value);

    // Re-inject the combined prompt
    const formatted = formatMemoryValue();
    setExtensionPrompt(MODULE_NAME, formatted, settings().position, settings().depth, settings().scan, settings().role);

    if (saveToMessage) {
        saveSectionToMessage(index);
    }
}

function saveSectionToMessage(index = null) {
    const context = getContext();
    if (!context.chat.length) return;

    const sections = settings().sections;
    const idx = index ?? context.chat.length - 2;
    const mes = context.chat[idx < 0 ? 0 : idx];
    if (!mes.extra) {
        mes.extra = {};
    }
    mes.extra.memory = {
        characters: sections.characters.content,
        body: sections.body.content,
        lore: sections.lore.content,
    };
    saveChatDebounced();
}

function reinsertMemory() {
    const formatted = formatMemoryValue();
    setExtensionPrompt(MODULE_NAME, formatted, settings().position, settings().depth, settings().scan, settings().role);
}

// --- Restore ---

/**
 * Restore a single section to its previous value by walking back through chat history.
 * Finds the most recent stored value that differs from the current content.
 * @param {string} section Section name (characters, body, lore)
 */
function onSectionContentRestoreClick(section) {
    const context = getContext();
    const currentContent = settings().sections[section].content || '';

    for (let i = context.chat.length - 2; i >= 0; i--) {
        const mes = context.chat[i];
        if (!mes.extra || !mes.extra.memory) continue;

        const stored = mes.extra.memory;
        let storedValue = '';
        if (typeof stored === 'string') {
            storedValue = section === 'body' ? stored : '';
        } else {
            storedValue = stored[section] || '';
        }

        if (storedValue !== currentContent) {
            setSectionContent(section, storedValue, true);
            return;
        }
    }

    // No different previous value found - clear the section
    if (currentContent) {
        setSectionContent(section, '', true);
    }
}

/**
 * Force-summarize a single section.
 * @param {string} section Section name
 * @param {boolean} quiet Suppress toast
 * @returns {Promise<string>} Summarized text
 */
async function forceSummarizeSection(section, quiet) {
    const context = getContext();
    const skipWIAN = settings().SkipWIAN;

    const label = defaultSectionLabels[section] || section;
    const toast = quiet ? jQuery() : toastr.info(`Summarizing ${label}...`, 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    const value = await summarizeSectionMain(context, section, true, skipWIAN);

    toastr.clear(toast);

    if (!value) {
        toastr.warning(`Failed to summarize ${label}`);
        return '';
    }

    return value;
}

/**
 * Force-summarize all sections.
 * @param {boolean} quiet Suppress toast
 * @returns {Promise<string>} Combined summary
 */
async function forceSummarizeChat(quiet) {
    const context = getContext();
    const skipWIAN = settings().SkipWIAN;

    const toast = quiet ? jQuery() : toastr.info('Summarizing all sections...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    const results = [];

    for (const section of summarySections) {
        const value = await summarizeSectionMain(context, section, true, skipWIAN);
        if (value) results.push(value);
        if (isContextChanged(context)) break;
    }

    toastr.clear(toast);

    if (results.length === 0) {
        toastr.warning('Failed to summarize chat');
        return '';
    }

    return results.join('\n\n');
}

/**
 * Summarize a single section using the main API.
 */
async function summarizeSectionMain(context, section, force, skipWIAN) {
    const sectionSettings = settings().sections[section];
    const prompt = sectionSettings.prompt;

    if (!prompt) {
        console.debug(`Summarization prompt for section "${section}" is empty. Skipping.`);
        return;
    }

    console.log(`Sending summary prompt for section: ${section}`);
    let summary = '';
    let index = null;

    if (prompt_builders.DEFAULT === settings().prompt_builder) {
        try {
            inApiCall = true;
            const params = {
                quietPrompt: prompt,
                skipWIAN: skipWIAN,
                responseLength: settings().overrideResponseLength,
            };
            summary = await generateQuietPrompt(params);
        } finally {
            inApiCall = false;
        }
    }

    if ([prompt_builders.RAW_BLOCKING, prompt_builders.RAW_NON_BLOCKING].includes(settings().prompt_builder)) {
        const lock = settings().prompt_builder === prompt_builders.RAW_BLOCKING;
        try {
            inApiCall = true;
            if (lock) {
                deactivateSendButtons();
            }

            const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt, section);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) {
                    toastr.info('To try again, remove the latest summary.', `No messages found to summarize (${defaultSectionLabels[section]})`);
                }
                return null;
            }

            const params = {
                prompt: rawPrompt,
                systemPrompt: prompt,
                responseLength: settings().overrideResponseLength,
            };
            const rawSummary = await generateRaw(params);
            summary = removeReasoningFromString(rawSummary);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            if (lock) {
                activateSendButtons();
            }
        }
    }

    if (prompt_builders.CONNECTION_PROFILE === settings().prompt_builder) {
        try {
            inApiCall = true;
            const result = await summarizeSectionViaProfile(context, section, prompt);

            if (!result) {
                if (force) {
                    toastr.info('To try again, remove the latest summary.', `No messages found to summarize (${defaultSectionLabels[section]})`);
                }
                return null;
            }

            summary = result.summary;
            index = result.lastUsedIndex;
        } catch (error) {
            toastr.error(String(error?.message || error), 'Summary request failed');
            console.error('Tech-Summarize: connection-profile request failed:', error);
            return null;
        } finally {
            inApiCall = false;
        }
    }

    if (!summary) {
        console.warn(`Empty summary received for section: ${section}`);
        return;
    }

    if (isContextChanged(context)) {
        return;
    }

    setSectionContent(section, summary, true, index);
    return summary;
}

/**
 * Get the raw summarization prompt from the chat context.
 */
async function getRawSummaryPrompt(context, prompt, section) {
    function getMemoryString(includeSystem) {
        const delimiter = '\n\n';
        const stringBuilder = [];
        const bufferString = chatBuffer.slice().join(delimiter);

        if (includeSystem) {
            stringBuilder.push(prompt);
        }

        if (latestSectionSummary) {
            stringBuilder.push(latestSectionSummary);
        }

        stringBuilder.push(bufferString);

        return stringBuilder.join(delimiter).trim();
    }

    const chat = context.chat.slice();
    const latestMemory = getLatestMemoryFromChat(chat);
    const latestSectionSummary = latestMemory[section] || '';
    const latestSummaryIndex = getIndexOfLatestChatSummary(chat);
    chat.pop();
    const chatBuffer = [];
    const PADDING = 64;
    const PROMPT_SIZE = await getSourceContextSize();
    let latestUsedMessage = null;

    for (let index = latestSummaryIndex + 1; index < chat.length; index++) {
        const message = chat[index];

        if (!message) break;
        if (message.is_system || !message.mes) continue;

        const entry = `${message.name}:\n${message.mes}`;
        chatBuffer.push(entry);

        const tokens = await countSourceTokens(getMemoryString(true), PADDING);

        if (tokens > PROMPT_SIZE) {
            chatBuffer.pop();
            break;
        }

        latestUsedMessage = message;

        if (settings().maxMessagesPerRequest > 0 && chatBuffer.length >= settings().maxMessagesPerRequest) {
            break;
        }
    }

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);
    const rawPrompt = getMemoryString(false);
    return { rawPrompt, lastUsedIndex };
}

// --- Connection-profile prompt builder ---

// Tokens kept free on top of the reserved response so we never butt right up against the limit.
const CONTEXT_SAFETY_MARGIN = 256;
// Rough per-message token overhead (role wrapper) when budgeting history.
const PER_MESSAGE_OVERHEAD = 4;
// Cap on how many recent messages are scanned for World Info activation (perf guard).
const WORLD_INFO_SCAN_CAP = 100;

/**
 * Resolves a connection profile id by name. "current" => the active profile.
 */
function getProfileIdByName(ctx, name) {
    const cm = ctx?.extensionSettings?.connectionManager;
    if (!cm) return null;
    if (name === 'current') return cm.selectedProfile;
    const p = cm.profiles?.find((x) => x.name === name);
    return p ? p.id : null;
}

/**
 * Resolves a connection profile object by name. "current" => the active profile.
 */
function resolveProfileByName(ctx, name) {
    const cm = ctx?.extensionSettings?.connectionManager;
    if (!cm || !Array.isArray(cm.profiles)) return null;
    if (name === 'current') return cm.profiles.find((p) => p.id === cm.selectedProfile) ?? null;
    return cm.profiles.find((p) => p.name === name) ?? null;
}

/** Max output tokens a completion preset defines (openai_max_tokens for CC, genamt for textgen). */
function resolvePresetMaxTokens(ctx, profile, presetName) {
    if (!presetName) return null;
    try {
        const isCc = profile?.mode === 'cc';
        const preset = ctx.getPresetManager(isCc ? 'openai' : 'textgenerationwebui')?.getCompletionPresetByName?.(presetName);
        if (!preset) return null;
        const max = isCc ? preset.openai_max_tokens : preset.genamt;
        return typeof max === 'number' && max > 0 ? max : null;
    } catch (error) {
        console.warn('Tech-Summarize: could not resolve preset max tokens:', error);
        return null;
    }
}

/** Context size a completion preset defines (openai_max_context for CC, max_context for textgen). */
function resolvePresetMaxContext(ctx, profile, presetName) {
    if (!presetName) return null;
    try {
        const isCc = profile?.mode === 'cc';
        const preset = ctx.getPresetManager(isCc ? 'openai' : 'textgenerationwebui')?.getCompletionPresetByName?.(presetName);
        if (!preset) return null;
        const size = isCc ? preset.openai_max_context : preset.max_context;
        return typeof size === 'number' && size > 0 ? size : null;
    } catch (error) {
        console.warn('Tech-Summarize: could not resolve preset max context:', error);
        return null;
    }
}

/**
 * Resolves the summarizer's connection: profile, preset, and the token budgets used to compose the
 * prompt — the response reservation and the total context size (explicit override, else the
 * preset's value, falling back to the app's current max context).
 */
function resolveSummaryConnection(ctx) {
    const profileId = getProfileIdByName(ctx, settings().connectionProfile);
    if (!profileId) throw new Error(`Summary connection profile not found: ${settings().connectionProfile}`);

    let profile = null;
    try {
        profile = ctx.ConnectionManagerRequestService?.getProfile?.(profileId) ?? null;
    } catch (error) {
        profile = null;
    }

    const usePreset = settings().completionPreset && settings().completionPreset !== 'current';
    const presetName = usePreset ? settings().completionPreset : profile?.preset;

    const responseTokens = settings().overrideResponseLength > 0
        ? Number(settings().overrideResponseLength)
        : (resolvePresetMaxTokens(ctx, profile, presetName) || 1024);

    const sizeOverride = Number(settings().connectionContextSize) || 0;
    const contextSize = sizeOverride > 0
        ? sizeOverride
        : (resolvePresetMaxContext(ctx, profile, presetName) || Number(ctx.maxContext) || 8192);

    return { profileId, profile, presetName, usePreset, responseTokens, contextSize };
}

/**
 * Scans recent chat for active World Info / lorebook entries (dry run, emits no events) so the
 * summarizer sees the same lore the roleplay does. Returns "" if unavailable.
 */
async function getActiveWorldInfo(ctx, context, contextSize) {
    try {
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const messages = context.chat
            .filter((c) => !c.is_system && c.mes)
            .slice(-WORLD_INFO_SCAN_CAP)
            .map((c) => `${c.name}: ${String(c.mes || '').trim()}`);
        if (messages.length === 0) return '';
        const chatForWI = messages.slice().reverse(); // getWorldInfoPrompt expects most-recent-first
        const maxContext = Number(contextSize) || Number(ctx.maxContext) || 8192;
        const { worldInfoString } = await ctx.getWorldInfoPrompt(chatForWI, maxContext, true);
        return String(worldInfoString || '').trim();
    } catch (error) {
        console.warn('Tech-Summarize: failed to gather world info:', error);
        return '';
    }
}

/**
 * Builds the system prompt for the connection-profile builder as labeled sections, in this order:
 *   ### Character card             (description + personality + scenario)
 *   ### Player character: <name>   (always shown; persona description if present)
 *   ### World Info                 (active lorebook entries; skipped when "No WI/AN" is on)
 *   ### Previous summary           (this section's latest stored summary, if any)
 * Macros like {{user}} / {{char}} are resolved via substituteParams.
 */
async function buildSummarySystemPrompt(ctx, context, previousSummary, contextSize) {
    const sub = (value) => {
        const s = String(value ?? '').replace(/\r/g, '');
        try {
            return typeof ctx.substituteParams === 'function' ? String(ctx.substituteParams(s)) : s;
        } catch (error) {
            return s;
        }
    };

    const sections = [];

    try {
        const char = ctx.characters && ctx.characterId != null ? ctx.characters[ctx.characterId] : null;
        if (char) {
            const card = sub([char.description, char.personality, char.scenario]
                .map((p) => String(p ?? '').trim())
                .filter(Boolean)
                .join('\n')).trim();
            if (card) sections.push(`### Character card\n${card}`);
        }

        const userName = sub('{{user}}').trim() || 'User';
        const persona = sub(ctx.getCharacterCardFields?.()?.persona ?? '').trim();
        sections.push(`### Player character: ${userName}${persona ? `\n${persona}` : ''}`);
    } catch (error) {
        console.warn('Tech-Summarize: failed to build system prompt sections:', error);
    }

    if (!settings().SkipWIAN) {
        const worldInfo = await getActiveWorldInfo(ctx, context, contextSize);
        if (worldInfo) sections.push(`### World Info\n${worldInfo}`);
    }

    const previous = String(previousSummary || '').trim();
    if (previous) sections.push(`### Previous summary\n${previous}`);

    return sections.join('\n\n').trim();
}

/**
 * Builds the summary chat-completion message array:
 * system (character card + player persona + world info + previous summary) + as many unsummarized
 * chat messages as fit the context budget + the section's summarize prompt as the final message.
 * The summarize prompt ends the array as a USER turn: standard chat-completion backends always add
 * a generation prompt, so a trailing assistant message would render as a completed turn and the
 * model would emit an end token immediately (dies after 1 token).
 */
async function buildSummaryMessages(ctx, context, section, prompt, conn) {
    const latestMemory = getLatestMemoryFromChat(context.chat);
    const previousSummary = latestMemory[section] || '';
    const latestSummaryIndex = getIndexOfLatestChatSummary(context.chat);
    const system = await buildSummarySystemPrompt(ctx, context, previousSummary, conn.contextSize);
    const instruction = { role: 'user', content: prompt };

    const budget = Math.max(0, conn.contextSize - conn.responseTokens - CONTEXT_SAFETY_MARGIN);
    let used = 0;
    if (system) used += await countSourceTokens(system) + PER_MESSAGE_OVERHEAD;
    used += await countSourceTokens(instruction.content) + PER_MESSAGE_OVERHEAD;

    // Exclude the latest message (mirrors the raw builder: the summary anchors at length - 2).
    const chat = context.chat.slice(0, -1);
    const included = [];
    let latestUsedMessage = null;

    // Forward-fill from the first unsummarized message: summarization consumes the OLDEST pending
    // messages first, so the next run picks up where this one stopped.
    for (let index = latestSummaryIndex + 1; index < chat.length; index++) {
        const message = chat[index];
        if (!message) break;
        if (message.is_system || !message.mes) continue;

        const content = `${message.name}:\n${message.mes}`;
        const cost = await countSourceTokens(content) + PER_MESSAGE_OVERHEAD;
        if (used + cost > budget) break;

        used += cost;
        included.push({ role: message.is_user ? 'user' : 'assistant', content });
        latestUsedMessage = message;

        if (settings().maxMessagesPerRequest > 0 && included.length >= settings().maxMessagesPerRequest) {
            break;
        }
    }

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push(...included);
    messages.push(instruction);
    return { messages, lastUsedIndex };
}

/** Sends the summary request via the configured profile + completion preset (non-streaming). */
async function sendSummaryRequest(ctx, conn, messages) {
    if (!ctx.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService not available');

    // "current" => use the profile's own preset. Any other value => temporarily point the profile
    // at the chosen preset for this one request (core derives presetName from profile.preset).
    let overriddenProfile = null;
    let originalPreset;
    try {
        const profile = conn.profile ?? ctx.ConnectionManagerRequestService.getProfile(conn.profileId);
        if (conn.usePreset && profile) {
            overriddenProfile = profile;
            originalPreset = profile.preset;
            profile.preset = settings().completionPreset;
        }

        // Non-streaming: the summary isn't shown live, and a single response is marginally faster.
        // With stream:false, sendRequest returns ExtractedData (.content).
        const response = await ctx.ConnectionManagerRequestService.sendRequest(
            conn.profileId,
            messages,
            conn.responseTokens,
            { stream: false, extractData: true, includePreset: true },
        );

        // Guard the streaming shape too, in case a backend ignores the flag and hands back a
        // generator factory yielding cumulative { text }.
        if (typeof response === 'function') {
            let text = '';
            for await (const chunk of response()) {
                if (chunk && typeof chunk.text === 'string') text = chunk.text;
            }
            return text;
        }
        return response?.content ?? '';
    } finally {
        if (overriddenProfile) overriddenProfile.preset = originalPreset;
    }
}

/**
 * Summarize a section through the extension's own connection profile.
 * @param {object} context SillyTavern context snapshot
 * @param {string} section Section name
 * @param {string} prompt The section's summarize prompt
 * @returns {Promise<{summary: string, lastUsedIndex: number}|null>} null when nothing to summarize
 */
async function summarizeSectionViaProfile(context, section, prompt) {
    const ctx = getContext();
    const conn = resolveSummaryConnection(ctx);
    const resolvedPrompt = typeof ctx.substituteParams === 'function' ? String(ctx.substituteParams(prompt)) : prompt;
    const { messages, lastUsedIndex } = await buildSummaryMessages(ctx, context, section, resolvedPrompt, conn);

    if (lastUsedIndex === null || lastUsedIndex === -1) {
        return null;
    }

    const response = await sendSummaryRequest(ctx, conn, messages);
    const summary = removeReasoningFromString(String(response || ''));
    return { summary, lastUsedIndex };
}

// --- Slash command callback ---

async function summarizeCallback(args, text) {
    text = text.trim();

    if (!text) {
        const quiet = isTrueBoolean(args.quiet);
        const section = args.section;
        if (section && summarySections.includes(section)) {
            return await forceSummarizeSection(section, quiet);
        }
        return await forceSummarizeChat(quiet);
    }

    try {
        // Use body section prompt as default for raw text summarization
        const sectionSettings = settings().sections.body;
        const prompt = args.prompt || sectionSettings.prompt;
        return removeReasoningFromString(await generateRaw({ prompt: text, systemPrompt: prompt, responseLength: settings().overrideResponseLength }));
    } catch (error) {
        toastr.error(String(error), 'Failed to summarize text');
        console.log(error);
        return '';
    }
}

// --- Popout ---

function doPopout(e) {
    const target = e.target;
    if ($('#tsExtensionPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="tsExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="tsExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
        const newElement = $(template);
        newElement.attr('id', 'tsExtensionPopout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        // Copy section contents before emptying
        const prevContents = {};
        for (const section of summarySections) {
            prevContents[section] = $(`#ts_section_content_${section}`).val() || '';
        }
        originalElement.empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
        $('#tsExtensionDrawerContents').addClass('scrollableInnerFull');
        // Restore section contents into popout
        for (const section of summarySections) {
            $(`#ts_section_content_${section}`).val(prevContents[section]);
        }
        setupListeners();
        loadSettings();
        loadMovingUIState();

        dragElement(newElement);

        $('#tsExtensionPopoutClose').off('click').on('click', function () {
            $('#tsExtensionDrawerContents').removeClass('scrollableInnerFull');
            const popoutHTML = $('#tsExtensionDrawerContents');
            $('#tsExtensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(popoutHTML);
                $('#tsExtensionPopout').remove();
            });
            loadSettings();
        });
    } else {
        console.debug('saw existing popout, removing');
        $('#tsExtensionPopout').fadeOut(animation_duration, () => { $('#tsExtensionPopoutClose').trigger('click'); });
    }
}

// --- Setup listeners ---

function setupListeners() {
    // Global controls
    $('#ts_skipWIAN').off('input').on('input', onSkipWIANInput);
    $('#ts_template').off('input').on('input', onTemplateInput);
    $('#ts_depth').off('input').on('input', onDepthInput);
    $('#ts_role').off('input').on('input', onRoleInput);
    $('input[name="ts_position"]').off('change').on('change', onPositionChange);
    $('#ts_prompt_builder_default').off('input').on('input', onPromptBuilderInput);
    $('#ts_prompt_builder_raw_blocking').off('input').on('input', onPromptBuilderInput);
    $('#ts_prompt_builder_raw_non_blocking').off('input').on('input', onPromptBuilderInput);
    $('#ts_prompt_builder_profile').off('input').on('input', onPromptBuilderInput);
    $('#ts_connection_profile').off('change').on('change', onConnectionProfileChange);
    $('#ts_completion_preset').off('change').on('change', onCompletionPresetChange);
    $('#ts_connection_context').off('input').on('input', onConnectionContextInput);
    $('#ts_override_response_length').off('input').on('input', onOverrideResponseLengthInput);
    $('#ts_max_messages_per_request').off('input').on('input', onMaxMessagesPerRequestInput);
    $('#ts_include_wi_scan').off('input').on('input', onIncludeWIScanInput);
    $('#ts_force_summarize_all').off('click').on('click', () => forceSummarizeChat(false));
    $('#ts_reset_prompts').off('click').on('click', onResetPromptsClick);
    $('#tsSettingsBlockToggle').off('click').on('click', function () {
        // Refresh the connection lists each time the panel opens, in case profiles changed.
        populateConnectionProfiles();
        populateCompletionPresets();
        $('#tsSettingsBlock').slideToggle(200, 'swing');
    });

    // Per-section controls
    for (const section of summarySections) {
        $(`#ts_section_content_${section}`).off('input').on('input', () => onSectionContentInput(section));
        $(`#ts_section_prompt_${section}`).off('input').on('input', () => onSectionPromptInput(section));
        $(`#ts_section_prompt_restore_${section}`).off('click').on('click', () => onSectionPromptRestoreClick(section));
        $(`#ts_section_content_restore_${section}`).off('click').on('click', () => onSectionContentRestoreClick(section));
        $(`#ts_force_summarize_${section}`).off('click').on('click', () => forceSummarizeSection(section, false));
        $(`#ts_section_settings_toggle_${section}`).off('click').on('click', function () {
            $(`#ts_section_settings_${section}`).slideToggle(200, 'swing');
        });
    }
}

// --- Init ---

jQuery(async function () {
    // Load default prompts from external files before anything else
    await loadDefaultPrompts();

    // Ensure settings object exists
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = {};
    }

    async function addExtensionControls() {
        const settingsHtml = await renderExtensionTemplateAsync(extensionName, 'settings', {
            defaultSettings,
            summarySections,
            defaultSectionLabels,
            defaultSectionPrompts,
        });
        // Create our own container since we're a standalone extension
        const container = $('<div id="tech_summarize_container" class="extension_container"></div>');
        container.append(settingsHtml);
        $('#extensions_settings2').append(container);
        setupListeners();
        $('#tsExtensionPopoutButton').off('click').on('click', function (e) {
            doPopout(e);
            e.stopPropagation();
        });
    }

    await addExtensionControls();
    loadSettings();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarize',
        callback: summarizeCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'section',
                description: 'section to summarize: characters, body, or lore',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
                enumList: summarySections,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt',
                description: 'prompt to use for summarization',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'suppress the toast message when summarizing the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to summarize', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Summarizes the given text or the current chat. Use section= to summarize a specific section (characters, body, lore). Without section=, summarizes all sections.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    const summaryMacroHandler = () => {
        const sections = settings().sections || {};
        const parts = summarySections
            .map(s => (sections[s] && sections[s].content) || '')
            .filter(Boolean);
        if (parts.length > 0) {
            return parts.join('\n\n');
        }
        // Fallback to scanning the chat
        const latestMemory = getLatestMemoryFromChat(getContext().chat);
        return [latestMemory.characters, latestMemory.body, latestMemory.lore].filter(Boolean).join('\n\n');
    };

    // Register per-section macros
    const registerSectionMacro = (sectionName) => {
        const handler = () => {
            const sections = settings().sections || {};
            return (sections[sectionName] && sections[sectionName].content) || '';
        };
        if (power_user.experimental_macro_engine) {
            macros.register(`summary_${sectionName}`, {
                category: MacroCategory.CHAT,
                description: `Returns the ${defaultSectionLabels[sectionName]} summary from the current chat.`,
                handler: () => handler(),
            });
        } else {
            MacrosParser.registerMacro(`summary_${sectionName}`,
                () => handler(),
                `Returns the ${defaultSectionLabels[sectionName]} summary from the current chat.`);
        }
    };

    for (const section of summarySections) {
        registerSectionMacro(section);
    }

    // Combined summary macro
    if (power_user.experimental_macro_engine) {
        macros.register('summary', {
            category: MacroCategory.CHAT,
            description: 'Returns the combined summary from all sections of the current chat.',
            handler: () => summaryMacroHandler(),
        });
    } else {
        MacrosParser.registerMacro('summary',
            () => summaryMacroHandler(),
            'Returns the combined summary from all sections of the current chat.');
    }
});
