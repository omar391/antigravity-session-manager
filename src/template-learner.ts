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
    variantIndex?: number
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
                        // Set default similarity if not present
                        if (!step.variants[variantIndex].imageSimilarity) {
                            step.variants[variantIndex].imageSimilarity = 0.85;
                        }
                        console.log(`💾 Saved new template to workflow.json for step "${stepID}" variant [${variantIndex}]`);
                    } else {
                        // Save to parent step (original behavior)
                        step.imageTemplate = dataUrl;
                        step.imageTemplateBounds = bounds;
                        // Set default similarity if not present
                        if (!step.imageSimilarity) {
                            step.imageSimilarity = 0.85; // Default threshold
                        }
                        console.log(`💾 Saved new template to workflow.json for step "${stepID}"`);
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
    configIndex?: number
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

                    // Only update similarity if step has an image template
                    if (targetStep.imageTemplate || targetStep.imageTemplates) {
                        targetStep.imageSimilarity = matchedSimilarity;
                    }
                    // Always save cached coordinates
                    targetStep.cachedX = x;
                    targetStep.cachedY = y;
                    // Save cached bounds if provided
                    if (bounds) {
                        targetStep.cachedBounds = bounds;
                    }
                    updated = true;
                    break;
                }
            }
        }

        if (updated) {
            fs.writeFileSync(workflowPath, JSON.stringify(json, null, 4));
            console.log(`💾 Updated step \"${stepID}\"${configIndex !== undefined ? `[${configIndex}]` : ''} with similarity=${matchedSimilarity.toFixed(2)}, x=${x}, y=${y}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ Failed to update workflow step:', error);
        return false;
    }
}

