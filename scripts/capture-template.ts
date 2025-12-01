#!/usr/bin/env bun
/**
 * Helper script to capture button/element templates
 * Usage: bun run scripts/capture-template.ts
 */

import { screen, imageToJimp, mouse } from "@nut-tree-fork/nut-js";
import { Jimp } from 'jimp';
import * as fs from 'fs';

console.log('📸 Template Capture Tool');
console.log('========================\n');
console.log('Instructions:');
console.log('1. Position your mouse over the element to capture');
console.log('2. Press Ctrl+C to cancel, or wait 3 seconds...\n');

// Wait 3 seconds
await new Promise(resolve => setTimeout(resolve, 3000));

// Get mouse position
const mousePos = await mouse.getPosition();
console.log(`Mouse position: (${mousePos.x}, ${mousePos.y})\n`);

// Capture screenshot
console.log('Taking screenshot...');
const img = await screen.grabScreen();
const jimpImg = await imageToJimp(img);

// Prompt for region size
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        readline.question(question, (answer: string) => {
            resolve(answer);
        });
    });
}

const widthStr = await ask('Enter template width (default: 100): ');
const heightStr = await ask('Enter template height (default: 40): ');

const width = parseInt(widthStr) || 100;
const height = parseInt(heightStr) || 40;

// Calculate region around mouse (retina coordinates)
const x = Math.max(0, mousePos.x * 2 - width / 2);
const y = Math.max(0, mousePos.y * 2 - height / 2);

console.log(`\nCapturing region: x=${x}, y=${y}, w=${width}, h=${height}`);

// Crop to template
const template = jimpImg.clone();
template.crop({ x, y, w: width, h: height });

// Save preview
const previewPath = 'template-preview.png';
await template.write(previewPath);
console.log(`✅ Preview saved: ${previewPath}`);

// Convert to base64
const buffer = await template.getBuffer('image/png');
const base64 = buffer.toString('base64');
const dataUrl = `data:image/png;base64,${base64}`;

// Save to clipboard (if pbcopy available)
try {
    const { spawn } = require('child_process');
    const pbcopy = spawn('pbcopy');
    pbcopy.stdin.write(dataUrl);
    pbcopy.stdin.end();
    console.log('✅ Base64 data URL copied to clipboard!');
} catch (e) {
    console.log('\n📋 Base64 data URL:');
    console.log(dataUrl.substring(0, 100) + '...');
}

// Save to file
const templateName = await ask('\nEnter template name (e.g., "signin_button"): ');
const jsonPath = `templates/${templateName}.json`;

fs.mkdirSync('templates', { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify({
    name: templateName,
    width,
    height,
    dataUrl
}, null, 2));

console.log(`✅ Template saved: ${jsonPath}`);
console.log('\n📝 Add to workflow.json:');
console.log(`"imageTemplate": "${dataUrl.substring(0, 50)}..."`);

readline.close();
process.exit(0);
