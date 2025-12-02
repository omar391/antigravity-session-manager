
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as workflow from "../src/workflow";
import * as ocr from "../src/ocr";
import * as automation from "../src/automation";
import * as learner from "../src/template-learner";
import * as fs from "fs";

// Mock dependencies
const mockFindElementWithRetry = mock(() => Promise.resolve({ x: 100, y: 100 } as any));
const mockClickAt = mock(() => Promise.resolve());
const mockCaptureTemplate = mock(() => Promise.resolve("base64template" as any));
const mockSaveTemplate = mock(() => true);
const mockReadFileSync = mock(() => JSON.stringify({
    workflow: {
        steps: [
            {
                action: "findAndClick",
                text: "Test Element",
                stepID: "test_step",
                maxWait: 100,
                retryInterval: 10
            }
        ]
    },
    ocr: { cacheEnabled: true }
}));
const mockExistsSync = mock(() => true);

// Apply mocks
mock.module("../src/ocr", () => ({
    findElementWithRetry: mockFindElementWithRetry
}));

mock.module("../src/automation", () => ({
    clickAt: mockClickAt,
    pressKey: mock(() => Promise.resolve()),
    openSettings: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve())
}));

mock.module("../src/template-learner", () => ({
    captureTemplateForStep: mockCaptureTemplate,
    saveTemplateToWorkflow: mockSaveTemplate
}));

mock.module("fs", () => ({
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    writeFileSync: mock(() => { })
}));

// Re-import workflow to apply mocks
const { executeWorkflow } = await import("../src/workflow");

describe("Workflow Execution", () => {
    beforeEach(() => {
        mockFindElementWithRetry.mockClear();
        mockClickAt.mockClear();
        mockCaptureTemplate.mockClear();
        mockSaveTemplate.mockClear();
    });

    it("should execute simple workflow successfully", async () => {
        mockFindElementWithRetry.mockResolvedValue({ x: 100, y: 100 });

        const result = await executeWorkflow([], "test@example.com");

        expect(result).toBe(true);
        expect(mockFindElementWithRetry).toHaveBeenCalled();
        expect(mockClickAt).toHaveBeenCalled();
    });

    it("should trigger learning mode when element not found", async () => {
        // First attempt fails
        mockFindElementWithRetry.mockResolvedValueOnce(null);
        // Second attempt (retry after learning) succeeds
        mockFindElementWithRetry.mockResolvedValueOnce({ x: 200, y: 200 });

        mockCaptureTemplate.mockResolvedValue("new-template");

        const result = await executeWorkflow([], "test@example.com", true, true); // learnMode = true

        expect(result).toBe(true);
        expect(mockCaptureTemplate).toHaveBeenCalledWith("test_step");
        expect(mockSaveTemplate).toHaveBeenCalled();
        expect(mockFindElementWithRetry).toHaveBeenCalledTimes(2);
    });

    it("should fail if element not found and learning cancelled", async () => {
        mockFindElementWithRetry.mockResolvedValue(null);
        mockCaptureTemplate.mockResolvedValue(null); // User cancelled

        const result = await executeWorkflow([], "test@example.com", true, true);

        expect(result).toBe(false);
        expect(mockCaptureTemplate).toHaveBeenCalled();
        expect(mockSaveTemplate).not.toHaveBeenCalled();
    });
});
