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
- Optional toggles and limits:
  - Skip WI/AN input (`No WI/AN`)
  - API response length override
  - Raw mode max messages per request
- Slash command support (`/summarize`)
- Macros for templates and prompts:
  - `{{summary}}`
  - `{{summary_characters}}`
  - `{{summary_body}}`
  - `{{summary_lore}}`

## Installation

### Manual install (recommended)

1. Go to your SillyTavern folder:
   - `SillyTavern/public/scripts/extensions/third-party/`
2. Clone this repository:
   - `git clone https://github.com/luisbrandao/Tech-Summarize.git`
3. Restart SillyTavern.
4. Open the Extensions panel and enable **Tech-Summarize**.

### Update

From the plugin folder:

```bash
git pull
```

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
