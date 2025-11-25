export interface Session {
    email: string;
    name?: string;
    last_used: number;
    created_at: number;
    updated_at: number;
}

export interface WorkflowStep {
    action: 'pressKey' | 'wait' | 'findAndClick' | 'findAndClickAny' | 'openSettings' | 'type' | 'clickAt';
    key?: string;
    modifiers?: string;
    ms?: number;
    text?: string;
    texts?: string[];  // For findAndClickAny - try multiple texts
    cacheName?: string;
    dynamic?: boolean;
    optional?: boolean; // If true, don't fail workflow if not found
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
