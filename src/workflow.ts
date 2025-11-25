import * as fs from 'fs';
import * as path from 'path';
import { keyboard } from "@nut-tree-fork/nut-js";
import { findElementCached } from './ocr';
import { clickAt, pressKey, openSettings, wait } from './automation';
import type { Config, WorkflowStep } from './types';

const CONFIG_FILE = path.join(process.cwd(), 'automation-config.json');

export async function executeWorkflow(targetEmail: string): Promise<boolean> {
    // Load configuration
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('❌ Configuration file not found: automation-config.json');
        return false;
    }

    const config: Config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const useCache = config.ocr.cacheEnabled;

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

                    const position = await findElementCached(
                        step.cacheName || searchText,
                        searchText,
                        useCache,
                        step.region
                    );

                    if (!position) {
                        console.error(`❌ Could not find element: "${searchText}"`);
                        return false;
                    }

                    await clickAt(position.x, position.y);
                    break;
            }
        } catch (error) {
            console.error(`❌ Error executing step:`, error);
            return false;
        }
    }

    return true;
}
