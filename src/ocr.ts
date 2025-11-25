import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { screen, imageToJimp } from "@nut-tree-fork/nut-js";

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
 * Find an element by text using OCR
 * @param searchText Text to search for
 * @param threshold Minimum similarity threshold (0-1)
 * @param region Optional region to search within (e.g., "left", "right", "top", "bottom")
 * @returns Element position or null if not found
 */
export async function findElement(
    searchText: string,
    threshold: number = 0.8,
    region?: string
): Promise<ElementPosition | null> {
    console.log(`🔍 Searching for: "${searchText}"${region ? ` (Region: ${region})` : ''}`);

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
            const originalCount = ocrResults.length;

            // Calculate bounds once before filtering
            const minX = Math.min(...ocrResults.map(r => r.x));
            const maxX = Math.max(...ocrResults.map(r => r.x + r.width));
            const maxY = Math.max(...ocrResults.map(r => r.y + r.height));

            ocrResults = ocrResults.filter(result => {
                switch (region.toLowerCase()) {
                    case 'left':
                        // Settings sidebar: within first 3200px from leftmost content
                        // (very wide for Retina displays - sidebar appears around x=3000px)
                        return result.x < minX + 3200;
                    case 'right':
                        return result.x > (2 * maxX) / 3;
                    case 'center':
                        const centerMinX = minX + (maxX - minX) / 3;
                        const centerMaxX = minX + (2 * (maxX - minX)) / 3;
                        return result.x > centerMinX && result.x < centerMaxX;
                    case 'top':
                        return result.y < maxY / 3;
                    case 'bottom':
                        return result.y > (2 * maxY) / 3;
                    default:
                        return true;
                }
            });

            if (debugMode) {
                console.log(`🔍 Filtered to ${ocrResults.length} elements in ${region} region (from ${originalCount})`);
                if (ocrResults.length > 0 && ocrResults.length <= 20) {
                    console.log('Filtered region texts:', ocrResults.map(r => r.text).join(', '));
                }
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
    region?: string
): Promise<{ x: number; y: number } | null> {
    // Try cache first
    if (useCache) {
        const cached = getCachedPosition(elementName);
        if (cached) {
            return cached;
        }
    }

    // Find element using OCR
    const element = await findElement(searchText, 0.8, region);
    if (!element) {
        return null;
    }

    // Cache the position
    cachePosition(elementName, { x: element.x, y: element.y });

    return { x: element.x, y: element.y };
}
