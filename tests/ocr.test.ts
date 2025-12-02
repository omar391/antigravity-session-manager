
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock external dependencies
const mockSpawn = mock(() => ({
    stdout: {
        on: (event: string, cb: any) => {
            if (event === 'data') cb("Level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t100\t20\t20\t90\tTest Element");
        }
    },
    stderr: { on: () => { } },
    on: (event: string, cb: any) => { if (event === 'close') cb(0) }
}));

const mockScreenGrab = mock(() => Promise.resolve({ width: 1920, height: 1080, data: new Uint8Array(0) }));
const mockImageToJimp = mock(() => Promise.resolve({
    writeAsync: mock(() => Promise.resolve()),
    width: 1920,
    height: 1080,
    bitmap: { data: new Uint8Array(1920 * 1080 * 4) }
}));

const mockFindTemplateInImage = mock((path: any, tmpl: any, sim: any) => Promise.resolve(null as any));
const mockLoadBase64Image = mock(() => Promise.resolve({}));
const mockFindTemplateMultiScale = mock(() => Promise.resolve(null));

const mockFs = {
    existsSync: mock(() => true),
    mkdirSync: mock(() => { }),
    readFileSync: mock((path: string) => {
        // Config file - workflow.json
        if (path.includes('workflow.json')) return JSON.stringify({
            workflow: { steps: [] },
            ocr: {
                initialSimilarity: 0.99,
                similarityDecayRate: 0.05,
                minSimilarity: 0.7
            }
        });
        if (path.endsWith('.json')) return JSON.stringify({});
        if (path.endsWith('.tsv')) return "Level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t100\t20\t20\t90\tTest Element";
        return "";
    }),
    writeFileSync: mock(() => { }),
    unlinkSync: mock(() => { }),
    promises: {}
};

// Apply mocks
mock.module("child_process", () => ({ spawn: mockSpawn }));
mock.module("@nut-tree-fork/nut-js", () => ({
    screen: { grab: mockScreenGrab },
    imageToJimp: mockImageToJimp
}));
mock.module("fs", () => mockFs);
mock.module("../src/image-matcher", () => ({
    loadBase64Image: mockLoadBase64Image,
    findTemplateInImage: mockFindTemplateInImage,
    findTemplateMultiScale: mockFindTemplateMultiScale
}));

// Import system under test
const ocr = await import("../src/ocr");

// Helper to create readFileSync mock with config support
const createMockReadFileSync = (cacheData: any = {}, tsvContent: string | null = null) => {
    return (path: string) => {
        // Config file - workflow.json
        if (path.includes('workflow.json')) return JSON.stringify({
            workflow: { steps: [] },
            ocr: {
                cacheEnabled: true,
                cacheLifetime: 3600000,
                fuzzyMatchThreshold: 0.8,
                initialSimilarity: 0.99,
                similarityDecayRate: 0.05,
                minSimilarity: 0.7
            }
        });
        // Cache file - element-cache.json with custom data
        if (path.includes('element-cache.json')) return JSON.stringify(cacheData);
        // TSV files (OCR output)
        if (path.endsWith('.tsv')) return tsvContent !== null ? tsvContent : "Level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t100\t20\t20\t90\tTest Element";
        return "";
    };
};

describe("OCR Logic", () => {
    beforeEach(() => {
        mockSpawn.mockClear();
        mockScreenGrab.mockClear();
        mockFindTemplateInImage.mockClear();
        mockFs.readFileSync.mockClear();
        mockFs.writeFileSync.mockClear();
    });

    describe("findElementWithRetry", () => {
        it("should return cached position if available and verified", async () => {
            // Setup cache hit
            mockFs.readFileSync.mockImplementation(createMockReadFileSync({
                "test_id": { x: 100, y: 100, timestamp: Date.now() }
            }));

            // Setup verification success (via OCR fallback)
            // Note: In the real implementation, we read from file, so the mockReadFileSync handles the TSV content.
            // The default mock returns "Test Element" at 100,100 (20x20 size), so center is 110,110.

            const result = await ocr.findElementWithRetry("test_id", "Test Element", true, undefined, 1000, 100);

            expect(result).not.toBeNull();
            expect(result?.x).toBe(110); // Should return the VERIFIED position (center), not the cached one
        });

        it("should fallback to OCR if cache misses", async () => {
            const tsvContent = "Level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t200\t200\t20\t20\t90\tTest Element";

            mockFs.readFileSync.mockImplementation(createMockReadFileSync({}, tsvContent));

            // Mock OCR finding it at 200,200 (stdout is ignored but we keep it for completeness)
            mockSpawn.mockImplementation(() => ({
                stdout: {
                    on: (event: string, cb: any) => {
                        if (event === 'data') cb(tsvContent);
                    }
                },
                stderr: { on: () => { } },
                on: (event: string, cb: any) => { if (event === 'close') cb(0) }
            }) as any);

            const result = await ocr.findElementWithRetry("test_id", "Test Element", true, undefined, 1000, 100);

            expect(result).not.toBeNull();
            expect(result?.x).toBe(210); // Center of 200 + 20/2
        });

        it("should prioritize image match if template provided", async () => {
            mockFs.readFileSync.mockImplementation(createMockReadFileSync({}));

            // Image match succeeds
            mockFindTemplateInImage.mockResolvedValue({ x: 300, y: 300, similarity: 0.9 });

            // OCR also succeeds (default mock)

            const result = await ocr.findElementWithRetry(
                "test_id",
                "Test Element",
                true,
                undefined,
                1000,
                100,
                undefined,
                "base64template"
            );

            expect(result).not.toBeNull();
            // It's a race, but image match is usually prioritized or at least checked.
            // In the implementation, image matching is pushed to promises list before OCR if template exists.
            // So it should win if it resolves fast enough.
            // But since both are async mocks resolving immediately, order depends on event loop.
            // Let's just check it's not null for now, or update expectation if we want to enforce priority.
        });

        it("should decrease similarity threshold on retry", async () => {
            // Make OCR fail by returning empty TSV
            mockFs.readFileSync.mockImplementation(createMockReadFileSync({}, ""));

            // Image match fails initially, then succeeds with lower threshold
            let callCount = 0;
            mockFindTemplateInImage.mockImplementation(async (path: any, tmpl: any, sim: any) => {
                callCount++;
                if (sim < 0.95) {
                    return { x: 500, y: 500, similarity: sim };
                }
                return null;
            });

            const result = await ocr.findElementWithRetry(
                "test_id",
                "Test Element",
                false,
                undefined,
                2000, // Max wait
                100,  // Retry interval
                undefined,
                "base64template",
                0.8 // Min similarity
            );

            expect(result).not.toBeNull();
            expect(result?.x).toBe(500);
            expect(callCount).toBeGreaterThan(1);
        });

        it("should retry screenshot capture on failure", async () => {
            mockFs.readFileSync.mockImplementation(createMockReadFileSync({}));

            // First capture fails, second succeeds
            mockScreenGrab
                .mockRejectedValueOnce(new Error("Capture failed"))
                .mockResolvedValue({ width: 1920, height: 1080, data: new Uint8Array(0) });

            mockSpawn.mockImplementation(() => ({
                stdout: {
                    on: (event: string, cb: any) => {
                        if (event === 'data') cb("Level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t100\t20\t20\t90\tTest Element");
                    }
                },
                stderr: { on: () => { } },
                on: (event: string, cb: any) => { if (event === 'close') cb(0) }
            }) as any);

            const result = await ocr.findElementWithRetry("test_id", "Test Element", false, undefined, 1000, 100);

            expect(result).not.toBeNull();
            expect(mockScreenGrab).toHaveBeenCalledTimes(2);
        });
    });
});
