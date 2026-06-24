import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWalletClient, formatUnits, http, isAddress, parseUnits, type Address } from 'viem';
import { expectAtLeastPositionalArgs, primaryRuntime } from '../common.js';
import { deploymentConfig, getDeployerAccount, orbitChain, orbitChainPublicClient, orbitChainRpcUrl } from './common.js';

const defaultCsvPath = fileURLToPath(new URL('../../../../data/slash_refund_summary.csv', import.meta.url));

type TransferRow = {
  rowNumber: number;
  address: Address;
  amount: bigint;
};

const [csvPathInput, ...extraArgs] = expectAtLeastPositionalArgs(
  0,
  'npx tsx deployments/primary/scripts/crynux-on-base/batch-transfer-cnx.ts [csvPath]',
);

if (extraArgs.length > 0) {
  throw new Error(
    'Usage: npx tsx deployments/primary/scripts/crynux-on-base/batch-transfer-cnx.ts [csvPath] --network=<testnet|mainnet>',
  );
}

const csvPath = resolve(csvPathInput ?? defaultCsvPath);
const rows = await loadTransferRows(csvPath);
const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0n);
const deployer = await getDeployerAccount();
const walletClient = createWalletClient({
  account: deployer,
  chain: orbitChain,
  transport: http(orbitChainRpcUrl),
});
const balanceBefore = await orbitChainPublicClient.getBalance({ address: deployer.address });

if (balanceBefore < totalAmount) {
  throw new Error(
    `Insufficient ${deploymentConfig.name} CNX balance. Required ${formatUnits(totalAmount, 18)}, available ${formatUnits(balanceBefore, 18)}.`,
  );
}

console.log(`${deploymentConfig.name} batch transfer:`);
console.log(
  JSON.stringify(
    {
      csvPath,
      network: primaryRuntime.network,
      sender: deployer.address,
      rowCount: rows.length,
      totalAmount: formatUnits(totalAmount, 18),
      balanceBefore: formatUnits(balanceBefore, 18),
    },
    null,
    2,
  ),
);

for (const row of rows) {
  console.log(`Sending row ${row.rowNumber}: ${formatUnits(row.amount, 18)} CNX to ${row.address}`);
  try {
    const hash = await walletClient.sendTransaction({
      to: row.address,
      value: row.amount,
    });
    console.log(`Transfer row ${row.rowNumber} submitted: ${hash}`);

    const receipt = await orbitChainPublicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction failed: ${hash}`);
    }

    console.log(`Transfer row ${row.rowNumber} confirmed: ${hash}`);
  } catch (error) {
    throw new Error(`Transfer row ${row.rowNumber} failed. Batch stopped: ${(error as Error).message}`);
  }
}

const balanceAfter = await orbitChainPublicClient.getBalance({ address: deployer.address });
console.log(`${deploymentConfig.name} batch transfer completed.`);
console.log(
  JSON.stringify(
    {
      sender: deployer.address,
      balanceAfter: formatUnits(balanceAfter, 18),
    },
    null,
    2,
  ),
);

async function loadTransferRows(inputPath: string): Promise<TransferRow[]> {
  const parsedRows = parseCsv(await readFile(inputPath, 'utf8'));

  if (parsedRows.length === 0) {
    throw new Error('Transfer CSV file is empty.');
  }

  const headers = normalizeCsvHeaders(parsedRows[0]);
  const addressIndex = getRequiredCsvColumn(headers, 'address');
  const amountIndex = getRequiredCsvColumn(headers, 'amount');
  const rows = parsedRows
    .slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => row.some((value) => value.trim() !== ''))
    .map(({ row, rowNumber }) => ({
      rowNumber,
      address: parseTransferAddress(row[addressIndex], rowNumber),
      amount: parseTransferAmount(row[amountIndex], rowNumber),
    }));

  if (rows.length === 0) {
    throw new Error('Transfer CSV file does not contain any transfer rows.');
  }

  return rows;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index];

    if (char === '"') {
      if (inQuotes && normalizedText[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n' && !inQuotes) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error('CSV contains an unterminated quoted field.');
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeCsvHeaders(row: string[]): string[] {
  return row.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim());
}

function getRequiredCsvColumn(headers: string[], columnName: string): number {
  const index = headers.indexOf(columnName);
  if (index === -1) {
    throw new Error(`CSV is missing required column: ${columnName}`);
  }
  return index;
}

function parseTransferAddress(value: string | undefined, rowNumber: number): Address {
  const address = value?.trim() ?? '';
  if (!isAddress(address)) {
    throw new Error(`Transfer CSV row ${rowNumber} address must be a valid EVM address.`);
  }
  return address;
}

function parseTransferAmount(value: string | undefined, rowNumber: number): bigint {
  const amountText = (value?.trim() ?? '').replace(/\s*CNX$/i, '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(amountText)) {
    throw new Error(`Transfer CSV row ${rowNumber} amount must be a positive CNX amount with up to 18 decimal places.`);
  }

  const amount = parseUnits(amountText, 18);
  if (amount <= 0n) {
    throw new Error(`Transfer CSV row ${rowNumber} amount must be greater than zero.`);
  }
  return amount;
}
