#!/usr/bin/env node

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodeAbiParameters,
  concat,
  getCreate2Address,
  http,
  keccak256,
  namehash,
  parseEventLogs,
  parseAbi,
  stringToHex,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { writeFile } from 'node:fs/promises'

const FACTORY = '0x77510ba162dfea3d8989e3f0928a691b345730d2'
const USER_REGISTRY_IMPL = '0xfaa23592aca10a6d8875b18ea86954e8eb6d8d72'
const RESOLVER_IMPL = '0x565b0f456a04ac9b48758190e90030623cff57c5'
const ERC8004_IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'

const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
  'function proxyLogic() view returns (address)',
])
const registryAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry)',
])
const resolverAbi = parseAbi([
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
  'function setAddr(bytes32 node, address addr)',
  'function setText(bytes32 node, string key, string value)',
])

// ENS EAC role bitmaps use one bit per role and the corresponding admin bit.
// 0x111... grants every role in the documented role bitmap format.
const ALL_ROLES = BigInt('0x' + '1'.repeat(64))
const OWNER_ROLES =
  (1n << 20n) | // ROLE_SET_SUBREGISTRY
  (1n << 24n) | // ROLE_SET_RESOLVER
  (1n << 28n)   // ROLE_CAN_TRANSFER_ADMIN

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

function required(name) {
  const value = arg(name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function address(value, name) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is not an address`)
  return value
}

function tx(to, data, description) {
  return { description, to, value: '0x0', data }
}

const parentName = required('parent-name').toLowerCase()
const label = required('label').toLowerCase()
const parentOwner = address(required('parent-owner'), 'parent-owner')
const agentWallet = address(required('agent-wallet'), 'agent-wallet')
const agentId = required('agent-id')
const rpcUrl = arg('rpc-url', process.env.ENS_RPC_URL || 'https://ethereum-rpc.publicnode.com')
const output = arg('output', 'ensv2-registration-txs.json')
const parentRegistry = arg('parent-registry')
const parentId = arg('parent-id')
const agentUri = arg('agent-uri', '')
const expiry = BigInt(arg('expiry', Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60))

if (!parentRegistry || !parentId) {
  throw new Error('Missing --parent-registry and --parent-id. Obtain the parent registry and token ID from ENS Explorer before preparing the attach transaction.')
}
address(parentRegistry, 'parent-registry')

const fullName = `${label}.${parentName}`
const registrySalt = BigInt(keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
  [keccak256(stringToHex('UserRegistry')), namehash(parentName), 0n],
)))
const resolverSalt = BigInt(keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
  [keccak256(stringToHex('OwnedResolver')), parentOwner, 0n],
)))

const registryInit = encodeFunctionData({
  abi: registryAbi,
  functionName: 'initialize',
  args: [[{ account: parentOwner, roleBitmap: ALL_ROLES }]],
})
const resolverInit = encodeFunctionData({
  abi: resolverAbi,
  functionName: 'initialize',
  args: [parentOwner, ALL_ROLES, []],
})
const registryDeploy = encodeFunctionData({
  abi: factoryAbi,
  functionName: 'deployProxy',
  args: [USER_REGISTRY_IMPL, registrySalt, registryInit],
})
const resolverDeploy = encodeFunctionData({
  abi: factoryAbi,
  functionName: 'deployProxy',
  args: [RESOLVER_IMPL, resolverSalt, resolverInit],
})

// Both proxy addresses are deterministic. The factory emits the definitive
// address in ProxyDeployed, so the script resolves them after deployment.
const factoryEvents = parseAbi([
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
])
const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })

const proxyLogic = await publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'proxyLogic' })
function predictProxy(salt) {
  const outerSalt = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [parentOwner, salt],
  ))
  const initCode = concat([
    '0x3d604d80600a3d3981f3363d3d373d3d3d363d73',
    proxyLogic,
    '0x5af43d82803e903d91602b57fd5bf3',
    outerSalt,
  ])
  return getCreate2Address({ from: FACTORY, salt: outerSalt, bytecodeHash: keccak256(initCode) })
}

const resolverAddress = predictProxy(resolverSalt)
const registryAddress = predictProxy(registrySalt)
const fullNameHash = namehash(fullName)
const attachData = encodeFunctionData({
  abi: registryAbi,
  functionName: 'setSubregistry',
  args: [BigInt(parentId), registryAddress],
})
const registerData = encodeFunctionData({
  abi: registryAbi,
  functionName: 'register',
  args: [label, parentOwner, '0x0000000000000000000000000000000000000000', resolverAddress, OWNER_ROLES, expiry],
})
const records = [
  tx(resolverAddress, encodeFunctionData({ abi: resolverAbi, functionName: 'setAddr', args: [fullNameHash, agentWallet] }), 'Set the agent address record'),
  tx(resolverAddress, encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [fullNameHash, 'agentRegistry', `eip155:8453:${ERC8004_IDENTITY}`] }), 'Set the ERC-8004 registry record'),
  tx(resolverAddress, encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [fullNameHash, 'agentId', agentId] }), 'Set the ERC-8004 agent ID record'),
]
if (agentUri) records.push(tx(resolverAddress, encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [fullNameHash, 'agentURI', agentUri] }), 'Set the ERC-8004 agent URI record'))

const bundle = {
  chainId: 1,
  parentName,
  fullName,
  parentOwner,
  agentWallet,
  agentId,
  erc8004IdentityRegistry: `eip155:8453:${ERC8004_IDENTITY}`,
  predictedProxyAddresses: { resolver: resolverAddress, registry: registryAddress },
  notes: [
    'Review every transaction on Ethereum Mainnet before signing.',
    'The registry and resolver addresses are learned from ProxyDeployed receipts.',
    'Do not use a registry address supplied by an unknown party.',
  ],
  transactions: [
    tx(FACTORY, resolverDeploy, 'Deploy the parent Permissioned Resolver proxy'),
    tx(FACTORY, registryDeploy, 'Deploy the User Registry proxy'),
    tx(parentRegistry, attachData, 'Attach the User Registry proxy to the parent name'),
    tx(registryAddress, registerData, 'Register the agent subname'),
    ...records,
  ],
  generatedAt: new Date().toISOString(),
}

// The attach and register calls depend on addresses emitted by the first two
// transactions. Prepare mode therefore writes a manifest with ABI templates;
// send mode executes the dependent calls and fills the real addresses.
await writeFile(output, JSON.stringify(bundle, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n')
console.log(`Wrote ${output}`)
console.log(`Predicted resolver proxy: ${resolverAddress}`)
console.log(`Predicted registry proxy: ${registryAddress}`)
console.log('Verify these CREATE2 addresses against ProxyDeployed events after deployment.')

const privateKey = process.env.ENS_PRIVATE_KEY
if (!privateKey) {
  console.log('Prepare mode complete. Use MetaMask or an approved transaction runner for each reviewed transaction.')
  process.exit(0)
}

const account = privateKeyToAccount(privateKey)
if (account.address.toLowerCase() !== parentOwner.toLowerCase()) {
  throw new Error(`Signer ${account.address} does not match --parent-owner`)
}
const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) })

async function send(address, abi, functionName, args, description) {
  console.log(`Sending: ${description}`)
  const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account })
  const hash = await wallet.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${description} failed: ${hash}`)
  return receipt
}

console.log('Signer mode is enabled through ENS_PRIVATE_KEY. MetaMask mode remains the default.')
const resolverReceipt = await send(FACTORY, factoryAbi, 'deployProxy', [RESOLVER_IMPL, resolverSalt, resolverInit], 'Deploy the Permissioned Resolver proxy')
const registryReceipt = await send(FACTORY, factoryAbi, 'deployProxy', [USER_REGISTRY_IMPL, registrySalt, registryInit], 'Deploy the User Registry proxy')
for (const [receipt, implementation, expected] of [[resolverReceipt, RESOLVER_IMPL, resolverAddress], [registryReceipt, USER_REGISTRY_IMPL, registryAddress]]) {
  const [event] = parseEventLogs({ abi: factoryEvents, eventName: 'ProxyDeployed', logs: receipt.logs })
  if (!event || event.args.proxyAddress.toLowerCase() !== expected.toLowerCase() || event.args.implementation.toLowerCase() !== implementation.toLowerCase()) {
    throw new Error('ProxyDeployed did not match the predicted address and official implementation; stopped before parent mutation')
  }
}
await send(parentRegistry, registryAbi, 'setSubregistry', [BigInt(parentId), registryAddress], 'Attach the User Registry proxy to the parent name')
await send(registryAddress, registryAbi, 'register', [label, parentOwner, '0x0000000000000000000000000000000000000000', resolverAddress, OWNER_ROLES, expiry], 'Register the agent subname')
for (const record of records) {
  const description = record.description
  console.log(`Sending: ${description}`)
  await publicClient.call({ account, to: record.to, data: record.data })
  const hash = await wallet.sendTransaction({ account, to: record.to, data: record.data, value: 0n })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${description} failed: ${hash}`)
}
console.log(`Completed ${fullName}`)
