import * as fs from 'fs';
import * as path from 'path';
import { keyboard } from "@nut-tree-fork/nut-js";
import { findElementWithRetry, captureScreen, findElement, findElementByImage } from './ocr';
import { clickAt, pressKey, openSettings, wait } from './automation';
import { captureTemplateForStep, saveTemplateToWorkflow, updateStepAfterMatch } from './template-learner';
import type { Config, WorkflowStep, WorkflowConfig } from './types';
import { getEffectiveConfig } from './constants';

const CONFIG_FILE = path.join(process.cwd(), 'workflow.json');

export async function executeWorkflow(
    steps: WorkflowStep[],
    targetEmail: string,
    useCache: boolean = true,
    learnMode: boolean = false
): Promise<boolean> {
    console.log('🤖 Starting automated workflow...');
    // Load configuration
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('❌ Configuration file not found: workflow.json');
        return false;
    }

    const rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const config = getEffectiveConfig(rawConfig);

    // const useCache = config.ocr.cacheEnabled; // This line is commented out as useCache is now a parameter

    console.log('');

    for (const step of config.workflow.steps) {
        try {
            // Check for multi-variant step
            if (step.variants && step.variants.length > 0) {
                const success = await executeMultiConfigStep(step, config, targetEmail, useCache, learnMode);
                if (!success) return false;
                continue;
            }

            switch (step.action) {
                case 'openSettings':
                    if (step.description) {
                        console.log(`⚙️  ${step.description}...`);
                    }
                    await openSettings();
                    break;

                case 'pressKey':
                    if (step.description) {
                        console.log(`⌨️  ${step.description}...`);
                    }
                    await pressKey(step.key!, step.modifiers);
                    break;

                case 'type':
                    if (step.description) {
                        console.log(`⌨️  ${step.description}...`);
                    }
                    if (step.text) {
                        // Type slowly to ensure UI catches up
                        keyboard.config.autoDelayMs = 50;
                        await keyboard.type(step.text);
                    }
                    break;

                case 'clickAt':
                    if (step.description) {
                        console.log(`🖱️  ${step.description}...`);
                    }
                    // Hardcoded coordinates are in mouse space, not screenshot space
                    await clickAt(step.x!, step.y!);
                    break;

                case 'wait':
                    await wait(step.ms!);
                    break;

                case 'findAndClick':
                    const stepStartTime = Date.now();
                    let searchText = step.text!;

                    // Replace dynamic placeholders
                    if (step.dynamic && searchText.includes('{targetEmail}')) {
                        searchText = targetEmail;
                    }

                    if (step.description) {
                        console.log(`🖱️  ${step.description}...`);
                    } else {
                        console.log(`🔍 Finding and clicking: "${searchText}"...`);
                    }

                    // Use stepID as cache key, fallback to searchText
                    const cacheKey = step.stepID || searchText;

                    // Declare these early so they're in scope for learning mode retry
                    const maxWaitTime = step.maxWait || config.workflow.maxWait;
                    const retryIntervalTime = step.retryInterval || config.workflow.retryInterval;

                    // Check if we have cached coordinates in the workflow step
                    let position = null;
                    if (step.cachedX !== undefined && step.cachedY !== undefined) {
                        console.log(`💾 Found cached position: (${step.cachedX}, ${step.cachedY})`);

                        // Run image and text verification in parallel to minimize latency
                        const verificationPromises: Promise<boolean>[] = [];

                        // Verify image template if available
                        if (step.imageTemplateBounds && step.imageTemplate) {
                            verificationPromises.push(
                                verifyCachedPosition(
                                    step.cachedX,
                                    step.cachedY,
                                    step.imageTemplateBounds,
                                    step.imageTemplate,
                                    step.imageSimilarity || config.ocr.defaultThreshold,
                                    config
                                )
                            );
                        }

                        // Verify text if available
                        if (step.text && step.textBounds) {
                            verificationPromises.push(
                                verifyTextAtCachedPosition(
                                    step.cachedX,
                                    step.cachedY,
                                    step.textBounds,
                                    searchText,
                                    config
                                )
                            );
                        }

                        // Wait for all verifications to complete
                        let isValid = true;
                        if (verificationPromises.length > 0) {
                            const results = await Promise.all(verificationPromises);
                            isValid = results.every(r => r); // All must pass

                            if (!isValid) {
                                console.log(`⚠️  Cache verification failed, performing full search`);
                            }
                        }

                        // Use cache only if verification passed
                        if (isValid) {
                            position = { x: step.cachedX, y: step.cachedY };
                        } else if (verificationPromises.length === 0) {
                            // No verification possible (legacy cache), use anyway
                            console.log(`⚠️  No bounds/template for verification, using cache without verification`);
                            position = { x: step.cachedX, y: step.cachedY };
                        }
                    }

                    // If no cached position, try to find it
                    if (!position) {
                        // Declare these first for use in early learning mode trigger
                        const maxWaitTime = step.maxWait || config.workflow.maxWait;
                        const retryIntervalTime = step.retryInterval || config.workflow.retryInterval;

                        // CRITICAL: If no imageTemplate, trigger learning mode immediately
                        // Text-only OCR is unreliable (accepts low-confidence substring matches)
                        if (!step.imageTemplate && learnMode && step.stepID) {
                            console.log(`⚠️  No imageTemplate found - triggering learning mode immediately`);
                            const retryPos = await handleLearningModeRetry(step.stepID, config, async (template) => {
                                return await findElementWithRetry(
                                    cacheKey,
                                    searchText,
                                    false,
                                    step.region,
                                    config.ocr.learningModeRetryTimeout,
                                    retryIntervalTime,
                                    step.colorFilter,
                                    template,
                                    config.ocr.defaultThreshold,
                                    true // multiScale
                                );
                            }, false);

                            if (retryPos) {
                                // TEXT BOUNDS FINDING: Now that we have the matched position
                                let textBounds: { width: number; height: number } | undefined;
                                if (step.text) {
                                    // Load the template to try OCR on it first
                                    const workflowPath = path.join(process.cwd(), 'workflow.json');
                                    const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
                                    const workflow = JSON.parse(workflowContent);
                                    const currentStep = workflow.workflow.steps.find((s: any) => s.stepID === step.stepID);

                                    if (currentStep?.imageTemplate) {
                                        // For text bounds search, prefer OCR position if available (text might not be centered in image template)
                                        // Re-run OCR to get exact text position
                                        const ocrPosition = await findElement(
                                            step.text,
                                            config.ocr.minConfidence,
                                            step.region,
                                            step.colorFilter
                                        );

                                        const searchX = ocrPosition?.x ?? retryPos.x;
                                        const searchY = ocrPosition?.y ?? retryPos.y;

                                        console.log(`🔍 [Text Bounds] Using ${ocrPosition ? 'OCR' : 'image'} position for search: (${searchX}, ${searchY})`);

                                        textBounds = await findTextBoundsWithinImage(
                                            currentStep.imageTemplate,
                                            currentStep.imageTemplateBounds || retryPos.bounds,
                                            step.text,
                                            config,
                                            searchX,
                                            searchY
                                        ) || undefined;

                                        if (textBounds) {
                                            // Save text bounds
                                            const workflowPath = path.join(process.cwd(), 'workflow.json');
                                            saveTemplateToWorkflow(
                                                step.stepID,
                                                currentStep.imageTemplate,
                                                currentStep.imageTemplateBounds,
                                                workflowPath,
                                                undefined,
                                                textBounds
                                            );
                                        }
                                    }
                                }

                                // Save the matched position and bounds to cache
                                // Use image bounds if available (from image match), otherwise fall back to result bounds
                                let boundsToSave = retryPos.imageBounds || retryPos.bounds;

                                // If no bounds in result, try to get from imageTemplateBounds
                                if (!boundsToSave) {
                                    const workflowPath = path.join(process.cwd(), 'workflow.json');
                                    const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
                                    const workflow = JSON.parse(workflowContent);

                                    const currentStep = workflow.workflow.steps.find((s: any) => s.stepID === step.stepID);
                                    if (currentStep?.imageTemplateBounds) {
                                        boundsToSave = currentStep.imageTemplateBounds;
                                    }
                                }

                                updateCacheIfEnabled(
                                    step.stepID,
                                    retryPos.similarity ?? 1.0,
                                    retryPos.x,
                                    retryPos.y,
                                    step.useCache,
                                    boundsToSave,
                                    undefined,
                                    undefined,
                                    retryPos.imageBounds ? retryPos.similarity : undefined // Only pass similarity if from image search
                                );

                                await clickAt(retryPos.x, retryPos.y);
                                break; // Continue to next step instead of exiting workflow
                            } else {
                                // Learning was cancelled or failed
                                if (step.optional) {
                                    console.log(`⚠️  Optional step skipped: ${step.description || searchText}`);
                                    break; // Continue to next step
                                }
                                console.error(`❌ Learning mode cancelled or failed for: ${searchText}`);
                                return false;
                            }
                        }

                        // If no imageTemplate and NOT in learning mode, fail immediately
                        if (!step.imageTemplate && !learnMode) {
                            console.error(`❌ No imageTemplate found and learning mode disabled. Cannot proceed with unreliable text-only matching.`);
                            if (step.optional) {
                                console.log(`⚠️  Optional step skipped: ${step.description || searchText}`);
                                return true;
                            }
                            return false;
                        }

                        // Default useCache to true
                        const shouldUseCache = step.useCache !== false && useCache;
                        // Note: maxWaitTime and retryIntervalTime already declared above

                        // Try multiple image templates if provided (like findAndClickAny)
                        const templatesToTry = step.imageTemplates || (step.imageTemplate ? [step.imageTemplate] : []);

                        if (templatesToTry.length > 0) {
                            for (const template of templatesToTry) {
                                position = await findElementWithRetry(
                                    cacheKey,
                                    searchText,
                                    shouldUseCache,
                                    step.region,
                                    maxWaitTime,
                                    retryIntervalTime,
                                    step.colorFilter,
                                    template,
                                    step.imageSimilarity,
                                    step.multiScale
                                );
                                if (position) break;
                            }
                        } else {
                            // No image templates, use OCR only
                            position = await findElementWithRetry(
                                cacheKey,
                                searchText,
                                shouldUseCache,
                                step.region,
                                maxWaitTime,
                                retryIntervalTime,
                                step.colorFilter,
                                undefined,
                                step.imageSimilarity,
                                step.multiScale
                            );
                        }
                    }

                    if (!position) {
                        // LEARNING MODE HOOK
                        if (learnMode && step.stepID) {
                            const retryPos = await handleLearningModeRetry(step.stepID, config, async (template) => {
                                return await findElementWithRetry(
                                    cacheKey,
                                    searchText,
                                    false,
                                    step.region,
                                    config.ocr.learningModeRetryTimeout,
                                    retryIntervalTime,
                                    step.colorFilter,
                                    template,
                                    config.ocr.defaultThreshold,
                                    true // multiScale
                                );
                            }, false);

                            if (retryPos) {
                                // Save the matched position and bounds to cache
                                // Prioritize bounds from the match result (may include text bounds from OCR)
                                let boundsToSave = retryPos.bounds;

                                // If no bounds in result, try to get from imageTemplateBounds
                                if (!boundsToSave) {
                                    const workflowPath = path.join(process.cwd(), 'workflow.json');
                                    const workflowContent = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));

                                    // Find the step and extract imageTemplateBounds
                                    for (const workflowStep of workflowContent.workflow.steps) {
                                        if (workflowStep.stepID === step.stepID && workflowStep.imageTemplateBounds) {
                                            boundsToSave = workflowStep.imageTemplateBounds;
                                            break;
                                        }
                                    }
                                }

                                // Update cache with position and bounds
                                updateCacheIfEnabled(
                                    step.stepID,
                                    step.imageSimilarity || config.ocr.defaultThreshold,
                                    retryPos.x,
                                    retryPos.y,
                                    step.useCache,
                                    boundsToSave
                                );

                                await clickAt(retryPos.x, retryPos.y);
                                break;
                            } else {
                                console.error(`❌ Could not find element: "${searchText}" after retry (timeout: ${config.ocr.learningModeRetryTimeout}ms)`);
                                return false;
                            }
                        }

                        const timeoutMsg = maxWaitTime === Infinity ? 'disabled' : `${maxWaitTime}ms`;
                        console.error(`❌ Could not find element: "${searchText}" (timeout: ${timeoutMsg})`);
                        return false;
                    }

                    // Save matched coordinates and bounds to workflow.json
                    const matchedSimilarity = step.imageSimilarity || config.ocr.defaultThreshold;
                    updateCacheIfEnabled(
                        step.stepID,
                        matchedSimilarity,
                        position.x,
                        position.y,
                        step.useCache,
                        position.bounds  // Bounds from either image or text matching
                    );

                    await clickAt(position.x, position.y);
                    break;

                case 'findAndClickAny':
                    const textOptions = step.texts!;

                    if (step.description) {
                        console.log(`🖱️  ${step.description}...`);
                    }

                    let found = false;
                    for (const textOption of textOptions) {
                        console.log(`🔍 Trying to find: "${textOption}"...`);

                        // Use stepID as cache key, fallback to textOption
                        const cacheKey = step.stepID || textOption;
                        const shouldUseCache = step.useCache !== false && useCache;
                        // In learning mode, we still want a timeout so we can trigger the interactive capture
                        const maxWaitTime = step.maxWait || config.workflow.maxWait;
                        const retryIntervalTime = step.retryInterval || config.workflow.retryInterval;

                        const pos = await findElementWithRetry(
                            cacheKey,
                            textOption,
                            shouldUseCache,
                            step.region,
                            maxWaitTime,
                            retryIntervalTime
                        );

                        if (pos) {
                            console.log(`✅ Found: "${textOption}"`);
                            await clickAt(pos.x, pos.y);
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        // LEARNING MODE HOOK
                        if (learnMode && step.stepID) {
                            const retryPos = await handleLearningModeRetry(step.stepID, config, async (template) => {
                                return await findElementWithRetry(
                                    step.stepID!,
                                    textOptions[0],
                                    false,
                                    step.region,
                                    config.ocr.learningModeRetryTimeout,
                                    step.retryInterval || config.workflow.retryInterval,
                                    step.colorFilter,
                                    template,
                                    config.ocr.defaultThreshold,
                                    true // multiScale
                                );
                            });

                            if (retryPos) {
                                await clickAt(retryPos.x, retryPos.y);
                                found = true;
                            }
                        }

                        if (!found) {
                            if (step.optional) {
                                console.log(`⚠️  Optional step skipped: Could not find any of: ${step.texts!.join(', ')}`);
                                break;
                            }
                            console.error(`❌ Could not find any of: ${step.texts!.join(', ')}`);
                            return false;
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error(`❌ Error executing step:`, error);
            return false;
        }
    }

    return true;
}

/**
 * Crop a region around a cached position with padding (DRY helper)
 * @param screenshot - The Jimp screenshot image
 * @param centerX - Center X coordinate
 * @param centerY - Center Y coordinate  
 * @param bounds - Width and height of the region
 * @param paddingPercent - Padding as percentage (0.2 = 20%)
 * @returns Cropped image, crop coordinates, and actual dimensions
 */
async function cropRegionAroundPosition(
    screenshot: any, // Jimp instance
    centerX: number,
    centerY: number,
    bounds: { width: number; height: number },
    paddingPercent: number
): Promise<{ croppedImage: any; cropX: number; cropY: number; cropWidth: number; cropHeight: number }> {
    // Calculate search region with padding
    const searchWidth = Math.round(bounds.width * (1 + paddingPercent));
    const searchHeight = Math.round(bounds.height * (1 + paddingPercent));

    // Calculate crop bounds (center around cached position)
    const cropX = Math.max(0, centerX - Math.floor(searchWidth / 2));
    const cropY = Math.max(0, centerY - Math.floor(searchHeight / 2));
    const cropWidth = Math.min(searchWidth, screenshot.width - cropX);
    const cropHeight = Math.min(searchHeight, screenshot.height - cropY);

    // Crop the region
    const croppedImage = screenshot.clone().crop({ x: cropX, y: cropY, w: cropWidth, h: cropHeight });

    return { croppedImage, cropX, cropY, cropWidth, cropHeight };
}

/**
 * Verify that a cached position still contains the expected template
 */
async function verifyCachedPosition(
    cachedX: number,
    cachedY: number,
    cachedBounds: { width: number; height: number },
    imageTemplate: string,
    similarity: number,
    config: Config
): Promise<boolean> {
    try {
        // Capture screenshot
        const screenshotPath = await captureScreen();

        try {
            // Load the template to compare
            const { getCachedMat, findTemplateInImage } = await import('./image-matcher');
            const template = await getCachedMat(imageTemplate);

            // Load screenshot
            const Jimp = (await import('jimp')).Jimp;
            const screenshot = await Jimp.read(screenshotPath);

            // FIX: Scale cached coordinates from logical (1x) to screenshot pixels
            // Cached coordinates are in logical points, but screenshot is at native resolution
            const { screen } = await import('@nut-tree-fork/nut-js');
            const logicalWidth = await screen.width();
            const scaleFactor = screenshot.width / logicalWidth;

            const scaledX = Math.round(cachedX * scaleFactor);
            const scaledY = Math.round(cachedY * scaleFactor);

            // Use template's actual dimensions (already at native resolution)
            // instead of cachedBounds which may have been normalized
            const templateBounds = {
                width: template.cols,
                height: template.rows
            };

            // Use DRY helper to crop region around scaled position
            const { croppedImage, cropX, cropY, cropWidth, cropHeight } = await cropRegionAroundPosition(
                screenshot,
                scaledX,
                scaledY,
                templateBounds, // Use template dimensions, not cachedBounds
                0.5 // 50% padding for extra margin
            );

            console.log(`🔍 [Cache-Debug] Template: ${template.cols}x${template.rows}, Cropped: ${cropWidth}x${cropHeight}, Position: (${scaledX},${scaledY}), Crop: (${cropX},${cropY})`);

            // First try matching on full screenshot to verify template works
            const verificationThreshold = 0.75;
            let match = await findTemplateInImage(screenshotPath, template, verificationThreshold);

            if (match) {
                console.log(`✅ [Cache-Img] Found on full screenshot at (${match.x},${match.y}) [similarity: ${match.similarity.toFixed(2)}]`);
                // Check if match is near expected position
                const distX = Math.abs(match.x - scaledX);
                const distY = Math.abs(match.y - scaledY);
                if (distX < templateBounds.width * 2 && distY < templateBounds.height * 2) {
                    console.log(`✅ [Cache-Img] Template verified near cached position (dist: ${distX}, ${distY})`);
                    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
                    return true;
                } else {
                    console.log(`⚠️  [Cache-Img] Template found but at different position (dist: ${distX}, ${distY})`);
                    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
                    return false; // Found but position changed
                }
            }

            console.log(`⚠️  [Cache-Img] Template not found at cached position`);
            if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
            return false;
        } finally {
            // Cleanup screenshot
            if (fs.existsSync(screenshotPath)) {
                fs.unlinkSync(screenshotPath);
            }
        }
    } catch (error) {
        console.warn(`⚠️  Cache verification error: ${error}`);
        return false;
    }
}

/**
 * Verify that text exists at a cached position (text verification)
 * @param cachedX - Cached X coordinate
 * @param cachedY - Cached Y coordinate
 * @param textBounds - Bounds of the text region
 * @param expectedText - Text to search for
 * @param config - Configuration
 * @param paddingPercent - Padding percentage (default 0.2 = 20%)
 * @returns true if text found, false otherwise
 */
async function verifyTextAtCachedPosition(
    cachedX: number,
    cachedY: number,
    textBounds: { width: number; height: number },
    expectedText: string,
    config: Config,
    paddingPercent: number = 0.2
): Promise<boolean> {
    try {
        // Capture screenshot
        const screenshotPath = await captureScreen();

        try {
            // Load screenshot
            const Jimp = (await import('jimp')).Jimp;
            const screenshot = await Jimp.read(screenshotPath);

            // Use DRY helper to crop region around cached position
            const { croppedImage } = await cropRegionAroundPosition(
                screenshot,
                cachedX,
                cachedY,
                textBounds,
                paddingPercent
            );

            // Save cropped image to temp file for OCR
            const path = await import('path');
            const os = await import('os');
            const tempDir = os.tmpdir();
            const croppedPath = path.join(tempDir, `text-verify-${Date.now()}.png`) as `${string}.${string}`;
            await croppedImage.write(croppedPath);

            // Run OCR on cropped region
            const { findElement } = await import('./ocr');
            const ocrResult = await findElement(
                expectedText,
                config.ocr.minConfidence,
                undefined, // No region filtering (already cropped)
                undefined, // No color filter
                croppedPath
            );

            // Cleanup cropped file
            if (fs.existsSync(croppedPath)) {
                fs.unlinkSync(croppedPath);
            }

            if (ocrResult) {
                console.log(`✅ [Cache-Text] Text verified: "${expectedText}" found at cached position`);
                return true;
            } else {
                console.log(`⚠️  [Cache-Text] Text not found at cached position`);
                return false;
            }
        } finally {
            // Cleanup screenshot
            if (fs.existsSync(screenshotPath)) {
                fs.unlinkSync(screenshotPath);
            }
        }
    } catch (error) {
        console.warn(`⚠️  Text verification error: ${error}`);
        return false;
    }
}

/**
 * Find text bounds within an image with progressive enlargement (Learning Stage)
 * Sequence:
 * 1. Try OCR on template image itself
 * 2. If not found, use matched (x, y) position for progressive enlargement on FULL SCREEN
 * 
 * @param templateBase64 - Base64 encoded template image
 * @param initialBounds - Initial bounds from image template capture
 * @param expectedText - Text to search for
 * @param config - Configuration
 * @param matchedX - X coordinate of matched position on screen
 * @param matchedY - Y coordinate of matched position on screen
 * @returns Text bounds if found, null otherwise
 */
async function findTextBoundsWithinImage(
    templateBase64: string,
    initialBounds: { width: number; height: number },
    expectedText: string,
    config: Config,
    matchedX: number,
    matchedY: number
): Promise<{ width: number; height: number } | null> {
    const Jimp = (await import('jimp')).Jimp;
    const path = await import('path');
    const os = await import('os');
    const { findElement } = await import('./ocr');

    // Progressive enlargement on FULL SCREENSHOT
    // Start with template bounds, enlarge if needed to find complete text
    console.log(`🔍 [Text Bounds] Searching for "${expectedText}" on full screenshot with progressive enlargement...`);

    const maxIterations = 3;
    const enlargementStep = 0.1; // 10% per iteration

    // Capture screen once for all iterations
    const screenshotPath = await captureScreen();

    try {
        const screenshot = await Jimp.read(screenshotPath);

        // Create all 3 iteration promises in parallel
        const iterationPromises = Array.from({ length: maxIterations }, (_, iteration) =>
            (async () => {
                try {
                    // Calculate bounds for this iteration
                    const currentBounds = iteration === 0
                        ? { ...initialBounds }
                        : {
                            width: Math.round(initialBounds.width * (1 + enlargementStep * iteration)),
                            height: Math.round(initialBounds.height * (1 + enlargementStep * iteration))
                        };

                    console.log(`📐 [Text Bounds] Iteration ${iteration + 1}: Trying ${iteration === 0 ? 'initial' : ''} bounds ${currentBounds.width}×${currentBounds.height}`);

                    // Crop region around matched position
                    const { croppedImage } = await cropRegionAroundPosition(
                        screenshot,
                        matchedX,
                        matchedY,
                        currentBounds,
                        0.2 // 20% padding
                    );

                    // Save cropped image for OCR
                    const croppedPath = path.join(os.tmpdir(), `text-bounds-${iteration}-${Date.now()}.png`);
                    await croppedImage.write(croppedPath);

                    // Run OCR
                    const ocrResult = await findElement(
                        expectedText,
                        config.ocr.minConfidence,
                        undefined,
                        undefined,
                        croppedPath as `${string}.${string}`
                    );

                    // Cleanup cropped image immediately
                    if (fs.existsSync(croppedPath)) {
                        fs.unlinkSync(croppedPath);
                    }

                    if (ocrResult) {
                        return {
                            iteration,
                            bounds: { width: ocrResult.width, height: ocrResult.height },
                            success: true
                        };
                    }
                    return null;
                } catch (error) {
                    console.warn(`⚠️  [Text Bounds] Error during search (iteration ${iteration + 1}):`, error);
                    return null;
                }
            })()
        );

        // Wait for all iterations to complete
        const results = await Promise.allSettled(iterationPromises);

        // Find successful results and select the best (prefer lower iteration number)
        const successfulResults = results
            .filter((r): r is PromiseFulfilledResult<{ iteration: number; bounds: { width: number; height: number }; success: true } | null> =>
                r.status === 'fulfilled' && r.value !== null && r.value.success
            )
            .map(r => r.value)
            .filter((v): v is { iteration: number; bounds: { width: number; height: number }; success: true } => v !== null)
            .sort((a, b) => a.iteration - b.iteration); // Prefer exact match (iteration 0) over enlarged

        if (successfulResults.length > 0) {
            const best = successfulResults[0];
            console.log(`✅ [Text Bounds] Found text at iteration ${best.iteration + 1}: ${best.bounds.width}×${best.bounds.height}`);
            return best.bounds;
        }
    } finally {
        // Cleanup screenshot only AFTER all iterations complete
        if (fs.existsSync(screenshotPath)) {
            fs.unlinkSync(screenshotPath);
        }
    }

    console.log(`❌ [Text Bounds] Could not find text "${expectedText}" after ${maxIterations} iterations`);
    return null;
}

/**
 * Update cache coordinates if stepID exists and cache is enabled
 */
function updateCacheIfEnabled(
    stepID: string | undefined,
    similarity: number,
    x: number,
    y: number,
    useCache?: boolean,
    bounds?: { width: number; height: number },
    configIndex?: number,
    textBounds?: { width: number; height: number },
    imageSimilarity?: number // Separate parameter for image-specific similarity
): void {
    if (stepID && useCache !== false) {
        const workflowPath = path.join(process.cwd(), 'workflow.json');
        updateStepAfterMatch(stepID, similarity, x, y, workflowPath, bounds, configIndex, textBounds, imageSimilarity);
    }
}

/**
 * Handle learning mode: capture template, save, and retry detection
 */
async function handleLearningModeRetry(
    stepID: string,
    config: Config,
    retryFn: (template: string) => Promise<{ x: number; y: number; similarity?: number; bounds?: { width: number; height: number }; imageBounds?: { width: number; height: number } } | null>,
    skipSave?: boolean
): Promise<{ x: number; y: number; similarity?: number; bounds?: { width: number; height: number }; imageBounds?: { width: number; height: number } } | null> {
    const captureResult = await captureTemplateForStep(stepID);
    if (!captureResult) return null;

    const { dataUrl, bounds } = captureResult;

    // Save to file unless caller handles it explicitly
    if (!skipSave) {
        const workflowPath = path.join(process.cwd(), 'workflow.json');
        saveTemplateToWorkflow(stepID, dataUrl, bounds, workflowPath);
    }

    console.log(`🔄 Retrying step "${stepID}" with new template...`);

    // Call the retry function with the captured template
    return await retryFn(dataUrl);
}

/**
 * Try to detect variants in parallel and return first match
 */
async function detectVariants(
    variants: WorkflowConfig[],
    screenshotPath: string,
    config: Config,
    targetEmail: string,
    extraTemplate?: string
): Promise<{ result: { x: number; y: number }, index: number, subStep: WorkflowConfig, matchedSimilarity: number, bounds?: { width: number; height: number } } | null> {
    const promises = variants.map(async (subStep, index) => {
        let searchText = subStep.text;
        if (subStep.dynamic && searchText && searchText.includes('{targetEmail}')) {
            searchText = targetEmail;
        }

        // Try extra template first (newly captured in learning mode)
        if (extraTemplate) {
            const result = await findElementByImage(
                screenshotPath,
                extraTemplate,
                config.ocr.defaultThreshold,
                true, // Enable multi-scale
                config
            );
            if (result) return { result: { x: result.x, y: result.y }, index, subStep, matchedSimilarity: result.similarity, bounds: result.bounds };
        }

        // Try variant's own image templates
        if (subStep.imageTemplate || subStep.imageTemplates) {
            const templates = subStep.imageTemplates || [subStep.imageTemplate!];
            for (const template of templates) {
                const result = await findElementByImage(
                    screenshotPath,
                    template,
                    subStep.imageSimilarity || config.ocr.defaultThreshold,
                    subStep.multiScale || false,
                    config
                );
                if (result) return { result: { x: result.x, y: result.y }, index, subStep, matchedSimilarity: result.similarity, bounds: result.bounds };
            }
        } else if (searchText) {
            // Try OCR detection
            const result = await findElement(
                searchText,
                0.8, // Default confidence
                subStep.region,
                subStep.colorFilter,
                screenshotPath
            );
            if (result) return { result, index, subStep, matchedSimilarity: 1.0 }; // OCR doesn't return similarity, use 1.0
        }
        return null;
    });

    const results = await Promise.all(promises);
    return results.find(r => r !== null) || null;
}

async function executeMultiConfigStep(
    step: WorkflowStep,
    config: Config,
    targetEmail: string,
    useCache: boolean,
    learnMode: boolean
): Promise<boolean> {
    if (!step.variants || step.variants.length === 0) return false;

    console.log(`🔀 Executing multi-variant step "${step.stepID || step.description}" with ${step.variants.length} variants...`);

    const maxWaitTime = step.maxWait || config.workflow.maxWait;
    const retryIntervalTime = step.retryInterval || config.workflow.retryInterval;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
        // 1. Check if any variant has cached coordinates
        for (let i = 0; i < step.variants.length; i++) {
            const variant = step.variants[i];
            if (variant.cachedX !== undefined && variant.cachedY !== undefined && useCache) {
                console.log(`💾 Found cached position from variant #${i}: (${variant.cachedX}, ${variant.cachedY})`);

                // Run image and text verification in parallel to minimize latency
                const verificationPromises: Promise<boolean>[] = [];

                // Verify image template if available
                if (variant.cachedBounds && variant.imageTemplate) {
                    verificationPromises.push(
                        verifyCachedPosition(
                            variant.cachedX,
                            variant.cachedY,
                            variant.cachedBounds,
                            variant.imageTemplate,
                            variant.imageSimilarity || config.ocr.defaultThreshold,
                            config
                        )
                    );
                }

                // Verify text if available
                if (variant.text && variant.cachedBounds) {
                    verificationPromises.push(
                        verifyTextAtCachedPosition(
                            variant.cachedX,
                            variant.cachedY,
                            variant.cachedBounds,
                            variant.text,
                            config
                        )
                    );
                }

                // Wait for all verifications to complete
                let isValid = true;
                if (verificationPromises.length > 0) {
                    const results = await Promise.all(verificationPromises);
                    isValid = results.every(r => r); // All must pass

                    if (!isValid) {
                        console.log(`⚠️  Cache verification failed for variant #${i}, trying other variants`);
                    }
                } else {
                    console.log(`⚠️  No bounds/template for verification, using cache without verification`);
                }

                if (isValid) {
                    // Update cache with current values (refreshes timestamp)
                    updateCacheIfEnabled(
                        step.stepID,
                        variant.imageSimilarity || config.ocr.defaultThreshold,
                        variant.cachedX,
                        variant.cachedY,
                        variant.useCache,
                        variant.cachedBounds,
                        i
                    );

                    // Click at cached position
                    await clickAt(variant.cachedX, variant.cachedY);
                    return true;
                }
            }
        }

        // 2. Capture screen ONCE for all variants
        const screenshotPath = await captureScreen();

        try {
            // 3. Run all variants in parallel
            const match = await detectVariants(step.variants, screenshotPath, config, targetEmail);

            if (match) {
                const { result, index, subStep } = match;
                console.log(`✅ Matched variant #${index} (${subStep.text || 'Image'})`);

                // Update cache/template if needed
                updateCacheIfEnabled(
                    step.stepID,
                    match.matchedSimilarity,
                    result.x,
                    result.y,
                    subStep.useCache,
                    match.bounds,
                    index
                );

                // Perform action
                await clickAt(result.x, result.y);
                return true;
            }

        } finally {
            // Cleanup screenshot
            if (fs.existsSync(screenshotPath)) {
                fs.unlinkSync(screenshotPath);
            }
        }

        // Wait before retry
        await wait(retryIntervalTime);
    }

    // LEARNING MODE HOOK - after initial timeout
    if (learnMode && step.stepID && step.variants) {
        const result = await handleLearningModeRetry(step.stepID, config, async (template) => {
            // AUTO-DETECT which variant was captured using OCR
            let detectedVariantIndex: number | null = null;

            try {
                const { detectTextFromTemplate } = await import('./ocr');
                const ocrText = await detectTextFromTemplate(template);

                console.log(`🔍 Auto-detecting variant from captured template...`);

                // Find matching variants
                const matches = step.variants!
                    .map((v, idx) => ({ idx, text: v.text }))
                    .filter(({ text }) => text && ocrText.includes(text));

                if (matches.length === 1) {
                    detectedVariantIndex = matches[0].idx;
                    console.log(`✅ Auto-detected variant #${detectedVariantIndex}: "${matches[0].text}"`);
                } else if (matches.length === 0) {
                    console.log(`⚠️  Could not auto-detect variant (no text matched in OCR)`);
                    console.log(`   OCR detected: "${ocrText.substring(0, 100)}..."`);
                } else {
                    console.log(`⚠️  Multiple variants matched: ${matches.map(m => `#${m.idx}`).join(', ')}`);
                }
            } catch (error) {
                console.log(`⚠️  OCR auto-detection failed: ${error}`);
            }

            // Fall back to last variant if auto-detection failed
            const targetVariantIndex = detectedVariantIndex !== null
                ? detectedVariantIndex
                : step.variants!.length - 1;

            if (detectedVariantIndex === null) {
                console.log(`⚠️  Saving to last variant #${targetVariantIndex} as fallback`);
            }

            // Extract bounds from the captured template
            let templateBounds: { width: number; height: number } | undefined;
            try {
                const { getCachedMat } = await import('./image-matcher');
                const templateImg = await getCachedMat(template);
                templateBounds = { width: templateImg.cols, height: templateImg.rows };
            } catch (e) {
                console.warn('⚠️  Could not extract template bounds');
            }

            // Save to the detected (or fallback) variant
            const workflowPath = path.join(process.cwd(), 'workflow.json');
            if (templateBounds) {
                saveTemplateToWorkflow(step.stepID!, template, templateBounds, workflowPath, targetVariantIndex);
            }

            // Retry loop for multi-variant with new template
            const retryStartTime = Date.now();
            const retryMaxWait = config.ocr.learningModeRetryTimeout;

            while (Date.now() - retryStartTime < retryMaxWait) {
                const screenshotPath = await captureScreen();

                try {
                    const match = await detectVariants(step.variants!, screenshotPath, config, targetEmail, template);

                    if (match) {
                        console.log(`✅ Matched variant #${match.index} after learning retry`);

                        // Update cache with the ACTUAL matched similarity
                        updateCacheIfEnabled(
                            step.stepID,
                            match.matchedSimilarity,
                            match.result.x,
                            match.result.y,
                            match.subStep.useCache,
                            match.bounds,
                            match.index
                        );

                        return match.result;
                    }
                } finally {
                    if (fs.existsSync(screenshotPath)) {
                        fs.unlinkSync(screenshotPath);
                    }
                }

                await wait(retryIntervalTime);
            }

            return null; // Timeout
        }, true); // skipSave=true since we handle it explicitly above

        if (result) {
            await clickAt(result.x, result.y);
            return true;
        } else {
            console.error(`❌ Could not find any variant for step "${step.stepID}" after learning retry (timeout: ${config.ocr.learningModeRetryTimeout}ms)`);
            return false;
        }
    }

    if (step.optional) {
        console.log(`⚠️  Optional multi-variant step skipped`);
        return true;
    }

    console.error(`❌ Could not find any variant for step "${step.stepID}"`);
    return false;
}
