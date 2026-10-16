#!/usr/bin/env node
/**
 * Verifies that the built shell executable is a GUI-subsystem Windows binary.
 *
 * This exists because a console-subsystem exe IS the bug the desktop shell work exists to
 * fix: double-clicking it opens a black console window and the user sees "no feedback".
 * A one-line PE header read is the cheapest guard against ever shipping that again, so it
 * runs after every build.
 *
 * Usage: node tools/check-shell-binary.mjs <path-to-exe>
 */
import { readFileSync, statSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/check-shell-binary.mjs <path-to-exe>');
  process.exit(2);
}

const bytes = readFileSync(target);

if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
  console.error(`FAIL  ${target} is not a PE image (no MZ signature)`);
  process.exit(1);
}

const peOffset = bytes.readInt32LE(0x3c);
if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
  console.error(`FAIL  ${target} has no PE signature at 0x${peOffset.toString(16)}`);
  process.exit(1);
}

const subsystem = bytes.readUInt16LE(peOffset + 0x5c);
const names = { 2: 'WINDOWS_GUI', 3: 'WINDOWS_CUI' };
const size = statSync(target).size;

console.log(target);
console.log(`  size       ${(size / 1048576).toFixed(1)} MB (${size} bytes)`);
console.log(`  SUBSYSTEM  ${subsystem} (${names[subsystem] ?? 'other'})`);

if (subsystem !== 2) {
  console.error('FAIL  expected WINDOWS_GUI (2): a console subsystem binary opens a black window on double-click');
  process.exit(1);
}

console.log('  OK');
