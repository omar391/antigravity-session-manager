# Antigravity Session Manager

Auto-sync session manager for switching between multiple Google accounts in Antigravity IDE.

## Features

- ✅ **Auto-detection** - Automatically detects and stores sessions when you log in
- ✅ **Smart syncing** - Updates sessions when data changes
- ✅ **Round-robin switching** - Cycle through accounts with one command
- ✅ **Global keybindings** - Works from any workspace
- ✅ **Self-installing** - One command to install globally

## Installation

```bash
cd /Users/omar/.gemini/antigravity/playground/obsidian-copernicus
bun install
bun session.ts
```

This will:
1. Copy the script to `~/.antigravity/scripts/`
2. Install dependencies
3. Set up global keybindings
4. Configure Antigravity IDE

**Reload Antigravity** (Cmd+Shift+P → "Reload Window") to activate.

## Usage

### Keybindings (Recommended)

- `Ctrl+Alt+N` - Next Session (auto-sync current + switch to next)
- `Ctrl+Alt+L` - List All Sessions

### Command Line

```bash
# Cycle to next session
bun session.ts next

# List all sessions
bun session.ts list

# Load specific session
bun session.ts load <email>

# Manually sync current
bun session.ts sync

# Delete a session
bun session.ts delete <email>

# Reinstall/update global keybindings
bun session.ts
```

## How It Works

### Auto-Detection

When you run `next`:
1. Reads current session from Antigravity database
2. Extracts email and auth data
3. Checks if email exists in session database
4. If new → adds to database
5. If changed → updates database
6. Loads next session in rotation

### Database

Sessions are stored in `~/.antigravity/sessions.db`:

```sql
CREATE TABLE sessions (
    email TEXT PRIMARY KEY,
    name TEXT,
    auth_status TEXT,      -- JSON blob
    google_data TEXT,      -- JSON blob
    last_used INTEGER,     -- Unix timestamp
    created_at INTEGER,
    updated_at INTEGER
);
```

## Example Workflow

1. **Log in** with Account A (personal@gmail.com)
2. Press `Ctrl+Alt+N` → Saves Account A, stays on it (only 1 session)
3. **Log out, log in** with Account B (work@gmail.com)
4. Press `Ctrl+Alt+N` → Saves Account B, switches to Account A
5. **Reload window** (Cmd+R)
6. Now logged in as personal@gmail.com
7. Press `Ctrl+Alt+N` → Switches to work@gmail.com
8. Keep cycling!

## Testing

Run the test suite:

```bash
bun test session.test.ts
```

## Files

- `session.ts` - Main script
- `session.test.ts` - Unit tests
- `package.json` - Dependencies
- `~/.antigravity/sessions.db` - Session database
- `~/Library/Application Support/Antigravity/User/keybindings.json` - Global keybindings

## Troubleshooting

**Keybindings not working?**
- Reload Antigravity window
- Check `~/Library/Application Support/Antigravity/User/keybindings.json`

**Session not switching?**
- Make sure to reload window (Cmd+R) after switching
- Check `bun session.ts list` to verify sessions are saved

**Want to start fresh?**
```bash
rm ~/.antigravity/sessions.db
```
