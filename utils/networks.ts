/**
 * The network under test.
 *
 * Base Sepolia isn't a preference — it's the only testnet market Aave still
 * runs. MetaMask doesn't ship with it, so the dApp has to ask the wallet to add
 * it and switch, and we approve that (see `ensureNetwork` in helpers.ts).
 */
export const BASE_SEPOLIA = {
  chainIdHex: '0x14a34', // 84532
  chainId: 84532,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // NOT the official https://sepolia.base.org — MetaMask's requests make it
  // return `failed to decode param in array[0] invalid JSON input` (-32603) and
  // the transaction never broadcasts. It looks exactly like a contract revert
  // ("Transaction failed" in the dApp) but it's the RPC choking on the payload.
  rpcUrls: [process.env.BASE_SEPOLIA_RPC_URL ?? 'https://base-sepolia-rpc.publicnode.com'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
} as const

/** Params shape accepted by `wallet_addEthereumChain`. */
export function addChainParams() {
  const { chainIdHex, chainName, nativeCurrency, rpcUrls, blockExplorerUrls } = BASE_SEPOLIA
  return {
    chainId: chainIdHex,
    chainName,
    nativeCurrency,
    rpcUrls: [...rpcUrls],
    blockExplorerUrls: [...blockExplorerUrls],
  }
}
