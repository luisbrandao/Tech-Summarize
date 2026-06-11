# Tech-Summarize

Tech-Summarize is a third-party extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that adds a **multi-section summarize tool**.

Instead of keeping one large memory blob, it keeps three focused summaries:

- **Characters**
- **Events & Plot**
- **World & Lore**

These sections can be generated independently, restored from history, and injected into the prompt with a customizable template.

## Features

- Multi-section chat summarization (`characters`, `body`, `lore`)
- One-click **Summarize All** or per-section summarize
- Per-section custom prompts with "restore default" action
- Restore previous summary value per section from chat history
- Custom summary injection template with placeholders:
  - `{{summary_characters}}`
  - `{{summary_body}}`
  - `{{summary_lore}}`
  - `{{summary}}` (all sections combined)
- Prompt injection controls:
  - Position
  - Depth / role
  - Include in World Info scanning
- Multiple prompt builder modes:
  - Classic (blocking)
  - Raw (blocking)
  - Raw (non-blocking)
  - Connection profile (non-blocking) — summarize on its own model/connection
- Optional toggles and limits:
  - Skip WI/AN input (`No WI/AN`)
  - API response length override
  - Raw/Profile mode max messages per request
- Slash command support (`/summarize`)
- Macros for templates and prompts:
  - `{{summary}}`
  - `{{summary_characters}}`
  - `{{summary_body}}`
  - `{{summary_lore}}`

## Installation

Just go in install extensions and paste the githubURL https://github.com/luisbrandao/Tech-Summarize

Disable the build in sumarize!!

## Usage

1. Open **Extensions -> Tech-Summarize**.
2. Use **Summarize All** to refresh all three sections at once.
3. Or use each section button to summarize only one area:
   - Characters
   - Events & Plot
   - World & Lore
4. Expand section settings (gear icon) to edit each section prompt.
5. Open **Summary Settings** to adjust template, placement, and builder mode.

## Slash Command

`/summarize` supports full chat summarization, section-only summarization, and plain text summarization.

Examples:

```text
/summarize
/summarize section=characters
/summarize section=lore quiet=true
/summarize prompt="Summarize this as bullet points" This is the text to summarize.
```

## Connection Profile Builder

The **Connection profile, non-blocking** builder sends the summarization request through its own
Connection Manager profile and completion preset, so summaries can run on a different (e.g. cheaper
or larger-context) model than the main reply — the same pattern used by the Director and Tracker
extensions. It never blocks the chat, since it does not share the main API connection.

It builds its own chat-completion prompt:

```text
system:
  ### Character card             (description + personality + scenario)
  ### Player character: <name>   (persona description, when set)
  ### World Info                 (active lorebook entries; skipped when "No WI/AN" is on)
  ### Previous summary           (this section's latest stored summary)
user/assistant: as many unsummarized chat messages as fit the context budget (oldest first)
user: the section's summarize prompt
```

Settings (under **Summary Settings**, shown when the builder is selected):

- **Connection profile** — `Use current connection` or any Connection Manager profile
- **Completion preset** — `Use connection profile default` or any preset
- **Context size** — token budget for the prompt; `0` = auto (preset's context size, falling back
  to the app's max context). The response length reservation comes from **API response length**
  (`0` = the preset's own value).

The summarize prompt is sent as the final **user** message, so the request works on standard
chat-completion backends (Ollama / llama.cpp / vLLM) as well as remote APIs.

## Default Section Intent

- **Characters**: Main and minor characters, role changes, traits, and important details.
- **Events & Plot**: Chronological event log and scene progression.
- **World & Lore**: Locations, world rules, systems, organizations, and politics.

## Data Model

Summaries are persisted per chat message in `extra.memory` as:

```json
{
  "characters": "...",
  "body": "...",
  "lore": "..."
}
```

Legacy single-string summaries are migrated into the `body` section.

## Project Files

- `manifest.json` - SillyTavern extension manifest
- `index.js` - extension logic, slash command, macros, summarization flow
- `settings.html` - extension UI
- `style.css` - extension styles
- `default-prompt-characters.txt` - default Characters prompt
- `default-prompt-body.txt` - default Events & Plot prompt
- `default-prompt-lore.txt` - default World & Lore prompt

## Author

- **Techmago**

## Repository

- https://github.com/luisbrandao/Tech-Summarize
