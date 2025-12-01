import { Jimp } from 'jimp';

export interface TemplateMatch {
    x: number;
    y: number;
    similarity: number;
}

/**
 * Load base64 encoded image
 */
export async function loadBase64Image(base64Data: string): Promise<any> {
    // Remove data URL prefix if present
    const base64String = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64String, 'base64');
    return await Jimp.read(buffer);
}

/**
 * Calculate similarity between two image regions (0-1)
 * Uses normalized cross-correlation
 */
function calculateSimilarity(
    screenshot: any,
    template: any,
    x: number,
    y: number
): number {
    const templateWidth = template.width;
    const templateHeight = template.height;

    // Check bounds
    if (x + templateWidth > screenshot.width || y + templateHeight > screenshot.height) {
        return 0;
    }

    let totalDiff = 0;
    let pixelCount = 0;

    // Compare pixels
    for (let ty = 0; ty < templateHeight; ty++) {
        for (let tx = 0; tx < templateWidth; tx++) {
            const sx = x + tx;
            const sy = y + ty;

            // Get pixel indices
            const tIdx = (ty * template.width + tx) * 4;
            const sIdx = (sy * screenshot.width + sx) * 4;

            // Compare RGB (ignore alpha)
            const rDiff = Math.abs(template.bitmap.data[tIdx] - screenshot.bitmap.data[sIdx]);
            const gDiff = Math.abs(template.bitmap.data[tIdx + 1] - screenshot.bitmap.data[sIdx + 1]);
            const bDiff = Math.abs(template.bitmap.data[tIdx + 2] - screenshot.bitmap.data[sIdx + 2]);

            totalDiff += (rDiff + gDiff + bDiff) / 3;
            pixelCount++;
        }
    }

    // Normalize to 0-1 (1 = perfect match)
    const avgDiff = totalDiff / pixelCount;
    return 1 - (avgDiff / 255);
}

/**
 * Find template in screenshot using sliding window
 */
export async function findTemplateInImage(
    screenshotPath: string,
    templateImage: any,
    similarityThreshold: number = 0.85,
    stepSize: number = 5
): Promise<TemplateMatch | null> {
    const screenshot = await Jimp.read(screenshotPath);

    const templateWidth = templateImage.width;
    const templateHeight = templateImage.height;

    let bestMatch: TemplateMatch | null = null;

    // Sliding window search
    for (let y = 0; y <= screenshot.height - templateHeight; y += stepSize) {
        for (let x = 0; x <= screenshot.width - templateWidth; x += stepSize) {
            const similarity = calculateSimilarity(screenshot, templateImage, x, y);

            if (similarity >= similarityThreshold) {
                if (!bestMatch || similarity > bestMatch.similarity) {
                    bestMatch = {
                        x: x + templateWidth / 2,  // Return center point
                        y: y + templateHeight / 2,
                        similarity
                    };

                    // Early exit if perfect match
                    if (similarity > 0.99) {
                        return bestMatch;
                    }
                }
            }
        }
    }

    return bestMatch;
}

/**
 * Find template with multi-scale matching for resolution independence
 */
export async function findTemplateMultiScale(
    screenshotPath: string,
    templateImage: any,
    similarityThreshold: number = 0.85,
    scales: number[] = [0.8, 0.9, 1.0, 1.1, 1.2]
): Promise<TemplateMatch | null> {
    let bestMatch: TemplateMatch | null = null;

    for (const scale of scales) {
        // Skip if scale is 1.0 (already tried)
        if (Math.abs(scale - 1.0) < 0.01 && bestMatch) continue;

        // Scale template
        const scaledTemplate = templateImage.clone();
        const newWidth = Math.round(templateImage.width * scale);
        const newHeight = Math.round(templateImage.height * scale);
        scaledTemplate.resize({ w: newWidth, h: newHeight });

        // Try to find
        const match = await findTemplateInImage(
            screenshotPath,
            scaledTemplate,
            similarityThreshold
        );

        if (match) {
            if (!bestMatch || match.similarity > bestMatch.similarity) {
                bestMatch = match;

                // Early exit if very good match
                if (match.similarity > 0.95) {
                    return bestMatch;
                }
            }
        }
    }

    return bestMatch;
}
