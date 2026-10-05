function readUInt(bytes, offset, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i];
  return value;
}

function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function normalizeTonAddress(address) {
  if (typeof address !== 'string') return undefined;
  const raw = address.trim().toLowerCase();
  if (/^-?\d+:[0-9a-f]{64}$/.test(raw)) return raw;
  try {
    const bytes = Buffer.from(address.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (bytes.length !== 36) return undefined;
    const expectedCrc = crc16Xmodem(bytes.subarray(0, 34));
    if (bytes[34] !== (expectedCrc >> 8) || bytes[35] !== (expectedCrc & 0xff)) return undefined;
    const tag = bytes[0] & 0x7f;
    if (tag !== 0x11 && tag !== 0x51) return undefined;
    const workchain = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
    return `${workchain}:${bytes.subarray(2, 34).toString('hex')}`;
  } catch {
    return undefined;
  }
}

function decodeSingleCellBoc(body) {
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('hex') !== 'b5ee9c72') return undefined;
  const flags = bytes[4];
  const hasIndex = Boolean(flags & 0x80);
  const hasCrc32 = Boolean(flags & 0x40);
  const sizeBytes = flags & 0x07;
  const offsetBytes = bytes[5];
  if (!sizeBytes || !offsetBytes) return undefined;

  let offset = 6;
  const cells = readUInt(bytes, offset, sizeBytes); offset += sizeBytes;
  const roots = readUInt(bytes, offset, sizeBytes); offset += sizeBytes;
  const absent = readUInt(bytes, offset, sizeBytes); offset += sizeBytes;
  const totalCellSize = readUInt(bytes, offset, offsetBytes); offset += offsetBytes;
  if (cells !== 1 || roots !== 1 || absent !== 0 || totalCellSize < 2) return undefined;
  offset += roots * sizeBytes;
  if (hasIndex) offset += cells * offsetBytes;
  if (offset + totalCellSize + (hasCrc32 ? 4 : 0) > bytes.length) return undefined;

  const refsDescriptor = bytes[offset++];
  const bitsDescriptor = bytes[offset++];
  if ((refsDescriptor & 0x07) !== 0 || (refsDescriptor & 0x08) !== 0) return undefined;
  const dataBytes = Math.ceil(bitsDescriptor / 2);
  const data = bytes.subarray(offset, offset + dataBytes);
  if (data.length !== dataBytes) return undefined;

  let bitLength = Math.floor(bitsDescriptor / 2) * 8;
  if (bitsDescriptor % 2) {
    const last = data[data.length - 1];
    if (!last) return undefined;
    let trailingZeros = 0;
    while (trailingZeros < 8 && ((last >> trailingZeros) & 1) === 0) trailingZeros++;
    bitLength = dataBytes * 8 - trailingZeros - 1;
  }
  if (bitLength < 32 || (bitLength - 32) % 8 !== 0) return undefined;
  return data.subarray(0, 4 + ((bitLength - 32) / 8));
}

export function decodeComment(messageContent) {
  const body = messageContent?.body;
  if (typeof body !== 'string') return undefined;
  try {
    const payload = decodeSingleCellBoc(body);
    if (!payload || payload.length < 1 || payload.subarray(0, 4).some(Boolean)) return undefined;
    const text = payload.subarray(4).toString('utf8');
    return text.startsWith('u_') && /^[\x20-\x7e]{3,128}$/.test(text) ? text : undefined;
  } catch { return undefined; }
}

export function extractInboundTonDeposits(transactions, adminAddress) {
  if (!Array.isArray(transactions) || !adminAddress) return [];
  const normalizedAdminAddress = normalizeTonAddress(adminAddress);
  if (!normalizedAdminAddress) return [];
  return transactions.flatMap((tx) => {
    const msg = tx?.in_msg;
    const value = msg?.value;
    const source = msg?.source;
    const destination = msg?.destination;
    const failed = tx?.description?.aborted === true
      || tx?.description?.compute_ph?.success === false
      || tx?.description?.action?.success === false
      || msg?.bounced === true;
    const isConfirmed = Number.isInteger(tx?.mc_block_seqno) && tx.mc_block_seqno > 0;
    if (!source || normalizeTonAddress(destination) !== normalizedAdminAddress || failed || !isConfirmed
      || !/^\d+$/.test(String(value)) || BigInt(value) <= 0) {
      return [];
    }
    const comment = decodeComment(msg.message_content);
    if (!comment || !tx?.hash || tx.lt === undefined) return [];
    return [{ comment, amount: String(value), txHash: String(tx.hash), txLt: String(tx.lt) }];
  });
}

export async function pollToncenter({ address, apiKey = process.env.TONCENTER_API_KEY, offset = 0 }) {
  if (!apiKey || !address) throw new Error('TONCENTER_API_KEY and ADMIN_TON_DEPOSIT_ADDRESS are required');
  const baseUrl = process.env.TONCENTER_API_URL || 'https://toncenter.com';
  const url = new URL('/api/v3/transactions', baseUrl);
  url.searchParams.set('account', address);
  url.searchParams.set('limit', '100');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', 'desc');
  const response = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  if (!response.ok) throw new Error(`TONCENTER request failed (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data?.transactions)) throw new Error('Unexpected Toncenter V3 response');
  return data.transactions;
}

export async function runMonitor({ supabase } = {}) {
  if (process.env.TON_MONITOR_ENABLED !== '1') return;
  const address = process.env.ADMIN_TON_DEPOSIT_ADDRESS;
  if (!address || !process.env.TONCENTER_API_KEY || !supabase) throw new Error('TON monitor requires explicit provider, address and Supabase settings');
  const cursorRows = await supabase('get_ton_monitor_cursor', {});
  const cursor = cursorRows?.[0];
  const pages = [];
  const maxPages = Math.max(1, Number(process.env.TON_MONITOR_MAX_PAGES || 100));
  const overlap = Math.max(1, Number(process.env.TON_MONITOR_OVERLAP || 20));
  let foundCursor = !cursor?.tx_hash;
  let cursorIndex = -1;

  for (let page = 0; page < maxPages; page++) {
    const transactions = await pollToncenter({ address, offset: page * 100 });
    if (!transactions.length) {
      foundCursor = true;
      break;
    }
    pages.push(...transactions);
    const pageCursorIndex = cursor?.tx_hash
      ? transactions.findIndex((tx) => String(tx.hash) === cursor.tx_hash && String(tx.lt) === cursor.tx_lt)
      : -1;
    if (!cursor?.tx_hash) {
      foundCursor = true;
      break;
    }
    if (pageCursorIndex >= 0) {
      foundCursor = true;
      cursorIndex = (page * 100) + pageCursorIndex;
    }
    if (cursorIndex >= 0 && pages.length >= cursorIndex + 1 + overlap) break;
    if (transactions.length < 100) {
      foundCursor = true;
      break;
    }
  }
  if (!foundCursor) throw new Error('TON monitor backfill limit reached before the saved cursor');

  const newest = pages.find((tx) => Number.isInteger(tx?.mc_block_seqno) && tx.mc_block_seqno > 0);
  const unprocessed = cursor?.tx_hash
    ? pages.slice(0, cursorIndex >= 0 ? Math.min(pages.length, cursorIndex + 1 + overlap) : pages.length)
    : pages.slice(0, 100);
  const deposits = extractInboundTonDeposits(unprocessed, address).reverse();
  for (const deposit of deposits) {
    await supabase('credit_deposit', { p_comment: deposit.comment, p_tx_hash: deposit.txHash,
      p_tx_lt: deposit.txLt, p_amount: deposit.amount });
  }
  if (newest?.hash && newest.lt !== undefined) {
    await supabase('set_ton_monitor_cursor', { p_tx_hash: String(newest.hash), p_tx_lt: String(newest.lt) });
  }
}