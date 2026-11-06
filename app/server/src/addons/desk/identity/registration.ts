/** ERC-8004 defines register(string agentURI) and related overloads, but the app has no selected deployment.
 * Preparation therefore requires the lead to inject a verified target and ABI encoder; this module
 * never guesses an address, emits fake calldata, or receives signing material.
 * Spec: https://ercs.ethereum.org/ERCS/erc-8004#registration (read 2026-11-06).
 */
export interface RegistrationTarget {
  chainId: string;
  registryAddress: string;
  encodeRegister(agentUri: string): string;
}

export interface UnsignedRegistrationTransaction {
  chainId: string;
  to: string;
  data: string;
  value: '0';
}

export function prepareRegistration(agentUri: string, target?: RegistrationTarget):
  | {kind:'ok'; value:UnsignedRegistrationTransaction}
  | {kind:'unavailable'|'invalid-input'|'failed'; message:string} {
  if (!/^https:\/\/[^\s]+$/.test(agentUri) && !/^ipfs:\/\/[^\s]+$/.test(agentUri) && !/^data:application\/json;base64,[A-Za-z0-9+/]+=*$/.test(agentUri)) {
    return {kind:'invalid-input', message:'Agent registration URI must be HTTPS, IPFS or JSON data URI'};
  }
  if (!target) return {kind:'unavailable', message:'No verified ERC-8004 registry deployment is configured'};
  if (!/^[1-9][0-9]*$/.test(target.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(target.registryAddress)) return {kind:'invalid-input', message:'Invalid verified registration target'};
  try {
    const data = target.encodeRegister(agentUri);
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(data)) return {kind:'failed', message:'Configured ABI encoder returned invalid calldata'};
    return {kind:'ok', value:{chainId:target.chainId, to:target.registryAddress, data, value:'0'}};
  } catch {
    return {kind:'failed', message:'ERC-8004 registration encoding failed'};
  }
}
