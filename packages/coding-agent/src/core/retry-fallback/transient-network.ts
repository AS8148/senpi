// A pure network-transient failure (timeout, reset, DNS, connection fault, a 5xx that
// names no limit) is the transport's fault, not the model's or the account's. Opening the
// shared circuit for it would stick the session on a fallback after one flaky office
// network, which is exactly what the guest report showed (senpi#3306). The same-model
// retry budget already paces these; only a failure that earns a fallback should open the
// circuit, and this predicate withholds that for a pure network fault.
const PURE_NETWORK_TEXT =
	/econnreset|econnrefused|etimedout|enotfound|ehostunreach|enetunreach|socket hang up|fetch failed|network error|request timed out|connection (?:reset|refused|timed out|closed)|dns|getaddrinfo/i;

export function isPureNetworkTransient(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && PURE_NETWORK_TEXT.test(errorMessage);
}
