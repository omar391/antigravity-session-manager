
/**
 * Override console methods to add timestamps
 */
export function setupLogger() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function getTimestamp() {
        return new Date().toISOString().substr(11, 12); // HH:mm:ss.mmm
    }

    console.log = function (...args: any[]) {
        const ts = getTimestamp();
        originalLog.apply(console, [`[${ts}]`, ...args]);
    };

    console.error = function (...args: any[]) {
        const ts = getTimestamp();
        originalError.apply(console, [`[${ts}]`, ...args]);
    };

    console.warn = function (...args: any[]) {
        const ts = getTimestamp();
        originalWarn.apply(console, [`[${ts}]`, ...args]);
    };
}
