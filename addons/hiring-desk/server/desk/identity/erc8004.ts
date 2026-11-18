import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Erc8004Reader, Erc8004Registration } from './types.js';

/** Read-only subset of the official IdentityRegistry ABI, reviewed 2026-11-07.
 * https://github.com/erc-8004/erc-8004-contracts/blob/master/abis/IdentityRegistry.json
 * Selectors are keccak256(function signature)[0:4], not an assumed legacy ABI.
 */
export const ERC8004_READ_SELECTORS = { ownerOf: '6352211e', tokenURI: 'c87b56dd', getAgentWallet: '00339509' } as const;
export interface Erc8004RpcOptions {
  /** Explicit trusted deployment. No implicit network, address, token or fallback. */
  chainId: string;
  registryAddress: string;
  rpcUrl: string;
  /** Metadata network fetch is disabled unless its exact DNS hostname is listed. */
  metadataHosts?: readonly string[];
  maxMetadataBytes?: number;
  timeoutMs?: number;
}
export type IdentityRpc = (method: string, params: unknown[]) => Promise<unknown>;
export interface MetadataTransport { read(url: URL, maxBytes: number, timeoutMs: number): Promise<Uint8Array> }
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const zero = `0x${'0'.repeat(40)}`;
const uint = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) < (1n << 256n);
const jsonObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const decoder = new TextDecoder('utf-8', { fatal: true });

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Identity read timeout')), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Fail-closed public address filter. IPv4-mapped IPv6 and transition/special IPv6 are excluded. */
export function publicMetadataAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [a = 0,b = 0,c = 0] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 100 && b! >= 64 && b! <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(value) !== 6 || value.includes('%') || value.includes('.')) return false;
  const first = Number.parseInt(value.split(':')[0]!, 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2001 && first !== 0x2002 && first !== 0x3fff;
}

/** Resolve once, reject every nonpublic answer, and pin the HTTPS socket to that answer.
 * Redirects are never followed; the original hostname remains TLS SNI/certificate authority.
 */
export const pinnedMetadataTransport: MetadataTransport = {
  async read(url, maxBytes, timeoutMs) {
    const answers = await deadline(lookup(url.hostname, { all: true, verbatim: true }), timeoutMs);
    if (!answers.length || answers.some(item => !publicMetadataAddress(item.address))) throw new Error('Metadata DNS is not public');
    const chosen = answers[0]!;
    return new Promise<Uint8Array>((resolve, reject) => {
      const req = httpsRequest(url, {
        method: 'GET', agent: false, headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
          else callback(null, chosen.address, chosen.family);
        },
      }, response => {
        if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(new Error('Metadata HTTP response unavailable')); return; }
        const length = response.headers['content-length'];
        if (length && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(maxBytes))) { response.destroy(); reject(new Error('Metadata exceeds byte limit')); return; }
        const chunks: Buffer[] = []; let count = 0;
        response.on('data', (chunk: Buffer) => {
          count += chunk.byteLength;
          if (count > maxBytes) { response.destroy(); reject(new Error('Metadata exceeds byte limit')); }
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('Metadata transport unavailable')));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      const timer = setTimeout(() => req.destroy(new Error('Metadata timeout')), timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', () => reject(new Error('Metadata transport unavailable')));
      req.end();
    });
  },
};

async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('Identity RPC unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > limit) throw new Error('Identity RPC response exceeds limit'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
class MissingToken extends Error {}
/** No error strings/RPC URLs are exposed by the public identity projection. */
function httpRpc(url: URL, timeoutMs: number, limit: number): IdentityRpc {
  let id = 0;
  return async (method, params) => {
    const requestId = ++id;
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const message: unknown = JSON.parse(decoder.decode(await boundedResponse(response, limit)));
    if (!jsonObject(message) || message.id !== requestId || message.jsonrpc !== '2.0') throw new Error('Invalid identity RPC envelope');
    if (message.error) {
      const error = message.error;
      // Only the exact ERC-721 custom-error selector plus requested token is treated as missing.
      if (method === 'eth_call' && jsonObject(error) && typeof error.data === 'string' && /^0x7e273289[0-9a-fA-F]{64}$/.test(error.data)) {
        const call = params[0];
        if (jsonObject(call) && typeof call.data === 'string' && call.data.startsWith(`0x${ERC8004_READ_SELECTORS.ownerOf}`) && error.data.slice(10).toLowerCase() === call.data.slice(10).toLowerCase()) throw new MissingToken('Missing registry token');
      }
      throw new Error('Identity RPC call failed');
    }
    if (!('result' in message)) throw new Error('Missing identity RPC result'); return message.result;
  };
}
function abiAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) throw new Error('Invalid registry address result');
  return `0x${value.slice(-40)}`;
}
function abiString(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > 2 * (limit + 96) + 2 || !/^0x(?:[0-9a-fA-F]{64}){2,}$/.test(value)) throw new Error('Invalid registry URI result');
  if (BigInt(`0x${value.slice(2,66)}`) !== 32n) throw new Error('Invalid registry URI offset');
  const length = BigInt(`0x${value.slice(66,130)}`);
  if (length > BigInt(limit) || value.length !== 130 + Math.ceil(Number(length) / 32) * 64) throw new Error('Invalid registry URI length');
  const content = value.slice(130, 130 + Number(length) * 2);
  if (!/^0*$/.test(value.slice(130 + Number(length) * 2))) throw new Error('Invalid registry URI padding');
  return decoder.decode(Buffer.from(content, 'hex'));
}

export class RpcErc8004Reader implements Erc8004Reader {
  private readonly rpc: IdentityRpc;
  private readonly registry: string;
  private readonly limit: number;
  private readonly timeout: number;
  private readonly hosts: Set<string>;
  private readonly options: Readonly<Erc8004RpcOptions>;
  constructor(options: Erc8004RpcOptions, rpc?: IdentityRpc, private readonly metadata: MetadataTransport = pinnedMetadataTransport) {
    this.options = Object.freeze({ ...options, metadataHosts: [...(options.metadataHosts ?? [])] });
    if (!/^[1-9][0-9]*$/.test(options.chainId) || !address(options.registryAddress) || options.registryAddress.toLowerCase() === zero) throw new Error('Explicit chain and registry deployment required');
    const endpoint = new URL(options.rpcUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Identity RPC must be configured HTTPS');
    this.limit = options.maxMetadataBytes ?? 65_536; this.timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.limit) || this.limit < 128 || this.limit > 262_144 || !Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 30_000) throw new Error('Invalid identity reader bounds');
    this.registry = `eip155:${options.chainId}:${options.registryAddress}`;
    this.hosts = new Set((options.metadataHosts ?? []).map(host => { if (host !== host.toLowerCase() || host.endsWith('.') || host.includes(':') || isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(host)) throw new Error('Invalid metadata hostname allowlist'); return host; }));
    this.rpc = rpc ?? httpRpc(endpoint, this.timeout, this.limit * 4 + 4096);
  }
  async readRegistration(ref: string): Promise<Erc8004Registration | null> {
    const match = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})\/(0|[1-9][0-9]*)$/.exec(ref);
    if (!match || match[1] !== this.options.chainId || match[2]!.toLowerCase() !== this.options.registryAddress.toLowerCase() || !uint(match[3]!)) throw new Error('Identity reference does not match configured deployment');
    const chain = await this.rpc('eth_chainId', []);
    if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== BigInt(this.options.chainId)) throw new Error('Identity RPC chain mismatch');
    const block = await this.rpc('eth_getBlockByNumber', ['finalized', false]);
    if (!jsonObject(block) || typeof block.number !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block.number) || typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new Error('Identity finality unavailable');
    const blockId = { blockHash: block.hash, requireCanonical: true };
    const code = await this.rpc('eth_getCode', [this.options.registryAddress, blockId]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error('Identity registry has no code');
    const argument = BigInt(match[3]!).toString(16).padStart(64, '0');
    const call = (selector: string) => this.rpc('eth_call', [{ to: this.options.registryAddress, data: `0x${selector}${argument}` }, blockId]);
    let owner: string;
    try { owner = abiAddress(await call(ERC8004_READ_SELECTORS.ownerOf)); } catch (e) { if (e instanceof MissingToken) return null; throw e; }
    if (owner.toLowerCase() === zero) throw new Error('Registry owner is zero');
    const payment = abiAddress(await call(ERC8004_READ_SELECTORS.getAgentWallet));
    const uri = abiString(await call(ERC8004_READ_SELECTORS.tokenURI), this.limit * 2);
    const services = await this.readMetadata(uri, match[3]!);
    return { agentRegistry: ref.slice(0, ref.lastIndexOf('/')), agentId: match[3]!, owner, paymentWallet: payment.toLowerCase() === zero ? null : payment, services };
  }
  private async readMetadata(uri: string, agentId: string): Promise<Erc8004Registration['services']> {
    let bytes: Uint8Array;
    const prefix = 'data:application/json;base64,';
    if (uri.startsWith(prefix)) {
      const encoded = uri.slice(prefix.length);
      if (encoded.length > Math.ceil(this.limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid or oversized inline registration');
      bytes = Buffer.from(encoded, 'base64');
      if (Buffer.from(bytes).toString('base64') !== encoded) throw new Error('Noncanonical inline registration');
    } else {
      const url = new URL(uri);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || isIP(url.hostname) || !this.hosts.has(url.hostname) || url.hostname.endsWith('.')) throw new Error('Metadata URL is not allowlisted HTTPS');
      bytes = await deadline(this.metadata.read(url, this.limit, this.timeout), this.timeout);
    }
    if (bytes.length > this.limit) throw new Error('Registration metadata exceeds byte limit');
    const data: unknown = JSON.parse(decoder.decode(bytes));
    if (!jsonObject(data) || data.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' || typeof data.name !== 'string' || data.name.length < 1 || data.name.length > 200 || typeof data.description !== 'string' || data.description.length > 8192 || !Array.isArray(data.services) || data.services.length > 32) throw new Error('Malformed registration metadata');
    if (data.registrations !== undefined) {
      if (!Array.isArray(data.registrations) || data.registrations.length > 32) throw new Error('Malformed registration references');
      if (data.registrations.length && !data.registrations.some(r => jsonObject(r) && typeof r.agentRegistry === 'string' && r.agentRegistry.toLowerCase() === this.registry.toLowerCase() && (typeof r.agentId === 'string' || typeof r.agentId === 'number' && Number.isSafeInteger(r.agentId)) && String(r.agentId) === agentId)) throw new Error('Metadata registration reference mismatch');
    }
    return data.services.map(raw => {
      if (!jsonObject(raw) || typeof raw.name !== 'string' || !raw.name || raw.name.length > 100 || typeof raw.endpoint !== 'string' || !raw.endpoint || raw.endpoint.length > 2048 || raw.version !== undefined && (typeof raw.version !== 'string' || raw.version.length > 100)) throw new Error('Malformed registration service');
      return { name: raw.name, endpoint: raw.endpoint, ...(typeof raw.version === 'string' ? { version: raw.version } : {}) };
    });
  }
}
