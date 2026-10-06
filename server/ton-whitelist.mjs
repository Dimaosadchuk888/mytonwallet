import {
  createHash, createPublicKey, randomBytes, verify as verifySignature,
} from 'node:crypto';
import {
  Address,
  Cell,
  contractAddress,
  loadStateInit,
  WalletContractV1R1,
  WalletContractV1R2,
  WalletContractV1R3,
  WalletContractV2R1,
  WalletContractV2R2,
  WalletContractV3R1,
  WalletContractV3R2,
  WalletContractV4,
  WalletContractV5R1,
} from '@ton/ton';

const MAINNET_CHAIN_ID = '-239';
const PROOF_MAX_AGE_SECONDS = 15 * 60;
const PROOF_MAX_FUTURE_SECONDS = 60;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_PROOF_PAYLOAD_BYTES = 128;
const MAX_STATE_INIT_BYTES = 64 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class TonWhitelistError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function failProof() {
  throw new TonWhitelistError('invalid_proof', 400);
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function loadV1(slice) {
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV2(slice) {
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV3(slice) {
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV4(slice) {
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV5(slice) {
  slice.loadBoolean();
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

const knownWalletContracts = [
  { contract: WalletContractV1R1, load: loadV1 },
  { contract: WalletContractV1R2, load: loadV1 },
  { contract: WalletContractV1R3, load: loadV1 },
  { contract: WalletContractV2R1, load: loadV2 },
  { contract: WalletContractV2R2, load: loadV2 },
  { contract: WalletContractV3R1, load: loadV3 },
  { contract: WalletContractV3R2, load: loadV3 },
  { contract: WalletContractV4, load: loadV4 },
  { contract: WalletContractV5R1, load: loadV5 },
].map(({ contract, load }) => ({
  code: contract.create({ workchain: 0, publicKey: Buffer.alloc(32) }).init.code,
  load,
}));

export function extractWalletPublicKey(stateInit) {
  if (!stateInit?.code || !stateInit?.data) return undefined;

  for (const { code, load } of knownWalletContracts) {
    try {
      if (code.equals(stateInit.code)) {
        const publicKey = load(stateInit.data.beginParse());
        return publicKey.length === 32 ? publicKey : undefined;
      }
    } catch {
      // A code match with an unexpected data layout is not trusted.
    }
  }

  return undefined;
}

export function buildTonProofDigest(address, proof) {
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workChain, 0);

  const domainBytes = Buffer.from(proof.domain.value, 'utf8');
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(proof.domain.lengthBytes, 0);

  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE(BigInt(proof.timestamp), 0);

  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    workchain,
    Buffer.from(address.hash),
    domainLength,
    domainBytes,
    timestamp,
    Buffer.from(proof.payload, 'utf8'),
  ]);

  return sha256(Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from('ton-connect', 'utf8'),
    sha256(message),
  ]));
}

function normalizeTonAddress(value) {
  if (typeof value !== 'string' || value.length > 128) {
    throw new TonWhitelistError('invalid_request', 400);
  }

  try {
    return Address.parse(value).toRawString();
  } catch {
    throw new TonWhitelistError('invalid_request', 400);
  }
}

function validateProofFields(account, proof, expectedDomain, expectedPayload, now) {
  if (!account || typeof account !== 'object' || !proof || typeof proof !== 'object') {
    failProof();
  }

  if (account.chain !== MAINNET_CHAIN_ID) failProof();
  if (typeof account.walletStateInit !== 'string'
    || !account.walletStateInit
    || account.walletStateInit.length > MAX_STATE_INIT_BYTES) {
    failProof();
  }

  if (typeof proof.domain?.value !== 'string'
    || proof.domain.value !== expectedDomain
    || !Number.isSafeInteger(proof.domain.lengthBytes)) {
    failProof();
  }
  const domainBytes = Buffer.from(proof.domain.value, 'utf8');
  if (proof.domain.lengthBytes !== domainBytes.length || domainBytes.length < 1 || domainBytes.length > 253) {
    failProof();
  }

  if (typeof proof.payload !== 'string'
    || Buffer.byteLength(proof.payload, 'utf8') < 1
    || Buffer.byteLength(proof.payload, 'utf8') > MAX_PROOF_PAYLOAD_BYTES
    || proof.payload !== expectedPayload) {
    failProof();
  }

  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(proof.timestamp)
    || proof.timestamp < nowSeconds - PROOF_MAX_AGE_SECONDS
    || proof.timestamp > nowSeconds + PROOF_MAX_FUTURE_SECONDS) {
    throw new TonWhitelistError('challenge_expired', 409);
  }

  if (typeof proof.signature !== 'string'
    || proof.signature.length > 128
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.signature)) {
    failProof();
  }

  const signature = Buffer.from(proof.signature, 'base64');
  if (signature.length !== 64
    || signature.toString('base64').replace(/=+$/, '') !== proof.signature.replace(/=+$/, '')) {
    failProof();
  }

  return signature;
}

async function getPublicKeyFromToncenter(address, { apiKey, fetchImpl }) {
  if (!apiKey) {
    throw new TonWhitelistError('public_key_unavailable', 503);
  }

  let response;
  try {
    response = await fetchImpl('https://toncenter.com/api/v2/runGetMethod', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        address,
        method: 'get_public_key',
        stack: [],
      }),
    });
  } catch {
    throw new TonWhitelistError('public_key_unavailable', 503);
  }

  if (!response.ok) {
    throw new TonWhitelistError('public_key_unavailable', 503);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new TonWhitelistError('public_key_unavailable', 503);
  }

  const stackValue = result?.result?.stack?.[0];
  if (result?.ok !== true || !Array.isArray(stackValue) || stackValue[0] !== 'num') {
    return undefined;
  }

  let publicKeyValue;
  try {
    publicKeyValue = BigInt(stackValue[1]);
  } catch {
    return undefined;
  }

  if (publicKeyValue < 0n || publicKeyValue >= (1n << 256n)) return undefined;
  return Buffer.from(publicKeyValue.toString(16).padStart(64, '0'), 'hex');
}

export async function verifyTonProof({
  account,
  proof,
  expectedDomain,
  expectedPayload,
  now = Date.now(),
  toncenterApiKey,
  fetchImpl = globalThis.fetch,
  resolveWalletPublicKey,
}) {
  const signature = validateProofFields(account, proof, expectedDomain, expectedPayload, now);
  let address;
  let stateInit;
  try {
    address = Address.parse(account.address);
    stateInit = loadStateInit(Cell.fromBase64(account.walletStateInit).beginParse());
  } catch {
    failProof();
  }

  const normalizedAddress = address.toRawString();
  const derivedAddress = contractAddress(address.workChain, stateInit);
  if (!derivedAddress.equals(address)) failProof();

  let publicKey = extractWalletPublicKey(stateInit);
  if (!publicKey) {
    try {
      publicKey = resolveWalletPublicKey
        ? await resolveWalletPublicKey(normalizedAddress)
        : await getPublicKeyFromToncenter(normalizedAddress, {
          apiKey: toncenterApiKey,
          fetchImpl,
        });
    } catch (error) {
      if (error instanceof TonWhitelistError) throw error;
      throw new TonWhitelistError('public_key_unavailable', 503);
    }
  }
  if (!publicKey || publicKey.length !== 32) failProof();

  let publicKeyObject;
  try {
    publicKeyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    failProof();
  }

  const digest = buildTonProofDigest(address, proof);
  if (!verifySignature(null, digest, publicKeyObject, signature)) failProof();

  return {
    address: normalizedAddress,
    networkId: MAINNET_CHAIN_ID,
    domain: proof.domain.value,
    timestamp: proof.timestamp,
    payloadHash: sha256(Buffer.from(proof.payload, 'utf8')).toString('hex'),
  };
}

function walletResponse(row) {
  return {
    address: row.address,
    networkId: row.network_id,
    verifiedAt: row.verified_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

function result(status, code, extra = {}) {
  return { status, body: { ...(code && { code }), ...extra } };
}

export async function handleTonWhitelistRequest({
  method,
  path,
  searchParams = new URLSearchParams(),
  telegramId,
  requestBody,
  supabase,
  env = {},
  now = Date.now,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  try {
    if (path === '/api/ton/whitelist' && method === 'GET') {
      let addressFilter = '';
      if (searchParams.has('address')) {
        const address = normalizeTonAddress(searchParams.get('address'));
        addressFilter = `&address=eq.${encodeURIComponent(address)}`;
      }

      const rows = await supabase(
        `internal_ton_wallet_whitelist?telegram_id=eq.${encodeURIComponent(telegramId)}`
          + `${addressFilter}&select=address,network_id,verified_at,last_verified_at`
          + '&order=verified_at.desc&limit=100',
        { headers: { accept: 'application/json' } },
      );
      return result(200, undefined, { wallets: (rows || []).map(walletResponse) });
    }

    if (path === '/api/ton/whitelist/challenge' && method === 'POST') {
      const issuedAt = now();
      const payload = randomBytes(32).toString('base64url');
      const expiresAt = new Date(issuedAt + CHALLENGE_LIFETIME_MS).toISOString();
      const payloadHash = sha256(Buffer.from(payload, 'utf8')).toString('hex');

      await supabase(
        `internal_ton_wallet_challenges?expires_at=lt.${encodeURIComponent(new Date(issuedAt).toISOString())}`,
        { method: 'DELETE', headers: { prefer: 'return=minimal' } },
      );
      await supabase(
        `internal_ton_wallet_challenges?telegram_id=eq.${encodeURIComponent(telegramId)}&used_at=is.null`,
        { method: 'DELETE', headers: { prefer: 'return=minimal' } },
      );
      await supabase('internal_ton_wallet_challenges', {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          telegram_id: telegramId,
          payload_hash: payloadHash,
          expires_at: expiresAt,
        }),
      });

      return result(201, undefined, { payload, expiresAt });
    }

    if (path === '/api/ton/whitelist/verify' && method === 'POST') {
      const account = requestBody?.account;
      const proof = requestBody?.proof;
      if (typeof proof?.payload !== 'string'
        || Buffer.byteLength(proof.payload, 'utf8') < 1
        || Buffer.byteLength(proof.payload, 'utf8') > MAX_PROOF_PAYLOAD_BYTES) {
        throw new TonWhitelistError('invalid_proof', 400);
      }

      const payloadHash = sha256(Buffer.from(proof.payload, 'utf8')).toString('hex');
      const challenges = await supabase(
        `internal_ton_wallet_challenges?telegram_id=eq.${encodeURIComponent(telegramId)}`
          + `&payload_hash=eq.${payloadHash}&used_at=is.null&select=expires_at&limit=1`,
        { headers: { accept: 'application/json' } },
      );
      const challenge = challenges?.[0];
      const challengeExpiry = Date.parse(challenge?.expires_at || '');
      if (!challenge || !Number.isFinite(challengeExpiry) || challengeExpiry <= now()) {
        throw new TonWhitelistError('challenge_expired', 409);
      }

      const expectedDomain = (env.TON_CONNECT_APP_DOMAIN || 'my-gramwallet.replit.app').toLowerCase();
      const verified = await verifyTonProof({
        account,
        proof,
        expectedDomain,
        expectedPayload: proof.payload,
        now: now(),
        toncenterApiKey: env.TONCENTER_API_KEY,
        fetchImpl,
      });

      const rows = await supabase('rpc/internal_ton_register_wallet', {
        method: 'POST',
        body: JSON.stringify({
          p_telegram_id: telegramId,
          p_address: verified.address,
          p_network_id: verified.networkId,
          p_payload_hash: verified.payloadHash,
          p_proof_timestamp: verified.timestamp,
          p_proof_domain: verified.domain,
        }),
      });
      const registration = Array.isArray(rows) ? rows[0] : rows;

      if (registration?.outcome === 'address_in_use') {
        throw new TonWhitelistError('address_in_use', 409);
      }
      if (registration?.outcome !== 'registered' || !registration.wallet) {
        throw new TonWhitelistError('challenge_expired', 409);
      }

      return result(201, undefined, { wallet: walletResponse(registration.wallet) });
    }

    if (path === '/api/ton/whitelist'
      || path === '/api/ton/whitelist/challenge'
      || path === '/api/ton/whitelist/verify') {
      return result(405, 'method_not_allowed');
    }
    return result(404, 'not_found');
  } catch (error) {
    if (error instanceof TonWhitelistError) {
      return result(error.status, error.code);
    }
    logger.error?.('[ton-whitelist] request failed', {
      status: error?.status || 'unknown',
    });
    return result(503, 'ton_whitelist_unavailable');
  }
}
