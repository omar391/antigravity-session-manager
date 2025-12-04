# Antigravity Session Manager (OCR-Enhanced)

# Antigravity Session Manager

Automated session switching for Antigravity using OCR-based UI automation with `nut.js`.

## Features

- 🔄 Automatic session switching between multiple Google accounts
- 🖱️ OCR-based UI element detection using Tesseract
- ⌨️ Cross-platform automation with nut.js
- 📂 Simple JSON-based email configuration
- 🎯 Retina display support with automatic DPI scaling

## Project Structure

```
antigravity-session-manager/
├── index.ts                    # Main CLI entry point
├── emails.json                # Email list configuration
├── src/
│   ├── types.ts               # TypeScript interfaces
│   ├── automation.ts          # UI automation (keyboard, mouse, focus)
│   ├── workflow.ts            # Workflow execution engine
│   └── ocr.ts                 # OCR text detection and caching
├── automation-config.json     # Workflow configuration
└── package.json
```

## Installation

```bash
bun install
```

## Usage

```bash
# Switch to next email (automated)
bun index.ts next

# List configured emails
bun index.ts list

# Add a new email
bun index.ts add user@gmail.com

# Remove an email
bun index.ts remove user@gmail.com

# Clear OCR cache
bun index.ts clear-cache
```

## How It Works

1. **Configuration**: Reads email list from `emails.json`
2. **UI Automation**: Uses nut.js to
creenshot** of the current screen
2. **Runs Tesseract OCR** to detect all text with bounding boxes
3. **Finds elements** using fuzzy text matching (handles slight variations)
4. **Caches positions** in `element-cache.json` for performance
5. **Clicks center** of detected element

### Workflow Configuration

The automation workflow is defined in `automation-config.json`:

```json
{
  "workflow": {
    "steps": [
      { "action": "pressKey", "key": ",", "modifiers": "command" },
      { "action": "wait", "ms": 1500 },
      { "action": "findAndClick", "text": "Account" },
      { "action": "wait", "ms": 800 },
      { "action": "findAndClick", "text": "Sign Out" },
      { "action": "wait", "ms": 1500 },
      { "action": "findAndClick", "text": "Sign In" },
      { "action": "wait", "ms": 2000 },
      { "action": "findAndClick", "text": "{targetEmail}", "dynamic": true }
    ]
  }
}
```

You can customize delays, add steps, or modify element names.

### Session Database

Sessions are stored in `~/.antigravity/sessions.db`:

```sql
CREATE TABLE sessions (
    email TEXT PRIMARY KEY,
    auth_status TEXT,      -- JSON blob
    google_data TEXT,      -- JSON blob
    last_used INTEGER,     -- Unix timestamp
    created_at INTEGER,
    updated_at INTEGER
);
```

### Element Cache

Element positions are cached in `element-cache.json`:

```json
{
  "Account": {
    "x": 150,
    "y": 250,
    "timestamp": 1700000000000
  }
}
```

Cache expires after 24 hours by default.

## Example Workflow

1. **Log in** with Account A (personal@gmail.com)
2. Run `bun session-manager.ts sync` to save it
3. **Log out, log in** with Account B (work@gmail.com)
4. Run `bun session-manager.ts next` →  
   - Saves Account B
   - Automatically switches to Account A
   - Window reloads
5. Run `bun session-manager.ts next` again →  
   - Switches to Account B
   - Much faster due to cached positions!

## Troubleshooting

### OCR Not Finding Elements?

```bash
# Clear cache to force fresh detection
bun session-manager.ts clear-cache

# Then try again
bun session-manager.ts next
```

### Elements Changed Position?

The cache auto-expires after 24 hours, or clear it manually:

```bash
bun session-manager.ts clear-cache
```

### Want to Test OCR Detection?

You can test individual components:

```typescript
import { findElement } from './ocr-utils';

const element = await findElement('Account');
console.log(element); // Shows detected position
```

### Automation Failing?

1. Ensure Antigravity window is visible and focused
2. Check that Settings dialog is accessible via Cmd+,
3. Verify element text hasn't changed in UI
4. Try adjusting fuzzy match threshold in `automation-config.json`

## Files

- `session-manager.ts` - Main unified script (replaces all 3 old files)
- `ocr-utils.ts` - OCR and element detection utilities
- `automation-config.json` - Workflow configuration
- `element-cache.json` - Cached element positions (auto-generated)
- `~/.antigravity/sessions.db` - Session database

## Migration from Old Scripts

The new `session-manager.ts` replaces:
- ❌ `setup-settings-coords.ts` - No longer needed (OCR handles this)
- ❌ `settings-click.ts` - Merged into `session-manager.ts`
- ❌ `session.ts` - Merged into `session-manager.ts`
- ❌ `settings-coords.json` - Replaced by `element-cache.json`

You can safely delete the old files after confirming the new script works.

## Advantages Over Old Approach

| Old Approach | New OCR Approach |
|--------------|------------------|
| Manual coordinate setup | Automatic element detection |
| Breaks when UI moves | Adapts to UI changes |
| 2-step process (setup + run) | 1-step process (just run) |
| Hardcoded positions | Dynamic detection |
| Stops at sign-in | Full automation to account selection |

## Platform Support

Screen capture uses `screenshot-desktop` for cross-platform support:
- ✅ **macOS** - Native support
- ✅ **Windows** - Native support
- ✅ **Linux** - Requires ImageMagick or scrot
