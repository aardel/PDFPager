const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Disable GPU acceleration and sandboxing to prevent crashes in environments with restricted GPU access
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');


function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // Set to false to allow preload to access node features if needed, or kept true for security.
    },
    title: 'PDFPager',
    autoHideMenuBar: true
  });

  // Check if we are in development mode
  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Destination Folder',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('save-pdfs', async (event, { folderPath, files }) => {
  try {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Destination directory does not exist: ${folderPath}`);
    }

    const savedFiles = [];

    for (const file of files) {
      // file.data is an ArrayBuffer/Uint8Array sent via IPC
      const buffer = Buffer.from(file.data);
      const filePath = path.join(folderPath, file.fileName);
      // fileName may carry subfolders (e.g. "org scan/<name>.pdf").
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
      savedFiles.push(filePath);
    }

    return { success: true, savedFiles };
  } catch (error) {
    console.error('Error saving PDFs:', error);
    return { success: false, error: error.message };
  }
});
