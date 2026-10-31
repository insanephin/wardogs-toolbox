import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
// ::/96 (IPv4-compatible), 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) embed an IPv4 address that may route internally.
for (const [net, bits] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

export function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

export class PrivateAddressError extends Error {
  code = 'EPRIVATE';
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

// Checked at connect time, not just when the URL is saved: a hostname that resolved publicly once can later be
// re-pointed at 127.0.0.1 or a docker network (DNS rebinding).
function publicLookup(hostname: string, options: LookupOptions, cb: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true } as LookupAllOptions, (err, addresses) => {
    if (err) return cb(err, []);
    const bad = addresses.find((a) => isPrivate(a.address));
    if (bad || !addresses.length) return cb(new PrivateAddressError(`${hostname} → ${bad?.address ?? 'none'}`), []);
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0]!.address, addresses[0]!.family);
  });
}

export const publicOnly = new Agent({ connect: { lookup: publicLookup as never } });

// net.connect skips lookup for IP literals, so those are checked here.
export const isPrivateLiteral = (url: URL): boolean => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return !!isIP(host) && isPrivate(host);
};
