import { Database } from 'bun:sqlite';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { Session } from './types';

const SESSION_DB_PATH = path.join(os.homedir(), '.antigravity', 'sessions.db');
const AG_DB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

export function initSessionDB(): Database {
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

export function getCurrentSession(): { email: string; auth_status: string; google_data: string } | null {
    if (!fs.existsSync(AG_DB_PATH)) return null;

    try {
        const agDb = new Database(AG_DB_PATH, { readonly: true });
        const authRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('ant igravityAuthStatus') as { value: string } | null;
        const googleRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('google.antigravity') as { value: string } | null;
        agDb.close();

        if (!authRow) return null;

        const authData = JSON.parse(authRow.value);
        const email = authData.email;

        if (!email) return null;

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

export function syncCurrent(): void {
    const current = getCurrentSession();

    if (!current) {
        console.log('No active session found in Antigravity.');
        return;
    }

    const db = initSessionDB();
    const now = Date.now();

    const existing = db.query('SELECT * FROM sessions WHERE email = ?').get(current.email) as Session | null;

    if (existing) {
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
        db.query(`
            INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(current.email, current.auth_status, current.google_data, 0, now, now);
        console.log(`🆕 Added new session: ${current.email}`);
    }

    db.close();
}

export function getNextSession(currentEmail?: string): Session | null {
    const db = initSessionDB();
    const sessions = db.query('SELECT * FROM sessions ORDER BY last_used ASC, email ASC').all() as Session[];
    db.close();

    if (sessions.length === 0) return null;
    if (sessions.length === 1) return sessions[0];
    if (!currentEmail) return sessions[0];

    const currentIndex = sessions.findIndex(s => s.email === currentEmail);
    if (currentIndex === -1) return sessions[0];

    const nextIndex = (currentIndex + 1) % sessions.length;
    return sessions[nextIndex];
}

export function listSessions(): void {
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

export function deleteSession(email: string): void {
    const db = initSessionDB();
    db.query('DELETE FROM sessions WHERE email = ?').run(email);
    db.close();
    console.log(`🗑️  Deleted session: ${email}`);
}

export function updateLastUsed(email: string): void {
    const db = initSessionDB();
    db.query('UPDATE sessions SET last_used = ? WHERE email = ?').run(Date.now(), email);
    db.close();
}

export function writeToDB(email: string, authStatus: string, googleData: string): void {
    const agDb = new Database(AG_DB_PATH);
    agDb.query('UPDATE ItemTable SET value = ? WHERE key = ?').run(authStatus, 'antigravityAuthStatus');
    agDb.query('UPDATE ItemTable SET value = ? WHERE key = ?').run(googleData, 'google.antigravity');
    agDb.close();

    const db = initSessionDB();
    updateLastUsed(email);
    db.close();
}
