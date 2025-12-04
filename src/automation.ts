import { spawn } from 'child_process';
import { keyboard, mouse, Key, Point } from "@nut-tree-fork/nut-js";

export async function clickAt(x: number, y: number): Promise<void> {
    // Coordinates should already be in logical mouse space (1x)
    // The detection layer (ocr.ts) normalizes coordinates from screenshot pixels to logical points
    const mouseX = Math.round(x);
    const mouseY = Math.round(y);

    console.log(`   🖱️  Clicking at mouse(${mouseX}, ${mouseY})`);

    await mouse.setPosition(new Point(mouseX, mouseY));
    await mouse.leftClick();
    await wait(500); // Brief wait after click to let UI respond
}

export async function pressKey(key: string, modifiers?: string): Promise<void> {
    const keyMap: { [key: string]: Key } = {
        ',': Key.Comma,
        'r': Key.R,
        'p': Key.P,
        '53': Key.Escape, // AppleScript key code for ESC
        'esc': Key.Escape,
        'escape': Key.Escape,
        'return': Key.Return,
        'enter': Key.Return,
        'space': Key.Space,
        'down': Key.Down,
        'up': Key.Up,
        'left': Key.Left,
        'right': Key.Right,
        'w': Key.W
    };

    const nutKey = keyMap[key.toLowerCase()] || keyMap[key];

    if (!nutKey) {
        console.warn(`⚠️  Unknown key: ${key}, ignoring.`);
        return;
    }

    // Handle modifiers
    if (modifiers) {
        const mods = modifiers.toLowerCase();
        if (mods.includes('command') || mods.includes('cmd')) await keyboard.pressKey(Key.LeftCmd);
        if (mods.includes('shift')) await keyboard.pressKey(Key.LeftShift);
        if (mods.includes('control') || mods.includes('ctrl')) await keyboard.pressKey(Key.LeftControl);
        if (mods.includes('option') || mods.includes('alt')) await keyboard.pressKey(Key.LeftAlt);
    }

    await keyboard.type(nutKey);

    // Release modifiers
    if (modifiers) {
        const mods = modifiers.toLowerCase();
        if (mods.includes('option') || mods.includes('alt')) await keyboard.releaseKey(Key.LeftAlt);
        if (mods.includes('control') || mods.includes('ctrl')) await keyboard.releaseKey(Key.LeftControl);
        if (mods.includes('shift')) await keyboard.releaseKey(Key.LeftShift);
        if (mods.includes('command') || mods.includes('cmd')) await keyboard.releaseKey(Key.LeftCmd);
    }
}

export async function focusAntigravity(): Promise<void> {
    return new Promise((resolve) => {
        const script = `
tell application "Antigravity"
    activate
end tell
`;
        const proc = spawn('osascript', ['-e', script]);
        proc.on('close', () => {
            setTimeout(resolve, 500); // Wait for focus
        });
    });
}

export async function wait(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

export async function openSettings(): Promise<void> {
    // 1. Ensure app is focused first
    await focusAntigravity();

    // 2. Use nut.js to send Cmd+,
    console.log('   ⌨️  Sending Cmd+, via nut.js...');

    // Configure nut.js
    keyboard.config.autoDelayMs = 100;

    // Send Cmd+,
    await keyboard.pressKey(Key.LeftCmd);
    await keyboard.type(Key.Comma);
    await keyboard.releaseKey(Key.LeftCmd);

    console.log('   ⏳ Waiting for Settings window to open...');
    await wait(4000); // Increased wait for Settings to fully render
}
