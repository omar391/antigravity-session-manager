import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { screen, imageToJimp } from "@nut-tree-fork/nut-js";
import { Jimp } from 'jimp';
import { loadBase64Image, findTemplateInImage, findTemplateMultiScale } from './image-matcher';

const CACHE_FILE = path.join(process.cwd(), 'element-cache.json');
const TEMP_DIR = path.join(os.tmpdir(), 'antigravity-ocr');

export interface ElementPosition {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    confidence?: number;
    timestamp?: number;
}

export interface OCRResult {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
}

interface CachedElement {
    x: number;
    y: number;
    timestamp: number;
}

interface Cache {
    [key: string]: CachedElement;
}

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Execute a shell command and return output
 */
async function execCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let output = '';
        let errorOutput = '';

        proc.stdout?.on('data', (data) => {
            output += data.toString();
        });

        proc.stderr?.on('data', (data) => {
            errorOutput += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`Command failed: ${errorOutput || output}`));
            }
        });
    });
}

/**
 * Capture screenshot of the entire screen
 * @param outputPath Optional path to save screenshot (default: temp file)
 * @returns Path to the captured screenshot
 */
export async function captureScreen(outputPath?: string): Promise<string> {
    const screenshotPath = outputPath || path.join(TEMP_DIR, `screenshot-${Date.now()}.png`);

    try {
        // Capture entire screen using nut.js
        // Use grab() instead of capture() to get the image in memory without saving
        const img = await screen.grab();

        // Convert to Jimp and save
        const jimpImg = await imageToJimp(img);
        await jimpImg.writeAsync(screenshotPath);

        return screenshotPath;
    } catch (error) {
        throw new Error(`Failed to capture screenshot: ${error}`);
    }
}

/**
 * Detect text in an image using Tesseract OCR
 * @param imagePath Path to the image file
 * @returns Array of detected text with positions
 */
export async function detectText(imagePath: string): Promise<OCRResult[]> {
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
    }

    const tsvPath = path.join(TEMP_DIR, `ocr-output-${Date.now()}.tsv`);

    try {
        // Run Tesseract with TSV output for bounding box data
        // Use PSM 6 (assume a single uniform block of text) for better detection
        await execCommand('tesseract', [imagePath, tsvPath.replace('.tsv', ''), '--psm', '6', 'tsv']);

        // Read and parse TSV output
        const tsvContent = fs.readFileSync(tsvPath, 'utf-8');
        const lines = tsvContent.split('\n').slice(1); // Skip header

        const results: OCRResult[] = [];

        for (const line of lines) {
            if (!line.trim()) continue;

            const parts = line.split('\t');
            if (parts.length < 12) continue;

            const level = parseInt(parts[0]);
            const text = parts[11]?.trim();
            const conf = parseFloat(parts[10]);

            // Only process word-level detections (level 5) with valid text
            if (level === 5 && text && text.length > 0 && conf > 0) {
                const x = parseInt(parts[6]);
                const y = parseInt(parts[7]);
                const width = parseInt(parts[8]);
                const height = parseInt(parts[9]);

                results.push({
                    text,
                    x,
                    y,
                    width,
                    height,
                    confidence: conf / 100 // Normalize to 0-1
                });
            }
        }

        // Cleanup temp file
        if (fs.existsSync(tsvPath)) {
            fs.unlinkSync(tsvPath);
        }

        return results;
    } catch (error) {
        throw new Error(`OCR detection failed: ${error}`);
    }
}

/**
 * Calculate string similarity using Levenshtein distance
 */
function stringSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    const len1 = s1.length;
    const len2 = s2.length;

    const matrix: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }

    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);

    return 1 - (distance / maxLen);
}

/**
 * Parse hex color code to RGB
 * @param hex Color code (e.g., "#007AFF" or "#007AFF:0.4" with tolerance)
 * @returns RGB values and optional tolerance
 */
function parseHexColor(hex: string): { r: number, g: number, b: number, tolerance: number } {
    // Check for tolerance suffix
    let colorPart = hex;
    let tolerance = 0.3; // default

    if (hex.includes(':')) {
        const parts = hex.split(':');
        colorPart = parts[0];
        tolerance = parseFloat(parts[1]) || 0.3;
    }

    // Remove # if present
    colorPart = colorPart.replace('#', '');

    // Parse RGB
    const r = parseInt(colorPart.substring(0, 2), 16);
    const g = parseInt(colorPart.substring(2, 4), 16);
    const b = parseInt(colorPart.substring(4, 6), 16);

    return { r, g, b, tolerance };
}

/**
 * Find element by image template matching
 * @param screenshotPath Path to screenshot
 * @param imageTemplate base64 encoded template image
 * @param similarity Similarity threshold (0-1), default 0.85
 * @param multiScale Whether to try multiple scales
 * @returns Element position or null
 */
export async function findElementByImage(
    screenshotPath: string,
    imageTemplate: string,
    similarity: number = 0.85,
    multiScale: boolean = false
): Promise<{ x: number; y: number } | null> {
    try {
        // Load template
        const template = await loadBase64Image(imageTemplate);

        // Find match
        const match = multiScale
            ? await findTemplateMultiScale(screenshotPath, template, similarity)
            : await findTemplateInImage(screenshotPath, template, similarity);

        if (match) {
            console.log(`🖼️  Image match found at (${match.x}, ${match.y}) [similarity: ${match.similarity.toFixed(2)}]`);
            return { x: match.x, y: match.y };
        }

        return null;
    } catch (error) {
        console.error(`❌ Image matching error: ${error}`);
        return null;
    }
}


/**
 * Check if a pixel matches the target color within tolerance
 */
function isColorMatch(
    pixelR: number,
    pixelG: number,
    pixelB: number,
    targetR: number,
    targetG: number,
    targetB: number,
    tolerance: number
): boolean {
    const maxDiff = 255 * tolerance;

    const rDiff = Math.abs(pixelR - targetR);
    const gDiff = Math.abs(pixelG - targetG);
    const bDiff = Math.abs(pixelB - targetB);

    // All channels must be within tolerance
    return rDiff <= maxDiff && gDiff <= maxDiff && bDiff <= maxDiff;
}

/**
 * Check if OCR result is on a background matching the target color
 * @param hex Hex color code (e.g., "#007AFF" or "#007AFF:0.4")
 */
function isTextOnColorBackground(
    jimp: any,
    result: OCRResult,
    hex: string,
    sampleSize: number = 10
): boolean {
    const { r: targetR, g: targetG, b: targetB, tolerance } = parseHexColor(hex);
    let matchingPixelCount = 0;
    const totalSamples = sampleSize * sampleSize;

    // Sample pixels around the text position
    for (let dx = 0; dx < sampleSize; dx++) {
        for (let dy = 0; dy < sampleSize; dy++) {
            const x = Math.floor(result.x - sampleSize / 2 + dx);
            const y = Math.floor(result.y - sampleSize / 2 + dy);

            // Check bounds
            if (x < 0 || y < 0 || x >= jimp.width || y >= jimp.height) continue;

            // Get pixel from bitmap data
            const idx = (y * jimp.width + x) * 4;
            const r = jimp.bitmap.data[idx];
            const g = jimp.bitmap.data[idx + 1];
            const b = jimp.bitmap.data[idx + 2];

            if (isColorMatch(r, g, b, targetR, targetG, targetB, tolerance)) {
                matchingPixelCount++;
            }
        }
    }

    // If more than 30% of sampled pixels match, consider it a match
    return matchingPixelCount / totalSamples > 0.3;
}


/**
 * Find an element by text using OCR
 * @param searchText Text to search for
 * @param threshold Minimum similarity threshold (0-1)
 * @param region Optional region to search within (e.g., "left", "right", "top", "bottom", "center")
 * @param colorFilter Optional hex color code (e.g., "#007AFF" or "#007AFF:0.4" with tolerance)
 * @returns Element position or null if not found
 */
export async function findElement(
    searchText: string,
    threshold: number = 0.8,
    region?: string,
    colorFilter?: string
): Promise<ElementPosition | null> {
    const colorInfo = colorFilter ? parseHexColor(colorFilter) : null;
    console.log(`🔍 Searching for: "${searchText}"${region ? ` (Region: ${region})` : ''}${colorInfo ? ` (Color: ${colorFilter})` : ''}`);

    // Capture screenshot
    const debugMode = process.env.DEBUG_OCR === '1';
    let screenshotPath: string;

    if (debugMode) {
        screenshotPath = path.join(process.cwd(), `debug-screenshot-${Date.now()}.png`);
        await captureScreen(screenshotPath);
        console.log(`📸 Debug screenshot saved: ${screenshotPath}`);
    } else {
        screenshotPath = await captureScreen();
    }

    try {
        // Detect text
        let ocrResults = await detectText(screenshotPath);

        if (debugMode) {
            console.log(`📋 OCR detected ${ocrResults.length} text elements`);
            console.log('Top 10 detected texts:', ocrResults.slice(0, 10).map(r => r.text).join(', '));
        }

        // Filter by region if specified
        if (region && ocrResults.length > 0) {
            const debugMode = process.env.DEBUG_OCR === '1';
            const jimp = await Jimp.read(screenshotPath);
            const screenWidth = jimp.width;
            const screenHeight = jimp.height;

            if (debugMode) {
                console.log(`Screen dimensions: ${screenWidth}x${screenHeight}`);
            }

            const originalCount = ocrResults.length;
            ocrResults = ocrResults.filter(result => {
                switch (region.toLowerCase()) {
                    case 'right':
                        return result.x > screenWidth / 2;
                    case 'left':
                        return result.x < screenWidth / 2;
                    case 'top':
                        return result.y < screenHeight / 2;
                    case 'bottom':
                        return result.y > screenHeight / 2;
                    case 'center':
                        // Middle 50% of screen (25%-75% on each axis)
                        return result.x > screenWidth * 0.25 && result.x < screenWidth * 0.75 &&
                            result.y > screenHeight * 0.25 && result.y < screenHeight * 0.75;
                    default:
                        return true; // Unknown region, don't filter
                }
            });

            if (ocrResults.length > 0) {
                console.log(`🔍 Filtered to ${ocrResults.length} elements in ${region} region (from ${originalCount})`);
                if (ocrResults.length > 0 && ocrResults.length <= 20) {
                    console.log('Filtered region texts:', ocrResults.map(r => r.text).join(', '));
                }
            }
        }

        // Filter by color if specified
        if (colorFilter && ocrResults.length > 0) {
            const jimp = await Jimp.read(screenshotPath);
            const originalCount = ocrResults.length;

            ocrResults = ocrResults.filter(result => isTextOnColorBackground(jimp, result, colorFilter));

            if (ocrResults.length > 0) {
                console.log(`🔍 Filtered to ${ocrResults.length} elements on target color background (from ${originalCount})`);
            }
        }

        if (ocrResults.length === 0) {
            console.log('⚠️  No text detected in screenshot');
            return null;
        }

        // Find best match
        let bestMatch: OCRResult | null = null;
        let bestSimilarity = 0;

        for (const result of ocrResults) {
            const similarity = stringSimilarity(searchText, result.text);

            // Also check if search text is contained in the detected text
            const containsMatch = result.text.toLowerCase().includes(searchText.toLowerCase());

            if (similarity > bestSimilarity && similarity >= threshold) {
                bestSimilarity = similarity;
                bestMatch = result;
            } else if (containsMatch && similarity > 0.6) {
                // Lower threshold for substring matches
                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestMatch = result;
                }
            }
        }

        if (bestMatch) {
            // Calculate center point for clicking
            const centerX = bestMatch.x + Math.floor(bestMatch.width / 2);
            const centerY = bestMatch.y + Math.floor(bestMatch.height / 2);

            console.log(`✅ Found: "${bestMatch.text}" at (${centerX}, ${centerY}) [similarity: ${bestSimilarity.toFixed(2)}]`);

            return {
                x: centerX,
                y: centerY,
                width: bestMatch.width,
                height: bestMatch.height,
                text: bestMatch.text,
                confidence: bestSimilarity,
                timestamp: Date.now()
            };
        }

        console.log(`❌ Not found: "${searchText}" (best similarity: ${bestSimilarity.toFixed(2)})`);
        return null;

    } finally {
        // Cleanup screenshot (unless in debug mode)
        if (!debugMode && fs.existsSync(screenshotPath)) {
            fs.unlinkSync(screenshotPath);
        }
    }
}

/**
 * Get cached element position
 * @param elementName Name of the cached element
 * @param maxAge Maximum age in milliseconds (default: 24 hours)
 * @returns Cached position or null if not found/expired
 */
export function getCachedPosition(elementName: string, maxAge: number = 86400000): { x: number; y: number } | null {
    if (!fs.existsSync(CACHE_FILE)) {
        return null;
    }

    try {
        const cache: Cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        const cached = cache[elementName];

        if (!cached) {
            return null;
        }

        // Check if cache is still valid
        const age = Date.now() - cached.timestamp;
        if (age > maxAge) {
            console.log(`⏰ Cache expired for: ${elementName}`);
            return null;
        }

        console.log(`💾 Using cached position for: ${elementName}`);
        return { x: cached.x, y: cached.y };

    } catch (error) {
        console.error('Failed to read cache:', error);
        return null;
    }
}

/**
 * Cache element position
 * @param elementName Name to cache the element under
 * @param position Position to cache
 */
export function cachePosition(elementName: string, position: { x: number; y: number }): void {
    let cache: Cache = {};

    if (fs.existsSync(CACHE_FILE)) {
        try {
            cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        } catch (error) {
            console.error('Failed to read existing cache:', error);
        }
    }

    cache[elementName] = {
        x: position.x,
        y: position.y,
        timestamp: Date.now()
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`💾 Cached position for: ${elementName}`);
}

/**
 * Clear the element cache
 */
export function clearCache(): void {
    if (fs.existsSync(CACHE_FILE)) {
        fs.unlinkSync(CACHE_FILE);
        console.log('🗑️  Cache cleared');
    }
}

/**
 * Find element with caching support
 * @param elementName Name for caching
 * @param searchText Text to search for
 * @param useCache Whether to use cached position
 * @param region Optional region to search within
 * @returns Element position or null
 */
export async function findElementCached(
    elementName: string,
    searchText: string,
    useCache: boolean = true,
    region?: string,
    colorFilter?: string
): Promise<{ x: number; y: number } | null> {
    // Try cache first
    if (useCache) {
        const cached = getCachedPosition(elementName);
        if (cached) {
            return cached;
        }
    }

    // Find element using OCR
    const element = await findElement(searchText, 0.8, region, colorFilter);
    if (!element) {
        return null;
    }

    // Cache the position
    cachePosition(elementName, { x: element.x, y: element.y });

    return { x: element.x, y: element.y };
}

/**
 * Find element with retry logic and auto-wait
 * @param elementName Name for caching
 * @param searchText Text to search for
 * @param useCache Whether to use cached position
 * @param region Optional region to search within
 * @param maxWait Maximum time to wait for element (ms), default 5000
 * @param retryInterval Time between retries (ms), default 500
 * @returns Element position or null
 */
export async function findElementWithRetry(
    elementName: string,
    searchText: string,
    useCache: boolean = true,
    region?: string,
    maxWait: number = 5000,
    retryInterval: number = 500,
    colorFilter?: string,
    imageTemplate?: string,
    imageSimilarity?: number,
    multiScale?: boolean
): Promise<{ x: number; y: number } | null> {
    const startTime = Date.now();

    // Helper to verify cache
    const verifyCache = async (): Promise<{ x: number; y: number } | null> => {
        if (!useCache) return null;
        const cached = getCachedPosition(elementName);
        if (!cached) return null;

        console.log(`💾 Checking cached position for: ${elementName}`);
        // Quick verification using region check around cached point
        // For now, we'll just return it if we trust it, but ideally we verify
        // Since we are racing, we can just return it and let the click handler deal with it?
        // No, we should verify it exists. 
        // Let's do a quick focused OCR/Image check at that spot

        // For speed in this parallel model, if cache exists, we can treat it as a strong candidate
        // But to be safe, let's verify it quickly
        const element = await findElement(searchText, 0.8, region, colorFilter);
        if (element) {
            console.log(`✅ Cache verified`);
            return { x: element.x, y: element.y };
        }
        return null;
    };

    // Helper for image matching
    const tryImages = async (): Promise<{ x: number; y: number } | null> => {
        if (!imageTemplate) return null;
        const screenshot = await captureScreen();
        return await findElementByImage(screenshot, imageTemplate, imageSimilarity, multiScale);
    };

    // Helper for OCR
    const tryOCR = async (): Promise<{ x: number; y: number } | null> => {
        return await findElement(searchText, 0.8, region, colorFilter);
    };

    // Retry loop with timeout
    while (Date.now() - startTime < maxWait) {
        // Run all methods in parallel and take the first success
        try {
            const promises: Promise<{ x: number; y: number } | null>[] = [];

            // 1. Cache Verification
            if (useCache) {
                promises.push(verifyCache());
            }

            // 2. Image Matching
            if (imageTemplate) {
                promises.push(tryImages());
            }

            // 3. OCR (Always try)
            promises.push(tryOCR());

            // Wait for the first successful result (non-null)
            // Promise.any would be ideal but might not be available in all environments
            // We'll use a custom race that ignores nulls until all fail
            const result = await Promise.any(promises.map(p => p.then(res => {
                if (res === null) throw new Error('Not found');
                return res;
            })));

            if (result) {
                // Cache the position for future use
                cachePosition(elementName, { x: result.x, y: result.y });
                return result;
            }
        } catch (e) {
            // All methods failed for this iteration
        }

        // Wait before retrying
        const elapsed = Date.now() - startTime;
        if (elapsed < maxWait) {
            const waitTime = Math.min(retryInterval, maxWait - elapsed);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    // Timeout - element not found
    return null;
}
