
import type { Config } from './types';

/**
 * Application-wide constants and default values
 * Structured to match the 'config' section of workflow.json
 */
/**
 * Application-wide constants and default values
 * Structured to match the 'config' section of workflow.json
 */
const DEFAULTS: Config = {
    workflow: {
        steps: [],
        maxWait: 5000,
        retryInterval: 500,
    },
    ocr: {
        initialSimilarity: 0.99,      // For adaptive search
        minSimilarity: 0.7,           // For adaptive search
        decayRate: 0.05,              // For adaptive search
        defaultThreshold: 0.85,       // For static match
        scales: [0.8, 0.9, 1.0, 1.1, 1.2],
        minConfidence: 0.8,           // For OCR
        learningModeRetryTimeout: 20000,
        cacheEnabled: true
    }
};

/**
 * Merges user configuration with defaults
 */
export function getEffectiveConfig(userConfig: any): Config {
    return {
        workflow: {
            ...DEFAULTS.workflow,
            ...userConfig?.workflow,
            steps: userConfig?.workflow?.steps || []
        },
        ocr: {
            ...DEFAULTS.ocr,
            ...userConfig?.ocr
        }
    };
}
