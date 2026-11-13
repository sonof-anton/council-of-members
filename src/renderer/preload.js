'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('council', {
  sendPrompt: (prompt, files) => ipcRenderer.invoke('council:send-prompt', prompt, files),
  // Real disk path of a dropped/picked File ('' if it has none)
  getFilePath: (file) => webUtils.getPathForFile(file),
  abort: () => ipcRenderer.invoke('council:abort'),
  setLevel: (level) => ipcRenderer.invoke('council:set-level', level),
  getState: () => ipcRenderer.invoke('council:get-state'),
  diagnose: () => ipcRenderer.invoke('council:diagnose'),
  skipMember: (name) => ipcRenderer.invoke('council:skip-member', name),
  waitMember: (name) => ipcRenderer.invoke('council:wait-member', name),
  retryMember: (name) => ipcRenderer.invoke('council:retry-member', name),
  forceMember: (name) => ipcRenderer.invoke('council:force-member', name),
  deepProbe: () => ipcRenderer.invoke('council:deep-probe'),
  navBack: (name) => ipcRenderer.invoke('council:nav-back', name),
  navForward: (name) => ipcRenderer.invoke('council:nav-forward', name),
  advanceRound: () => ipcRenderer.invoke('council:advance-round'),
  getConstitution: () => ipcRenderer.invoke('council:get-constitution'),
  getModes: () => ipcRenderer.invoke('council:get-modes'),
  listModes: (name) => ipcRenderer.invoke('council:list-modes', name),
  selectMode: (name, optionText) => ipcRenderer.invoke('council:select-mode', name, optionText),
  applyModePreset: (preset) => ipcRenderer.invoke('council:apply-mode-preset', preset),

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
  onMemberActivity: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:member-activity', listener);
    return () => ipcRenderer.removeListener('council:member-activity', listener);
  },
  onConsultStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:consult-status', listener);
    return () => ipcRenderer.removeListener('council:consult-status', listener);
  },
  onModes: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:modes', listener);
    return () => ipcRenderer.removeListener('council:modes', listener);
  },
  onIndividualConsensus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('council:individual-consensus', listener);
    return () => ipcRenderer.removeListener('council:individual-consensus', listener);
  }
});
