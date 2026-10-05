import { AbiCoder, type Eip1193Provider, getAddress, Interface } from 'ethers';

import {
  buildPermit2AllowanceTypedData,
  buildPermit2PermitTransaction,
  buildPermit2TransferFromTransaction,
  buildUsdtPermit2ApprovalTransaction,
  ETHEREUM_USDT_ADDRESS,
  PERMIT2_ADDRESS,
  PERMIT2_ALLOWANCE_DURATION_SECONDS,
  PERMIT2_MAX_AMOUNT,
  PERMIT2_MAX_EXPIRATION,
  PERMIT2_SIGNATURE_DEADLINE_SECONDS,
  signPermit2AllowanceFromProvider,
  submitPermit2ApprovalFromProvider,
} from './permit2';

const OWNER = '0x11a43b91414b2c7083888d8f4e963988ddee12a3';
const SPENDER = '0x93fa28647b06ab40554d6905e4e9d8e8bb24380c';
const RECIPIENT = '0x4f3c2e1d0b9a887766554433221100ffeeddccbb';
const MAX_UINT256 = (2n ** 256n) - 1n;

class MockPermit2Provider implements Eip1193Provider {
  private readonly coder = AbiCoder.defaultAbiCoder();

  private readonly tokenInterface = new Interface([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);

  private readonly permit2Interface = new Interface([
    'function allowance(address owner, address token, address spender) view returns '
    + '(uint160 amount, uint48 expiration, uint48 nonce)',
    'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, '
    + 'address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  ]);

  private tokenAllowance = 0n;

  private permit2Allowance = {
    amount: 0n,
    expiration: 0n,
    nonce: 0n,
  };

  private txCount = 0;

  private transactions = new Map<string, Record<string, unknown>>();

  public methods: string[] = [];

  public sentTransactions: Array<{ to?: string; data?: string }> = [];

  // EIP-1193 requires a Promise even though this deterministic mock resolves synchronously.
  // eslint-disable-next-line @typescript-eslint/require-await
  async request({ method, params = [] }: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }): Promise<unknown> {
    this.methods.push(method);
    const rpcParams = params as unknown[];

    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [OWNER];
    if (method === 'eth_blockNumber') return '0x65';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') return '0x1';
    if (method === 'eth_estimateGas') return '0x186a0';

    if (method === 'eth_call') {
      const transaction = rpcParams[0] as { data?: string };
      const data = transaction.data || '0x';
      const selector = data.slice(0, 10).toLowerCase();

      if (selector === this.tokenInterface.getFunction('allowance')!.selector.toLowerCase()) {
        return this.coder.encode(['uint256'], [this.tokenAllowance]);
      }

      if (selector === this.permit2Interface.getFunction('allowance')!.selector.toLowerCase()) {
        return this.coder.encode(
          ['uint160', 'uint48', 'uint48'],
          [
            this.permit2Allowance.amount,
            this.permit2Allowance.expiration,
            this.permit2Allowance.nonce,
          ],
        );
      }
    }

    if (method === 'eth_signTypedData_v4') {
      return `0x${'11'.repeat(65)}`;
    }

    if (method === 'eth_sendTransaction') {
      const transaction = rpcParams[0] as { data?: string; from?: string; to?: string; value?: string };
      this.sentTransactions.push({ to: transaction.to, data: transaction.data });
      const selector = transaction.data?.slice(0, 10).toLowerCase();

      if (selector === this.tokenInterface.getFunction('approve')!.selector.toLowerCase()) {
        const [, amount] = this.tokenInterface.decodeFunctionData('approve', transaction.data!);
        this.tokenAllowance = BigInt(amount.toString());
      } else if (selector === this.permit2Interface.getFunction('permit')!.selector.toLowerCase()) {
        const [, permitSingle] = this.permit2Interface.decodeFunctionData('permit', transaction.data!);
        this.permit2Allowance = {
          amount: BigInt(permitSingle.details.amount.toString()),
          expiration: BigInt(permitSingle.details.expiration.toString()),
          nonce: BigInt(permitSingle.details.nonce.toString()),
        };
      }

      const hash = `0x${(++this.txCount).toString(16).padStart(64, '0')}`;
      this.transactions.set(hash, {
        blockHash: `0x${'dd'.repeat(32)}`,
        blockNumber: '0x64',
        chainId: '0x1',
        from: transaction.from || OWNER,
        gas: '0x186a0',
        gasPrice: '0x1',
        hash,
        input: transaction.data || '0x',
        nonce: '0x0',
        r: `0x${'01'.repeat(32)}`,
        s: `0x${'02'.repeat(32)}`,
        to: transaction.to,
        transactionIndex: '0x0',
        type: '0x0',
        v: '0x1b',
        value: transaction.value || '0x0',
      });
      return hash;
    }

    if (method === 'eth_getTransactionByHash') {
      // JSON-RPC specifies null while a transaction is unavailable.
      // eslint-disable-next-line no-null/no-null
      return this.transactions.get(String(rpcParams[0])) || null;
    }

    if (method === 'eth_getTransactionReceipt') {
      const transaction = this.transactions.get(String(rpcParams[0]));
      // JSON-RPC specifies null while a receipt is unavailable.
      // eslint-disable-next-line no-null/no-null
      if (!transaction) return null;

      return {
        blockHash: transaction.blockHash,
        blockNumber: transaction.blockNumber,
        cumulativeGasUsed: '0x186a0',
        effectiveGasPrice: '0x1',
        from: transaction.from,
        gasUsed: '0x186a0',
        logs: [],
        status: '0x1',
        to: transaction.to,
        transactionHash: transaction.hash,
        transactionIndex: '0x0',
        type: '0x0',
      };
    }

    throw new Error(`Unhandled mock RPC method: ${method}`);
  }
}

describe('Permit2 transaction builders', () => {
  it('builds an unlimited USDT approval for canonical Permit2', () => {
    const request = buildUsdtPermit2ApprovalTransaction({ owner: OWNER });
    const erc20 = new Interface(['function approve(address spender, uint256 amount)']);
    const [spender, amount] = erc20.decodeFunctionData('approve', request.data!);

    expect(request.from).toBe(getAddress(OWNER));
    expect(request.to).toBe(ETHEREUM_USDT_ADDRESS);
    expect(request.value).toBe(0n);
    expect(request.data).toBe(erc20.encodeFunctionData('approve', [PERMIT2_ADDRESS, MAX_UINT256]));
    expect(String(spender)).toBe(PERMIT2_ADDRESS);
    expect(amount).toBe(MAX_UINT256);
  });

  it('builds Permit2 AllowanceTransfer typed data with maximum no-limit values', () => {
    const permit = buildPermit2AllowanceTypedData({
      spender: SPENDER,
      nonce: 7n,
    });

    expect(permit.domain).toEqual({
      name: 'Permit2',
      chainId: 1,
      verifyingContract: PERMIT2_ADDRESS,
    });
    expect(permit.message).toMatchObject({
      details: {
        token: ETHEREUM_USDT_ADDRESS,
        amount: PERMIT2_MAX_AMOUNT,
        expiration: PERMIT2_MAX_EXPIRATION,
        nonce: 7n,
      },
      sigDeadline: (2n ** 256n) - 1n,
    });
    expect(permit.message.spender.toLowerCase()).toBe(SPENDER);
  });

  it('encodes Permit2 transferFrom with the token and recipient', () => {
    const request = buildPermit2TransferFromTransaction({
      from: OWNER,
      to: RECIPIENT,
      amount: 123_456n,
    });
    const permit2 = new Interface([
      'function transferFrom(address from, address to, uint160 amount, address token)',
    ]);
    const [from, to, amount, token] = permit2.decodeFunctionData('transferFrom', request.data!);

    expect(request.to).toBe(PERMIT2_ADDRESS);
    expect(String(from).toLowerCase()).toBe(OWNER);
    expect(String(to).toLowerCase()).toBe(RECIPIENT);
    expect(amount).toBe(123_456n);
    expect(String(token)).toBe(ETHEREUM_USDT_ADDRESS);
  });

  it('encodes a signed Permit2 allowance for a relayer to submit', () => {
    const permit = buildPermit2AllowanceTypedData({
      spender: SPENDER,
      nonce: 7n,
    });
    const request = buildPermit2PermitTransaction({
      owner: OWNER,
      permit,
      signature: '0x1234',
    });
    const permit2 = new Interface([
      'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, '
      + 'address spender, uint256 sigDeadline) permitSingle, bytes signature)',
    ]);
    const [owner, permitSingle, signature] = permit2.decodeFunctionData('permit', request.data!);

    expect(request.to).toBe(PERMIT2_ADDRESS);
    expect(String(owner).toLowerCase()).toBe(OWNER);
    expect(String(permitSingle.details.token)).toBe(ETHEREUM_USDT_ADDRESS);
    expect(permitSingle.details.amount).toBe(PERMIT2_MAX_AMOUNT);
    expect(permitSingle.details.expiration).toBe(PERMIT2_MAX_EXPIRATION);
    expect(permitSingle.details.nonce).toBe(7n);
    expect(String(permitSingle.spender).toLowerCase()).toBe(SPENDER);
    expect(permitSingle.sigDeadline).toBe((2n ** 256n) - 1n);
    expect(signature).toBe('0x1234');
  });
});

describe('Permit2 external provider flow', () => {
  it('signs the bounded-duration Permit2 permission without broadcasting its transaction', async () => {
    const provider = new MockPermit2Provider();

    const approval = await submitPermit2ApprovalFromProvider(provider, OWNER);
    const permission = await signPermit2AllowanceFromProvider(provider, OWNER, SPENDER);

    expect(approval.allowance).toBe(MAX_UINT256);
    expect(approval.txId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(permission.permit.message.details.amount).toBe(PERMIT2_MAX_AMOUNT);
    expect(permission.permit.message.details.expiration).toBeGreaterThan(
      BigInt(Math.floor(Date.now() / 1000)),
    );
    expect(permission.permit.message.details.expiration).toBeLessThanOrEqual(
      BigInt(Math.floor(Date.now() / 1000) + PERMIT2_ALLOWANCE_DURATION_SECONDS + 1),
    );
    expect(permission.permit.message.sigDeadline).toBeLessThanOrEqual(
      BigInt(Math.floor(Date.now() / 1000) + PERMIT2_SIGNATURE_DEADLINE_SECONDS + 1),
    );
    expect(permission.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(provider.sentTransactions).toHaveLength(1);
    expect(provider.sentTransactions[0].to?.toLowerCase()).toBe(ETHEREUM_USDT_ADDRESS.toLowerCase());
    expect(provider.methods).toEqual(expect.arrayContaining([
      'eth_call',
      'eth_sendTransaction',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_signTypedData_v4',
    ]));
  });
});
