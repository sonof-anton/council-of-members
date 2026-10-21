'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('council', {
  sendPrompt: (prompt) => ipcRenderer.invoke('council:send-prompt', prompt),
  abort: () => ipcRenderer.invoke('council:abort'),
  setLevel: (level) => ipcRenderer.invoke('council:set-level', level),
  getState: () => ipcRenderer.invoke('council:get-state'),
  diagnose: () => ipcRenderer.invoke('council:diagnose'),
  skipMember: (name) => ipcRenderer.invoke('council:skip-member', name),
  waitMember: (name) => ipcRenderer.invoke('council:wait-member', name),
  deepProbe: () => ipcRenderer.invoke('council:deep-probe'),
  navBack: (name) => ipcRenderer.invoke('council:nav-back', name),
  navForward: (name) => ipcRenderer.invoke('council:nav-forward', name),

  onLoginStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:login-status', listener);
    return () => ipcRenderer.removeListener('council:login-status', listener);
  },

  onPhaseChange: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:phase-change', listener);
    return () => ipcRenderer.removeListener('council:phase-change', listener);
  },
  onAiStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:ai-status', listener);
    return () => ipcRenderer.removeListener('council:ai-status', listener);
  },
  onRoundUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:round-update', listener);
    return () => ipcRenderer.removeListener('council:round-update', listener);
  },
  onConsensus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:consensus', listener);
    return () => ipcRenderer.removeListener('council:consensus', listener);
  },
  onLogMessage: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:log-message', listener);
    return () => ipcRenderer.removeListener('council:log-message', listener);
  },
  onError: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:error', listener);
    return () => ipcRenderer.removeListener('council:error', listener);
  },
  onTimeoutTick: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:timeout-tick', listener);
    return () => ipcRenderer.removeListener('council:timeout-tick', listener);
  },
  onAiThought: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:ai-thought', listener);
    return () => ipcRenderer.removeListener('council:ai-thought', listener);
  },
  onPerfUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:perf-update', listener);
    return () => ipcRenderer.removeListener('council:perf-update', listener);
  },
  onIndividualConsensus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:individual-consensus', listener);
    return () => ipcRenderer.removeListener('council:individual-consensus', listener);
  }
});
