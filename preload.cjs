const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('formforge', {
  initialState: () => ipcRenderer.invoke('app:initial-state'),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  importFile: () => ipcRenderer.invoke('tools:import-file'),
  importProject: () => ipcRenderer.invoke('tools:import-project'),
  importUrl: url => ipcRenderer.invoke('tools:import-url', url),
  chooseParameterFile: kind => ipcRenderer.invoke('tools:choose-parameter-file', kind),
  saveIconAsset: (toolId, parameterName, svg) => ipcRenderer.invoke('tools:save-icon-asset', toolId, parameterName, svg),
  traceImage: (rgba, width, height, options) => ipcRenderer.invoke('tools:trace-image', rgba, width, height, options),
  saveHeightmapAsset: (toolId, parameterName, png) => ipcRenderer.invoke('tools:save-heightmap-asset', toolId, parameterName, png),
  iconIndex: () => ipcRenderer.invoke('icons:index'),
  readIcons: items => ipcRenderer.invoke('icons:read-many', items),
  readIcon: (pack, relativePath) => ipcRenderer.invoke('icons:read', pack, relativePath),
  openIconFolder: () => ipcRenderer.invoke('icons:open-folder'),
  deleteTool: toolId => ipcRenderer.invoke('tools:delete', toolId),
  addParameter: (toolId, parameter) => ipcRenderer.invoke('tools:add-parameter', toolId, parameter),
  render: (toolId, values) => ipcRenderer.invoke('tools:render', toolId, values),
  export: (toolId, values, format, transform = null, options = {}) => ipcRenderer.invoke('tools:export', toolId, values, format, transform, options),
  // Per-plate export progress: callback({ plate, count }); returns an unsubscribe function.
  onExportProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  chooseExportDirectory: current => ipcRenderer.invoke('settings:choose-export-directory', current),
  openExportDirectory: () => ipcRenderer.invoke('settings:open-export-directory')
});
