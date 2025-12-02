
import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mocks
const mockCaptureScreen = mock(() => Promise.resolve("mock-screenshot.png"));
const mockFindElement = mock((text: string, minConfidence: number, region?: string, colorFilter?: string, screenshotPath?: string) => Promise.resolve<{ x: number, y: number } | null>(null));
const mockFindElementByImage = mock((screenshotPath: string, imageTemplate: string, similarity: number, multiScale: boolean, config: any) => Promise.resolve<{ x: number, y: number } | null>(null));
const mockClickAt = mock(() => Promise.resolve());
const mockUpdateStepAfterMatch = mock(() => true);
const mockReadFileSync = mock(() => JSON.stringify({
    workflow: { steps: [] },
    ocr: { cacheEnabled: true, defaultThreshold: 0.85 }
}));

// Apply mocks
mock.module("../src/ocr", () => ({
    captureScreen: mockCaptureScreen,
    findElement: mockFindElement,
    findElementByImage: mockFindElementByImage,
    findElementWithRetry: mock(() => Promise.resolve(null))
}));

mock.module("../src/automation", () => ({
    clickAt: mockClickAt,
    wait: mock(() => Promise.resolve()),
    pressKey: mock(() => Promise.resolve()),
    openSettings: mock(() => Promise.resolve())
}));

mock.module("../src/template-learner", () => ({
    updateStepAfterMatch: mockUpdateStepAfterMatch,
    captureTemplateForStep: mock(() => Promise.resolve(null)),
    saveTemplateToWorkflow: mock(() => { })
}));

mock.module("fs", () => ({
    readFileSync: mockReadFileSync,
    existsSync: mock(() => true),
    unlinkSync: mock(() => { }),
    writeFileSync: mock(() => { })
}));

// Import after mocks
const { executeWorkflow } = await import("../src/workflow");

describe("Multi-Config Execution", () => {
    beforeEach(() => {
        mockCaptureScreen.mockClear();
        mockFindElement.mockClear();
        mockFindElementByImage.mockClear();
        mockClickAt.mockClear();
        mockUpdateStepAfterMatch.mockClear();
    });

    it("should execute parallel configs and click the first match", async () => {
        // Setup config with multi-config step
        mockReadFileSync.mockReturnValue(JSON.stringify({
            workflow: {
                steps: [
                    {
                        stepID: "multi_step",
                        variants: [
                            { text: "Option A", action: "findAndClick" },
                            { text: "Option B", action: "findAndClick" }
                        ],
                        maxWait: 500, // Enough for a few retries if needed, but we mock immediate success
                        retryInterval: 10
                    }
                ],
                maxWait: 5000,
                retryInterval: 500
            },
            ocr: { cacheEnabled: true, defaultThreshold: 0.85 }
        }));

        // Option B matches
        mockFindElement.mockImplementation(async (text) => {
            if (text === "Option B") return { x: 200, y: 200 };
            return null;
        });

        const result = await executeWorkflow([], "test@example.com");

        expect(result).toBe(true);
        expect(mockCaptureScreen).toHaveBeenCalled();
        // Both should be called (parallel execution started)
        // Note: Promise.all might not wait for all if one resolves, but we map them all.
        // Actually we use Promise.all so all are started.
        expect(mockFindElement).toHaveBeenCalledWith("Option A", expect.any(Number), undefined, undefined, "mock-screenshot.png");
        expect(mockFindElement).toHaveBeenCalledWith("Option B", expect.any(Number), undefined, undefined, "mock-screenshot.png");
        expect(mockClickAt).toHaveBeenCalledWith(200, 200);
    });

    it("should support image templates in multi-config", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({
            workflow: {
                steps: [
                    {
                        stepID: "image_multi_step",
                        variants: [
                            { text: "Text Option", action: "findAndClick" },
                            { imageTemplate: "base64data", action: "findAndClick" }
                        ],
                        maxWait: 500,
                        retryInterval: 10
                    }
                ],
                maxWait: 5000,
                retryInterval: 500
            },
            ocr: { cacheEnabled: true, defaultThreshold: 0.85 }
        }));

        // Image matches
        mockFindElementByImage.mockResolvedValue({ x: 300, y: 300 });

        const result = await executeWorkflow([], "test@example.com");

        expect(result).toBe(true);
        expect(mockFindElement).toHaveBeenCalled();
        expect(mockFindElementByImage).toHaveBeenCalled();
        expect(mockClickAt).toHaveBeenCalledWith(300, 300);
    });
});
