import dns from "node:dns";

export const dnsResolver = {
	async resolve(hostname) {
		return dns.promises.lookup(hostname, { all: true, verbatim: true });
	},
};

export function pinnedResolver(addresses) {
	return { resolve: async () => addresses };
}
