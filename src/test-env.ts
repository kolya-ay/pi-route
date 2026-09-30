// src/test-env.ts

// Test preload (bunfig.toml). Tests own their telemetry: the dev shell's exporter
// target must not leak in, whether its collector is up (polluted traces) or down
// (unhandled ECONNREFUSED on each span flush). Spawned CLI children inherit this env.
delete process.env.PI_ROUTE_OTLP_URL
delete process.env.PI_ROUTE_OTLP_PORT
