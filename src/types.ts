export interface Session {
    email: string;
    name?: string;
    last_used: number;
    created_at: number;
    updated_at: number;
}

export interface WorkflowStep {
    action: 'pressKey' | 'wait' | 'findAndClick' | 'findAndClickAny' | 'openSettings' | 'type' | 'clickAt';
    stepID?: string;    // Unique ID for this step (used as cache key)
    key?: string;
    modifiers?: string;
    ms?: number;
    text?: string;
    texts?: string[];  // For findAndClickAny - try multiple texts
    imageTemplate?: string;  // base64 encoded PNG template for image matching
    imageTemplates?: string[];  // Try multiple image templates (like texts)
    imageSimilarity?: number;  // Similarity threshold (0-1), default 0.85
    multiScale?: boolean;  // Try multiple scales for resolution independence
    dynamic?: boolean;
    optional?: boolean; // If true, don't fail workflow if not found
    useCache?: boolean;  // Whether to use cache, default true
    maxWait?: number;    // Max time to wait for element (ms), default 5000
    retryInterval?: number; // Time between retries (ms), default 500
    colorFilter?: string;  // Hex color code (e.g., "#007AFF") with optional tolerance suffix (e.g., "#007AFF:0.4")
    description?: string;
    region?: string;
    x?: number;
    y?: number;
    cachedX?: number;  // Cached x coordinate from last successful match
    cachedY?: number;  // Cached y coordinate from last successful match
}

export interface Config {
    workflow: {
        steps: WorkflowStep[];
        // Global workflow settings
        maxWait: number;           // Default 5000ms
        retryInterval: number;     // Default 500ms
    };
    ocr: {
        // OCR & Image Matching settings
        initialSimilarity: number;      // Default 0.99
        minSimilarity: number;          // Default 0.7
        decayRate: number;              // Default 0.05
        defaultThreshold: number;       // Default 0.85
        stepSize: number;               // Default 5
        scales: number[];               // Default [0.8, 0.9, 1.0, 1.1, 1.2]
        minConfidence: number;          // Default 0.8
        learningModeRetryTimeout: number; // Default 20000ms
        cacheEnabled: boolean;          // Default true
    };
}

export interface ElementPosition {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    confidence: number;
    timestamp: number;
}
