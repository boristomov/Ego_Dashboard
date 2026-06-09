/**
 * Lead capture -> Google Sheet.
 *
 * Receives the JSON the dashboard sends when a visitor unlocks a download
 * (email + company) or a client signs in, and appends one row per lead.
 *
 * Deploy:
 *   1. Create a Google Sheet (this is where leads land).
 *   2. Extensions -> Apps Script. Delete the stub and paste this file.
 *   3. Save, then Deploy -> New deployment -> type "Web app".
 *        - Description:  ego lead capture
 *        - Execute as:   Me
 *        - Who has access: Anyone   (required so the public site can POST)
 *   4. Deploy, authorize, and copy the Web app URL (ends with /exec).
 *   5. Send that URL to wire it as VITE_LEAD_ENDPOINT.
 *
 * The site POSTs a text/plain body (no preflight); we parse it as JSON here.
 */

var SHEET_NAME = 'Leads';
var HEADERS = [
  'receivedAt', 'acceptedAt', 'type', 'email', 'company',
  'role', 'consent', 'page', 'referrer', 'userAgent',
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return _json({ ok: false, error: 'busy' });
  }
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
    }
    sheet.appendRow([
      new Date().toISOString(),
      data.acceptedAt || '',
      data.type || '',
      data.email || '',
      data.company || '',
      data.role || '',
      data.consent ? 'yes' : 'no',
      data.page || '',
      data.referrer || '',
      data.userAgent || '',
    ]);
    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Lets you sanity-check the deployment in a browser (GET the /exec URL).
function doGet() {
  return _json({ ok: true, service: 'ego-lead-capture' });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
