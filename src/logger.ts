
/**
 * Override console methods to add timestamps
 */
export function setupLogger() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function getTimestamp() {
        return new Date().toLocaleTimeString('en-US', {
            hour12: true,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3
        });
    }

    console.log = function (...args: any[]) {
        originalLog(`[${getTimestamp()}]`, ...args);
    };

    console.error = function (...args: any[]) {
        originalError(`[${getTimestamp()}]`, ...args);
    };

    console.warn = function (...args: any[]) {
        originalWarn(`[${getTimestamp()}]`, ...args);
    };
}
