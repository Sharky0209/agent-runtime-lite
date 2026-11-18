// Real local workflow steps; ARL_ROOT is supplied by the runtime to each child.
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const root = process.env.ARL_ROOT;
const step = process.argv[2];
if (!root || !['build', 'verify', 'render'].includes(step)) {
  throw Error('EXPECTED_ARL_ROOT_AND_STEP');
}

function readTotals() {
  const lines = fs.readFileSync(path.join(root, 'invoices.jsonl'), 'utf8')
    .split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw Error('INVOICES_EMPTY');
  const seen = new Set();
  const totals = {invoiceCount: 0, paidCount: 0, totalCents: 0, paidCents: 0};
  for (const line of lines) {
    const invoice = JSON.parse(line);
    if (!invoice || typeof invoice.id !== 'string' || !invoice.id.trim() ||
        seen.has(invoice.id) || !Number.isSafeInteger(invoice.amountCents) ||
        invoice.amountCents < 0 || !['paid', 'pending'].includes(invoice.status)) {
      throw Error('INVOICE_INVALID_OR_DUPLICATE');
    }
    seen.add(invoice.id);
    totals.invoiceCount++;
    totals.totalCents += invoice.amountCents;
    if (invoice.status === 'paid') {
      totals.paidCount++;
      totals.paidCents += invoice.amountCents;
    }
    if (!Number.isSafeInteger(totals.totalCents) ||
        !Number.isSafeInteger(totals.paidCents)) throw Error('INVOICE_TOTAL_OVERFLOW');
  }
  return totals;
}

if (step === 'build') {
  fs.writeFileSync(path.join(root, 'audit.json'),
    JSON.stringify({status: 'ready', ...readTotals()}, null, 2) + '\n');
}

if (step === 'verify') {
  // A separate child process reads the original input again and checks the report.
  const audit = JSON.parse(fs.readFileSync(path.join(root, 'audit.json'), 'utf8'));
  const expected = {status: 'ready', ...readTotals()};
  if (!isDeepStrictEqual(audit, expected)) throw Error('AUDIT_READBACK_MISMATCH');
  fs.writeFileSync(path.join(root, 'verification.json'),
    JSON.stringify({status: 'verified', ...readTotals()}, null, 2) + '\n');
}

if (step === 'render') {
  const verified = JSON.parse(fs.readFileSync(path.join(root, 'verification.json'), 'utf8'));
  if (!isDeepStrictEqual(verified, {status: 'verified', ...readTotals()})) {
    throw Error('VERIFICATION_READBACK_MISMATCH');
  }
  const money = cents => (cents / 100).toFixed(2);
  const summary = [
    '# Invoice reconciliation report',
    '',
    'Locally verified against the source invoices.jsonl.',
    '',
    `- Invoices: ${verified.invoiceCount}`,
    `- Paid invoices: ${verified.paidCount}`,
    `- Gross amount: ${money(verified.totalCents)}`,
    `- Paid amount: ${money(verified.paidCents)}`,
    ''
  ].join('\n');
  const summaryPath = path.join(root, 'summary.md');
  fs.writeFileSync(summaryPath, summary);
  if (fs.readFileSync(summaryPath, 'utf8') !== summary) {
    throw Error('SUMMARY_READBACK_MISMATCH');
  }
  fs.writeFileSync(path.join(root, 'rendered.json'),
    JSON.stringify({status: 'rendered', bytes: Buffer.byteLength(summary)}) + '\n');
}
