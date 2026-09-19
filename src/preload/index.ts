import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type IpcContract } from '@shared/ipc';
import type { ConnectionConfig } from '@shared/schema';

const api = {
    connect: (cfg: ConnectionConfig) => ipcRenderer.invoke(IPC.connect, cfg),
    disconnect: () => ipcRenderer.invoke(IPC.disconnect),
    getDiagram: () => ipcRenderer.invoke(IPC.getDiagram),
    analyzeQuery: (sql: string) => ipcRenderer.invoke(IPC.analyzeQuery, sql),
    executeQuery: (sql: string) => ipcRenderer.invoke(IPC.executeQuery, sql),
    listSaved: () => ipcRenderer.invoke(IPC.listSaved),
    saveConnection: (name: string, cfg: ConnectionConfig) =>
        ipcRenderer.invoke(IPC.saveConnection, name, cfg),
    deleteConnection: (id: string) => ipcRenderer.invoke(IPC.deleteConnection, id),
    loadSaved: (id: string) => ipcRenderer.invoke(IPC.loadSaved, id)
} satisfies IpcContract;

contextBridge.exposeInMainWorld('db', api);
