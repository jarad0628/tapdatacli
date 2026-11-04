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
| datasource.tables | artifact fields + config | tables[], count; requires get_table_names_function |
| datasource.tableInfo | artifact fields + config, table | numOfRows, storageSize, avgObjSize; requires get_table_info_function |
| datasource.now | artifact fields + config | connector timestamp; requires get_current_timestamp_function |
| datasource.streamRead | artifact fields + config, optional table, startTime epoch millis, recordSize | final count; requires stream_read_function; uses timestamp_to_stream_offset_function when available |
| datasource.sample | artifact fields + config, table, limit 1..100 | rows[], count, limit |
| datasource.count | artifact fields + config, table | count; requires batch_count_function |
| datasource.indexes | artifact fields + config, table | indexes[]; requires query_indexes_function |
| datasource.constraints | artifact fields + config, table | constraints[]; requires query_constraints_function |
| datasource.minmax | artifact fields + config, table, field, optional TapAdvanceFilter | min/max value; requires query_field_min_max_value_function |
| datasource.query | artifact fields + config, table, TapAdvanceFilter-compatible filter, optional sort[], projection, skip, limit | rows[], count, skip, sort; requires query_by_advance_filter_function |
| datasource.sql | artifact fields + config, sql, sqlType=query\|execute | rows[], count, batches; requires execute_command_v2_function |
| datasource.command | artifact fields + config, command, commandParams, batchSize | connector-defined results[]; requires execute_command_function |
| task.export | artifact fields + config, table, output, exclude[] | written, output |
| operation.cancel | requestId | requested (not final state) |

Notifications: `task.progress` reports task export progress. `stream.records` carries a batch of PDK events, cumulative count and transient offset for a `datasource.streamRead` request. Stream read is a foreground operation; cancellation requests connector stop and the operation returns its final result/error. It does not persist offsets.

Artifacts are immutable cached JARs plus optional dependencies. Each operation creates an isolated connector instance, registers capabilities, constructs PDK context and in-memory state maps, calls the operation and stops the connector in finally. Classloaders are reused within one engine process. There is no platform connection or database persistence in this engine.

The TS boundary checks handshake version, bounds samples, checks artifact hashes and correlates IDs. A timed out ordinary operation kills the owned engine and fails pending requests; requests with side effects are never automatically replayed. Export has a 24-hour maximum control timeout. State maps are in memory, with no recovery guarantee.

This initial protocol is handwritten; full generated schemas/types, metadata pagination, durable event replay and multi-client sockets remain planned.

The runtime capability-to-command inventory and the lifecycle-only API classification are maintained in [PDK-CAPABILITY-MAP.md](PDK-CAPABILITY-MAP.md).
