'use strict';

const vscode = require('vscode');

function getConfig() {
  return vscode.workspace.getConfiguration('llmCluster');
}

function getManagerBaseUrl() {
  const configured = String(getConfig().get('managerUrl', 'http://localhost:3000')).trim();
  return configured.replace(/\/+$/, '');
}

function getModelName() {
  return String(getConfig().get('model', 'Qwen 2.5 Coder 7B')).trim();
}

function getTimeoutMs() {
  const value = Number(getConfig().get('requestTimeoutMs', 120000));
  return Number.isFinite(value) && value > 0 ? value : 120000;
}

function getInvocationMode() {
  return String(getConfig().get('invocationMode', 'manager') || 'manager');
}

function getEngineEndpoint() {
  return String(getConfig().get('engineUrl', 'http://localhost:8080')).trim();
}

function getClientProxyUrl() {
  return String(getConfig().get('clientProxyUrl', 'http://localhost:3000')).trim();
}

function getPreferredWorkerId() {
  return String(getConfig().get('preferredWorkerId', '') || '').trim();
}

function getPreferredWorkerEndpoint() {
  return String(getConfig().get('preferredWorkerEndpoint', '') || '').trim();
}

async function setInvocationMode(mode) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update('invocationMode', mode, vscode.ConfigurationTarget.Workspace);
    return true;
  } catch (e) {
    console.error('Failed to save invocationMode:', e.message);
    return false;
  }
}

async function setEngineUrl(url) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update('engineUrl', String(url || '').trim(), vscode.ConfigurationTarget.Workspace);
    return true;
  } catch (e) {
    console.error('Failed to save engineUrl:', e.message);
    return false;
  }
}

async function setClientProxyUrl(url) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update('clientProxyUrl', String(url || '').trim(), vscode.ConfigurationTarget.Workspace);
    return true;
  } catch (e) {
    console.error('Failed to save clientProxyUrl:', e.message);
    return false;
  }
}

async function setPreferredWorkerId(workerId) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update('preferredWorkerId', String(workerId || '').trim(), vscode.ConfigurationTarget.Workspace);
    return true;
  } catch (e) {
    console.error('Failed to save preferredWorkerId:', e.message);
    return false;
  }
}

async function setPreferredWorkerEndpoint(url) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update('preferredWorkerEndpoint', String(url || '').trim(), vscode.ConfigurationTarget.Workspace);
    return true;
  } catch (e) {
    console.error('Failed to save preferredWorkerEndpoint:', e.message);
    return false;
  }
}

async function setUseWorkerEndpointForDirect(enabled) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update(
      'useWorkerEndpointForDirectCalls',
      Boolean(enabled),
      vscode.ConfigurationTarget.Workspace
    );
    return true;
  } catch (e) {
    console.error('Failed to save useWorkerEndpointForDirectCalls:', e.message);
    return false;
  }
}

async function updateSetting(key, value) {
  try {
    await vscode.workspace.getConfiguration('llmCluster').update(key, value, vscode.ConfigurationTarget.Workspace);
    return true;
  } catch (e) {
    console.error(`Failed to save ${key}:`, e.message);
    return false;
  }
}

module.exports = {
  getConfig,
  getManagerBaseUrl,
  getModelName,
  getTimeoutMs,
  getInvocationMode,
  getEngineEndpoint,
  getClientProxyUrl,
  getPreferredWorkerId,
  getPreferredWorkerEndpoint,
  setInvocationMode,
  setEngineUrl,
  setClientProxyUrl,
  setPreferredWorkerId,
  setPreferredWorkerEndpoint,
  setUseWorkerEndpointForDirect,
  updateSetting,
};
