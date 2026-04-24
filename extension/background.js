'use strict';
const CFG_KEY = 'b2c_cfg';
const DEFAULTS = { serverUrl: 'http://localhost:3000', token: '', autoSync: true };

function getCfg() {
  return new Promise(r => chrome.storage.local.get([CFG_KEY], x => r({ ...DEFAULTS, ...(x[CFG_KEY] || {}) })));
}
function setCfg(cfg) {
  return new Promise(r => chrome.storage.local.set({ [CFG_KEY]: cfg }, r));
}

async function pushToServer(payload) {
  const cfg = await getCfg();
  if (!cfg.serverUrl || !cfg.token) return { ok: false, error: 'Set server URL & token in options' };
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/$/, '') + '/api/ingest/panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || ('HTTP ' + res.status) };
    return { ok: true, inserted: data.inserted || 0, skipped: data.skipped || 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'PANEL_DATA') {
    pushToServer(msg.payload).then(r => sendResponse(r));
    return true;
  }
  if (msg.type === 'GET_CFG') { getCfg().then(c => sendResponse({ ok: true, cfg: c })); return true; }
  if (msg.type === 'SET_CFG') { setCfg(msg.cfg).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'TRIGGER_SCRAPE_ACTIVE') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return sendResponse({ ok: false, error: 'no active tab' });
      chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_NOW' }, r => sendResponse(r || { ok: false, error: 'no response' }));
    });
    return true;
  }
});

chrome.alarms.create('auto-scrape', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'auto-scrape') return;
  const cfg = await getCfg();
  if (!cfg.autoSync) return;
  chrome.tabs.query({ url: ['https://panel.freeplay24.com/*','https://admin.testawl247.com/*','https://testawl247.com/*'] }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'SCRAPE_NOW' }, () => void chrome.runtime.lastError);
  });
});
