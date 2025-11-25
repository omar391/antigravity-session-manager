#!/usr/bin/env bun
import { clearCache } from './src/ocr';
import { syncCurrent, getCurrentSession, getNextSession, listSessions, initSessionDB } from './src/database';
import { focusAntigravity, pressKey, wait } from './src/automation';
import { executeWorkflow } from './src/workflow';
import type { Session } from './src/types';

async function switchToNext(): Promise<void> {
    // Sync current session first (auto-detect and save)
    console.log('🔄 Detecting current session...');
    syncCurrent();

    const current = getCurrentSession();
    const nextSession = getNextSession(current?.email);

    if (!nextSession) {
        console.log('📭 No sessions available yet. Please log in to Antigravity with a Google account, then run this command again.');
        return;
    }

    if (current && nextSession.email === current.email) {
        console.log(`ℹ️  Only one session available: ${current.email}`);
        console.log(`   Log in to another Google account in Antigravity, then run 'bun index.ts next' to add it to rotation.`);
        return;
    }

    console.log(`\n🔄 Current: ${current?.email || 'none'}`);
    console.log(`➡️  Next: ${nextSession.name || nextSession.email} (${nextSession.email})\n`);

    // Execute automation workflow
    console.log('🤖 Starting automated workflow...\n');

    // Focus Antigravity window first
    console.log('🎯 Focusing Antigravity window...');
    await focusAntigravity();

    const success = await executeWorkflow(nextSession.email);

    if (!success) {
        console.error('\n❌ Automation failed. Please try again or clear cache with: bun index.ts clear-cache');
        return;
    }

    // Wait for OAuth and window to settle
    console.log('\n⏳ Waiting for session to settle...');
    await wait(3000);

    // Close any OAuth windows
    console.log('🔄 Closing OAuth window...');
    await pressKey('53'); // ESC
    await wait(300);

    // Reload window
    console.log('🔄 Reloading window...');
    await pressKey('r', 'command');
    await wait(2000); // Wait for reload

    // Auto-detect and save the new session
    console.log('💾 Auto-saving new session...');
    syncCurrent();

    // Update last_used for the session we switched to
    const db = initSessionDB();
    db.query('UPDATE sessions SET last_used = ? WHERE email = ?').run(Date.now(), nextSession.email);
    db.close();

    console.log(`\n✅ Switched to: ${nextSession.email}\n`);
}

function removeEmail(email: string): void {
    const db = initSessionDB();
    const result = db.query('DELETE FROM sessions WHERE email = ?').run(email);
    db.close();

    if (result.changes === 0) {
        console.error(`❌ Email not found: ${email}`);
    } else {
        console.log(`🗑️  Removed email: ${email}`);
    }
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

        case 'list':
            listSessions();
            break;

        case 'remove':
            if (!arg) {
                console.error('Usage: bun index.ts remove <email>');
                process.exit(1);
            }
            removeEmail(arg);
            break;

        case 'clear-cache':
            clearCache();
            break;

        default:
            console.log(`
Antigravity Session Manager

Usage:
  bun index.ts next             Switch to next session (auto-detects and saves new accounts)
  bun index.ts list             List all sessions
  bun index.ts remove <email>   Remove email from rotation
  bun index.ts clear-cache      Clear OCR cache

How it works:
  1. Log in to a Google account in Antigravity
  2. Run 'bun index.ts next' - it will auto-detect and save it
  3. Repeat for other accounts - they'll be added automatically
  4. Future 'next' commands will rotate through all saved accounts
            `.trim());
            break;
    }
})();
