'use strict';
const $ = s => document.querySelector(s);

let activeTabId = null;

// Sanity check: are server URL and token configured? If not, prompt loud.
chrome.runtime.sendMessage({ type: 'GET_CFG' }, (r) => {
  if (!r || !r.ok) return;
  const c = r.cfg || {};
  if (!c.serverUrl || !c.token) {
    const s = $('#status');
    s.style.color = '#ff5569';
    s.textContent = 'Not configured. Click Settings → set Server URL (e.g. http://localhost:3000) and paste an API token (Login → Settings → Tokens → New).';
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  activeTabId = tab.id;
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (r) => {
    if (chrome.runtime.lastError || !r) {
      $('#site').textContent = 'Open a panel page (freeplay24 / testawl247) then reopen this popup.';
      $('#btnSync').disabled = true;
      $('#btnDiagnose').disabled = true;
      return;
    }
    $('#site').textContent = r.site + ' · ' + new URL(r.url).pathname;
  });
});

$('#btnSync').addEventListener('click', () => {
  $('#status').textContent = 'Syncing…';
  chrome.tabs.sendMessage(activeTabId, { type: 'SCRAPE_NOW' }, (r) => {
    if (chrome.runtime.lastError) {
      $('#status').textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    if (!r || !r.ok) $('#status').textContent = 'Error: ' + ((r && r.error) || 'no response');
    else $('#status').textContent = 'Scrape requested — watch the bottom-right badge on the page.';
  });
});

$('#btnDiagnose').addEventListener('click', () => {
  $('#diag').textContent = 'Scanning page…';
  chrome.tabs.sendMessage(activeTabId, { type: 'DIAGNOSE' }, (r) => {
    if (chrome.runtime.lastError) {
      $('#diag').textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    if (!r || !r.ok) { $('#diag').textContent = 'No report.'; return; }
    const lines = r.report.map(t =>
      `Table #${t.idx}: ${t.rows} rows\nHeaders: ${t.headers.join(' | ')}\nRow1: ${(t.sampleFirstRow||[]).join(' | ')}`
    );
    $('#diag').textContent = lines.join('\n\n') || 'No tables found on page.';
  });
});

$('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
