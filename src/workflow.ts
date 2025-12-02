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
                    await clickAt(step.x!, step.y!, true);
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
                        console.log(`💾 Using cached position from workflow: (${step.cachedX}, ${step.cachedY})`);
                        position = { x: step.cachedX, y: step.cachedY };
                    }

                    // If no cached position, try to find it
                    if (!position) {
                        // Default useCache to true
                        const shouldUseCache = step.useCache !== false && useCache;
                        // In learning mode, we still want a timeout so we can trigger the interactive capture
                        const maxWaitTime = step.maxWait || config.workflow.maxWait;
                        const retryIntervalTime = step.retryInterval || config.workflow.retryInterval;

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
                                    true
                                );
                            });

                            if (retryPos) {
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


                    // Save matched coordinates to workflow.json
                    const matchedSimilarity = step.imageSimilarity || config.ocr.defaultThreshold;
                    updateCacheIfEnabled(step.stepID, matchedSimilarity, position.x, position.y, step.useCache);


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
                                    true
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
 * Update cache coordinates if stepID exists and cache is enabled
 */
function updateCacheIfEnabled(
    stepID: string | undefined,
    similarity: number,
    x: number,
    y: number,
    useCache?: boolean,
    configIndex?: number
): void {
    if (stepID && useCache !== false) {
        const workflowPath = path.join(process.cwd(), 'workflow.json');
        updateStepAfterMatch(stepID, similarity, x, y, workflowPath, configIndex);
    }
}

/**
 * Handle learning mode: capture template, save, and retry detection
 */
async function handleLearningModeRetry(
    stepID: string,
    config: Config,
    retryFn: (template: string) => Promise<{ x: number; y: number } | null>,
    skipSave?: boolean
): Promise<{ x: number; y: number } | null> {
    const template = await captureTemplateForStep(stepID);
    if (!template) return null;

    // Save to file unless caller handles it explicitly
    if (!skipSave) {
        const workflowPath = path.join(process.cwd(), 'workflow.json');
        saveTemplateToWorkflow(stepID, template, workflowPath);
    }

    console.log(`🔄 Retrying step "${stepID}" with new template...`);

    // Call the retry function with the captured template
    return await retryFn(template);
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
): Promise<{ result: { x: number; y: number }, index: number, subStep: WorkflowConfig, matchedSimilarity: number } | null> {
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
            if (result) return { result: { x: result.x, y: result.y }, index, subStep, matchedSimilarity: result.similarity };
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
                if (result) return { result: { x: result.x, y: result.y }, index, subStep, matchedSimilarity: result.similarity };
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
                console.log(`💾 Using cached position from variant #${i}: (${variant.cachedX}, ${variant.cachedY})`);

                // Update cache with current values (refreshes timestamp)
                updateCacheIfEnabled(
                    step.stepID,
                    variant.imageSimilarity || config.ocr.defaultThreshold,
                    variant.cachedX,
                    variant.cachedY,
                    variant.useCache,
                    i
                );

                // Click at cached position
                await clickAt(variant.cachedX, variant.cachedY);
                return true;
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

            // Save to the detected (or fallback) variant
            const workflowPath = path.join(process.cwd(), 'workflow.json');
            saveTemplateToWorkflow(step.stepID!, template, workflowPath, targetVariantIndex);

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
