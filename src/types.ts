export interface Session {
    email: string;
    name?: string;
    auth_status: string;
    google_data: string;
    last_used: number;
    created_at: number;
    updated_at: number;
}

export interface WorkflowStep {
    action: 'pressKey' | 'wait' | 'findAndClick' | 'openSettings' | 'type' | 'clickAt';
    key?: string;
    modifiers?: string;
    ms?: number;
    text?: string;
    cacheName?: string;
    dynamic?: boolean;
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
