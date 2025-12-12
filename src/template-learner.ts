import { Jimp } from 'jimp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';


/**
 * Interactively capture a template for a specific step
 * @param stepID The ID of the step being learned
 * @returns Object with dataUrl and bounds, or null if cancelled
 */
export async function captureTemplateForStep(stepID: string): Promise<{ dataUrl: string; bounds: { width: number; height: number } } | null> {
    console.log(`\n📸 LEARNING MODE: Step "${stepID}" failed.`);
    console.log('------------------------------------------------');
    console.log('Launching screen capture tool...');
    console.log('👉 Drag to select the element to match.');
    console.log('👉 Press Esc to skip learning this step.\n');

    const tempPath = path.join(os.tmpdir(), `antigravity-learn-${stepID}-${Date.now()}.png`);

    // Use macOS native interactive screencapture
    try {
        spawnSync('screencapture', ['-i', '-x', tempPath]);
    } catch (error) {
        console.error('❌ Error launching screencapture:', error);
        return null;
    }

    if (!fs.existsSync(tempPath)) {
        console.log('⚠️  Capture cancelled. Skipping learning.');
        return null;
    }

    try {
        // Load and process image
        const jimpImg = await Jimp.read(tempPath);

        // NO RESIZE! Keep template at native resolution (2x on Retina)
        // This matches our screenshot resolution (screencapture -R also captures at physical pixels)
        // Coordinate normalization happens later in ocr.ts (divides by scale factor)

        // Convert to base64
        const buffer = await jimpImg.getBuffer('image/png');
        const base64 = buffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;

        // Cleanup
        fs.unlinkSync(tempPath);

        console.log(`✅ Captured template for "${stepID}" (${jimpImg.width}x${jimpImg.height})`);
        return {
            dataUrl,
            bounds: { width: jimpImg.width, height: jimpImg.height }
        };
    } catch (error) {
        console.error('❌ Failed to process captured image:', error);
        return null;
    }
}

/**
 * Update the workflow.json file with the new template
 */
export function saveTemplateToWorkflow(
    stepID: string,
    dataUrl: string,
    bounds: { width: number; height: number },
    workflowPath: string,
    variantIndex?: number,
    textBounds?: { width: number; height: number }
) {
    try {
        const content = fs.readFileSync(workflowPath, 'utf-8');
        const json = JSON.parse(content);

        let updated = false;

        // Find and update the step
        if (json.workflow && Array.isArray(json.workflow.steps)) {
            for (const step of json.workflow.steps) {
                if (step.stepID === stepID) {
                    // If variantIndex is provided, save to that specific variant
                    if (variantIndex !== undefined && step.variants && Array.isArray(step.variants) && step.variants[variantIndex]) {
                        step.variants[variantIndex].imageTemplate = dataUrl;
                        step.variants[variantIndex].imageTemplateBounds = bounds;
                        if (textBounds) {
                            step.variants[variantIndex].textBounds = textBounds;
                        }
                        // Set default similarity if not present
                        if (!step.variants[variantIndex].imageSimilarity) {
                            step.variants[variantIndex].imageSimilarity = 0.85;
                        }
                        console.log(`💾 Saved new template to workflow.json for step "${stepID}"[${variantIndex}]${textBounds ? ` with text bounds ${textBounds.width}×${textBounds.height}` : ''}`);
                    } else {
                        // Save to main step
                        step.imageTemplate = dataUrl;
                        step.imageTemplateBounds = bounds;
                        if (textBounds) {
                            step.textBounds = textBounds;
                        }
                        // Set default similarity if not present
                        if (!step.imageSimilarity) {
                            step.imageSimilarity = 0.85; // Default threshold
                        }
                        console.log(`💾 Saved new template to workflow.json for step "${stepID}"${textBounds ? ` with text bounds ${textBounds.width}×${textBounds.height}` : ''}`);
                    }
                    updated = true;
                    break;
                }
            }
        }

        if (updated) {
            fs.writeFileSync(workflowPath, JSON.stringify(json, null, 4));
            return true;
        } else {
            console.error(`❌ Could not find step with ID "${stepID}" in workflow.json`);
            return false;
        }
    } catch (error) {
        console.error('❌ Failed to update workflow.json:', error);
        return false;
    }
}

/**
 * Update workflow step with matched similarity and cached coordinates
 */
export function updateStepAfterMatch(
    stepID: string,
    matchedSimilarity: number,
    x: number,
    y: number,
    workflowPath: string,
    bounds?: { width: number; height: number },
    configIndex?: number,
    textBounds?: { width: number; height: number },
    imageSimilarity?: number // Only provided when image search succeeded
): boolean {
    try {
        const content = fs.readFileSync(workflowPath, 'utf-8');
        const json = JSON.parse(content);

        let updated = false;

        if (json.workflow && Array.isArray(json.workflow.steps)) {
            for (const step of json.workflow.steps) {
                if (step.stepID === stepID) {
                    let targetStep = step;

                    // If configIndex is provided, target the specific variant entry
                    if (configIndex !== undefined && step.variants && Array.isArray(step.variants) && step.variants[configIndex]) {
                        targetStep = step.variants[configIndex];
                    }

                    // Only update imageSimilarity if image search won (indicated by imageSimilarity parameter)
                    if (imageSimilarity !== undefined && (targetStep.imageTemplate || targetStep.imageTemplates)) {
                        targetStep.imageSimilarity = imageSimilarity;
                    }
                    // Always save cached coordinates
                    targetStep.cachedX = x;
                    targetStep.cachedY = y;
                    // Save cached bounds if provided
                    if (bounds) {
                        targetStep.cachedBounds = bounds;
                    }
                    // Save text bounds if provided
                    if (textBounds) {
                        targetStep.textBounds = textBounds;
                    }
                    updated = true;
                    break;
                }
            }
        }

        if (updated) {
            fs.writeFileSync(workflowPath, JSON.stringify(json, null, 4));
            console.log(`💾 Updated step "${stepID}"${configIndex !== undefined ? `[${configIndex}]` : ''} with similarity=${matchedSimilarity.toFixed(2)}, x=${x}, y=${y}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`Failed to update workflow after match:`, error);
        return false;
    }
}

/**
 * Create or update a dynamic variant for a step
 * Used when a dynamic field (e.g., {targetEmail}) matches via OCR
 */
export function createDynamicVariant(
    stepID: string,
    resolvedText: string,
    x: number,
    y: number,
    textBounds: { width: number; height: number },
    workflowPath: string
): boolean {
    try {
        const content = fs.readFileSync(workflowPath, 'utf-8');
        const json = JSON.parse(content);

        if (json.workflow && Array.isArray(json.workflow.steps)) {
            for (const step of json.workflow.steps) {
                if (step.stepID === stepID && step.dynamic) {
                    // Initialize variants array if needed
                    if (!step.variants) {
                        step.variants = [];
                    }

                    // Check if variant with this text already exists
                    const existingVariant = step.variants.find((v: any) => v.text === resolvedText);

                    if (existingVariant) {
                        // Update existing variant
                        existingVariant.cachedX = x;
                        existingVariant.cachedY = y;
                        existingVariant.textBounds = textBounds;
                        console.log(`💾 Updated dynamic variant "${resolvedText}" for step "${stepID}"`);
                    } else {
                        // Create new variant
                        step.variants.push({
                            text: resolvedText,
                            cachedX: x,
                            cachedY: y,
                            textBounds: textBounds
                        });
                        console.log(`💾 Created dynamic variant "${resolvedText}" for step "${stepID}"`);
                    }

                    fs.writeFileSync(workflowPath, JSON.stringify(json, null, 4));
                    return true;
                }
            }
        }

        console.error(`❌ Could not find dynamic step with ID "${stepID}"`);
        return false;
    } catch (error) {
        console.error(`Failed to create dynamic variant:`, error);
        return false;
    }
}
