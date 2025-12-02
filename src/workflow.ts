import * as fs from 'fs';
import * as path from 'path';
import { keyboard } from "@nut-tree-fork/nut-js";
import { findElementWithRetry } from './ocr';
import { clickAt, pressKey, openSettings, wait } from './automation';
import { captureTemplateForStep, saveTemplateToWorkflow, updateStepAfterMatch } from './template-learner';
import type { Config, WorkflowStep } from './types';
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
                            const template = await captureTemplateForStep(step.stepID);
                            if (template) {
                                // Save to file
                                const workflowPath = path.join(process.cwd(), 'workflow.json');
                                saveTemplateToWorkflow(step.stepID, template, workflowPath);

                                // Update local step and retry
                                step.imageTemplate = template;
                                step.imageSimilarity = config.ocr.defaultThreshold;
                                step.multiScale = true; // Enable multi-scale for better matching

                                console.log(`🔄 Retrying step "${step.stepID}" with new template...`);
                                const retryMaxWait = config.ocr.learningModeRetryTimeout;
                                const retryPos = await findElementWithRetry(
                                    cacheKey,
                                    searchText,
                                    false, // Don't use cache for retry
                                    step.region,
                                    retryMaxWait, // Give plenty of time for retry with new template
                                    retryIntervalTime,
                                    step.colorFilter,
                                    step.imageTemplate,
                                    step.imageSimilarity,
                                    step.multiScale
                                );

                                if (retryPos) {
                                    await clickAt(retryPos.x, retryPos.y);
                                    break;
                                } else {
                                    // Failed retry - show correct timeout
                                    console.error(`❌ Could not find element: "${searchText}" after retry (timeout: ${retryMaxWait}ms)`);
                                    return false;
                                }
                            }
                        }

                        const timeoutMsg = maxWaitTime === Infinity ? 'disabled' : `${maxWaitTime}ms`;
                        console.error(`❌ Could not find element: "${searchText}" (timeout: ${timeoutMsg})`);
                        return false;
                    }


                    // Save matched coordinates to workflow.json if we have stepID
                    if (step.stepID) {
                        const workflowPath = path.join(process.cwd(), 'workflow.json');
                        // Use the step's imageSimilarity if available, otherwise use default
                        const matchedSimilarity = step.imageSimilarity || config.ocr.defaultThreshold;
                        updateStepAfterMatch(step.stepID, matchedSimilarity, position.x, position.y, workflowPath);
                    }


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
                            const template = await captureTemplateForStep(step.stepID);
                            if (template) {
                                // Save to file
                                const workflowPath = path.join(process.cwd(), 'workflow.json');
                                saveTemplateToWorkflow(step.stepID, template, workflowPath);

                                // Update local step and retry
                                step.imageTemplate = template;
                                step.imageSimilarity = config.ocr.defaultThreshold; // Default
                                step.multiScale = true; // Enable multi-scale for better matching

                                console.log(`🔄 Retrying step "${step.stepID}" with new template...`);
                                // Retry with the new template
                                const retryPos = await findElementWithRetry(
                                    step.stepID,
                                    textOptions[0], // Just use first text option for log name
                                    false,
                                    step.region,
                                    config.ocr.learningModeRetryTimeout, // Use config timeout
                                    step.retryInterval || config.workflow.retryInterval,
                                    step.colorFilter,
                                    step.imageTemplate,
                                    step.imageSimilarity,
                                    step.multiScale
                                );

                                if (retryPos) {
                                    await clickAt(retryPos.x, retryPos.y);
                                    found = true;
                                }
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
