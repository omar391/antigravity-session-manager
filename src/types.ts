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
}

export interface Config {
    workflow: {
        steps: WorkflowStep[];
    };
    ocr: {
        cacheEnabled: boolean;
        cacheLifetime: number;
        fuzzyMatchThreshold: number;
    };
}
