# Mini Engine protocol v1

Transport: UTF-8 JSON Lines over child stdin/stdout. JSON-RPC 2.0 string request IDs. All regular engine stdout is redirected to stderr, including connector System.out logging. CLI writes stderr to workspace engine.log.

Request: `{"jsonrpc":"2.0","id":"uuid","method":"...","params":{...}}`

Success: `{"jsonrpc":"2.0","id":"uuid","result":{...}}`

Failure: `{"jsonrpc":"2.0","id":"uuid","error":{"code":-32000,"message":"..."}}`

Cancellation final error code is -32800. `operation.cancel` only acknowledges a request; the original request produces the final result. Cancel acknowledgement is never presented as confirmed cancellation.

| Method | Parameters | Result |
| --- | --- | --- |
| engine.hello | {} | protocolVersion, engineVersion, javaVersion |
| connector.inspect | jar, dependencies[], optional className | pdkId, version, className, configOptions, capabilities |
| connector.unload | artifact fields | unloaded |
| datasource.test | artifact fields + config | passed, checks[] |
| datasource.discover | artifact fields + config, optional table | tables[{id,name,fields[]}] |
| datasource.sample | artifact fields + config, table, limit 1..100 | rows[], count, limit |
| task.export | artifact fields + config, table, output, exclude[] | written, output |
| operation.cancel | requestId | requested (not final state) |

Notifications: `{"jsonrpc":"2.0","method":"task.progress","params":{"requestId":"...","written":500,"output":"..."}}`.

Artifacts are immutable cached JARs plus optional dependencies. Each operation creates an isolated connector instance, registers capabilities, constructs PDK context and in-memory state maps, calls the operation and stops the connector in finally. Classloaders are reused within one engine process. There is no platform connection or database persistence in this engine.

The TS boundary checks handshake version, bounds samples, checks artifact hashes and correlates IDs. A timed out ordinary operation kills the owned engine and fails pending requests; requests with side effects are never automatically replayed. Export has a 24-hour maximum control timeout. State maps are in memory, with no recovery guarantee.

This initial protocol is handwritten; full generated schemas/types, metadata pagination, durable event replay and multi-client sockets remain planned.
