#!/usr/bin/env bun
import { clearCache } from './src/ocr';
import { syncCurrent, getCurrentSession, getNextSession, listSessions, deleteSession, initSessionDB, writeToDB } from './src/database';
import { focusAntigravity, pressKey, wait } from './src/automation';
import { executeWorkflow } from './src/workflow';
import { Database } from 'bun:sqlite';
import * as path from 'path';
import * as os from 'os';

const AG_DB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

async function switchToNext(): Promise<void> {
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

    const authData = JSON.parse(nextSession.auth_status);
    console.log(`\n🔄 Current: ${current?.email || 'none'}`);
    console.log(`➡️  Next: ${authData.name} (${nextSession.email})\n`);

    // Execute automation workflow
    console.log('🤖 Starting automated workflow...\n');

    // Focus Antigravity window first
    console.log('🎯 Focusing Antigravity window...');
    await focusAntigravity();

    const success = await executeWorkflow(nextSession.email);

    if (!success) {
        console.error('\n❌ Automation failed. Please try again or clear cache with: bun session-manager.ts clear-cache');
        return;
    }

    // Wait for OAuth to complete
    console.log('\n⏳ Waiting for OAuth to complete...');
    await wait(3000);

    // Write session to database (bypass Google chooser)
    console.log('⚡ Writing session to database...');
    const agDb = new Database(AG_DB_PATH);
    agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityAuthStatus', nextSession.auth_status);
    agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('google.antigravity', nextSession.google_data);
    agDb.close();

    // Close any OAuth windows
    console.log('🔄 Closing OAuth window...');
    await pressKey('53'); // ESC
    await wait(300);

    // Reload window
    console.log('🔄 Reloading window...');
    await pressKey('r', 'command');

    // Update last_used
    const db = initSessionDB();
    db.query('UPDATE sessions SET last_used = ? WHERE email = ?').run(Date.now(), nextSession.email);
    db.close();

    console.log(`\n✅ Switched to: ${nextSession.email}\n`);
}

function loadSession(email: string): void {
    const db = initSessionDB();
    const session = db.query('SELECT * FROM sessions WHERE email = ?').get(email) as any;

    if (!session) {
        console.error(`❌ Session not found: ${email}`);
        db.close();
        return;
    }

    const agDb = new Database(AG_DB_PATH);
    agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityAuthStatus', session.auth_status);
    agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('google.antigravity', session.google_data);
    agDb.close();

    const now = Date.now();
    db.query('UPDATE sessions SET last_used = ? WHERE email = ?').run(now, email);
    db.close();

    console.log(`✅ Loaded session: ${email}`);
    console.log(`⚠️  Please reload the window (Cmd+R) to apply changes.`);
}

// ============================================================================
// CLI Interface
// ============================================================================

const command = process.argv[2];
const arg = process.argv[3];

(async () => {
    switch (command) {
        case 'next':
            await switchToNext();
            break;

        case 'sync':
            syncCurrent();
            break;

        case 'list':
            listSessions();
            break;

        case 'load':
            if (!arg) {
                console.error('Usage: bun session-manager.ts load <email>');
                process.exit(1);
            }
            loadSession(arg);
            break;

        case 'delete':
            if (!arg) {
                console.error('Usage: bun session-manager.ts delete <email>');
                process.exit(1);
            }
            deleteSession(arg);
            break;

        case 'clear-cache':
            clearCache();
            break;

        default:
            console.log(`
Antigravity Session Manager

Usage:
  bun session-manager.ts next          Switch to next session
  bun session-manager.ts sync          Sync current session
  bun session-manager.ts list          List all sessions
  bun session-manager.ts load <email>  Load specific session
  bun session-manager.ts delete <email> Delete session
  bun session-manager.ts clear-cache   Clear OCR cache
            `.trim());
            break;
    }
})();
