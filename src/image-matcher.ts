import { Jimp } from 'jimp';

export interface TemplateMatch {
    x: number;
    y: number;
    similarity: number;
    bounds: { width: number; height: number };
}

// OpenCV instance - must be set before use via initOpenCV()
let cv: any = null;

/**
 * Initialize OpenCV. Must be called once at application startup.
 * Call this from the main entry point (index.ts) before using any image matching functions.
 */
export async function initOpenCV(): Promise<void> {
    if (cv) return; // Already initialized

    console.log('🖼️  Initializing OpenCV-WASM...');
    const startTime = Date.now();
    const module = await require('opencv-wasm');
    cv = module.cv;
    console.log(`🖼️  OpenCV initialized in ${Date.now() - startTime}ms`);
}

/**
 * Check if OpenCV is initialized
 */
export function isOpenCVReady(): boolean {
    return cv !== null;
}

// Cache for loaded Mat objects (key: base64 hash, value: Mat)
const matCache = new Map<string, any>();

/**
 * Simple hash function for cache keys
 */
function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(str.length, 1000); i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
}

/**
 * Get or create cached Mat from base64 image
 */
export async function getCachedMat(base64Data: string): Promise<any> {
    const cacheKey = hashString(base64Data);

    if (matCache.has(cacheKey)) {
        return matCache.get(cacheKey);
    }

    const mat = await loadBase64Image(base64Data);
    matCache.set(cacheKey, mat);
    return mat;
}

/**
 * Clear Mat cache (call when templates change)
 */
export function clearMatCache(): void {
    for (const mat of matCache.values()) {
        if (mat && mat.delete) {
            mat.delete();
        }
    }
    matCache.clear();
}

/**
 * Load base64 encoded image as OpenCV Mat
 * Requires initOpenCV() to be called first
 */
export async function loadBase64Image(base64Data: string): Promise<any> {
    if (!cv) throw new Error('OpenCV not initialized. Call initOpenCV() first.');

    // Remove data URL prefix and decode
    const base64String = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64String, 'base64');

    // Use Jimp to decode image
    const jimpImg = await Jimp.read(buffer);

    // Convert to OpenCV Mat using matFromImageData
    return cv.matFromImageData({
        data: new Uint8ClampedArray(jimpImg.bitmap.data),
        width: jimpImg.width,
        height: jimpImg.height
    });
}

/**
 * Load image file as OpenCV Mat using Jimp
 */
async function loadImageFile(imagePath: string): Promise<any> {
    if (!cv) throw new Error('OpenCV not initialized. Call initOpenCV() first.');

    const jimpImg = await Jimp.read(imagePath);

    return cv.matFromImageData({
        data: new Uint8ClampedArray(jimpImg.bitmap.data),
        width: jimpImg.width,
        height: jimpImg.height
    });
}

/**
 * Find template in screenshot using OpenCV matchTemplate
 * Uses TM_CCOEFF_NORMED for normalized cross-correlation matching
 * 
 * Performance: ~2s for 3456x2234 screenshot with 100x100 template
 * (vs ~20s with our previous custom sliding window implementation)
 */
export async function findTemplateInImage(
    screenshotPath: string,
    template: any,
    similarityThreshold: number
): Promise<TemplateMatch | null> {
    if (!cv) throw new Error('OpenCV not initialized. Call initOpenCV() first.');

    try {
        // Load screenshot
        const screenshot = await loadImageFile(screenshotPath);

        // Validate dimensions
        if (template.rows > screenshot.rows || template.cols > screenshot.cols) {
            screenshot.delete();
            return null;
        }

        // Perform template matching using TM_CCOEFF_NORMED
        const resultMat = new cv.Mat();
        cv.matchTemplate(screenshot, template, resultMat, cv.TM_CCOEFF_NORMED);

        // Find best match location
        const mask = new cv.Mat();
        const minMax = cv.minMaxLoc(resultMat, mask);
        const similarity = minMax.maxVal;

        // Cleanup
        mask.delete();
        resultMat.delete();
        screenshot.delete();

        if (similarity >= similarityThreshold) {
            return {
                x: minMax.maxLoc.x + template.cols / 2,
                y: minMax.maxLoc.y + template.rows / 2,
                similarity,
                bounds: { width: template.cols, height: template.rows }
            };
        }

        return null;
    } catch (error) {
        console.error('OpenCV template matching error:', error);
        return null;
    }
}

/**
 * Find template with multi-scale matching for resolution independence
 */
export async function findTemplateMultiScale(
    screenshotPath: string,
    template: any,
    similarityThreshold: number,
    scales: number[]
): Promise<TemplateMatch | null> {
    if (!cv) throw new Error('OpenCV not initialized. Call initOpenCV() first.');

    let bestMatch: TemplateMatch | null = null;

    try {
        for (const scale of scales) {
            let scaledTemplate = template;

            // Resize if scale differs significantly from 1.0
            if (Math.abs(scale - 1.0) > 0.01) {
                scaledTemplate = new cv.Mat();
                const newSize = new cv.Size(
                    Math.floor(template.cols * scale),
                    Math.floor(template.rows * scale)
                );
                cv.resize(template, scaledTemplate, newSize);
            }

            const match = await findTemplateInImage(screenshotPath, scaledTemplate, similarityThreshold);

            // Clean up scaled template if we created one
            if (scaledTemplate !== template) {
                scaledTemplate.delete();
            }

            if (match) {
                if (!bestMatch || match.similarity > bestMatch.similarity) {
                    bestMatch = match;

                    // Early exit on excellent match
                    if (match.similarity > 0.99) {
                        return bestMatch;
                    }
                }
            }
        }
    } catch (error) {
        console.error('OpenCV multi-scale matching error:', error);
    }

    return bestMatch;
}
