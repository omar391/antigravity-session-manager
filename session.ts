#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as jsonc from 'jsonc-parser';

// Configuration
const AG_DB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
const SESSION_DB_PATH = path.join(os.homedir(), '.antigravity', 'sessions.db');
const SETTINGS_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'settings.json');
const WORKSPACE_DIR = process.cwd();

interface Session {
    email: string;
    name?: string;
    auth_status: string;
    google_data: string;
    last_used: number;
    created_at: number;
    updated_at: number;
}

// Initialize our session database
function initSessionDB(): Database {
    const dir = path.dirname(SESSION_DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database(SESSION_DB_PATH);

    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            email TEXT PRIMARY KEY,
            name TEXT,
            auth_status TEXT,
            google_data TEXT,
            last_used INTEGER,
            created_at INTEGER,
            updated_at INTEGER
        )
    `);

    return db;
}

// Get current session from Antigravity DB
function getCurrentSession(): { email: string; auth_status: string; google_data: string } | null {
    const agDb = new Database(AG_DB_PATH, { readonly: true });

    const authRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus') as { value: string } | null;
    const googleRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('google.antigravity') as { value: string } | null;

    agDb.close();

    if (!authRow) {
        return null;
    }

    try {
        const authData = JSON.parse(authRow.value);
        const email = authData.email;

        if (!email) {
            return null;
        }

        return {
            email,
            auth_status: authRow.value,
            google_data: googleRow?.value || '{}'
        };
    } catch (e) {
        console.error('Error parsing current session:', e);
        return null;
    }
}

// Sync current session to our database
function syncCurrent(): void {
    const current = getCurrentSession();

    if (!current) {
        console.log('No active session found in Antigravity.');
        return;
    }

    const db = initSessionDB();
    const now = Date.now();

    const existing = db.query('SELECT * FROM sessions WHERE email = ?').get(current.email) as Session | null;

    if (existing) {
        // Check if values changed
        if (existing.auth_status !== current.auth_status || existing.google_data !== current.google_data) {
            db.query(`
                UPDATE sessions 
                SET auth_status = ?, google_data = ?, updated_at = ?
                WHERE email = ?
            `).run(current.auth_status, current.google_data, now, current.email);
            console.log(`✅ Updated session for: ${current.email}`);
        } else {
            console.log(`✓ Session for ${current.email} is already up to date.`);
        }
    } else {
        // Insert new session
        db.query(`
            INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(current.email, current.auth_status, current.google_data, 0, now, now);
        console.log(`🆕 Added new session: ${current.email}`);
    }

    db.close();
}

// Get next session in rotation
function getNextSession(currentEmail?: string): Session | null {
    const db = initSessionDB();

    const sessions = db.query('SELECT * FROM sessions ORDER BY last_used ASC, email ASC').all() as Session[];

    db.close();

    if (sessions.length === 0) {
        return null;
    }

    if (sessions.length === 1) {
        return sessions[0];
    }

    if (!currentEmail) {
        return sessions[0];
    }

    // Find next session after current
    const currentIndex = sessions.findIndex(s => s.email === currentEmail);
    if (currentIndex === -1) {
        return sessions[0];
    }

    const nextIndex = (currentIndex + 1) % sessions.length;
    return sessions[nextIndex];
}

// Load a session to Antigravity DB
function loadSession(email: string): void {
    const db = initSessionDB();

    const session = db.query('SELECT * FROM sessions WHERE email = ?').get(email) as Session | null;

    if (!session) {
        console.error(`❌ Session not found: ${email}`);
        db.close();
        return;
    }

    const agDb = new Database(AG_DB_PATH);

    agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityAuthStatus', session.auth_status);
    agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('google.antigravity', session.google_data);

    agDb.close();

    // Update last_used
    const now = Date.now();
    db.query('UPDATE sessions SET last_used = ? WHERE email = ?').run(now, email);

    db.close();

    console.log(`✅ Loaded session: ${email}`);
    console.log(`⚠️  Please reload the window (Cmd+R) to apply changes.`);
}

// Next: Sync current + Load next
function next(): void {
    console.log('🔄 Syncing current session...');
    syncCurrent();

    const current = getCurrentSession();
    const nextSession = getNextSession(current?.email);

    if (!nextSession) {
        console.log('📭 No sessions available. Please log in first.');
        return;
    }

    if (current && nextSession.email === current.email) {
        console.log(`ℹ️  Already on the only available session: ${current.email}`);
        return;
    }

    console.log(`\n➡️  Switching to: ${nextSession.email}`);
    loadSession(nextSession.email);
}

// List all sessions
function listSessions(): void {
    const db = initSessionDB();
    const sessions = db.query('SELECT * FROM sessions ORDER BY last_used DESC').all() as Session[];
    db.close();

    if (sessions.length === 0) {
        console.log('📭 No sessions stored yet.');
        return;
    }

    console.log('\n📋 Available Sessions:\n');

    const current = getCurrentSession();

    sessions.forEach((session, index) => {
        const isCurrent = current && session.email === current.email;
        const lastUsed = session.last_used === 0 ? 'never' : new Date(session.last_used).toLocaleString();
        const marker = isCurrent ? '👉' : '  ';

        console.log(`${marker} ${index + 1}. ${session.email}`);
        console.log(`      Last used: ${lastUsed}`);
        console.log(`      Created: ${new Date(session.created_at).toLocaleString()}\n`);
    });
}

// Load specific session by email
function loadByEmail(email: string): void {
    loadSession(email);
}

// Delete a session
function deleteSession(email: string): void {
    const db = initSessionDB();
    db.query('DELETE FROM sessions WHERE email = ?').run(email);
    db.close();
    console.log(`🗑️  Deleted session: ${email}`);
}

// Setup global keybindings
function setupKeybindings(): void {
    const KEYBINDINGS_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'keybindings.json');
    const GLOBAL_SCRIPTS_DIR = path.join(os.homedir(), '.antigravity', 'scripts');

    // Create global scripts directory
    if (!fs.existsSync(GLOBAL_SCRIPTS_DIR)) {
        fs.mkdirSync(GLOBAL_SCRIPTS_DIR, { recursive: true });
    }

    // Copy this script and dependencies to global location
    const currentDir = process.cwd();
    const filesToCopy = ['session.ts', 'package.json', 'bun.lock'];

    console.log('📦 Installing to global location...');

    for (const file of filesToCopy) {
        const sourcePath = path.join(currentDir, file);
        const destPath = path.join(GLOBAL_SCRIPTS_DIR, file);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`  ✓ Copied ${file}`);
        }
    }

    // Copy node_modules if exists
    const nodeModulesSource = path.join(currentDir, 'node_modules');
    const nodeModulesDest = path.join(GLOBAL_SCRIPTS_DIR, 'node_modules');

    if (fs.existsSync(nodeModulesSource)) {
        if (fs.existsSync(nodeModulesDest)) {
            fs.rmSync(nodeModulesDest, { recursive: true, force: true });
        }
        fs.cpSync(nodeModulesSource, nodeModulesDest, { recursive: true });
        console.log('  ✓ Copied node_modules');
    }

    // Setup keybindings
    const keybindings = [
        {
            key: "ctrl+alt+n",
            command: "workbench.action.terminal.sendSequence",
            args: {
                text: "cd ~/.antigravity/scripts && bun session.ts next\n"
            }
        },
        {
            key: "ctrl+alt+l",
            command: "workbench.action.terminal.sendSequence",
            args: {
                text: "cd ~/.antigravity/scripts && bun session.ts list\n"
            }
        }
    ];

    fs.writeFileSync(KEYBINDINGS_PATH, JSON.stringify(keybindings, null, 2));

    console.log('\n✅ Installation complete!');
    console.log(`\n📍 Installed to: ${GLOBAL_SCRIPTS_DIR}`);
    console.log('\nKeybindings:');
    console.log('  Ctrl+Alt+N - Next Session');
    console.log('  Ctrl+Alt+L - List Sessions');
    console.log('\n⚠️  Please reload Antigravity window to activate keybindings.');
}

// CLI Interface
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
    case 'next':
        next();
        break;

    case 'sync':
        syncCurrent();
        break;

    case 'list':
        listSessions();
        break;

    case 'load':
        if (!arg) {
            console.error('Usage: bun session.ts load <email>');
            process.exit(1);
        }
        loadByEmail(arg);
        break;

    case 'delete':
        if (!arg) {
            console.error('Usage: bun session.ts delete <email>');
            process.exit(1);
        }
        deleteSession(arg);
        break;

    default:
        setupKeybindings();
        break;
}
