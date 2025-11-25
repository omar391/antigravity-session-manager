#!/usr/bin/env bun
import { clearCache } from './src/ocr';
import { syncCurrent, getCurrentSession, getNextSession, listSessions, initSessionDB, deleteSession } from './src/database';
import { focusAntigravity, pressKey, wait } from './src/automation';
import { executeWorkflow } from './src/workflow';
import type { Session } from './src/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

    // Auto-detect and save the new session
    console.log('\n💾 Auto-saving new session...');
    syncCurrent();

    // Update last_used for the session we switched to
    const db = initSessionDB();
    db.query('UPDATE sessions SET last_used = ? WHERE email = ?').run(Date.now(), nextSession.email);
    db.close();

    console.log(`\n✅ Switched to: ${nextSession.email}\n`);
}

function setupKeybindings(): void {
    const KEYBINDINGS_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'keybindings.json');
    const GLOBAL_SCRIPTS_DIR = path.join(os.homedir(), '.antigravity', 'scripts');

    // Create global scripts directory
    if (!fs.existsSync(GLOBAL_SCRIPTS_DIR)) {
        fs.mkdirSync(GLOBAL_SCRIPTS_DIR, { recursive: true });
    }

    // Copy this script and dependencies to global location
    const currentDir = process.cwd();
    const filesToCopy = ['index.ts', 'workflow.json', 'package.json', 'bun.lock'];

    console.log('📦 Installing to global location...');

    for (const file of filesToCopy) {
        const sourcePath = path.join(currentDir, file);
        const destPath = path.join(GLOBAL_SCRIPTS_DIR, file);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`  ✓ Copied ${file}`);
        }
    }

    // Copy src directory
    const srcSource = path.join(currentDir, 'src');
    const srcDest = path.join(GLOBAL_SCRIPTS_DIR, 'src');

    if (fs.existsSync(srcSource)) {
        if (fs.existsSync(srcDest)) {
            fs.rmSync(srcDest, { recursive: true, force: true });
        }
        fs.cpSync(srcSource, srcDest, { recursive: true });
        console.log('  ✓ Copied src/');
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
                text: "cd ~/.antigravity/scripts && bun index.ts next\n"
            }
        },
        {
            key: "ctrl+alt+l",
            command: "workbench.action.terminal.sendSequence",
            args: {
                text: "cd ~/.antigravity/scripts && bun index.ts list\n"
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

        case 'init':
            setupKeybindings();
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
  bun index.ts init             Install global keybindings (Ctrl+Alt+N, Ctrl+Alt+L)
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
