#!/usr/bin/env node

const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const navigationFilePath = path.join(
  __dirname,
  '..',
  'api-docs',
  'assets',
  'navigation.js',
);
const apiDocsDir = path.join(__dirname, '..', 'api-docs');

// Decodes and decompresses the TypeDoc navigation data
function decodeTypeDocNavigation(encodedData) {
  return new Promise((resolve, reject) => {
    const base64Data = encodedData.replace(
      /^data:application\/octet-stream;base64,/,
      '',
    );
    const buffer = Buffer.from(base64Data, 'base64');

    zlib.gunzip(buffer, (err, decompressed) => {
      if (err) {
        reject(new Error('Failed to decompress data: ' + err.message));
        return;
      }

      try {
        const jsonData = JSON.parse(decompressed.toString('utf-8'));
        resolve(jsonData);
      } catch (parseError) {
        reject(new Error('Failed to parse JSON: ' + parseError.message));
      }
    });
  });
}

// Compresses and encodes the TypeDoc navigation data
function encodeTypeDocNavigation(jsonData) {
  return new Promise((resolve, reject) => {
    const jsonString = JSON.stringify(jsonData);

    zlib.gzip(jsonString, (err, compressed) => {
      if (err) {
        reject(new Error('Failed to compress data: ' + err.message));
        return;
      }

      const base64Data = compressed.toString('base64');
      resolve('data:application/octet-stream;base64,' + base64Data);
    });
  });
}

// Recursively updates URLs in the navigation data
function updateUrls(data, searchString, replaceString) {
  if (typeof data === 'object' && data !== null) {
    for (let key in data) {
      if (
        typeof data[key] === 'string' &&
        data[key].includes(`${searchString}/`)
      ) {
        data[key] = data[key].replace(
          new RegExp(`${searchString}/`, 'g'),
          `${replaceString}/`,
        );
      } else if (typeof data[key] === 'object') {
        updateUrls(data[key], searchString, replaceString);
      }
    }
  }
  return data;
}

// Updates href links in HTML files
async function updateHtmlFiles(dir, searchString, replaceString) {
  const files = await fsp.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      await updateHtmlFiles(filePath, searchString, replaceString);
    } else if (path.extname(file) === '.html') {
      let content = await fsp.readFile(filePath, 'utf8');
      if (content.includes(`/${searchString}/`)) {
        content = content.replace(
          new RegExp(`/${searchString}/`, 'g'),
          `/${replaceString}/`,
        );
        await fsp.writeFile(filePath, content);
        console.log(`Updated: ${filePath}`);
      }
    }
  }
}

// Updates the navigation file and HTML files in the api-docs directory
// replacing /function file names and url references with /funcs
async function updateNavigationAndHtmlFiles(
  searchString = 'functions',
  replaceString = 'funcs',
) {
  try {
    // Rename the directory
    const oldDirPath = path.join(apiDocsDir, searchString);
    const newDirPath = path.join(apiDocsDir, replaceString);
    await fsp.rename(oldDirPath, newDirPath);
    console.log(`Directory renamed from ${searchString} to ${replaceString}`);

    // Update navigation file
    const fileContent = await fsp.readFile(navigationFilePath, 'utf8');
    const match = fileContent.match(/window\.navigationData = "(.*?)"/);
    if (!match) {
      throw new Error('Navigation data not found in file');
    }
    const encodedData = match[1];

    const decodedData = await decodeTypeDocNavigation(encodedData);
    const updatedData = updateUrls(decodedData, searchString, replaceString);
    const newEncodedData = await encodeTypeDocNavigation(updatedData);
    const newFileContent = `window.navigationData = "${newEncodedData}"`;
    await fsp.writeFile(navigationFilePath, newFileContent);

    console.log('Navigation file updated successfully');

    // Update HTML files
    await updateHtmlFiles(apiDocsDir, searchString, replaceString);
    console.log('HTML files updated successfully');
  } catch (error) {
    console.error('Error updating files:', error);
  }
}

updateNavigationAndHtmlFiles();
