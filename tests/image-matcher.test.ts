/**
 * Unit tests for image-matcher.ts
 * Tests OpenCV-based template matching functionality
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Jimp } from 'jimp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    initOpenCV,
    isOpenCVReady,
    loadBase64Image,
    getCachedMat,
    clearMatCache,
    findTemplateInImage,
    findTemplateMultiScale
} from '../src/image-matcher';

const TEST_DIR = path.join(os.tmpdir(), 'image-matcher-tests');

describe('image-matcher', () => {
    // Test fixtures
    let testScreenshotPath: string;
    let testTemplateBase64: string;
    let templateX: number;
    let templateY: number;

    beforeAll(async () => {
        // Create test directory
        if (!fs.existsSync(TEST_DIR)) {
            fs.mkdirSync(TEST_DIR, { recursive: true });
        }

        // Initialize OpenCV
        await initOpenCV();

        // Create a test image (solid color with a distinct pattern in the center)
        const width = 800;
        const height = 600;
        const img = new Jimp({ width, height, color: 0x333333ff }); // Dark gray background

        // Draw a distinct colored rectangle in the center (our "template")
        templateX = 350; // Template starts at this X
        templateY = 250; // Template starts at this Y
        const templateWidth = 100;
        const templateHeight = 100;

        for (let y = templateY; y < templateY + templateHeight; y++) {
            for (let x = templateX; x < templateX + templateWidth; x++) {
                img.setPixelColor(0xff5500ff, x, y); // Orange color
            }
        }

        // Save as screenshot
        testScreenshotPath = path.join(TEST_DIR, 'test-screenshot.png');
        await img.write(testScreenshotPath as `${string}.${string}`);

        // Create template from the orange region
        const templateImg = img.clone().crop({ x: templateX, y: templateY, w: templateWidth, h: templateHeight });
        const buffer = await templateImg.getBuffer('image/png');
        testTemplateBase64 = `data:image/png;base64,${buffer.toString('base64')}`;
    });

    afterAll(() => {
        // Cleanup
        clearMatCache();
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    describe('initOpenCV', () => {
        test('should initialize OpenCV successfully', () => {
            expect(isOpenCVReady()).toBe(true);
        });

        test('should be idempotent (multiple calls are safe)', async () => {
            await initOpenCV();
            await initOpenCV();
            expect(isOpenCVReady()).toBe(true);
        });
    });

    describe('loadBase64Image', () => {
        test('should load a base64 image as OpenCV Mat', async () => {
            const mat = await loadBase64Image(testTemplateBase64);

            expect(mat).toBeDefined();
            expect(mat.cols).toBe(100);
            expect(mat.rows).toBe(100);

            mat.delete(); // Cleanup
        });

        test('should handle data URL prefix', async () => {
            const withPrefix = testTemplateBase64;
            const withoutPrefix = testTemplateBase64.replace(/^data:image\/\w+;base64,/, '');

            const mat1 = await loadBase64Image(withPrefix);
            const mat2 = await loadBase64Image(`data:image/png;base64,${withoutPrefix}`);

            expect(mat1.cols).toBe(mat2.cols);
            expect(mat1.rows).toBe(mat2.rows);

            mat1.delete();
            mat2.delete();
        });
    });

    describe('getCachedMat', () => {
        test('should cache Mat objects', async () => {
            clearMatCache(); // Start fresh

            // First call should load
            const mat1 = await getCachedMat(testTemplateBase64);
            expect(mat1).toBeDefined();

            // Second call should return cached
            const mat2 = await getCachedMat(testTemplateBase64);
            expect(mat2).toBe(mat1); // Same reference
        });

        test('should clear cache properly', async () => {
            await getCachedMat(testTemplateBase64);
            clearMatCache();

            // After clear, should load fresh
            const mat = await getCachedMat(testTemplateBase64);
            expect(mat).toBeDefined();
        });
    });

    describe('findTemplateInImage', () => {
        test('should find template in screenshot', async () => {
            const template = await loadBase64Image(testTemplateBase64);

            const result = await findTemplateInImage(
                testScreenshotPath,
                template,
                0.9 // 90% similarity threshold
            );

            expect(result).not.toBeNull();
            expect(result!.similarity).toBeGreaterThan(0.99); // Should be nearly perfect

            // Verify bounds are correct
            expect(result!.bounds.width).toBe(100);
            expect(result!.bounds.height).toBe(100);

            // Verify coordinates are within image bounds
            expect(result!.x).toBeGreaterThan(0);
            expect(result!.y).toBeGreaterThan(0);
            expect(result!.x).toBeLessThan(800);
            expect(result!.y).toBeLessThan(600);

            template.delete();
        });

        test('should return low similarity for unmatched template', async () => {
            // Create a template with a distinct pattern that doesn't exist in the screenshot
            // Use a checkerboard pattern which is unlikely to match solid colors
            const unmatchedImg = new Jimp({ width: 50, height: 50, color: 0x00ff00ff });
            for (let y = 0; y < 50; y++) {
                for (let x = 0; x < 50; x++) {
                    if ((x + y) % 10 < 5) {
                        unmatchedImg.setPixelColor(0x0000ffff, x, y); // Blue
                    }
                }
            }
            const buffer = await unmatchedImg.getBuffer('image/png');
            const base64 = `data:image/png;base64,${buffer.toString('base64')}`;

            const template = await loadBase64Image(base64);

            const result = await findTemplateInImage(
                testScreenshotPath,
                template,
                0.99 // Very high threshold - should fail
            );

            // With a distinct pattern and high threshold, should not match
            expect(result).toBeNull();
            template.delete();
        });

        test('should return null when template is larger than image', async () => {
            // Create large template
            const largeTemplate = new Jimp({ width: 1000, height: 1000, color: 0xff0000ff });
            const buffer = await largeTemplate.getBuffer('image/png');
            const base64 = `data:image/png;base64,${buffer.toString('base64')}`;

            const template = await loadBase64Image(base64);

            const result = await findTemplateInImage(
                testScreenshotPath,
                template,
                0.5
            );

            expect(result).toBeNull();
            template.delete();
        });
    });

    describe('findTemplateMultiScale', () => {
        test('should find template at original scale', async () => {
            const template = await loadBase64Image(testTemplateBase64);

            const result = await findTemplateMultiScale(
                testScreenshotPath,
                template,
                0.9,
                [1.0] // Only original scale
            );

            expect(result).not.toBeNull();
            expect(result!.similarity).toBeGreaterThan(0.99);

            template.delete();
        });

        test('should try multiple scales', async () => {
            const template = await loadBase64Image(testTemplateBase64);

            const result = await findTemplateMultiScale(
                testScreenshotPath,
                template,
                0.9,
                [1.0, 0.9, 1.1] // Multiple scales
            );

            expect(result).not.toBeNull();

            template.delete();
        });
    });
});
