'use strict';
const $ = s => document.querySelector(s);

function load() {
  chrome.runtime.sendMessage({ type: 'GET_CFG' }, (r) => {
    if (!r || !r.ok) return;
    $('#url').value = r.cfg.serverUrl || '';
    $('#token').value = r.cfg.token || '';
    $('#auto').checked = !!r.cfg.autoSync;
  });
}
load();

$('#save').addEventListener('click', () => {
  const cfg = { serverUrl: $('#url').value.trim(), token: $('#token').value.trim(), autoSync: $('#auto').checked };
  chrome.runtime.sendMessage({ type: 'SET_CFG', cfg }, () => { $('#msg').textContent = 'Saved.'; });
});

$('#test').addEventListener('click', async () => {
  $('#msg').textContent = 'Testing…';
  try {
    const url = $('#url').value.trim().replace(/\/$/, '') + '/api/ingest/panel/status';
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + $('#token').value.trim() } });
    const data = await res.json().catch(() => ({}));
    if (res.ok) $('#msg').textContent = 'OK — server reachable. Last sync: ' + JSON.stringify(data.last_sync || {});
    else $('#msg').textContent = 'Server responded ' + res.status + ': ' + (data.error || '');
  } catch (e) { $('#msg').textContent = 'Error: ' + e.message; }
});
