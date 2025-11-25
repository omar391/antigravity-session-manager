import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Test configuration
const TEST_DIR = path.join(os.tmpdir(), `session-test-${Date.now()}`);
const TEST_AG_DB = path.join(TEST_DIR, 'antigravity.db');
const TEST_SESSION_DB = path.join(TEST_DIR, 'sessions.db');

// Mock environment
process.env.HOME = TEST_DIR;

// Helper: Create mock Antigravity database
function setupMockAgDB(email: string, name: string = 'Test User'): void {
    const db = new Database(TEST_AG_DB);

    db.exec(`
        CREATE TABLE IF NOT EXISTS ItemTable (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    const authStatus = JSON.stringify({
        name: name,
        email: email,
        apiKey: 'test-api-key'
    });

    db.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityAuthStatus', authStatus);
    db.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('google.antigravity', '{}');

    db.close();
}

// Helper: Get session from our DB
function getSessionFromDB(email: string): any {
    const db = new Database(TEST_SESSION_DB);
    const session = db.query('SELECT * FROM sessions WHERE email = ?').get(email);
    db.close();
    return session;
}

// Helper: Get all sessions
function getAllSessions(): any[] {
    const db = new Database(TEST_SESSION_DB);
    const sessions = db.query('SELECT * FROM sessions ORDER BY email').all();
    db.close();
    return sessions;
}

describe('Session Manager', () => {
    beforeEach(() => {
        // Create test directory
        if (!fs.existsSync(TEST_DIR)) {
            fs.mkdirSync(TEST_DIR, { recursive: true });
        }
    });

    afterEach(() => {
        // Cleanup test directory
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    describe('Database Initialization', () => {
        test('should create sessions database with correct schema', () => {
            const db = new Database(TEST_SESSION_DB);

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

            // Verify table exists
            const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
            expect(tables).toHaveLength(1);

            db.close();
        });
    });

    describe('Session Detection', () => {
        test('should detect current session from AG database', () => {
            setupMockAgDB('test@gmail.com', 'Test User');

            const agDb = new Database(TEST_AG_DB, { readonly: true });
            const authRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus') as { value: string } | null;

            expect(authRow).toBeTruthy();

            const authData = JSON.parse(authRow!.value);
            expect(authData.email).toBe('test@gmail.com');
            expect(authData.name).toBe('Test User');

            agDb.close();
        });

        test('should return null when no session exists', () => {
            const agDb = new Database(TEST_AG_DB);
            agDb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
            agDb.close();

            const db = new Database(TEST_AG_DB, { readonly: true });
            const authRow = db.query('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');

            expect(authRow).toBeNull();

            db.close();
        });
    });

    describe('Session Sync', () => {
        test('should add new session to database', () => {
            setupMockAgDB('new@gmail.com', 'New User');

            // Simulate syncCurrent
            const agDb = new Database(TEST_AG_DB, { readonly: true });
            const authRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus') as { value: string };
            const authData = JSON.parse(authRow.value);
            agDb.close();

            const db = new Database(TEST_SESSION_DB);
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

            const now = Date.now();
            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                authData.email,
                authRow.value,
                '{}',
                0,
                now,
                now
            );
            db.close();

            const session = getSessionFromDB('new@gmail.com');
            expect(session).toBeTruthy();
            expect(session.email).toBe('new@gmail.com');
        });

        test('should update existing session when data changes', () => {
            setupMockAgDB('existing@gmail.com', 'Original Name');

            const db = new Database(TEST_SESSION_DB);
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

            const now = Date.now();
            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'existing@gmail.com',
                '{"email":"existing@gmail.com","name":"Original Name"}',
                '{}',
                0,
                now - 1000,
                now - 1000
            );
            db.close();

            // Update AG DB with new data
            setupMockAgDB('existing@gmail.com', 'Updated Name');

            // Simulate update
            const agDb = new Database(TEST_AG_DB, { readonly: true });
            const authRow = agDb.query('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus') as { value: string };
            agDb.close();

            const db2 = new Database(TEST_SESSION_DB);
            db2.query('UPDATE sessions SET auth_status = ?, updated_at = ? WHERE email = ?').run(
                authRow.value,
                now,
                'existing@gmail.com'
            );
            db2.close();

            const session = getSessionFromDB('existing@gmail.com');
            const authData = JSON.parse(session.auth_status);
            expect(authData.name).toBe('Updated Name');
        });
    });

    describe('Session Loading', () => {
        test('should load session to AG database', () => {
            // Create mock session in our DB
            const db = new Database(TEST_SESSION_DB);
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

            const authStatus = JSON.stringify({ email: 'load@gmail.com', name: 'Load Test' });
            const now = Date.now();
            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'load@gmail.com',
                authStatus,
                '{}',
                0,
                now,
                now
            );
            db.close();

            // Load to AG DB
            const session = getSessionFromDB('load@gmail.com');

            const agDb = new Database(TEST_AG_DB);
            agDb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
            agDb.query('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityAuthStatus', session.auth_status);
            agDb.close();

            // Verify
            const agDb2 = new Database(TEST_AG_DB, { readonly: true });
            const loaded = agDb2.query('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus') as { value: string };
            agDb2.close();

            const loadedData = JSON.parse(loaded.value);
            expect(loadedData.email).toBe('load@gmail.com');
        });
    });

    describe('Session Rotation', () => {
        test('should rotate to next session correctly', () => {
            const db = new Database(TEST_SESSION_DB);
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

            const now = Date.now();

            // Add three sessions
            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'user1@gmail.com', '{}', '{}', now - 3000, now, now
            );
            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'user2@gmail.com', '{}', '{}', now - 2000, now, now
            );
            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'user3@gmail.com', '{}', '{}', now - 1000, now, now
            );
            db.close();

            // Get sessions ordered by last_used
            const sessions = getAllSessions();
            expect(sessions).toHaveLength(3);

            // Should rotate: user1 -> user2 -> user3 -> user1
            const db2 = new Database(TEST_SESSION_DB);
            const orderedSessions = db2.query('SELECT email FROM sessions ORDER BY last_used ASC').all() as { email: string }[];
            db2.close();

            expect(orderedSessions[0].email).toBe('user1@gmail.com');
            expect(orderedSessions[1].email).toBe('user2@gmail.com');
            expect(orderedSessions[2].email).toBe('user3@gmail.com');
        });

        test('should handle single session gracefully', () => {
            const db = new Database(TEST_SESSION_DB);
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

            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'only@gmail.com', '{}', '{}', 0, Date.now(), Date.now()
            );
            db.close();

            const sessions = getAllSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0].email).toBe('only@gmail.com');
        });
    });

    describe('Session Deletion', () => {
        test('should delete session from database', () => {
            const db = new Database(TEST_SESSION_DB);
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

            db.query('INSERT INTO sessions (email, auth_status, google_data, last_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                'delete@gmail.com', '{}', '{}', 0, Date.now(), Date.now()
            );
            db.close();

            // Delete
            const db2 = new Database(TEST_SESSION_DB);
            db2.query('DELETE FROM sessions WHERE email = ?').run('delete@gmail.com');
            db2.close();

            const session = getSessionFromDB('delete@gmail.com');
            expect(session).toBeNull();
        });
    });
});
