// Phase 15 CI demo target.
//
// A tiny, dependency-free HTTP server used by examples/ci/ci-demo.sh and the
// Tracer CLI workflow. It is deliberately deterministic: every response is a
// fixed document so a passing or failing collection always produces the same
// machine-readable report in CI.

const port = Number(process.env.TRACER_CI_PORT ?? 4571);
const hostname = "127.0.0.1";

const json = (body, status = 200, headers = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});

const server = Bun.serve({
	hostname,
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return json({ status: "ok", service: "tracer-ci-demo" });
		}
		if (request.method === "GET" && url.pathname === "/api/orders/1") {
			return json({ id: 1, status: "open", total: 42 });
		}
		if (request.method === "GET" && url.pathname === "/api/orders/missing") {
			return json({ error: "order_not_found" }, 404);
		}
		if (request.method === "POST" && url.pathname === "/api/orders") {
			const body = await request.text();
			return json({ id: 2, status: "open", echo: body }, 201, { Location: "/api/orders/2" });
		}
		return json({ error: "not_found", path: url.pathname }, 404);
	},
});

console.log(`tracer-ci-demo listening on http://${hostname}:${server.port}`);

const shutdown = () => {
	server.stop(true);
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
