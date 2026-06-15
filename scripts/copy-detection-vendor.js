#!/usr/bin/env node
/** Copy onnxruntime-web WASM bits into public/vendor/ort after npm install. */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../node_modules/onnxruntime-web/dist');
const dstDir = path.join(__dirname, '../public/vendor/ort');

if (!fs.existsSync(srcDir)) {
  console.warn('onnxruntime-web not installed — skip ORT vendor copy');
  process.exit(0);
}

fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, 'ort.wasm.min.js'), path.join(dstDir, 'ort.wasm.min.js'));

for (const name of fs.readdirSync(srcDir)) {
  if (name.endsWith('.wasm')) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
  }
}

console.log('Copied onnxruntime-web WASM assets to public/vendor/ort/');
