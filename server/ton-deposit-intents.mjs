export const TON_MAINNET_NETWORK_ID = '-239';

export async function isVerifiedTonDepositSource(supabase, telegramId, sourceAddress) {
  const rows = await supabase(
    `internal_ton_wallet_whitelist?telegram_id=eq.${encodeURIComponent(telegramId)}`
      + `&network_id=eq.${TON_MAINNET_NETWORK_ID}`
      + `&address=eq.${encodeURIComponent(sourceAddress)}`
      + '&select=address,network_id,verified_at&limit=1',
    { headers: { accept: 'application/json' } },
  );

  return (rows || []).some((wallet) => (
    wallet.address === sourceAddress
    && wallet.network_id === TON_MAINNET_NETWORK_ID
    && Boolean(wallet.verified_at)
  ));
}
